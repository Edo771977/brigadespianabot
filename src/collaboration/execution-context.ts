// src/collaboration/execution-context.ts
//
// Async-scoped capability for tools invoked inside a Team attempt. Tools see
// identifiers and semantic operations, never the lease token or fence needed
// to mutate the authoritative store.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type {
	CollaborationStore,
	DelegateAttemptChildrenResult,
	DelegatedChildTaskDraft,
} from "./store.js";
import { pageTeamTaskResult, type TeamTaskResultPage } from "./task-result-page.js";
import type {
	ApprovalStatus,
	Artifact,
	AttemptStatus,
	DelegationKind,
	Handoff,
	HandoffStatus,
	RunStatus,
	TaskStatus,
	TeamApproval,
	RoomMessage,
	RoomMessageAttachment,
} from "./types.js";
import { CollaborationConflictError, CollaborationNotFoundError } from "./types.js";

export interface ActiveTeamExecutionIdentifiers {
	roomId: string;
	runId: string;
	taskId: string;
	attemptId: string;
	agentId: string;
	sessionKey: string;
	runtimeRunId: string;
}

export interface ActiveTeamExecutionStatus {
	runStatus: RunStatus;
	taskStatus: TaskStatus;
	attemptStatus: AttemptStatus;
	assignedAgentId?: string;
	leaseExpiresAt: number;
	updatedAt: number;
}

export interface OfferTeamHandoffInput {
	toAgentId: string;
	reason?: string;
	expiresInMs?: number;
	signal?: AbortSignal;
}

export interface RequestTeamApprovalInput {
	kind: string;
	prompt: string;
	requestedBy?: string;
	expiresInMs?: number;
	signal?: AbortSignal;
}

export interface AttachTeamArtifactInput {
	kind: string;
	name: string;
	uri: string;
	mimeType?: string;
	bytes?: number;
	sha256?: string;
	metadata?: Record<string, unknown>;
}

export interface ReadTeamTaskResultInput {
	taskId: string;
	offset?: number;
	limit?: number;
}

export interface DelegateTeamChildrenInput {
	requestKey: string;
	delegationKind?: DelegationKind;
	tasks: DelegatedChildTaskDraft[];
}

export interface PostTeamMessageInput {
	content: string;
	mentions?: string[];
	attachments?: RoomMessageAttachment[];
	replyToMessageId?: string;
}

export interface ReadTeamMessagesInput {
	threadRootMessageId?: string;
	afterMessageId?: string;
	afterCreatedAt?: number;
	limit?: number;
}

export interface ActiveTeamExecutionContext {
	readonly identifiers: ActiveTeamExecutionIdentifiers;
	getStatus(): Promise<ActiveTeamExecutionStatus>;
	/** Lossless paged access to direct planned dependencies and delegated children. */
	readTaskResult(input: ReadTeamTaskResultInput): Promise<TeamTaskResultPage>;
	/** Atomically yield this attempt to durable child work. The parent resumes in
	 * a fresh fenced attempt only after every direct child has settled. */
	delegateChildren(input: DelegateTeamChildrenInput): Promise<DelegateAttemptChildrenResult>;
	/** Public room conversation. Posting is fenced to this exact attempt. */
	postMessage(input: PostTeamMessageInput): Promise<RoomMessage>;
	readMessages(input?: ReadTeamMessagesInput): Promise<RoomMessage[]>;
	offerHandoff(input: OfferTeamHandoffInput): Promise<Handoff>;
	requestApproval(input: RequestTeamApprovalInput): Promise<TeamApproval>;
	attachArtifact(input: AttachTeamArtifactInput): Promise<Artifact>;
}

