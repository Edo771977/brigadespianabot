// src/collaboration/runtime-service.ts
//
// Production Team scheduler. This is transport- and agent-SDK-neutral: the
// gateway injects one narrow turn callback and one optional durable-event
// publisher. The collaboration store remains the authority for every claim,
// budget, cancellation and completion transition.

import { randomUUID } from "node:crypto";
import type { CollaborationStore, CollaborationStoreSnapshot } from "./store.js";
import {
	CollaborationBudgetError,
	CollaborationConflictError,
	CollaborationDomainError,
	type CollaborationEvent,
	type TaskAttempt,
	type TeamRun,
	type TeamTask,
} from "./types.js";
import {
	createActiveTeamExecutionContext,
	runWithTeamExecutionContext,
	type ActiveTeamExecutionIdentifiers,
} from "./execution-context.js";
import { buildTeamAttemptSessionKey } from "./session-key.js";
import { buildTeamTaskPrompt, visibleArtifactsForTask } from "./task-prompt.js";
import { sanitizeTeamResult } from "./result-sanitize.js";

export type TeamRuntimeProgressKind =
	| "assistant.delta"
	| "thinking.delta"
	| "tool.started"
	| "tool.updated"
	| "tool.finished"
	| "attempt.heartbeat";

export interface TeamTurnProgressInput {
	kind: TeamRuntimeProgressKind;
	payload: Record<string, unknown>;
}

export interface TeamRuntimeProgress extends TeamTurnProgressInput {
	progressId: string;
	roomId: string;
	runId: string;
	taskId: string;
	attemptId: string;
	agentId: string;
	progressSeq: number;
	emittedAt: number;
}

export interface TeamTurnRunnerRequest {
	agentId: string;
	sessionKey: string;
	prompt: string;
	executionContext: ActiveTeamExecutionIdentifiers;
	signal: AbortSignal;
	/** Pause active-model time while the gateway waits for exclusive workspace access. */
	onAdmissionWaitStart(): void;
	/** Resume active-model time after workspace admission or an aborted wait. */
	onAdmissionWaitEnd(): void;
	/** Await this callback to preserve monotonic per-attempt delivery order. */
	onProgress(progress: TeamTurnProgressInput): Promise<void>;
}

export interface TeamTurnRunnerResult {
	reply: string;
	usage?: { tokens: number; costUsd: number; costComplete?: boolean };
}

/** Narrow adapter implemented by the existing Brigade turn runner. */
export type TeamTurnRunner = (request: TeamTurnRunnerRequest) => Promise<TeamTurnRunnerResult>;

export interface TeamOutboxPublisher {
	publish(event: CollaborationEvent, signal: AbortSignal): Promise<void>;
}

export interface TeamRuntimeServiceOptions {
	store: CollaborationStore;
	runTurn: TeamTurnRunner;
	workerId: string;
	globalConcurrency?: number;
	leaseDurationMs?: number;
	leaseRenewIntervalMs?: number;
	taskTimeoutMs?: number;
	idlePollMs?: number;
	outboxPublisher?: TeamOutboxPublisher;
	outboxBatchSize?: number;
	outboxLeaseMs?: number;
	outboxBackoffBaseMs?: number;
	outboxBackoffMaxMs?: number;
	outboxMaxAttempts?: number;
	defaultAgentId?: string;
	resolveAgentId?: (task: TeamTask, run: TeamRun) => string;
	/** Required availability check prevents a syntactically valid but unknown
	 * assignment from falling through to a gateway's default agent. */
	validateAgentId: (agentId: string) => boolean | Promise<boolean>;
	onProgress?: (progress: TeamRuntimeProgress) => Promise<void> | void;
	now?: () => number;
	commandId?: () => string;
}

export interface ActiveTeamAttemptInfo extends ActiveTeamExecutionIdentifiers {
	sessionKey: string;
	startedAt: number;
	paused: boolean;
}

type AbortDisposition = "durable-cancel" | "lease-lost" | "shutdown" | "timeout" | "aborted";

interface ActiveAttempt {
	attempt: TaskAttempt;
	identifiers: ActiveTeamExecutionIdentifiers;
	sessionKey: string;
	/** Agent admission slot. Separate from the attempt transcript key so
	 * retries, tasks, and rooms never let one agent mutate the same workspace
	 * concurrently inside this runtime. */
	reservationKey: string;
	controller: AbortController;
	abortDisposition?: AbortDisposition;
	progressSeq: number;
	progressTail: Promise<void>;
	paused: boolean;
	promise: Promise<void>;
}

function teamAgentReservationKey(agentId: string): string {
	return `agent:${agentId}`;
}

class PausableDeadline {
	private remainingMs: number;
	private activeSince = Date.now();
	private pauses = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private done = false;

	constructor(
		durationMs: number,
		private readonly onExpire: () => void,
	) {
		this.remainingMs = durationMs;
		this.arm();
	}

