// src/collaboration/coordinator.ts
//
// Store-driven Team Mode scheduler. It deliberately knows nothing about pi or
// WebSockets: a Brigade runtime adapter implements TeamTaskExecutor and maps one
// leased attempt to one agent turn. Durable state always changes in the store
// before UI delivery or best-effort process cancellation.

import { randomUUID } from "node:crypto";
import type { Artifact, AttemptUsage, RunId, TaskAttempt, TeamRun, TeamTask } from "./types.js";
import { CollaborationBudgetError, CollaborationConflictError } from "./types.js";
import type { CollaborationStore } from "./store.js";

export interface TeamExecutionContext {
	roomId: string;
	teamRunId: RunId;
	taskId: string;
	attemptId: string;
	runtimeRunId: string;
	leaseToken: string;
	fence: number;
}

export interface TeamTaskExecutionRequest {
	context: TeamExecutionContext;
	run: TeamRun;
	task: TeamTask;
	attempt: TaskAttempt;
	signal: AbortSignal;
}

export type TeamTaskExecutionResult =
	| {
			status: "succeeded";
			result?: unknown;
			usage?: Partial<AttemptUsage>;
			artifacts?: Array<Omit<Artifact, "id" | "runId" | "taskId" | "attemptId" | "createdAt"> & { id?: string }>;
	  }
	| {
			status: "failed";
			errorCode?: string;
			errorMessage: string;
			retryable?: boolean;
			usage?: Partial<AttemptUsage>;
	  };

/** Stable seam implemented by Brigade's existing session/agent loop adapter. */
export interface TeamTaskExecutor {
	execute(request: TeamTaskExecutionRequest): Promise<TeamTaskExecutionResult>;
	/** Optional best-effort process cancellation after durable cancellation/fencing. */
	cancel?(context: TeamExecutionContext, reason: string): Promise<void> | void;
}

export interface TeamCoordinatorOptions {
	store: CollaborationStore;
	executor: TeamTaskExecutor;
	workerId: string;
	leaseDurationMs?: number;
	leaseRenewIntervalMs?: number;
	executionTimeoutMs?: number;
	maxClaimsPerTick?: number;
	now?: () => number;
	commandId?: () => string;
}

export interface TeamCoordinatorTickOptions {
	runId?: RunId;
	agentId?: string;
	signal?: AbortSignal;
}

export interface AttemptDispatchResult {
	attemptId: string;
	taskId: string;
	status: "succeeded" | "failed" | "stale";
	error?: string;
}

export interface TeamCoordinatorTickResult {
	claimed: number;
	results: AttemptDispatchResult[];
	reconciledExpiredAttempts: string[];
}

export interface TeamCoordinatorRunResult {
	run: TeamRun;
	reason: "settled" | "idle" | "aborted" | "tick_limit";
	ticks: number;
}

function isStaleTransition(error: unknown): boolean {
	return error instanceof CollaborationConflictError && [
		"STALE_ATTEMPT",
		"FENCE_MISMATCH",
		"LEASE_EXPIRED",
		"INVALID_RUN_STATE",
	].includes(error.code);
}

function abortError(message: string): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

export class TeamCoordinator {
	private readonly store: CollaborationStore;
	private readonly executor: TeamTaskExecutor;
	private readonly workerId: string;
	private readonly leaseDurationMs: number;
	private readonly leaseRenewIntervalMs: number;
	private readonly executionTimeoutMs: number | undefined;
	private readonly maxClaimsPerTick: number;
	private readonly clock: () => number;
	private readonly nextCommandId: () => string;

	constructor(options: TeamCoordinatorOptions) {
		this.store = options.store;
		this.executor = options.executor;
		this.workerId = options.workerId;
		this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
		this.leaseRenewIntervalMs = options.leaseRenewIntervalMs ?? Math.max(1_000, Math.floor(this.leaseDurationMs / 3));
		this.executionTimeoutMs = options.executionTimeoutMs;
		this.maxClaimsPerTick = options.maxClaimsPerTick ?? 32;
		this.clock = options.now ?? Date.now;
		this.nextCommandId = options.commandId ?? randomUUID;
		if (!Number.isSafeInteger(this.leaseDurationMs) || this.leaseDurationMs <= 0) throw new Error("leaseDurationMs must be positive");
		if (!Number.isSafeInteger(this.leaseRenewIntervalMs) || this.leaseRenewIntervalMs <= 0) throw new Error("leaseRenewIntervalMs must be positive");
		if (this.leaseRenewIntervalMs >= this.leaseDurationMs) throw new Error("leaseRenewIntervalMs must be shorter than leaseDurationMs");
		if (this.executionTimeoutMs !== undefined && (!Number.isSafeInteger(this.executionTimeoutMs) || this.executionTimeoutMs <= 0)) {
			throw new Error("executionTimeoutMs must be positive");
		}
		if (!Number.isSafeInteger(this.maxClaimsPerTick) || this.maxClaimsPerTick <= 0) throw new Error("maxClaimsPerTick must be positive");
	}