export interface CreateActiveTeamExecutionContextOptions {
	store: CollaborationStore;
	identifiers: ActiveTeamExecutionIdentifiers;
	leaseToken: string;
	fence: number;
	/** Current runtime availability check. Kept inside the capability so a
	 * worker cannot offer a handoff to a deleted or otherwise unknown agent. */
	validateAgentId: (agentId: string) => boolean | Promise<boolean>;
	now?: () => number;
	commandId?: () => string;
	pollIntervalMs?: number;
	/** Runtime-only hooks used to pause the task execution deadline while a
	 * human/agent decision is pending. They are not exposed to tools. */
	onWaitStart?: (kind: "approval" | "handoff") => void;
	onWaitEnd?: (kind: "approval" | "handoff") => void;
	/** Retire the provider turn synchronously once authority says it may no
	 * longer perform workspace work. The decision value still returns through
	 * the waiting tool while the outer runner observes an aborted signal. */
	onTerminalDecision?: (kind: "approval" | "handoff" | "delegation", outcome: string) => void;
}

const activeContext = new AsyncLocalStorage<ActiveTeamExecutionContext>();

export function getActiveTeamExecutionContext(): ActiveTeamExecutionContext | undefined {
	return activeContext.getStore();
}

export function requireActiveTeamExecutionContext(): ActiveTeamExecutionContext {
	const context = getActiveTeamExecutionContext();
	if (!context) throw new CollaborationConflictError("NOT_TEAM_ATTEMPT", "this operation requires an active Team task attempt");
	return context;
}

export function runWithTeamExecutionContext<T>(
	context: ActiveTeamExecutionContext,
	operation: () => T,
): T {
	return activeContext.run(context, operation);
}

function validateDuration(value: number | undefined, field: string): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
		throw new CollaborationConflictError("INVALID_ARGUMENT", `${field} must be a positive integer`);
	}
}

function abortError(reason: unknown): Error {
	if (reason instanceof Error) return reason;
	const error = new Error(typeof reason === "string" ? reason : "operation aborted");
	error.name = "AbortError";
	return error;
}