	private arm(): void {
		if (this.done || this.pauses > 0) return;
		this.activeSince = Date.now();
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.done = true;
			this.remainingMs = 0;
			this.onExpire();
		}, Math.max(1, this.remainingMs));
		this.timer.unref?.();
	}

	pause(): void {
		if (this.done) return;
		this.pauses += 1;
		if (this.pauses !== 1) return;
		this.remainingMs = Math.max(0, this.remainingMs - (Date.now() - this.activeSince));
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	resume(): void {
		if (this.done || this.pauses === 0) return;
		this.pauses -= 1;
		if (this.pauses === 0) this.arm();
	}

	cancel(): void {
		this.done = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}

function positiveInt(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
	return value;
}

function staleAttemptError(error: unknown): boolean {
	return error instanceof CollaborationConflictError && [
		"STALE_ATTEMPT",
		"FENCE_MISMATCH",
		"LEASE_EXPIRED",
		"INVALID_RUN_STATE",
	].includes(error.code);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function makeAbortError(message: string): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

function waitForAbortOrDelay(signal: AbortSignal, delayMs: number): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => {
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal.removeEventListener("abort", finish);
			resolve();
		};
		const timer = setTimeout(finish, delayMs);
		signal.addEventListener("abort", finish, { once: true });
		// AbortSignal does not replay an abort that happens immediately before a
		// listener is attached. Close that narrow race explicitly.
		if (signal.aborted) finish();
	});
}

const LIVE_RUNTIME_ATTEMPT_STATUSES = new Set<TaskAttempt["status"]>([
	"running",
	"waiting_approval",
]);

const UNKNOWN_TURN_USAGE = { tokens: 0, costUsd: 0, costComplete: false } as const;

function decisionAlreadySettled(error: unknown): boolean {
	return error instanceof CollaborationConflictError && [
		"HANDOFF_RESOLVED",
		"APPROVAL_RESOLVED",
	].includes(error.code);
}

function runHasBudgetWork(run: TeamRun, now: number): boolean {
	if (run.status !== "running") return false;
	if (run.budgets.maxTokens !== undefined && run.usage.tokens >= run.budgets.maxTokens) return true;
	if (run.budgets.maxCostUsd !== undefined && run.usage.costComplete === false) return true;
	if (run.budgets.maxCostUsd !== undefined && run.usage.costUsd >= run.budgets.maxCostUsd) return true;
	return run.budgets.maxDurationMs !== undefined &&
		run.startedAt !== undefined &&
		now - run.startedAt >= run.budgets.maxDurationMs;
}

function snapshotNeedsReconciliation(snapshot: CollaborationStoreSnapshot, now: number): boolean {
	if (snapshot.attempts.some((attempt) =>
		LIVE_RUNTIME_ATTEMPT_STATUSES.has(attempt.status) && attempt.lease.expiresAt <= now
	)) return true;
	if (snapshot.handoffs.some((handoff) =>
		handoff.status === "offered" && handoff.expiresAt !== undefined && handoff.expiresAt <= now
	)) return true;
	if (snapshot.approvals.some((approval) =>
		approval.status === "pending" && approval.expiresAt !== undefined && approval.expiresAt <= now
	)) return true;
	if (snapshot.attempts.some((attempt) =>
		!LIVE_RUNTIME_ATTEMPT_STATUSES.has(attempt.status) &&
		attempt.usageRecorded !== true &&
		(attempt.usageDueAt ?? attempt.lease.expiresAt) <= now
	)) return true;
	return snapshot.runs.some((run) => runHasBudgetWork(run, now));
}

function snapshotHasClaimableTask(snapshot: CollaborationStoreSnapshot, now: number): boolean {
	const runs = new Map(snapshot.runs.map((run) => [run.id, run]));
	return snapshot.tasks.some((task) => {
		if (task.status !== "ready" || (task.nextAttemptAt ?? 0) > now) return false;
		const run = runs.get(task.runId);
		if (!run || run.status !== "running" || runHasBudgetWork(run, now)) return false;
		if (run.budgets.maxAttempts !== undefined && run.usage.attempts >= run.budgets.maxAttempts) return false;
		return run.budgets.maxConcurrency === undefined ||
			run.usage.activeAttempts < run.budgets.maxConcurrency;
	});
}