	async startRun(runId: RunId): Promise<TeamRun> {
		return (await this.store.startRun({ commandId: this.nextCommandId(), runId, now: this.clock() })).value;
	}

	/** Reconcile expired leases and any terminal joins after a process restart. */
	async reconcile(): Promise<Awaited<ReturnType<CollaborationStore["reconcile"]>>["value"]> {
		return (await this.store.reconcile({ commandId: this.nextCommandId(), now: this.clock() })).value;
	}

	async tick(options: TeamCoordinatorTickOptions = {}): Promise<TeamCoordinatorTickResult> {
		const reconciliation = await this.reconcile();
		if (options.signal?.aborted) {
			return { claimed: 0, results: [], reconciledExpiredAttempts: reconciliation.expiredAttempts };
		}

		const claimed: TaskAttempt[] = [];
		for (let index = 0; index < this.maxClaimsPerTick; index += 1) {
			if (options.signal?.aborted) break;
			const runtimeRunId = randomUUID();
			try {
				const result = await this.store.claimReadyTask({
					commandId: this.nextCommandId(),
					now: this.clock(),
					workerId: this.workerId,
					leaseDurationMs: this.leaseDurationMs,
					runtimeRunId,
					...(options.runId ? { runId: options.runId } : {}),
					...(options.agentId ? { agentId: options.agentId } : {}),
				});
				if (!result.value) break;
				claimed.push(result.value);
			} catch (error) {
				if (error instanceof CollaborationBudgetError && error.reason === "concurrency") break;
				throw error;
			}
		}

		const results = await Promise.all(claimed.map((attempt) => this.executeAttempt(attempt, options.signal)));
		await this.reconcile();
		return {
			claimed: claimed.length,
			results,
			reconciledExpiredAttempts: reconciliation.expiredAttempts,
		};
	}