async function wait(intervalMs: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw abortError(signal.reason);
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, intervalMs);
		const onAbort = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(abortError(signal?.reason));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function createActiveTeamExecutionContext(
	options: CreateActiveTeamExecutionContextOptions,
): ActiveTeamExecutionContext {
	const clock = options.now ?? Date.now;
	const nextCommandId = options.commandId ?? randomUUID;
	const pollIntervalMs = options.pollIntervalMs ?? 250;
	validateDuration(pollIntervalMs, "pollIntervalMs");
	const ids = Object.freeze({ ...options.identifiers });

	const getBoundAttempt = async () => {
		const attempt = await options.store.getAttempt(ids.attemptId);
		if (!attempt) throw new CollaborationNotFoundError("attempt", ids.attemptId);
		if (attempt.taskId !== ids.taskId || attempt.runId !== ids.runId) {
			throw new CollaborationConflictError("ATTEMPT_SCOPE_MISMATCH", "active Team attempt scope no longer matches");
		}
		if (attempt.lease.token !== options.leaseToken || attempt.lease.fence !== options.fence) {
			throw new CollaborationConflictError("FENCE_MISMATCH", "active Team attempt lease is stale");
		}
		return attempt;
	};

	const reconcileExpired = async (): Promise<void> => {
		await options.store.reconcile({ commandId: nextCommandId(), now: clock() });
	};

	const waitForHandoff = async (handoffId: string, signal?: AbortSignal): Promise<Handoff> => {
		const terminal = new Set<HandoffStatus>(["accepted", "rejected", "cancelled", "expired"]);
		for (;;) {
			if (signal?.aborted) throw abortError(signal.reason);
			const handoff = (await options.store.listHandoffs(ids.runId)).find((row) => row.id === handoffId);
			if (!handoff) throw new CollaborationNotFoundError("handoff", handoffId);
			if (terminal.has(handoff.status)) {
				if (handoff.status === "accepted") options.onTerminalDecision?.("handoff", handoff.status);
				return handoff;
			}
			if (handoff.expiresAt !== undefined && handoff.expiresAt <= clock()) await reconcileExpired();
			else await wait(pollIntervalMs, signal);
		}
	};

	const waitForApproval = async (approvalId: string, signal?: AbortSignal): Promise<TeamApproval> => {
		const terminal = new Set<ApprovalStatus>(["approved", "rejected", "cancelled", "expired"]);
		for (;;) {
			if (signal?.aborted) throw abortError(signal.reason);
			const approval = (await options.store.listApprovals(ids.runId)).find((row) => row.id === approvalId);
			if (!approval) throw new CollaborationNotFoundError("approval", approvalId);
			if (terminal.has(approval.status)) {
				if (approval.status !== "approved") options.onTerminalDecision?.("approval", approval.status);
				return approval;
			}
			if (approval.expiresAt !== undefined && approval.expiresAt <= clock()) await reconcileExpired();
			else await wait(pollIntervalMs, signal);
		}
	};

	return Object.freeze({
		identifiers: ids,
		async getStatus(): Promise<ActiveTeamExecutionStatus> {
			const attempt = await getBoundAttempt();
			const task = await options.store.getTask(ids.taskId);
			const run = await options.store.getRun(ids.runId);
			if (!task) throw new CollaborationNotFoundError("task", ids.taskId);
			if (!run) throw new CollaborationNotFoundError("run", ids.runId);
			return {
				runStatus: run.status,
				taskStatus: task.status,
				attemptStatus: attempt.status,
				...(task.assignedAgentId ? { assignedAgentId: task.assignedAgentId } : {}),
				leaseExpiresAt: attempt.lease.expiresAt,
				updatedAt: Math.max(run.updatedAt, task.updatedAt, attempt.updatedAt),
			};
		},
		async readTaskResult(input: ReadTeamTaskResultInput): Promise<TeamTaskResultPage> {
			const attempt = await getBoundAttempt();
			if (
				(attempt.status !== "running" && attempt.status !== "waiting_approval")
				|| attempt.lease.expiresAt <= clock()
			) {
				throw new CollaborationConflictError("STALE_ATTEMPT", "active Team attempt is no longer readable");
			}
			const currentTask = await options.store.getTask(ids.taskId);
			if (!currentTask) throw new CollaborationNotFoundError("task", ids.taskId);
			const plannedDependency = currentTask.dependencies.some(
				(dependency) => dependency.taskId === input.taskId,
			);
			const delegatedChild = (await options.store.listTasks(ids.runId)).some(
				(candidate) => candidate.id === input.taskId && candidate.parentTaskId === currentTask.id,
			);
			if (!plannedDependency && !delegatedChild) {
				// Check the durable edge before resolving the target so arbitrary task ids
				// cannot be used as an existence oracle across the run or another room.
				throw new CollaborationConflictError(
					"TASK_RESULT_NOT_VISIBLE",
					"Only direct dependency and delegated-child results are visible to this Team task",
				);
			}
			const dependency = await options.store.getTask(input.taskId);
			if (!dependency || dependency.runId !== ids.runId) {
				throw new CollaborationConflictError(
					"TASK_RESULT_NOT_VISIBLE",
					"Only direct dependency and delegated-child results are visible to this Team task",
				);
			}
			return pageTeamTaskResult(dependency, {
				...(input.offset !== undefined ? { offset: input.offset } : {}),
				...(input.limit !== undefined ? { limit: input.limit } : {}),
			});
		},
		async delegateChildren(input: DelegateTeamChildrenInput): Promise<DelegateAttemptChildrenResult> {
			await getBoundAttempt();
			for (const task of input.tasks) {
				if (!(await options.validateAgentId(task.assignedAgentId))) {
					throw new CollaborationConflictError(
						"UNKNOWN_AGENT",
						`delegated child is assigned to an unknown agent: ${task.assignedAgentId}`,
					);
				}
			}
			const delegated = await options.store.delegateAttemptChildren({
				commandId: nextCommandId(),
				now: clock(),
				attemptId: ids.attemptId,
				leaseToken: options.leaseToken,
				fence: options.fence,
				requestKey: input.requestKey,
				...(input.delegationKind ? { delegationKind: input.delegationKind } : {}),
				tasks: input.tasks,
			});
			options.onTerminalDecision?.("delegation", "yielded");
			return delegated.value;
		},
		async postMessage(input: PostTeamMessageInput): Promise<RoomMessage> {
			await getBoundAttempt();
			for (const agentId of input.mentions ?? []) {
				if (!(await options.validateAgentId(agentId))) {
					throw new CollaborationConflictError("UNKNOWN_AGENT", `message mentions an unknown agent: ${agentId}`);
				}
			}
			return (await options.store.postMessage({
				commandId: nextCommandId(),
				now: clock(),
				roomId: ids.roomId,
				authorId: ids.agentId,
				authorKind: "agent",
				source: "task",
				content: input.content,
				mentions: input.mentions ?? [],
				attachments: input.attachments ?? [],
				...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
				runId: ids.runId,
				taskId: ids.taskId,
				attemptId: ids.attemptId,
				leaseToken: options.leaseToken,
				fence: options.fence,
			})).value;
		},
		async readMessages(input: ReadTeamMessagesInput = {}): Promise<RoomMessage[]> {
			const attempt = await getBoundAttempt();
			if ((attempt.status !== "running" && attempt.status !== "waiting_approval") || attempt.lease.expiresAt <= clock()) {
				throw new CollaborationConflictError("STALE_ATTEMPT", "active Team attempt is no longer readable");
			}
			return options.store.listMessages({
				roomId: ids.roomId,
				...(input.threadRootMessageId ? { threadRootMessageId: input.threadRootMessageId } : {}),
				...(input.afterMessageId ? { afterMessageId: input.afterMessageId } : {}),
				...(input.afterCreatedAt !== undefined ? { afterCreatedAt: input.afterCreatedAt } : {}),
				...(input.limit !== undefined ? { limit: input.limit } : {}),
			});
		},
		async offerHandoff(input: OfferTeamHandoffInput): Promise<Handoff> {
			validateDuration(input.expiresInMs, "expiresInMs");
			await getBoundAttempt();
			if (!(await options.validateAgentId(input.toAgentId))) {
				throw new CollaborationConflictError(
					"UNKNOWN_AGENT",
					`handoff target is not a configured agent: ${input.toAgentId}`,
				);
			}
			const at = clock();
			const offered = await options.store.offerHandoff({
				commandId: nextCommandId(),
				now: at,
				attemptId: ids.attemptId,
				leaseToken: options.leaseToken,
				fence: options.fence,
				fromAgentId: ids.agentId,
				toAgentId: input.toAgentId,
				...(input.reason ? { reason: input.reason } : {}),
				...(input.expiresInMs ? { expiresAt: at + input.expiresInMs } : {}),
			});
			options.onWaitStart?.("handoff");
			try {
				return await waitForHandoff(offered.value.id, input.signal);
			} finally {
				options.onWaitEnd?.("handoff");
			}
		},
		async requestApproval(input: RequestTeamApprovalInput): Promise<TeamApproval> {
			validateDuration(input.expiresInMs, "expiresInMs");
			await getBoundAttempt();
			const at = clock();
			const requested = await options.store.requestApproval({
				commandId: nextCommandId(),
				now: at,
				attemptId: ids.attemptId,
				leaseToken: options.leaseToken,
				fence: options.fence,
				kind: input.kind,
				prompt: input.prompt,
				requestedBy: input.requestedBy ?? ids.agentId,
				...(input.expiresInMs ? { expiresAt: at + input.expiresInMs } : {}),
			});
			options.onWaitStart?.("approval");
			try {
				return await waitForApproval(requested.value.id, input.signal);
			} finally {
				options.onWaitEnd?.("approval");
			}
		},
		async attachArtifact(input: AttachTeamArtifactInput): Promise<Artifact> {
			await getBoundAttempt();
			return (await options.store.addArtifact({
				commandId: nextCommandId(),
				now: clock(),
				runId: ids.runId,
				taskId: ids.taskId,
				attemptId: ids.attemptId,
				leaseToken: options.leaseToken,
				fence: options.fence,
				kind: input.kind,
				name: input.name,
				uri: input.uri,
				...(input.mimeType ? { mimeType: input.mimeType } : {}),
				...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
				...(input.sha256 ? { sha256: input.sha256 } : {}),
				...(input.metadata ? { metadata: input.metadata } : {}),
			})).value;
		},
	} satisfies ActiveTeamExecutionContext);
}
