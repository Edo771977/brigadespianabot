import { AsyncLocalStorage } from "node:async_hooks";
import { realpath } from "node:fs/promises";
import path from "node:path";

export type WorkspaceAdmissionMode = "ordinary" | "team";

export interface WorkspaceAdmissionOptions {
	workspaceDir: string;
	mode: WorkspaceAdmissionMode;
	signal?: AbortSignal;
	/** Called exactly once when this admission has to queue. */
	onWaitStart?: () => void;
	/** Paired with onWaitStart, on both admission and abort. */
	onWaitEnd?: () => void;
}

interface AdmissionLease {
	workspaceKey: string;
	mode: WorkspaceAdmissionMode;
	active: boolean;
}

interface AdmissionWaiter {
	mode: WorkspaceAdmissionMode;
	resolve: (release: () => void) => void;
	reject: (error: unknown) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
	onWaitEnd?: () => void;
	settled: boolean;
}

interface WorkspaceState {
	activeOrdinary: number;
	activeTeam: boolean;
	ordinaryQueue: AdmissionWaiter[];
	teamQueue: AdmissionWaiter[];
}

function normalizePlatformPath(value: string): string {
	return process.platform === "win32" ? value.toLowerCase() : value;
}

function abortReason(signal: AbortSignal): Error {
	if (signal.reason instanceof Error) return signal.reason;
	const error = new Error(
		signal.reason === undefined ? "Workspace admission aborted" : String(signal.reason),
	);
	error.name = "AbortError";
	return error;
}

function invokeHook(hook: (() => void) | undefined): void {
	try {
		hook?.();
	} catch {
		// Admission correctness must not depend on an observability/deadline hook.
	}
}

/**
 * Resolve aliases even when the workspace leaf does not exist yet. The nearest
 * existing ancestor is realpathed and the missing suffix is appended again.
 */
export async function canonicalWorkspacePath(workspaceDir: string): Promise<string> {
	const absolute = path.resolve(workspaceDir);
	let cursor = absolute;
	const suffix: string[] = [];
	while (true) {
		try {
			const physical = await realpath(cursor);
			return normalizePlatformPath(path.resolve(physical, ...suffix));
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") {
				return normalizePlatformPath(absolute);
			}
			const parent = path.dirname(cursor);
			if (parent === cursor) return normalizePlatformPath(absolute);
			suffix.unshift(path.basename(cursor));
			cursor = parent;
		}
	}
}

/**
 * Reader/writer admission for agent workspaces.
 *
 * Ordinary turns are readers: existing Brigade concurrency is preserved.
 * Team attempts are writers: one runs alone, and a queued writer prevents new
 * readers from starving it. A causally nested ordinary turn inherits an active
 * ordinary admission so synchronous same-agent sub-agents cannot deadlock
 * behind a Team attempt that queued after their parent started.
 */
export class WorkspaceAdmissionController {
	private readonly states = new Map<string, WorkspaceState>();
	private readonly scope = new AsyncLocalStorage<readonly AdmissionLease[]>();
	private registrationTail: Promise<void> = Promise.resolve();

	constructor(
		private readonly resolveWorkspaceKey: (workspaceDir: string) => Promise<string> = canonicalWorkspacePath,
	) {}

	async run<T>(options: WorkspaceAdmissionOptions, operation: () => Promise<T>): Promise<T> {
		// Path canonicalization is asynchronous. Register calls in invocation order
		// so a later reader cannot resolve realpath first and jump ahead of an
		// earlier Team writer. Only registration is serialized; admitted operations
		// on independent workspaces still execute concurrently.
		const priorRegistration = this.registrationTail;
		let releaseRegistration!: () => void;
		this.registrationTail = new Promise<void>((resolve) => { releaseRegistration = resolve; });
		let workspaceKey: string | undefined;
		let resolutionError: unknown;
		try {
			workspaceKey = await this.resolveWorkspaceKey(options.workspaceDir);
		} catch (error) {
			resolutionError = error;
		}
		await priorRegistration;
		if (resolutionError !== undefined) {
			releaseRegistration();
			throw resolutionError;
		}
		if (workspaceKey === undefined) {
			releaseRegistration();
			throw new Error("Workspace path resolution returned no path");
		}
		if (options.signal?.aborted) {
			releaseRegistration();
			throw abortReason(options.signal);
		}

		const inherited = this.scope
			.getStore()
			?.find((lease) => lease.active && lease.workspaceKey === workspaceKey);
		// Descendants of a writer remain inside that writer's exclusive scope.
		// Reader descendants may join their already-admitted reader cohort, but a
		// nested writer must still wait for every reader (including its parent).
		if (inherited && (inherited.mode === "team" || options.mode === "ordinary")) {
			releaseRegistration();
			return operation();
		}

		const admission = this.acquire(workspaceKey, options);
		releaseRegistration();
		const release = await admission;
		const lease: AdmissionLease = { workspaceKey, mode: options.mode, active: true };
		const parentScope = this.scope.getStore() ?? [];
		return this.scope.run([...parentScope, lease], async () => {
			try {
				return await operation();
			} finally {
				lease.active = false;
				release();
			}
		});
	}