	private async executeAttempt(attempt: TaskAttempt, parentSignal?: AbortSignal): Promise<AttemptDispatchResult> {
		const task = await this.store.getTask(attempt.taskId);
		const run = await this.store.getRun(attempt.runId);
		if (!task || !run) return { attemptId: attempt.id, taskId: attempt.taskId, status: "stale", error: "task or run disappeared" };
		const room = await this.store.getRoom(run.roomId);
		if (!room) return { attemptId: attempt.id, taskId: task.id, status: "stale", error: "room disappeared" };

		const context: TeamExecutionContext = {
			roomId: room.id,
			teamRunId: run.id,
			taskId: task.id,
			attemptId: attempt.id,
			runtimeRunId: attempt.runtimeRunId ?? randomUUID(),
			leaseToken: attempt.lease.token,
			fence: attempt.lease.fence,
		};
		const controller = new AbortController();
		const onParentAbort = (): void => controller.abort(parentSignal?.reason ?? abortError("coordinator aborted"));
		if (parentSignal?.aborted) onParentAbort();
		else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
		const onExecutionAbort = (): void => {
			void Promise.resolve().then(() =>
				this.executor.cancel?.(
					context,
					controller.signal.reason instanceof Error
						? controller.signal.reason.message
						: "team task execution aborted",
				),
			).catch(() => undefined);
		};
		controller.signal.addEventListener("abort", onExecutionAbort, { once: true });

		let stopped = false;
		let renewTimer: ReturnType<typeof setTimeout> | undefined;
		const scheduleRenewal = (): void => {
			if (stopped) return;
			renewTimer = setTimeout(() => {
				void this.store.renewAttemptLease({
					commandId: this.nextCommandId(),
					now: this.clock(),
					attemptId: attempt.id,
					leaseToken: attempt.lease.token,
					fence: attempt.lease.fence,
					leaseDurationMs: this.leaseDurationMs,
				}).then(
					() => scheduleRenewal(),
					(error: unknown) => controller.abort(error),
				);
			}, this.leaseRenewIntervalMs);
			renewTimer.unref?.();
		};
		scheduleRenewal();

		let timeout: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = this.executionTimeoutMs === undefined
			? undefined
			: new Promise<TeamTaskExecutionResult>((resolve) => {
				timeout = setTimeout(() => {
					controller.abort(abortError("team task execution timed out"));
					resolve({ status: "failed", errorCode: "EXECUTION_TIMEOUT", errorMessage: "team task execution timed out", retryable: true });
				}, this.executionTimeoutMs);
				timeout.unref?.();
			});

		try {
			const execution = Promise.resolve()
				.then(() => this.executor.execute({ context, run, task, attempt, signal: controller.signal }))
				.catch((error: unknown): TeamTaskExecutionResult => ({
					status: "failed",
					errorCode: controller.signal.aborted ? "EXECUTION_ABORTED" : "EXECUTOR_ERROR",
					errorMessage: error instanceof Error ? error.message : String(error),
					retryable: !parentSignal?.aborted,
				}));
			const outcome = timeoutPromise ? await Promise.race([execution, timeoutPromise]) : await execution;
			stopped = true;
			if (renewTimer) clearTimeout(renewTimer);
			if (timeout) clearTimeout(timeout);

			try {
				if (outcome.status === "succeeded") {
					const completion = await this.store.completeAttempt({
						commandId: this.nextCommandId(),
						now: this.clock(),
						attemptId: attempt.id,
						leaseToken: attempt.lease.token,
						fence: attempt.lease.fence,
						...(outcome.result !== undefined ? { result: outcome.result } : {}),
						...(outcome.usage ? { usage: outcome.usage } : {}),
						...(outcome.artifacts ? { artifacts: outcome.artifacts } : {}),
					});
					if (completion.value.status === "failed") {
						return {
							attemptId: attempt.id,
							taskId: task.id,
							status: "failed",
							error: completion.value.errorMessage,
						};
					}
					return { attemptId: attempt.id, taskId: task.id, status: "succeeded" };
				}
				const retryable = outcome.retryable === undefined
					? undefined
					: outcome.retryable && (
						task.retry.retryableCodes === undefined ||
						(outcome.errorCode !== undefined && task.retry.retryableCodes.includes(outcome.errorCode))
					);
				await this.store.failAttempt({
					commandId: this.nextCommandId(),
					now: this.clock(),
					attemptId: attempt.id,
					leaseToken: attempt.lease.token,
					fence: attempt.lease.fence,
					...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
					errorMessage: outcome.errorMessage,
					...(outcome.usage ? { usage: outcome.usage } : {}),
					...(retryable !== undefined ? { retryable } : {}),
				});
				return { attemptId: attempt.id, taskId: task.id, status: "failed", error: outcome.errorMessage };
			} catch (error) {
				if (isStaleTransition(error)) {
					return { attemptId: attempt.id, taskId: task.id, status: "stale", error: error instanceof Error ? error.message : String(error) };
				}
				throw error;
			}
		} finally {
			stopped = true;
			if (renewTimer) clearTimeout(renewTimer);
			if (timeout) clearTimeout(timeout);
			parentSignal?.removeEventListener("abort", onParentAbort);
			controller.signal.removeEventListener("abort", onExecutionAbort);
		}
	}

	/**
	 * Drive ready work until the run settles or reaches a durable waiting state
	 * (approval, handoff, delayed retry, or no currently claimable task).
	 */
	async runUntilIdle(
		runId: RunId,
		options: { signal?: AbortSignal; maxTicks?: number } = {},
	): Promise<TeamCoordinatorRunResult> {
		const maxTicks = options.maxTicks ?? 1_000;
		for (let ticks = 0; ticks < maxTicks; ticks += 1) {
			const run = await this.store.getRun(runId);
			if (!run) throw new Error(`run not found: ${runId}`);
			if (["completed", "failed", "cancelled"].includes(run.status)) return { run, reason: "settled", ticks };
			if (options.signal?.aborted) return { run, reason: "aborted", ticks };
			const tick = await this.tick({ runId, ...(options.signal ? { signal: options.signal } : {}) });
			if (tick.claimed === 0) {
				const current = await this.store.getRun(runId);
				if (!current) throw new Error(`run not found: ${runId}`);
				return {
					run: current,
					reason: ["completed", "failed", "cancelled"].includes(current.status) ? "settled" : "idle",
					ticks: ticks + 1,
				};
			}
		}
		const run = await this.store.getRun(runId);
		if (!run) throw new Error(`run not found: ${runId}`);
		return { run, reason: "tick_limit", ticks: maxTicks };
	}
}