function compareClaimCandidates(a: TeamTask, b: TeamTask): number {
	return b.priority - a.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

function snapshotHasClaimableOutbox(snapshot: CollaborationStoreSnapshot, now: number): boolean {
	const rows = snapshot.outbox;
	return rows.some((item) => {
		const eligible =
			(item.status === "pending" && item.nextAttemptAt <= now) ||
			(item.status === "claimed" && (item.claimExpiresAt ?? 0) <= now);
		if (!eligible) return false;
		return !rows.some((prior) =>
			prior.event.roomId === item.event.roomId &&
			prior.event.roomSeq < item.event.roomSeq &&
			prior.status !== "acked" &&
			prior.status !== "dead"
		);
	});
}

/** A handoff acceptance or negative approval is first observed inside the
 * blocking `team_task` call that created it. Let that call return to the agent
 * loop so the provider turn can settle and report its real usage. The durable
 * fence already prevents the old attempt from mutating or completing the task,
 * and the normal active-time deadline still bounds a runner that fails to
 * unwind. External cancellation and every other terminal transition abort
 * immediately. */
function expectsTerminalToolSettlement(attempt: TaskAttempt | undefined): boolean {
	return attempt?.status === "handed_off" || (
		attempt?.status === "failed" &&
		(attempt.errorCode === "APPROVAL_REJECTED" || attempt.errorCode === "APPROVAL_EXPIRED")
	);
}

export class TeamRuntimeService {
	private readonly store: CollaborationStore;
	private readonly runTurn: TeamTurnRunner;
	private readonly workerId: string;
	private readonly globalConcurrency: number;
	private readonly leaseDurationMs: number;
	private readonly leaseRenewIntervalMs: number;
	private readonly taskTimeoutMs: number | undefined;
	private readonly idlePollMs: number;
	private readonly outboxPublisher: TeamOutboxPublisher | undefined;
	private readonly outboxBatchSize: number;
	private readonly outboxLeaseMs: number;
	private readonly outboxBackoffBaseMs: number;
	private readonly outboxBackoffMaxMs: number;
	private readonly outboxMaxAttempts: number;
	private readonly resolveAgent: (task: TeamTask, run: TeamRun) => string;
	private readonly validateAgent: TeamRuntimeServiceOptions["validateAgentId"];
	private readonly progressHandler: TeamRuntimeServiceOptions["onProgress"];
	private readonly clock: () => number;
	private readonly nextCommandId: () => string;
	private readonly active = new Map<string, ActiveAttempt>();
	private readonly busySessions = new Set<string>();
	private readonly lateSettlements = new Set<Promise<void>>();
	private readonly stopController = new AbortController();
	private stopped = false;
	private startupReconciled = false;
	private startPromise: Promise<void> | undefined;
	private pumpPromise: Promise<void> | undefined;
	private pumpAgain = false;
	private outboxPumpPromise: Promise<void> | undefined;
	private outboxPumpAgain = false;
	private idleTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(options: TeamRuntimeServiceOptions) {
		this.store = options.store;
		this.runTurn = options.runTurn;
		this.workerId = options.workerId;
		this.globalConcurrency = positiveInt(options.globalConcurrency ?? 8, "globalConcurrency");
		this.leaseDurationMs = positiveInt(options.leaseDurationMs ?? 30_000, "leaseDurationMs");
		this.leaseRenewIntervalMs = positiveInt(
			options.leaseRenewIntervalMs ?? Math.max(1_000, Math.floor(this.leaseDurationMs / 3)),
			"leaseRenewIntervalMs",
		);
		if (this.leaseRenewIntervalMs >= this.leaseDurationMs) throw new Error("leaseRenewIntervalMs must be shorter than leaseDurationMs");
		this.taskTimeoutMs = options.taskTimeoutMs === undefined ? undefined : positiveInt(options.taskTimeoutMs, "taskTimeoutMs");
		this.idlePollMs = positiveInt(options.idlePollMs ?? 1_000, "idlePollMs");
		this.outboxPublisher = options.outboxPublisher;
		this.outboxBatchSize = positiveInt(options.outboxBatchSize ?? 100, "outboxBatchSize");
		this.outboxLeaseMs = positiveInt(options.outboxLeaseMs ?? 30_000, "outboxLeaseMs");
		this.outboxBackoffBaseMs = positiveInt(options.outboxBackoffBaseMs ?? 1_000, "outboxBackoffBaseMs");
		this.outboxBackoffMaxMs = positiveInt(options.outboxBackoffMaxMs ?? 60_000, "outboxBackoffMaxMs");
		this.outboxMaxAttempts = positiveInt(options.outboxMaxAttempts ?? 10, "outboxMaxAttempts");
		const defaultAgentId = options.defaultAgentId ?? "main";
		this.resolveAgent = options.resolveAgentId ?? ((task) => task.assignedAgentId ?? defaultAgentId);
		this.validateAgent = options.validateAgentId;
		this.progressHandler = options.onProgress;
		this.clock = options.now ?? Date.now;
		this.nextCommandId = options.commandId ?? randomUUID;
	}

	async start(): Promise<void> {
		if (this.stopped) throw new Error("TeamRuntimeService has been stopped");
		if (this.startPromise) return this.startPromise;
		this.startPromise = this.kick().catch((error: unknown) => {
			this.startPromise = undefined;
			throw error;
		});
		return this.startPromise;
	}

	/** Coalesces any number of concurrent wakeups into one non-overlapping pump. */
	async kick(): Promise<void> {
		if (this.stopped) return;
		this.pumpAgain = true;
		if (!this.pumpPromise) {
			this.pumpPromise = this.runPump().finally(() => {
				this.pumpPromise = undefined;
				if (this.pumpAgain && !this.stopped) void this.kick().catch(() => this.scheduleIdlePoll());
			});
		}
		return this.pumpPromise;
	}

	private async runPump(): Promise<void> {
		while (this.pumpAgain && !this.stopped) {
			this.pumpAgain = false;
			await this.pumpOnce();
		}
	}

	private async pumpOnce(): Promise<void> {
		await this.syncDurableCancellations();
		let snapshot = await this.store.readSnapshot();
		const now = this.clock();
		if (!this.startupReconciled || snapshotNeedsReconciliation(snapshot, now)) {
			await this.store.reconcile({ commandId: this.nextCommandId(), now });
			this.startupReconciled = true;
			snapshot = await this.store.readSnapshot();
		}
		await this.settleOrphanDecisions(snapshot);
		await this.syncDurableCancellations();

		while (!this.stopped && this.active.size < this.globalConcurrency) {
			snapshot = await this.store.readSnapshot();
			if (!snapshotHasClaimableTask(snapshot, this.clock())) break;
			const plan = this.findClaimPlan(snapshot, this.clock());
			if (!plan) break;
			try {
				const claimed = await this.store.claimReadyTask({
					commandId: this.nextCommandId(),
					now: this.clock(),
					workerId: this.workerId,
					leaseDurationMs: this.leaseDurationMs,
					runtimeRunId: randomUUID(),
					runId: plan.runId,
					taskId: plan.taskId,
					...(plan.agentIdFilter ? { agentId: plan.agentIdFilter } : {}),
				});
				if (!claimed.value) break;
				this.launch(claimed.value, this.resolvePlannedIdentity(snapshot, claimed.value));
			} catch (error) {
				if (error instanceof CollaborationBudgetError && error.reason === "concurrency") break;
				throw error;
			}
		}

		this.kickOutboxPump();
		this.scheduleIdlePoll();
	}

	/** Delivery can include a coordinator model turn. Keep it outside the task
	 * scheduler so an old outbox row cannot delay gateway readiness or claims. */
	private kickOutboxPump(): void {
		if (!this.outboxPublisher || this.stopped) return;
		this.outboxPumpAgain = true;
		if (this.outboxPumpPromise) return;
		this.outboxPumpPromise = (async () => {
			while (this.outboxPumpAgain && !this.stopped) {
				this.outboxPumpAgain = false;
				await this.drainOutbox();
			}
		})().finally(() => {
			this.outboxPumpPromise = undefined;
			if (this.outboxPumpAgain && !this.stopped) this.kickOutboxPump();
		});
		void this.outboxPumpPromise.catch(() => this.scheduleIdlePoll());
	}

	/** Choose an exact durable task claim whose resolved agent is not already
	 * reserved by this process. The authority revalidates both task and agent
	 * atomically, so snapshot drift cannot redirect the claim to another task. */
	private findClaimPlan(
		snapshot: CollaborationStoreSnapshot,
		now: number,
	): { runId: string; taskId: string; agentIdFilter?: string } | undefined {
		const runs = new Map(snapshot.runs.map((run) => [run.id, run]));
		const reserved = new Set(
			[...this.active.values()]
				.map((active) => active.reservationKey)
				.filter((reservationKey) => reservationKey.length > 0),
		);
		const candidates = snapshot.tasks.filter((task) => {
			if (task.status !== "ready" || (task.nextAttemptAt ?? 0) > now) return false;
			const run = runs.get(task.runId);
			if (!run || run.status !== "running" || runHasBudgetWork(run, now)) return false;
			if (run.budgets.maxAttempts !== undefined && run.usage.attempts >= run.budgets.maxAttempts) return false;
			return run.budgets.maxConcurrency === undefined || run.usage.activeAttempts < run.budgets.maxConcurrency;
		}).sort(compareClaimCandidates);
		for (const task of candidates) {
			const run = runs.get(task.runId)!;
			let agentId: string;
			try {
				agentId = this.resolveAgent(task, run);
			} catch {
				// Claim the invalid task so execute() can terminalize it instead of
				// leaving it as a permanent scheduler head-of-line blocker.
				return { runId: task.runId, taskId: task.id, ...(task.assignedAgentId ? { agentIdFilter: task.assignedAgentId } : {}) };
			}
			if (reserved.has(teamAgentReservationKey(agentId))) continue;
			return {
				runId: task.runId,
				taskId: task.id,
				agentIdFilter: agentId,
			};
		}
		return undefined;
	}

	private resolvePlannedIdentity(
		snapshot: CollaborationStoreSnapshot,
		attempt: TaskAttempt,
	): { roomId: string; agentId: string; sessionKey: string; reservationKey: string } | undefined {
		const task = snapshot.tasks.find((candidate) => candidate.id === attempt.taskId);
		const run = snapshot.runs.find((candidate) => candidate.id === attempt.runId);
		if (!task || !run) return undefined;
		try {
			const agentId = attempt.agentId ?? this.resolveAgent(task, run);
			return {
				roomId: run.roomId,
				agentId,
				sessionKey: buildTeamAttemptSessionKey(run.roomId, agentId, attempt.id),
				reservationKey: teamAgentReservationKey(agentId),
			};
		} catch {
			return undefined;
		}
	}

	/** Close decisions whose source attempt became terminal during cancellation,
	 * lease expiry, or a previous-process crash. The current store contract has
	 * no separate system-cancel command, so a system rejection is the only
	 * terminal transition that is atomic and adapter-portable. */
	private async settleOrphanDecisions(snapshot: CollaborationStoreSnapshot): Promise<void> {
		const attempts = new Map(snapshot.attempts.map((attempt) => [attempt.id, attempt]));
		for (const handoff of snapshot.handoffs) {
			const source = attempts.get(handoff.fromAttemptId);
			if (handoff.status !== "offered" || !source || LIVE_RUNTIME_ATTEMPT_STATUSES.has(source.status)) continue;
			try {
				await this.store.rejectHandoff({
					commandId: this.nextCommandId(),
					now: this.clock(),
					handoffId: handoff.id,
					respondingAgentId: handoff.toAgentId,
					reason: `source attempt ${source.status}`,
				});
			} catch (error) {
				if (!decisionAlreadySettled(error)) throw error;
			}
		}
		for (const approval of snapshot.approvals) {
			const source = attempts.get(approval.attemptId);
			if (approval.status !== "pending" || !source || LIVE_RUNTIME_ATTEMPT_STATUSES.has(source.status)) continue;
			try {
				await this.store.resolveApproval({
					commandId: this.nextCommandId(),
					now: this.clock(),
					approvalId: approval.id,
					decision: "rejected",
					resolution: `source attempt ${source.status}`,
				});
			} catch (error) {
				if (!decisionAlreadySettled(error)) throw error;
			}
		}
	}

	private launch(
		attempt: TaskAttempt,
		planned?: { roomId: string; agentId: string; sessionKey: string; reservationKey: string },
	): void {
		const controller = new AbortController();
		const placeholder = Promise.resolve();
		const active: ActiveAttempt = {
			attempt,
			identifiers: {
				roomId: planned?.roomId ?? "",
				runId: attempt.runId,
				taskId: attempt.taskId,
				attemptId: attempt.id,
				agentId: planned?.agentId ?? "",
				sessionKey: planned?.sessionKey ?? "",
				runtimeRunId: attempt.runtimeRunId ?? randomUUID(),
			},
			sessionKey: planned?.sessionKey ?? "",
			reservationKey: planned?.reservationKey ?? "",
			controller,
			progressSeq: 0,
			progressTail: Promise.resolve(),
			paused: false,
			promise: placeholder,
		};
		this.active.set(attempt.id, active);
		active.promise = this.execute(active).catch(async (error: unknown) => {
			// A claimed attempt must never be abandoned because prompt/session/agent
			// preflight failed. Domain/config defects are non-retryable; transient
			// adapter failures may use the task's normal retry policy.
			await this.failActive(
				active,
				"RUNTIME_PREFLIGHT_ERROR",
				errorMessage(error),
				!(error instanceof CollaborationDomainError),
			).catch(() => undefined);
		}).finally(() => {
			this.active.delete(attempt.id);
			void this.kick().catch(() => this.scheduleIdlePoll());
		});
	}

	private async execute(active: ActiveAttempt): Promise<void> {
		const task = await this.store.getTask(active.attempt.taskId);
		const run = await this.store.getRun(active.attempt.runId);
		if (!task || !run) throw new CollaborationConflictError("RUNTIME_PREFLIGHT_MISSING", "claimed task or run disappeared");
		const snapshot = await this.store.readRunSnapshot(run.id);
		if (!snapshot) throw new CollaborationConflictError("RUNTIME_PREFLIGHT_MISSING", "run snapshot disappeared");
		const agentId = active.attempt.agentId ?? this.resolveAgent(task, run);
		if (!(await this.validateAgent(agentId))) {
			throw new CollaborationConflictError("UNKNOWN_AGENT", `Team task is assigned to unknown agent: ${agentId}`);
		}
		if (!snapshot.room.members.some((member) => member.agentId === agentId)) {
			throw new CollaborationConflictError(
				"AGENT_NOT_IN_ROOM",
				`Team task agent ${agentId} is not a member of room ${snapshot.room.id}`,
			);
		}
		const sessionKey = buildTeamAttemptSessionKey(run.roomId, agentId, active.attempt.id);
		const reservationKey = teamAgentReservationKey(agentId);
		active.sessionKey = sessionKey;
		active.reservationKey = reservationKey;
		active.identifiers = {
			roomId: run.roomId,
			runId: run.id,
			taskId: task.id,
			attemptId: active.attempt.id,
			agentId,
			sessionKey,
			runtimeRunId: active.attempt.runtimeRunId ?? active.identifiers.runtimeRunId,
		};
		const dependencyIds = new Set(task.dependencies.map(({ taskId }) => taskId));
		for (const candidate of snapshot.tasks) {
			if (candidate.parentTaskId === task.id) dependencyIds.add(candidate.id);
		}
		const dependencies = [...dependencyIds]
			.map((taskId) => snapshot.tasks.find((candidate) => candidate.id === taskId))
			.filter((candidate): candidate is TeamTask => candidate !== undefined);
		const prompt = buildTeamTaskPrompt({
			identifiers: active.identifiers,
			run,
			task,
			attempt: active.attempt,
			dependencies,
			artifacts: visibleArtifactsForTask(snapshot.artifacts, task, dependencyIds),
		});

		const abortPromise = new Promise<{ kind: "aborted" }>((resolve) => {
			active.controller.signal.addEventListener("abort", () => resolve({ kind: "aborted" }), { once: true });
		});
		const deadline = this.taskTimeoutMs === undefined
			? undefined
			: new PausableDeadline(this.taskTimeoutMs, () => {
				active.abortDisposition = "timeout";
				active.controller.abort(makeAbortError("Team task execution timed out"));
			});
		let contextPauseDepth = 0;
		let admissionPauseDepth = 0;
		let storePaused = false;
		const setPaused = (paused: boolean): void => {
			active.paused = paused;
		};
		const refreshPaused = (): void => {
			setPaused(contextPauseDepth > 0 || admissionPauseDepth > 0 || storePaused);
		};
		const context = createActiveTeamExecutionContext({
			store: this.store,
			identifiers: active.identifiers,
			leaseToken: active.attempt.lease.token,
			fence: active.attempt.lease.fence,
			validateAgentId: this.validateAgent,
			now: this.clock,
			commandId: this.nextCommandId,
			onWaitStart: () => {
				contextPauseDepth += 1;
				deadline?.pause();
				refreshPaused();
				void this.kick().catch(() => this.scheduleIdlePoll());
			},
				onWaitEnd: () => {
					contextPauseDepth = Math.max(0, contextPauseDepth - 1);
					deadline?.resume();
					refreshPaused();
					void this.kick().catch(() => this.scheduleIdlePoll());
				},
				onTerminalDecision: (kind, outcome) => {
					this.abortActive(
						active,
						"durable-cancel",
						`Team ${kind} ${outcome}; this attempt may no longer perform workspace work`,
					);
				},
			});

		let renewTimer: ReturnType<typeof setTimeout> | undefined;
		let renewalStopped = false;
		const scheduleRenewal = (): void => {
			if (renewalStopped || active.controller.signal.aborted) return;
			renewTimer = setTimeout(() => {
				void this.store.renewAttemptLease({
					commandId: this.nextCommandId(),
					now: this.clock(),
					attemptId: active.attempt.id,
					leaseToken: active.attempt.lease.token,
					fence: active.attempt.lease.fence,
					leaseDurationMs: this.leaseDurationMs,
				}).then((renewed) => {
					const waiting = renewed.value.status === "waiting_approval";
					if (waiting && !storePaused) {
						storePaused = true;
						deadline?.pause();
					} else if (!waiting && storePaused) {
						storePaused = false;
						deadline?.resume();
					}
					refreshPaused();
					void this.emitProgress(active, {
						kind: "attempt.heartbeat",
						payload: { leaseExpiresAt: renewed.value.lease.expiresAt },
					});
					scheduleRenewal();
				}, (error: unknown) => {
					void this.store.getAttempt(active.attempt.id).then((current) => {
						// Accepted handoffs and negative approvals intentionally let the
						// tool/provider turn unwind so its usage can be attributed. A
						// renewal racing that terminal transition must not undo that rule.
						if (expectsTerminalToolSettlement(current)) {
							renewalStopped = true;
							return;
						}
						active.abortDisposition = "lease-lost";
						active.controller.abort(error);
					}, () => {
						active.abortDisposition = "lease-lost";
						active.controller.abort(error);
					});
				});
			}, this.leaseRenewIntervalMs);
			renewTimer.unref?.();
		};
		scheduleRenewal();
		const releaseSession = await this.acquireSession(active, deadline, () => {
			refreshPaused();
		});
		if (!releaseSession) {
			renewalStopped = true;
			if (renewTimer) clearTimeout(renewTimer);
			deadline?.cancel();
			return;
		}

		const runnerPromise = Promise.resolve().then(() => runWithTeamExecutionContext(context, () => this.runTurn({
			agentId,
			sessionKey,
			prompt,
			executionContext: active.identifiers,
			signal: active.controller.signal,
			onAdmissionWaitStart: () => {
				admissionPauseDepth += 1;
				deadline?.pause();
				refreshPaused();
			},
			onAdmissionWaitEnd: () => {
				admissionPauseDepth = Math.max(0, admissionPauseDepth - 1);
				deadline?.resume();
				refreshPaused();
			},
			onProgress: (progress) => this.emitProgress(active, progress),
	}))).then(
			(result) => ({ kind: "result" as const, result }),
			(error: unknown) => ({ kind: "error" as const, error }),
		);

		try {
			const settled = await Promise.race([runnerPromise, abortPromise]);
			if (settled.kind === "aborted") {
				renewalStopped = true;
				if (renewTimer) clearTimeout(renewTimer);
				deadline?.cancel();
				// A cooperative runner can settle in the same turn of the event loop
				// as cancellation. Preserve any usage it reports, but never use its
				// reply to change the already-terminal task.
				const lateSettlement = await Promise.race([
					runnerPromise,
					new Promise<{ kind: "grace-expired" }>((resolve) => {
						setTimeout(() => resolve({ kind: "grace-expired" }), 250);
					}),
				]);
				if (active.abortDisposition === "timeout") {
					await this.failActive(
						active,
						"EXECUTION_TIMEOUT",
						"Team task execution timed out",
						true,
						lateSettlement.kind === "result"
							? (lateSettlement.result.usage ?? UNKNOWN_TURN_USAGE)
							: UNKNOWN_TURN_USAGE,
					);
				} else if (lateSettlement.kind === "result" && lateSettlement.result.usage) {
					await this.recordTerminalUsage(active, lateSettlement.result.usage);
				} else if (lateSettlement.kind === "grace-expired") {
					this.trackLateTerminalUsage(active, runnerPromise);
				}
				return;
			}
			if (settled.kind === "error") {
				renewalStopped = true;
				if (renewTimer) clearTimeout(renewTimer);
				deadline?.cancel();
				await this.failActive(
					active,
					active.controller.signal.aborted ? "EXECUTION_ABORTED" : "TURN_RUNNER_ERROR",
					errorMessage(settled.error),
					!active.controller.signal.aborted,
					UNKNOWN_TURN_USAGE,
				);
				return;
			}
			if (typeof settled.result?.reply !== "string") {
				throw new CollaborationConflictError("INVALID_TURN_RESULT", "Team turn runner must return a string reply");
			}

			const current = await this.waitUntilCompletable(active, deadline);
			if (!current) {
				// A handoff acceptance, approval rejection, or concurrent durable
				// cancellation can make the attempt terminal while the provider turn
				// is settling. Keep its real spend in the run budget without allowing
				// the stale callback to overwrite task state or result ownership.
				if (settled.result.usage) {
					await this.recordTerminalUsage(active, settled.result.usage);
				}
				return;
			}
			renewalStopped = true;
			if (renewTimer) clearTimeout(renewTimer);
			deadline?.cancel();
			const sanitizedResult = sanitizeTeamResult(settled.result.reply);
			try {
				await this.store.completeAttempt({
					commandId: this.nextCommandId(),
					now: this.clock(),
					attemptId: active.attempt.id,
					leaseToken: active.attempt.lease.token,
					fence: active.attempt.lease.fence,
					result: sanitizedResult,
					...(settled.result.usage ? { usage: settled.result.usage } : {}),
				});
			} catch (error) {
				if (!staleAttemptError(error)) throw error;
			}
		} finally {
			renewalStopped = true;
			if (renewTimer) clearTimeout(renewTimer);
			deadline?.cancel();
			releaseSession();
			await active.progressTail.catch(() => undefined);
		}
	}

	/** Brigade sessions are FIFO by session key. Mirror that admission boundary
	 * here so a claimed attempt waiting behind another turn keeps its lease but
	 * does not spend its execution timeout before the injected runner starts. */
	private async acquireSession(
		active: ActiveAttempt,
		deadline: PausableDeadline | undefined,
		restorePaused: () => void,
	): Promise<(() => void) | undefined> {
		let waiting = false;
		try {
			while (this.busySessions.has(active.reservationKey)) {
				if (!waiting) {
					waiting = true;
					deadline?.pause();
					active.paused = true;
				}
				await this.waitForSessionRelease(active.controller.signal);
				if (active.controller.signal.aborted || this.stopped) return undefined;
			}
			if (active.controller.signal.aborted || this.stopped) return undefined;
			this.busySessions.add(active.reservationKey);
			let released = false;
			return () => {
				if (released) return;
				released = true;
				this.busySessions.delete(active.reservationKey);
			};
		} finally {
			if (waiting) {
				deadline?.resume();
				restorePaused();
			}
		}
	}

	private async waitForSessionRelease(signal: AbortSignal): Promise<void> {
		await waitForAbortOrDelay(signal, Math.min(100, this.idlePollMs));
	}

	private async recordTerminalUsage(
		active: ActiveAttempt,
		usage: NonNullable<TeamTurnRunnerResult["usage"]>,
	): Promise<void> {
		try {
			await this.store.recordAttemptUsage({
				commandId: this.nextCommandId(),
				now: this.clock(),
				attemptId: active.attempt.id,
				leaseToken: active.attempt.lease.token,
				fence: active.attempt.lease.fence,
				usage,
			});
		} catch (error) {
			if (!staleAttemptError(error) && !(
				error instanceof CollaborationConflictError && [
					"ATTEMPT_STILL_ACTIVE",
					"USAGE_ALREADY_RECORDED",
				].includes(error.code)
			)) throw error;
		}
	}

	private trackLateTerminalUsage(
		active: ActiveAttempt,
		settlement: Promise<
			| { kind: "result"; result: TeamTurnRunnerResult }
			| { kind: "error"; error: unknown }
		>,
	): void {
		const tracked = settlement.then(async (late) => {
			if (late.kind === "result" && late.result.usage) {
				await this.recordTerminalUsage(active, late.result.usage);
			}
		}).catch(() => undefined).finally(() => {
			this.lateSettlements.delete(tracked);
		});
		this.lateSettlements.add(tracked);
	}

	private async waitUntilCompletable(active: ActiveAttempt, deadline: PausableDeadline | undefined): Promise<TaskAttempt | undefined> {
		let pausedHere = false;
		try {
			for (;;) {
				const attempt = await this.store.getAttempt(active.attempt.id);
				if (!attempt || attempt.status === "cancelled" || attempt.status === "failed" || attempt.status === "timed_out" || attempt.status === "handed_off" || attempt.status === "delegated" || attempt.status === "lost") {
					return undefined;
				}
				if (attempt.status === "running") return attempt;
				if (attempt.status === "waiting_approval") {
					if (!pausedHere) {
						pausedHere = true;
						deadline?.pause();
						active.paused = true;
					}
					await waitForAbortOrDelay(active.controller.signal, Math.min(250, this.idlePollMs));
					if (active.controller.signal.aborted) return undefined;
				}
			}
		} finally {
			if (pausedHere) deadline?.resume();
		}
	}

	private async failActive(
		active: ActiveAttempt,
		code: string,
		message: string,
		retryable: boolean,
		usage?: NonNullable<TeamTurnRunnerResult["usage"]>,
	): Promise<void> {
		try {
			const task = await this.store.getTask(active.attempt.taskId);
			const policyAllowsRetry = retryable && (
				task?.retry.retryableCodes === undefined || task.retry.retryableCodes.includes(code)
			);
			await this.store.failAttempt({
				commandId: this.nextCommandId(),
				now: this.clock(),
				attemptId: active.attempt.id,
				leaseToken: active.attempt.lease.token,
				fence: active.attempt.lease.fence,
				errorCode: code,
				errorMessage: message,
				retryable: policyAllowsRetry,
				...(usage ? { usage } : {}),
			});
		} catch (error) {
			if (!staleAttemptError(error)) throw error;
		}
	}

	private async emitProgress(active: ActiveAttempt, input: TeamTurnProgressInput): Promise<void> {
		if (!this.progressHandler) return;
		const progress: TeamRuntimeProgress = {
			...input,
			progressId: randomUUID(),
			roomId: active.identifiers.roomId,
			runId: active.identifiers.runId,
			taskId: active.identifiers.taskId,
			attemptId: active.identifiers.attemptId,
			agentId: active.identifiers.agentId,
			progressSeq: ++active.progressSeq,
			emittedAt: this.clock(),
		};
		active.progressTail = active.progressTail
			.then(() => this.progressHandler?.(progress))
			.then(() => undefined, () => undefined);
		return active.progressTail;
	}

	private async syncDurableCancellations(): Promise<void> {
		for (const active of this.active.values()) {
			const [attempt, task, run] = await Promise.all([
				this.store.getAttempt(active.attempt.id),
				this.store.getTask(active.attempt.taskId),
				this.store.getRun(active.attempt.runId),
			]);
			const live =
				(attempt?.status === "running" || attempt?.status === "waiting_approval") &&
				(task?.status === "running" || task?.status === "waiting_approval") &&
				run?.status === "running";
			const explicitlyCancelled =
				attempt?.status === "cancelled" || task?.status === "cancelled" || run?.status === "cancelled";
			if (!live && (explicitlyCancelled || !expectsTerminalToolSettlement(attempt))) {
				this.abortActive(active, "durable-cancel", "Team task is no longer active");
			}
		}
	}

	private abortActive(active: ActiveAttempt, disposition: AbortDisposition, reason: string): void {
		if (active.controller.signal.aborted) return;
		active.abortDisposition = disposition;
		active.controller.abort(makeAbortError(reason));
	}

	async cancelTask(taskId: string, reason?: string): Promise<void> {
		await this.store.cancelTask({ commandId: this.nextCommandId(), taskId, ...(reason ? { reason } : {}), now: this.clock() });
		for (const active of this.active.values()) {
			if (active.attempt.taskId === taskId) this.abortActive(active, "durable-cancel", reason ?? "Team task cancelled");
		}
		await this.kick();
	}

	async cancelRun(runId: string, reason?: string): Promise<void> {
		await this.store.cancelRun({ commandId: this.nextCommandId(), runId, ...(reason ? { reason } : {}), now: this.clock() });
		for (const active of this.active.values()) {
			if (active.attempt.runId === runId) this.abortActive(active, "durable-cancel", reason ?? "Team run cancelled");
		}
		await this.kick();
	}

	listActiveAttempts(): ActiveTeamAttemptInfo[] {
		return [...this.active.values()].map((active) => ({
			...active.identifiers,
			sessionKey: active.sessionKey,
			startedAt: active.attempt.startedAt,
			paused: active.paused,
		}));
	}

	private async drainOutbox(): Promise<void> {
		if (!this.outboxPublisher || this.stopped) return;
		// Claim one row at a time. If delivery of roomSeq N fails, N+1 must not
		// leapfrog it merely because both rows were claimed in the same batch.
		for (let index = 0; index < this.outboxBatchSize; index += 1) {
			const snapshot = await this.store.readSnapshot();
			if (!snapshotHasClaimableOutbox(snapshot, this.clock())) break;
			const claimed = await this.store.claimOutbox({
				commandId: this.nextCommandId(),
				now: this.clock(),
				workerId: this.workerId,
				leaseDurationMs: this.outboxLeaseMs,
				limit: 1,
			});
			const item = claimed.value[0];
			if (!item) break;
			if (!item.claimToken || this.stopped) break;
			try {
				await this.outboxPublisher.publish(item.event, this.stopController.signal);
				await this.store.ackOutbox({
					commandId: this.nextCommandId(),
					now: this.clock(),
					outboxId: item.id,
					claimToken: item.claimToken,
					fence: item.claimFence,
				});
			} catch (error) {
				const delay = Math.min(
					this.outboxBackoffMaxMs,
					this.outboxBackoffBaseMs * (2 ** Math.min(20, Math.max(0, item.attempts - 1))),
				);
				try {
					await this.store.nackOutbox({
						commandId: this.nextCommandId(),
						now: this.clock(),
						outboxId: item.id,
						claimToken: item.claimToken,
						fence: item.claimFence,
						error: errorMessage(error),
						retryAt: this.clock() + delay,
						dead: item.attempts >= this.outboxMaxAttempts,
					});
				} catch (nackError) {
					if (!staleAttemptError(nackError)) {
						// Another publisher may have reclaimed the row after a long send.
						// Its fence is authoritative, so this pump simply moves on.
					}
				}
				break;
			}
		}
	}

	private scheduleIdlePoll(): void {
		if (this.stopped || this.idleTimer) return;
		this.idleTimer = setTimeout(() => {
			this.idleTimer = undefined;
			void this.kick().catch(() => this.scheduleIdlePoll());
		}, this.idlePollMs);
		this.idleTimer.unref?.();
	}

	async waitForQuiescence(timeoutMs = 10_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const pump = this.pumpPromise;
			const outboxPump = this.outboxPumpPromise;
			const active = [...this.active.values()].map((entry) => entry.promise);
			if (!pump && !outboxPump && active.length === 0 && !this.pumpAgain && !this.outboxPumpAgain) return;
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error("Team runtime did not become quiescent before timeout");
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					...(pump ? [pump] : []),
					...(outboxPump ? [outboxPump] : []),
					...active,
					new Promise<void>((_resolve, reject) => {
						timer = setTimeout(
							() => reject(new Error("Team runtime did not become quiescent before timeout")),
							remaining,
						);
					}),
				]);
			} finally {
				if (timer) clearTimeout(timer);
			}
		}
	}

	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.stopController.abort(makeAbortError("Team runtime stopped"));
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = undefined;
		for (const active of this.active.values()) this.abortActive(active, "shutdown", "Team runtime stopped");
		await Promise.allSettled([...this.active.values()].map((entry) => entry.promise));
		await this.pumpPromise?.catch(() => undefined);
		await this.outboxPumpPromise?.catch(() => undefined);
	}
}

let installedRuntime: TeamRuntimeService | undefined;

export function setActiveTeamRuntimeService(service: TeamRuntimeService | undefined): void {
	installedRuntime = service;
}

export function getActiveTeamRuntimeService(): TeamRuntimeService | undefined {
	return installedRuntime;
}

/** Tool/server wake hook. A missing runtime is safe: the durable mutation is retained. */
export async function kickActiveTeamRuntime(): Promise<void> {
	try {
		await installedRuntime?.kick();
	} catch {
		// Wakeups are best-effort. The command that requested the wake has already
		// committed durably and the runtime's idle poll will retry.
	}
}