	private stateFor(workspaceKey: string): WorkspaceState {
		let state = this.states.get(workspaceKey);
		if (!state) {
			state = {
				activeOrdinary: 0,
				activeTeam: false,
				ordinaryQueue: [],
				teamQueue: [],
			};
			this.states.set(workspaceKey, state);
		}
		return state;
	}

	private acquire(
		workspaceKey: string,
		options: WorkspaceAdmissionOptions,
	): Promise<() => void> {
		const state = this.stateFor(workspaceKey);
		if (this.canEnterImmediately(state, options.mode)) {
			return Promise.resolve(this.activate(workspaceKey, state, options.mode));
		}

		invokeHook(options.onWaitStart);
		return new Promise<() => void>((resolve, reject) => {
			const waiter: AdmissionWaiter = {
				mode: options.mode,
				resolve,
				reject,
				settled: false,
				...(options.signal ? { signal: options.signal } : {}),
				...(options.onWaitEnd ? { onWaitEnd: options.onWaitEnd } : {}),
			};
			const queue = options.mode === "team" ? state.teamQueue : state.ordinaryQueue;
			queue.push(waiter);

			if (options.signal) {
				waiter.onAbort = () => {
					if (waiter.settled) return;
					waiter.settled = true;
					const index = queue.indexOf(waiter);
					if (index >= 0) queue.splice(index, 1);
					invokeHook(waiter.onWaitEnd);
					waiter.reject(abortReason(options.signal!));
					this.drain(workspaceKey, state);
				};
				options.signal.addEventListener("abort", waiter.onAbort, { once: true });
				// Close the check/listener race without relying on event timing.
				if (options.signal.aborted) waiter.onAbort();
			}
		});
	}

	private canEnterImmediately(state: WorkspaceState, mode: WorkspaceAdmissionMode): boolean {
		if (mode === "team") {
			return !state.activeTeam && state.activeOrdinary === 0 && state.teamQueue.length === 0;
		}
		return !state.activeTeam && state.teamQueue.length === 0;
	}

	private activate(
		workspaceKey: string,
		state: WorkspaceState,
		mode: WorkspaceAdmissionMode,
	): () => void {
		if (mode === "team") state.activeTeam = true;
		else state.activeOrdinary += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (mode === "team") state.activeTeam = false;
			else state.activeOrdinary = Math.max(0, state.activeOrdinary - 1);
			this.drain(workspaceKey, state);
		};
	}

	private grant(
		workspaceKey: string,
		state: WorkspaceState,
		waiter: AdmissionWaiter,
	): void {
		if (waiter.settled) return;
		waiter.settled = true;
		if (waiter.signal && waiter.onAbort) {
			waiter.signal.removeEventListener("abort", waiter.onAbort);
		}
		// Mark the admission active before the lifecycle callback. Even though the
		// runtime hook is currently bookkeeping-only, a future hook must not be able
		// to synchronously admit a reader in the hand-off gap.
		const release = this.activate(workspaceKey, state, waiter.mode);
		invokeHook(waiter.onWaitEnd);
		waiter.resolve(release);
	}

	private drain(workspaceKey: string, state: WorkspaceState): void {
		if (state.activeTeam) return;
		if (state.teamQueue.length > 0) {
			if (state.activeOrdinary > 0) return;
			const waiter = state.teamQueue.shift();
			if (waiter) this.grant(workspaceKey, state, waiter);
			return;
		}

		while (state.ordinaryQueue.length > 0) {
			const waiter = state.ordinaryQueue.shift();
			if (waiter) this.grant(workspaceKey, state, waiter);
		}
		if (
			!state.activeTeam &&
			state.activeOrdinary === 0 &&
			state.teamQueue.length === 0 &&
			state.ordinaryQueue.length === 0
		) {
			this.states.delete(workspaceKey);
		}
	}
}
