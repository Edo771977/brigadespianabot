// src/collaboration/memory-store.ts
//
// Complete, deterministic reference implementation of CollaborationStore.
// Persistence adapters can hydrate this store from a committed snapshot, run
// one semantic command under their own transaction lock, then persist the next
// snapshot. It is also the single-process filesystem fallback for Team Mode.

import { createHash, randomUUID } from "node:crypto";
import {
	MAX_ATOMIC_DELEGATION_COMMAND_BYTES,
	MAX_DELEGATED_CHILDREN_PER_COMMAND,
	MAX_DELEGATED_CHILDREN_PER_RUN,
	MAX_DELEGATION_DEPTH,
} from "./store.js";
import { taskResultGateFailure } from "./result-gate.js";
import { resolveRoomCoordinatorAgentId } from "./room-coordinator.js";
import type {
	AckOutboxCommand,
	AddArtifactCommand,
	AddTasksCommand,
	ArchiveRoomCommand,
	CancelRunCommand,
	CancelTaskCommand,
	ClaimOutboxCommand,
	ClaimReadyTaskCommand,
	CollaborationCommandReceipt,
	CollaborationStore,
	CollaborationStoreSnapshot,
	CommandMeta,
	CommandResult,
	CompleteAttemptCommand,
	CreateRoomCommand,
	CreateRunCommand,
	DelegateAttemptChildrenCommand,
	DelegateAttemptChildrenResult,
	DelegateRunCommand,
	DelegateRunResult,
	EventQuery,
	EditRoomMessageCommand,
	FailAttemptCommand,
	DeleteRoomMessageCommand,
	MessageQuery,
	MessageSearchQuery,
	NackOutboxCommand,
	OfferHandoffCommand,
	PinRoomMessageCommand,
	PostRoomMessageCommand,
	ReactRoomMessageCommand,
	ReconcileCommand,
	RecordAttemptUsageCommand,
	RenewAttemptLeaseCommand,
	RequestApprovalCommand,
	ResolveApprovalCommand,
	RespondHandoffCommand,
	RetryTaskCommand,
	StartRunCommand,
	TaskDraft,
	UpdateRoomCommand,
} from "./store.js";
import {
	CollaborationBudgetError,
	CollaborationConflictError,
	CollaborationNotFoundError,
	type ApprovalId,
	type Artifact,
	type ArtifactId,
	type AttemptId,
	type AttemptStatus,
	type CollaborationEvent,
	type CollaborationEventType,
	type CollaborationOutboxItem,
	type CollaborationRoom,
	type Handoff,
	type HandoffId,
	type JoinCondition,
	type MessageId,
	type OutboxId,
	type ReconciliationReport,
	type RoomId,
	type RunId,
	type RunSnapshot,
	type TaskAttempt,
	type TaskId,
	type TaskStatus,
	type TeamApproval,
	type TeamRun,
	type TeamTask,
	type RoomMessage,
	type RoomMessageAttachment,
	type RoomMetrics,
} from "./types.js";

const TERMINAL_TASK_STATUSES = new Set<TaskStatus>([
	"succeeded",
	"failed",
	"cancelled",
	"skipped",
	"handed_off",
]);

const LIVE_ATTEMPT_STATUSES = new Set<AttemptStatus>(["running", "waiting_approval"]);
const MAX_ATOMIC_DELEGATION_TASKS = 256;
const DEFAULT_DECISION_TIMEOUT_MS = 5 * 60_000;
const MAX_DECISION_TIMEOUT_MS = 24 * 60 * 60_000;
const TERMINAL_USAGE_SETTLEMENT_GRACE_MS = 30_000;
const MAX_MESSAGE_CONTENT_CHARS = 100_000;
const MAX_MESSAGE_ATTACHMENTS = 32;
const MAX_MESSAGE_MENTIONS = 64;

function clone<T>(value: T): T {
	return structuredClone(value);
}

function nowOf(command: CommandMeta): number {
	const now = command.now ?? Date.now();
	if (!Number.isFinite(now) || now < 0) {
		throw new CollaborationConflictError("INVALID_TIME", "now must be a non-negative finite timestamp");
	}
	return now;
}

function positiveInt(value: number, field: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new CollaborationConflictError("INVALID_ARGUMENT", `${field} must be a positive integer`);
	}
}

function finiteNonNegative(value: number, field: string): void {
	if (!Number.isFinite(value) || value < 0) {
		throw new CollaborationConflictError("INVALID_ARGUMENT", `${field} must be non-negative`);
	}
}

function validateRoomCoordinatorInvariant(
	members: readonly { agentId: string; role?: string }[],
	metadata: Record<string, unknown>,
): void {
	const roleCoordinators = members.filter((member) => member.role === "coordinator");
	if (roleCoordinators.length > 1) {
		throw new CollaborationConflictError(
			"ROOM_COORDINATOR_AMBIGUOUS",
			"a Team room may have only one member with the coordinator role",
		);
	}
	const raw = metadata.coordinatorAgentId;
	if (raw === undefined) return;
	if (typeof raw !== "string" || raw.trim().length === 0) {
		throw new CollaborationConflictError(
			"INVALID_ROOM_COORDINATOR",
			"metadata.coordinatorAgentId must be a non-empty string",
		);
	}
	const coordinatorAgentId = raw.trim();
	if (!members.some((member) => member.agentId === coordinatorAgentId)) {
		throw new CollaborationConflictError(
			"ROOM_COORDINATOR_NOT_MEMBER",
			`room coordinator ${coordinatorAgentId} must be a room member`,
		);
	}
	if (roleCoordinators[0] && roleCoordinators[0].agentId !== coordinatorAgentId) {
		throw new CollaborationConflictError(
			"ROOM_COORDINATOR_MISMATCH",
			"metadata.coordinatorAgentId must match the member with role coordinator",
		);
	}
}

function stableValue(value: unknown, seen = new Set<object>()): unknown {
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) {
		throw new CollaborationConflictError("INVALID_ARGUMENT", "commands must not contain cyclic values");
	}
	seen.add(value);
	try {
		if (Array.isArray(value)) return value.map((item) => stableValue(item, seen));
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const item = (value as Record<string, unknown>)[key];
			if (item !== undefined) out[key] = stableValue(item, seen);
		}
		return out;
	} finally {
		seen.delete(value);
	}
}

function fingerprint(value: unknown): string {
	// `now` is an execution stamp supplied by the server/adapter, not semantic
	// command intent. A retry after an RPC timeout naturally gets a fresh wall
	// clock value and must still replay the original receipt.
	const semantic = value && typeof value === "object" && !Array.isArray(value)
		? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== "now"))
		: value;
	return createHash("sha256").update(JSON.stringify(stableValue(semantic))).digest("hex");
}

function semanticCommandByteLength(value: CommandMeta): number {
	const semantic = Object.fromEntries(
		Object.entries(value as unknown as Record<string, unknown>).filter(([key]) => key !== "now"),
	);
	const encoded = JSON.stringify(stableValue(semantic));
	if (encoded === undefined) {
		throw new CollaborationConflictError("INVALID_ARGUMENT", "command must be JSON-serializable");
	}
	return Buffer.byteLength(encoded, "utf8");
}

function compareTasks(a: TeamTask, b: TeamTask): number {
	return b.priority - a.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

function compareCreated<T extends { createdAt: number; id: string }>(a: T, b: T): number {
	return a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

function compareAttempts(a: TaskAttempt, b: TaskAttempt): number {
	return a.startedAt - b.startedAt || a.id.localeCompare(b.id);
}

function validateJoin(join: JoinCondition, dependencyCount: number): void {
	if (join.kind !== "quorum") return;
	positiveInt(join.minimum, "join.minimum");
	if (join.minimum > dependencyCount) {
		throw new CollaborationConflictError(
			"INVALID_JOIN",
			`quorum ${join.minimum} cannot exceed dependency count ${dependencyCount}`,
		);
	}
}

function isTerminalTask(task: TeamTask): boolean {
	return TERMINAL_TASK_STATUSES.has(task.status);
}

function normalizeSearchText(value: string): string {
	return value.normalize("NFKC").toLocaleLowerCase();
}

function uniqueTrimmed(values: readonly string[], field: string, maximum: number): string[] {
	if (values.length > maximum) {
		throw new CollaborationConflictError("INVALID_ARGUMENT", `${field} cannot contain more than ${maximum} values`);
	}
	const result: string[] = [];
	const seen = new Set<string>();
	for (const raw of values) {
		if (typeof raw !== "string" || raw.trim().length === 0) {
			throw new CollaborationConflictError("INVALID_ARGUMENT", `${field} values must be non-empty strings`);
		}
		const value = raw.trim();
		if (!seen.has(value)) {
			seen.add(value);
			result.push(value);
		}
	}
	return result;
}

function validateMessageAttachments(values: readonly RoomMessageAttachment[]): RoomMessageAttachment[] {
	if (values.length > MAX_MESSAGE_ATTACHMENTS) {
		throw new CollaborationConflictError(
			"INVALID_ARGUMENT",
			`attachments cannot contain more than ${MAX_MESSAGE_ATTACHMENTS} values`,
		);
	}
	return values.map((value, index) => {
		if (!value.name?.trim()) {
			throw new CollaborationConflictError("INVALID_ARGUMENT", `attachments[${index}].name is required`);
		}
		if (!value.artifactId && !value.uri?.trim()) {
			throw new CollaborationConflictError(
				"INVALID_ARGUMENT",
				`attachments[${index}] requires artifactId or uri`,
			);
		}
		if (value.bytes !== undefined) finiteNonNegative(value.bytes, `attachments[${index}].bytes`);
		return {
			...(value.artifactId ? { artifactId: value.artifactId.trim() } : {}),
			name: value.name.trim(),
			...(value.uri ? { uri: value.uri.trim() } : {}),
			...(value.mimeType ? { mimeType: value.mimeType.trim() } : {}),
			...(value.bytes !== undefined ? { bytes: value.bytes } : {}),
		};
	});
}

type JoinEvaluation = "waiting" | "satisfied" | "impossible";

/** Pure join evaluator shared by the reference store and coordinator tests. */
export function evaluateJoinCondition(
	join: JoinCondition,
	dependencies: readonly TeamTask[],
): JoinEvaluation {
	if (dependencies.length === 0) return "satisfied";
	const succeeded = dependencies.filter((task) => task.status === "succeeded").length;
	const terminal = dependencies.filter(isTerminalTask).length;
	const remaining = dependencies.length - terminal;
	switch (join.kind) {
		case "all":
			if (succeeded === dependencies.length) return "satisfied";
			return terminal - succeeded > 0 ? "impossible" : "waiting";
		case "any":
			if (succeeded > 0) return "satisfied";
			return remaining === 0 ? "impossible" : "waiting";
		case "quorum":
			if (succeeded >= join.minimum) return "satisfied";
			return succeeded + remaining < join.minimum ? "impossible" : "waiting";
	}
}

/**
 * Hydratable reference store. Every mutation is serialized, including replay
 * lookup and receipt creation, so concurrent callers observe linearizable
 * command behavior in one process.
 */
export class InMemoryCollaborationStore implements CollaborationStore {
	private readonly rooms = new Map<RoomId, CollaborationRoom>();
	private readonly runs = new Map<RunId, TeamRun>();
	private readonly tasks = new Map<TaskId, TeamTask>();
	private readonly attempts = new Map<AttemptId, TaskAttempt>();
	private readonly handoffs = new Map<HandoffId, Handoff>();
	private readonly approvals = new Map<ApprovalId, TeamApproval>();
	private readonly artifacts = new Map<ArtifactId, Artifact>();
	private readonly messages = new Map<MessageId, RoomMessage>();
	private readonly events: CollaborationEvent[] = [];
	private readonly outbox = new Map<OutboxId, CollaborationOutboxItem>();
	private readonly receipts = new Map<string, CollaborationCommandReceipt>();
	private readonly roomSequences = new Map<RoomId, number>();
	private mutationTail: Promise<void> = Promise.resolve();
	private activeCommandId: string | undefined;

	constructor(snapshot?: CollaborationStoreSnapshot) {
		if (snapshot) this.hydrate(snapshot);
	}

	private hydrate(snapshot: CollaborationStoreSnapshot): void {
		this.rooms.clear();
		this.runs.clear();
		this.tasks.clear();
		this.attempts.clear();
		this.handoffs.clear();
		this.approvals.clear();
		this.artifacts.clear();
		this.messages.clear();
		this.events.length = 0;
		this.outbox.clear();
		this.receipts.clear();
		this.roomSequences.clear();
		for (const value of snapshot.rooms) this.rooms.set(value.id, clone(value));
		for (const value of snapshot.runs) this.runs.set(value.id, clone(value));
		for (const value of snapshot.tasks) this.tasks.set(value.id, clone(value));
		for (const value of snapshot.attempts) this.attempts.set(value.id, clone(value));
		for (const value of snapshot.handoffs) this.handoffs.set(value.id, clone(value));
		for (const value of snapshot.approvals) this.approvals.set(value.id, clone(value));
		for (const value of snapshot.artifacts) this.artifacts.set(value.id, clone(value));
		for (const value of snapshot.messages ?? []) this.messages.set(value.id, clone(value));
		for (const value of snapshot.events) {
			this.events.push(clone(value));
			this.roomSequences.set(value.roomId, Math.max(this.roomSequences.get(value.roomId) ?? 0, value.roomSeq));
		}
		for (const value of snapshot.roomSequences ?? []) {
			this.roomSequences.set(value.roomId, Math.max(this.roomSequences.get(value.roomId) ?? 0, value.roomSeq));
		}
		for (const value of snapshot.outbox) this.outbox.set(value.id, clone(value));
		for (const value of snapshot.commandReceipts ?? []) this.receipts.set(value.commandId, clone(value));
	}

	private snapshotUnsafe(): CollaborationStoreSnapshot {
		return clone({
			rooms: [...this.rooms.values()],
			runs: [...this.runs.values()],
			tasks: [...this.tasks.values()],
			attempts: [...this.attempts.values()],
			handoffs: [...this.handoffs.values()],
			approvals: [...this.approvals.values()],
			artifacts: [...this.artifacts.values()],
			messages: [...this.messages.values()],
			events: [...this.events],
			outbox: [...this.outbox.values()],
			commandReceipts: [...this.receipts.values()],
			roomSequences: [...this.roomSequences].map(([roomId, roomSeq]) => ({ roomId, roomSeq })),
		});
	}

	private serialize<T>(operation: () => Promise<T> | T): Promise<T> {
		const result = this.mutationTail.then(operation);
		this.mutationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async consistentRead<T>(read: () => T): Promise<T> {
		await this.mutationTail;
		return clone(read());
	}

	private async command<T>(
		operation: string,
		meta: CommandMeta,
		body: (now: number) => T | Promise<T>,
	): Promise<CommandResult<T>> {
		if (!meta.commandId.trim()) {
			throw new CollaborationConflictError("INVALID_COMMAND_ID", "commandId is required");
		}
		return this.serialize(async () => {
			const commandFingerprint = fingerprint(meta);
			const prior = this.receipts.get(meta.commandId);
			if (prior) {
				if (prior.operation !== operation || prior.fingerprint !== commandFingerprint) {
					throw new CollaborationConflictError(
						"IDEMPOTENCY_CONFLICT",
						`commandId ${meta.commandId} was already used for a different command`,
					);
				}
				const eventIds = new Set(prior.eventIds);
				return {
					value: clone(prior.value as T),
					replayed: true,
					events: clone(this.events.filter((event) => eventIds.has(event.eventId))),
				};
			}

			const before = this.snapshotUnsafe();
			const eventStart = this.events.length;
			this.activeCommandId = meta.commandId;
			try {
				const at = nowOf(meta);
				const value = await body(at);
				const emitted = this.events.slice(eventStart);
				this.receipts.set(meta.commandId, {
					commandId: meta.commandId,
					operation,
					fingerprint: commandFingerprint,
					value: clone(value),
					eventIds: emitted.map((event) => event.eventId),
					committedAt: at,
				});
				return { value: clone(value), replayed: false, events: clone(emitted) };
			} catch (error) {
				// Reference-store atomicity: a semantic command either commits state,
				// events, outbox rows and its receipt together, or changes nothing.
				this.hydrate(before);
				throw error;
			} finally {
				this.activeCommandId = undefined;
			}
		});
	}

	private emit(
		type: CollaborationEventType,
		roomId: RoomId,
		createdAt: number,
		fields: {
			runId?: RunId;
			taskId?: TaskId;
			attemptId?: AttemptId;
			payload?: Record<string, unknown>;
		} = {},
	): CollaborationEvent {
		if (!this.activeCommandId) {
			throw new Error("collaboration events may only be emitted inside a command");
		}
		const room = this.rooms.get(roomId);
		if (room && createdAt > room.updatedAt) room.updatedAt = createdAt;
		const roomSeq = (this.roomSequences.get(roomId) ?? 0) + 1;
		this.roomSequences.set(roomId, roomSeq);
		const event: CollaborationEvent = {
			eventId: randomUUID(),
			roomSeq,
			type,
			roomId,
			...(fields.runId ? { runId: fields.runId } : {}),
			...(fields.taskId ? { taskId: fields.taskId } : {}),
			...(fields.attemptId ? { attemptId: fields.attemptId } : {}),
			commandId: this.activeCommandId,
			payload: fields.payload ?? {},
			createdAt,
		};
		this.events.push(event);
		const outboxItem: CollaborationOutboxItem = {
			id: randomUUID(),
			event,
			status: "pending",
			attempts: 0,
			nextAttemptAt: createdAt,
			claimFence: 0,
			createdAt,
			updatedAt: createdAt,
		};
		this.outbox.set(outboxItem.id, outboxItem);
		return event;
	}

	private roomOrThrow(roomId: RoomId): CollaborationRoom {
		const room = this.rooms.get(roomId);
		if (!room) throw new CollaborationNotFoundError("room", roomId);
		return room;
	}

	private runOrThrow(runId: RunId): TeamRun {
		const run = this.runs.get(runId);
		if (!run) throw new CollaborationNotFoundError("run", runId);
		return run;
	}

	private taskOrThrow(taskId: TaskId): TeamTask {
		const task = this.tasks.get(taskId);
		if (!task) throw new CollaborationNotFoundError("task", taskId);
		return task;
	}

	private attemptOrThrow(attemptId: AttemptId): TaskAttempt {
		const attempt = this.attempts.get(attemptId);
		if (!attempt) throw new CollaborationNotFoundError("attempt", attemptId);
		return attempt;
	}

	private messageOrThrow(messageId: MessageId): RoomMessage {
		const message = this.messages.get(messageId);
		if (!message) throw new CollaborationNotFoundError("message", messageId);
		return message;
	}

	private validateRunBudgets(run: TeamRun): void {
		const budgets = run.budgets;
		if (budgets.maxTokens !== undefined) positiveInt(budgets.maxTokens, "budgets.maxTokens");
		if (budgets.maxCostUsd !== undefined) finiteNonNegative(budgets.maxCostUsd, "budgets.maxCostUsd");
		if (budgets.maxDurationMs !== undefined) positiveInt(budgets.maxDurationMs, "budgets.maxDurationMs");
		if (budgets.maxConcurrency !== undefined) positiveInt(budgets.maxConcurrency, "budgets.maxConcurrency");
		if (budgets.maxAttempts !== undefined) positiveInt(budgets.maxAttempts, "budgets.maxAttempts");
	}

	private materializeMembers(
		inputs: CreateRoomCommand["members"] | UpdateRoomCommand["members"],
		at: number,
		existing: CollaborationRoom["members"] = [],
	): CollaborationRoom["members"] {
		const prior = new Map(existing.map((member) => [member.agentId, member]));
		const seen = new Set<string>();
		return (inputs ?? []).map((input) => {
			const agentId = input.agentId.trim();
			if (!agentId) throw new CollaborationConflictError("INVALID_ARGUMENT", "room member agentId is required");
			if (seen.has(agentId)) throw new CollaborationConflictError("INVALID_ARGUMENT", `duplicate room member: ${agentId}`);
			seen.add(agentId);
			const joinedAt = input.joinedAt ?? prior.get(agentId)?.joinedAt ?? at;
			if (!Number.isFinite(joinedAt) || joinedAt < 0) {
				throw new CollaborationConflictError("INVALID_ARGUMENT", "member joinedAt must be a non-negative timestamp");
			}
			return { agentId, ...(input.role ? { role: input.role } : {}), joinedAt };
		});
	}

	private assertRoomMember(roomId: RoomId, agentIdValue: string, field: string): string {
		const agentId = agentIdValue.trim();
		if (!agentId) {
			throw new CollaborationConflictError("INVALID_ARGUMENT", `${field} is required`);
		}
		const room = this.roomOrThrow(roomId);
		if (!room.members.some((member) => member.agentId === agentId)) {
			throw new CollaborationConflictError(
				"AGENT_NOT_IN_ROOM",
				`agent ${agentId} is not a member of room ${room.id}`,
			);
		}
		return agentId;
	}

	private budgetBlock(
		run: TeamRun,
		at: number,
		options: { allowReservedAttemptsToFinish?: boolean } = {},
	): "tokens" | "cost" | "cost_unknown" | "duration" | "concurrency" | "attempts" | undefined {
		if (run.budgets.maxTokens !== undefined && run.usage.tokens >= run.budgets.maxTokens) return "tokens";
		if (run.budgets.maxCostUsd !== undefined && run.usage.costComplete === false) return "cost_unknown";
		if (run.budgets.maxCostUsd !== undefined && run.usage.costUsd >= run.budgets.maxCostUsd) return "cost";
		if (
			run.budgets.maxDurationMs !== undefined &&
			run.startedAt !== undefined &&
			at - run.startedAt >= run.budgets.maxDurationMs
		) return "duration";
		if (
			run.budgets.maxConcurrency !== undefined &&
			run.usage.activeAttempts >= run.budgets.maxConcurrency
		) return "concurrency";
		if (
			run.budgets.maxAttempts !== undefined &&
			run.usage.attempts >= run.budgets.maxAttempts &&
			!(options.allowReservedAttemptsToFinish === true && run.usage.activeAttempts > 0)
		) return "attempts";
		return undefined;
	}

	private taskAttempts(taskId: TaskId): TaskAttempt[] {
		return [...this.attempts.values()]
			.filter((attempt) => attempt.taskId === taskId)
			.sort((a, b) => a.number - b.number);
	}

	private verifyLease(
		attempt: TaskAttempt,
		leaseToken: string,
		fence: number,
		at: number,
		allowed: ReadonlySet<AttemptStatus> = LIVE_ATTEMPT_STATUSES,
	): void {
		if (!allowed.has(attempt.status)) {
			throw new CollaborationConflictError("STALE_ATTEMPT", `attempt ${attempt.id} is ${attempt.status}`);
		}
		if (attempt.lease.token !== leaseToken || attempt.lease.fence !== fence) {
			throw new CollaborationConflictError("FENCE_MISMATCH", `attempt ${attempt.id} lease is stale`);
		}
		if (attempt.lease.expiresAt <= at) {
			throw new CollaborationConflictError("LEASE_EXPIRED", `attempt ${attempt.id} lease expired`);
		}
	}

	private addUsage(run: TeamRun, attempt: TaskAttempt, usage: { tokens?: number; costUsd?: number; costComplete?: boolean } | undefined): void {
		if (attempt.usageRecorded) {
			throw new CollaborationConflictError("USAGE_ALREADY_RECORDED", `attempt ${attempt.id} usage was already recorded`);
		}
		const tokens = usage?.tokens ?? 0;
		const costUsd = usage?.costUsd ?? 0;
		const costComplete = usage?.costComplete ?? true;
		if (!Number.isSafeInteger(tokens) || tokens < 0) {
			throw new CollaborationConflictError("INVALID_ARGUMENT", "usage.tokens must be a non-negative safe integer");
		}
		finiteNonNegative(costUsd, "usage.costUsd");
		attempt.usage.tokens = tokens;
		attempt.usage.costUsd = costUsd;
		attempt.usage.costComplete = costComplete;
		attempt.usageRecorded = true;
		run.usage.tokens += tokens;
		run.usage.costUsd += costUsd;
		run.usage.costComplete = (run.usage.costComplete ?? true) && costComplete;
		run.usage.activeAttempts = Math.max(0, run.usage.activeAttempts - 1);
	}

	private dependenciesFor(task: TeamTask): TeamTask[] {
		return task.dependencies.map(({ taskId }) => this.taskOrThrow(taskId));
	}

	/** Validate the opt-in independent review topology against the complete
	 * authority graph. Planned assignments establish the policy before work
	 * starts; persisted attempt identities make the check fail closed after
	 * handoffs or recovery. */
	private independentReviewPolicyFailure(
		runId: RunId,
		additions: readonly TeamTask[] = [],
		assignmentOverrides: ReadonlyMap<TaskId, string> = new Map(),
	): string | undefined {
		const tasks = new Map<TaskId, TeamTask>();
		for (const task of this.tasks.values()) {
			if (task.runId === runId) tasks.set(task.id, task);
		}
		for (const task of additions) {
			if (task.runId === runId) tasks.set(task.id, task);
		}
		const childrenByParent = new Map<TaskId, TeamTask[]>();
		for (const task of tasks.values()) {
			if (!task.parentTaskId) continue;
			const children = childrenByParent.get(task.parentTaskId) ?? [];
			children.push(task);
			childrenByParent.set(task.parentTaskId, children);
		}
		const assignedAgent = (task: TeamTask): string | undefined =>
			assignmentOverrides.get(task.id) ?? task.assignedAgentId;

		for (const review of tasks.values()) {
			if (review.resultGate && (
				review.resultGate.kind !== "review_verdict"
				|| (review.resultGate.policy !== undefined && review.resultGate.policy !== "independent-v1")
			)) {
				return `task ${review.id} has an unsupported result gate`;
			}
			if (review.resultGate?.policy !== "independent-v1") continue;
			const reviewerAgentId = assignedAgent(review);
			if (!reviewerAgentId) {
				return `independent review task ${review.id} requires an explicit assignedAgentId`;
			}
			if (review.dependencies.length === 0) {
				return `independent review task ${review.id} requires at least one direct dependency`;
			}
			if (review.join.kind !== "all") {
				return `independent review task ${review.id} requires an all join`;
			}

			const contributors = new Map<TaskId, TeamTask>();
			const pending = review.dependencies.map(({ taskId }) => taskId);
			while (pending.length > 0) {
				const taskId = pending.pop()!;
				if (contributors.has(taskId)) continue;
				const contributor = tasks.get(taskId);
				if (!contributor) {
					return `independent review task ${review.id} has unknown contributor ${taskId}`;
				}
				contributors.set(taskId, contributor);
				for (const dependency of contributor.dependencies) pending.push(dependency.taskId);
				for (const child of childrenByParent.get(taskId) ?? []) pending.push(child.id);
			}

			for (const contributor of contributors.values()) {
				const plannedAgentId = assignedAgent(contributor);
				if (!plannedAgentId) {
					return `independent review contributor ${contributor.id} requires an explicit assignedAgentId`;
				}
				if (plannedAgentId === reviewerAgentId) {
					return `independent reviewer ${reviewerAgentId} must differ from contributor ${contributor.id}`;
				}
				for (const attempt of this.taskAttempts(contributor.id)) {
					const actualAgentId: string = attempt.agentId ?? plannedAgentId;
					if (actualAgentId === reviewerAgentId) {
						return `independent reviewer ${reviewerAgentId} already contributed through attempt ${attempt.id}`;
					}
				}
			}
		}
		return undefined;
	}

	private assertIndependentReviewPolicies(
		runId: RunId,
		additions: readonly TeamTask[] = [],
		assignmentOverrides: ReadonlyMap<TaskId, string> = new Map(),
	): void {
		const failure = this.independentReviewPolicyFailure(runId, additions, assignmentOverrides);
		if (failure) throw new CollaborationConflictError("INVALID_REVIEW_POLICY", failure);
	}

	private cancelLiveAttemptForTask(task: TeamTask, at: number, reason: string): void {
		const run = this.runOrThrow(task.runId);
		for (const attempt of this.taskAttempts(task.id)) {
			if (!LIVE_ATTEMPT_STATUSES.has(attempt.status)) continue;
			attempt.status = "cancelled";
			attempt.errorMessage = reason;
			attempt.finishedAt = at;
			attempt.updatedAt = at;
			attempt.usageDueAt = at + TERMINAL_USAGE_SETTLEMENT_GRACE_MS;
			run.usage.activeAttempts = Math.max(0, run.usage.activeAttempts - 1);
			this.emit("attempt.cancelled", run.roomId, at, {
				runId: run.id,
				taskId: task.id,
				attemptId: attempt.id,
				payload: { reason },
			});
		}
	}

	private markTaskCancelled(
		task: TeamTask,
		at: number,
		reason: string,
		options: { cancelledByJoin?: TaskId } = {},
	): void {
		if (isTerminalTask(task)) return;
		const run = this.runOrThrow(task.runId);
		this.cancelLiveAttemptForTask(task, at, reason);
		task.status = "cancelled";
		task.failureReason = reason;
		task.cancelledByJoin = options.cancelledByJoin;
		task.nextAttemptAt = undefined;
		task.updatedAt = at;
		this.emit("task.cancelled", run.roomId, at, {
			runId: run.id,
			taskId: task.id,
			payload: { reason },
		});
		for (const approval of this.approvals.values()) {
			if (approval.taskId === task.id && approval.status === "pending") {
				approval.status = "cancelled";
				approval.updatedAt = at;
				approval.resolvedAt = at;
				this.emit("approval.cancelled", run.roomId, at, {
					runId: run.id,
					taskId: task.id,
					attemptId: approval.attemptId,
					payload: { approvalId: approval.id, reason },
				});
			}
		}
		for (const handoff of this.handoffs.values()) {
			if (handoff.taskId === task.id && handoff.status === "offered") {
				handoff.status = "cancelled";
				handoff.reason ??= reason;
				handoff.updatedAt = at;
				handoff.resolvedAt = at;
				this.emit("handoff.cancelled", run.roomId, at, {
					runId: run.id,
					taskId: task.id,
					attemptId: handoff.fromAttemptId,
					payload: { handoffId: handoff.id, reason },
				});
			}
		}
		for (const child of this.tasks.values()) {
			if (child.runId === task.runId && child.parentTaskId === task.id && !isTerminalTask(child)) {
				this.markTaskCancelled(child, at, `delegating parent ${task.id} was cancelled`);
			}
		}
	}

	private applyJoinCancellation(task: TeamTask, at: number): void {
		if (task.join.kind === "all" || task.join.cancelRemaining !== true) return;
		for (const dependency of this.dependenciesFor(task)) {
			if (dependency.status === "succeeded" || isTerminalTask(dependency)) continue;
			// A dependency can feed more than one join. cancelRemaining is an
			// optimization for work made redundant by this join, not permission to
			// make another still-blocked consumer impossible.
			const stillNeededElsewhere = [...this.tasks.values()].some((consumer) =>
				consumer.runId === task.runId &&
				consumer.id !== task.id &&
				consumer.status === "blocked" &&
				consumer.dependencies.some(({ taskId }) => taskId === dependency.id),
			);
			if (stillNeededElsewhere) continue;
			this.markTaskCancelled(dependency, at, `join for ${task.id} was satisfied`, {
				cancelledByJoin: task.id,
			});
		}
	}

	private refreshTaskReadiness(runId: RunId, at: number): void {
		const run = this.runOrThrow(runId);
		if (run.status !== "running") return;
		let changed = true;
		while (changed) {
			changed = false;
			for (const parent of this.tasks.values()) {
				if (parent.runId !== runId || parent.status !== "waiting_children") continue;
				const delegatedAttempt = this.taskAttempts(parent.id)
					.slice()
					.reverse()
					.find((attempt) => attempt.status === "delegated");
				if (!delegatedAttempt || delegatedAttempt.usageRecorded !== true) continue;
				const children = [...this.tasks.values()].filter(
					(task) => task.runId === runId && task.delegatedByAttemptId === delegatedAttempt.id,
				);
				if (children.length === 0 || children.some((child) => !isTerminalTask(child))) continue;
				parent.status = "ready";
				parent.nextAttemptAt = at;
				parent.failureReason = undefined;
				parent.updatedAt = at;
				this.emit("task.children_settled", run.roomId, at, {
					runId,
					taskId: parent.id,
					attemptId: delegatedAttempt.id,
					payload: {
						childTaskIds: children.map((child) => child.id),
						failedChildTaskIds: children
							.filter((child) => child.status !== "succeeded")
							.map((child) => child.id),
					},
				});
				this.emit("task.ready", run.roomId, at, {
					runId,
					taskId: parent.id,
					payload: { resumedAfterDelegation: true, delegatedByAttemptId: delegatedAttempt.id },
				});
				changed = true;
			}
			const candidates = [...this.tasks.values()].filter(
				(task) => task.runId === runId && (task.status === "blocked" || task.status === "ready"),
			);
			for (const task of candidates) {
				const evaluation = evaluateJoinCondition(task.join, this.dependenciesFor(task));
				if (evaluation === "satisfied") {
					if (task.status !== "ready") {
						this.applyJoinCancellation(task, at);
						task.status = "ready";
						task.updatedAt = at;
						this.emit("task.ready", run.roomId, at, { runId, taskId: task.id });
						changed = true;
					}
				} else if (evaluation === "impossible") {
					task.status = "skipped";
					task.failureReason = "dependency join condition became impossible";
					task.updatedAt = at;
					this.emit("task.skipped", run.roomId, at, {
						runId,
						taskId: task.id,
						payload: { reason: task.failureReason },
					});
					changed = true;
				}
			}
		}
	}

	private finishRunIfTerminal(runId: RunId, at: number): "completed" | "failed" | undefined {
		const run = this.runOrThrow(runId);
		if (run.status !== "running") return undefined;
		const tasks = [...this.tasks.values()].filter((task) => task.runId === runId);
		if (tasks.length === 0 || tasks.some((task) => !isTerminalTask(task))) return undefined;
		// A join/cancel/handoff can terminalize the task graph while its provider
		// call is still unwinding. Do not publish success until every started call
		// has either reported usage or been reconciled as deliberately unknown.
		if ([...this.attempts.values()].some((attempt) => attempt.runId === runId && attempt.usageRecorded !== true)) {
			return undefined;
		}
		const failed = tasks.some(
			(task) =>
				task.status === "failed" ||
				task.status === "skipped" ||
				(task.status === "cancelled" && task.cancelledByJoin === undefined),
		);
		run.status = failed ? "failed" : "completed";
		run.updatedAt = at;
		run.finishedAt = at;
		run.usage.finishedAt = at;
		if (failed) run.failureReason ??= "one or more tasks did not succeed";
		this.emit(failed ? "run.failed" : "run.completed", run.roomId, at, {
			runId,
			payload: failed ? { reason: run.failureReason } : {},
		});
		return failed ? "failed" : "completed";
	}

	private stopRunForBudget(run: TeamRun, reason: Exclude<ReturnType<InMemoryCollaborationStore["budgetBlock"]>, undefined>, at: number): void {
		if (reason === "concurrency") return;
		for (const task of this.tasks.values()) {
			if (task.runId === run.id && !isTerminalTask(task)) {
				this.markTaskCancelled(task, at, `run budget exhausted: ${reason}`);
			}
		}
		if (run.status === "running") {
			run.status = "failed";
			run.failureReason = `run budget exhausted: ${reason}`;
			run.finishedAt = at;
			run.updatedAt = at;
			run.usage.finishedAt = at;
			this.emit("run.failed", run.roomId, at, { runId: run.id, payload: { reason: run.failureReason } });
		}
	}

	private failCompletedRunForLateBudget(
		run: TeamRun,
		reason: Exclude<ReturnType<InMemoryCollaborationStore["terminalBudgetViolation"]>, undefined>,
		at: number,
	): void {
		if (run.status !== "completed") return;
		run.status = "failed";
		run.failureReason = `run budget exhausted: ${reason}`;
		run.updatedAt = Math.max(run.updatedAt, at);
		run.finishedAt ??= at;
		run.usage.finishedAt ??= run.finishedAt;
		this.emit("run.failed", run.roomId, at, {
			runId: run.id,
			payload: { reason: run.failureReason, correctedAfterLateUsage: true },
		});
	}

	/**
	 * A completed run may consume exactly its token/cost/attempt allowance, but it
	 * must not finish beyond a hard ceiling. Unknown cost remains fail-closed even
	 * when the result happened to be the last task in the graph.
	 */
	private terminalBudgetViolation(
		run: TeamRun,
		at: number,
	): "tokens" | "cost" | "cost_unknown" | "duration" | "attempts" | undefined {
		if (run.budgets.maxTokens !== undefined && run.usage.tokens > run.budgets.maxTokens) {
			return "tokens";
		}
		if (run.budgets.maxCostUsd !== undefined && run.usage.costComplete === false) {
			return "cost_unknown";
		}
		if (run.budgets.maxCostUsd !== undefined && run.usage.costUsd > run.budgets.maxCostUsd) {
			return "cost";
		}
		if (
			run.budgets.maxDurationMs !== undefined &&
			run.startedAt !== undefined &&
			at - run.startedAt >= run.budgets.maxDurationMs
		) {
			return "duration";
		}
		if (run.budgets.maxAttempts !== undefined && run.usage.attempts > run.budgets.maxAttempts) {
			return "attempts";
		}
		return undefined;
	}

	private hasTerminalTaskGraph(runId: RunId): boolean {
		const tasks = [...this.tasks.values()].filter((task) => task.runId === runId);
		return tasks.length > 0 && tasks.every(isTerminalTask);
	}

	private scheduleOrFailTask(
		task: TeamTask,
		attempt: TaskAttempt,
		at: number,
		options: { retryable: boolean; retryDelayMs?: number },
	): "retried" | "failed" {
		const run = this.runOrThrow(task.runId);
		const mayRetry = options.retryable && attempt.number < task.retry.maxAttempts;
		if (mayRetry) {
			const delay = options.retryDelayMs ?? task.retry.backoffMs ?? 0;
			finiteNonNegative(delay, "retry delay");
			task.status = "ready";
			task.nextAttemptAt = at + delay;
			task.failureReason = attempt.errorMessage;
			task.updatedAt = at;
			this.emit("task.retry_scheduled", run.roomId, at, {
				runId: run.id,
				taskId: task.id,
				attemptId: attempt.id,
				payload: { nextAttemptAt: task.nextAttemptAt, attemptNumber: attempt.number + 1 },
			});
			return "retried";
		}
		task.status = "failed";
		task.failureReason = attempt.errorMessage ?? "task attempt failed";
		task.nextAttemptAt = undefined;
		task.updatedAt = at;
		this.emit("task.failed", run.roomId, at, {
			runId: run.id,
			taskId: task.id,
			attemptId: attempt.id,
			payload: { reason: task.failureReason },
		});
		return "failed";
	}

	private assertAcyclic(runId: RunId, proposed: readonly TeamTask[]): void {
		const all = new Map<TaskId, TeamTask>();
		for (const task of this.tasks.values()) if (task.runId === runId) all.set(task.id, task);
		for (const task of proposed) all.set(task.id, task);
		const visiting = new Set<TaskId>();
		const visited = new Set<TaskId>();
		const visit = (taskId: TaskId): void => {
			if (visited.has(taskId)) return;
			if (visiting.has(taskId)) {
				throw new CollaborationConflictError("DAG_CYCLE", `task dependency cycle includes ${taskId}`);
			}
			visiting.add(taskId);
			const task = all.get(taskId);
			for (const dependency of task?.dependencies ?? []) visit(dependency.taskId);
			visiting.delete(taskId);
			visited.add(taskId);
		};
		for (const taskId of all.keys()) visit(taskId);
	}

	/** Validate both ordinary DAG edges and the implicit parent-waits-for-child
	 * edge introduced by worker delegation. */
	private assertDelegationAcyclic(runId: RunId, proposed: readonly TeamTask[]): void {
		const all = new Map<TaskId, TeamTask>();
		for (const task of this.tasks.values()) if (task.runId === runId) all.set(task.id, task);
		for (const task of proposed) all.set(task.id, task);
		const children = new Map<TaskId, TaskId[]>();
		for (const task of all.values()) {
			if (task.parentTaskId) {
				const rows = children.get(task.parentTaskId) ?? [];
				rows.push(task.id);
				children.set(task.parentTaskId, rows);
			}
		}
		const visiting = new Set<TaskId>();
		const visited = new Set<TaskId>();
		const visit = (taskId: TaskId): void => {
			if (visited.has(taskId)) return;
			if (visiting.has(taskId)) {
				throw new CollaborationConflictError("DELEGATION_CYCLE", `delegation cycle includes ${taskId}`);
			}
			visiting.add(taskId);
			const task = all.get(taskId);
			for (const dependency of task?.dependencies ?? []) visit(dependency.taskId);
			for (const childId of children.get(taskId) ?? []) visit(childId);
			visiting.delete(taskId);
			visited.add(taskId);
		};
		for (const taskId of all.keys()) visit(taskId);
	}

	async createRoom(command: CreateRoomCommand): Promise<CommandResult<CollaborationRoom>> {
		return this.command("createRoom", command, (at) => {
			const id = command.roomId ?? randomUUID();
			if (this.rooms.has(id)) throw new CollaborationConflictError("ROOM_EXISTS", `room already exists: ${id}`);
			if (!command.title.trim()) throw new CollaborationConflictError("INVALID_ARGUMENT", "room title is required");
			const members = this.materializeMembers(command.members, at);
			const metadata = clone(command.metadata ?? {});
			validateRoomCoordinatorInvariant(members, metadata);
			const room: CollaborationRoom = {
				id,
				title: command.title.trim(),
				createdBy: command.createdBy,
				status: "open",
				members,
				metadata,
				createdAt: at,
				updatedAt: at,
			};
			this.rooms.set(id, room);
			this.emit("room.created", id, at, { payload: { title: room.title } });
			return room;
		});
	}

	async updateRoom(command: UpdateRoomCommand): Promise<CommandResult<CollaborationRoom>> {
		return this.command("updateRoom", command, (at) => {
			const room = this.roomOrThrow(command.roomId);
			if (room.status !== "open") throw new CollaborationConflictError("ROOM_ARCHIVED", "archived room is immutable");
			const nextMembers = command.members === undefined
				? room.members
				: this.materializeMembers(command.members, at, room.members);
			const nextMetadata = command.metadata === undefined ? room.metadata : clone(command.metadata);
			validateRoomCoordinatorInvariant(nextMembers, nextMetadata);
			if (command.title !== undefined) {
				if (!command.title.trim()) throw new CollaborationConflictError("INVALID_ARGUMENT", "room title is required");
				room.title = command.title.trim();
			}
			if (command.members !== undefined) {
				const memberIds = new Set(nextMembers.map((member) => member.agentId));
				const activeRunIds = new Set(
					[...this.runs.values()]
						.filter((run) => run.roomId === room.id && (run.status === "created" || run.status === "running"))
						.map((run) => run.id),
				);
				const assigned = [...this.tasks.values()].find(
					(task) =>
						activeRunIds.has(task.runId) &&
						!isTerminalTask(task) &&
						task.assignedAgentId !== undefined &&
						!memberIds.has(task.assignedAgentId),
				);
				if (assigned?.assignedAgentId) {
					throw new CollaborationConflictError(
						"ROOM_MEMBER_IN_USE",
						`cannot remove agent ${assigned.assignedAgentId}; active task ${assigned.id} is assigned to it`,
					);
				}
				room.members = nextMembers;
			}
			if (command.metadata !== undefined) room.metadata = nextMetadata;
			room.updatedAt = at;
			this.emit("room.updated", room.id, at);
			return room;
		});
	}

	async archiveRoom(command: ArchiveRoomCommand): Promise<CommandResult<CollaborationRoom>> {
		return this.command("archiveRoom", command, (at) => {
			const room = this.roomOrThrow(command.roomId);
			const active = [...this.runs.values()].some(
				(run) => run.roomId === room.id && (run.status === "created" || run.status === "running"),
			);
			if (active) throw new CollaborationConflictError("ROOM_HAS_ACTIVE_RUNS", "cancel or finish active runs first");
			room.status = "archived";
			room.updatedAt = at;
			this.emit("room.archived", room.id, at);
			return room;
		});
	}

	async listRooms(): Promise<CollaborationRoom[]> {
		return this.consistentRead(() => [...this.rooms.values()].sort(compareCreated));
	}

	async getRoom(roomId: RoomId): Promise<CollaborationRoom | undefined> {
		return this.consistentRead(() => this.rooms.get(roomId));
	}

	private prepareRun(
		command: CreateRunCommand | DelegateRunCommand,
		at: number,
	): { room: CollaborationRoom; run: TeamRun } {
		const room = this.roomOrThrow(command.roomId);
		if (room.status !== "open") {
			throw new CollaborationConflictError("ROOM_ARCHIVED", "cannot create a run in an archived room");
		}
		const active = [...this.runs.values()].find((candidate) =>
			candidate.roomId === room.id && (candidate.status === "created" || candidate.status === "running"));
		if (active) {
			throw new CollaborationConflictError(
				"ROOM_ACTIVE_RUN_EXISTS",
				`room already has active run ${active.id}`,
			);
		}
		const id = command.runId ?? randomUUID();
		if (this.runs.has(id)) throw new CollaborationConflictError("RUN_EXISTS", `run already exists: ${id}`);
		if (!command.objective.trim()) throw new CollaborationConflictError("INVALID_ARGUMENT", "run objective is required");
		const run: TeamRun = {
			id,
			roomId: room.id,
			status: "created",
			objective: command.objective.trim(),
			budgets: clone(command.budgets ?? {}),
			usage: { tokens: 0, costUsd: 0, attempts: 0, activeAttempts: 0 },
			createdBy: command.createdBy,
			metadata: clone(command.metadata ?? {}),
			createdAt: at,
			updatedAt: at,
		};
		this.validateRunBudgets(run);
		return { room, run };
	}

	private commitRun(room: CollaborationRoom, run: TeamRun, at: number): void {
		this.runs.set(run.id, run);
		this.emit("run.created", room.id, at, {
			runId: run.id,
			payload: { objective: run.objective },
		});
	}

	private startPreparedRun(run: TeamRun, at: number): TeamRun {
		if (run.status !== "created") {
			throw new CollaborationConflictError("INVALID_RUN_STATE", `run is ${run.status}`);
		}
		if (![...this.tasks.values()].some((task) => task.runId === run.id)) {
			throw new CollaborationConflictError("RUN_HAS_NO_TASKS", "cannot start a Team run without tasks");
		}
		this.assertIndependentReviewPolicies(run.id);
		run.status = "running";
		run.startedAt = at;
		run.usage.startedAt = at;
		run.updatedAt = at;
		this.emit("run.started", run.roomId, at, { runId: run.id });
		this.refreshTaskReadiness(run.id, at);
		return run;
	}

	async createRun(command: CreateRunCommand): Promise<CommandResult<TeamRun>> {
		return this.command("createRun", command, (at) => {
			const { room, run } = this.prepareRun(command, at);
			this.commitRun(room, run, at);
			return run;
		});
	}

	async delegateRun(command: DelegateRunCommand): Promise<CommandResult<DelegateRunResult>> {
		return this.command("delegateRun", command, (at) => {
			const commandBytes = semanticCommandByteLength(command);
			if (commandBytes > MAX_ATOMIC_DELEGATION_COMMAND_BYTES) {
				throw new CollaborationConflictError(
					"INVALID_ARGUMENT",
					`atomic delegation command is ${commandBytes} bytes; maximum is ${MAX_ATOMIC_DELEGATION_COMMAND_BYTES} bytes`,
				);
			}
			if (command.tasks.length > MAX_ATOMIC_DELEGATION_TASKS) {
				throw new CollaborationConflictError(
					"INVALID_ARGUMENT",
					`atomic delegation supports at most ${MAX_ATOMIC_DELEGATION_TASKS} tasks`,
				);
			}
			const { room, run } = this.prepareRun(command, at);
			const tasks = this.prepareTasks(run, command.tasks, at);

			// Nothing mutates until every run, budget, member, task, dependency,
			// join, retry, and DAG invariant above has passed.
			this.commitRun(room, run, at);
			this.commitTasks(run, tasks, at);
			this.startPreparedRun(run, at);
			return { run, tasks };
		});
	}

	async startRun(command: StartRunCommand): Promise<CommandResult<TeamRun>> {
		return this.command("startRun", command, (at) => {
			const run = this.runOrThrow(command.runId);
			return this.startPreparedRun(run, at);
		});
	}

	async listRuns(roomId?: RoomId): Promise<TeamRun[]> {
		return this.consistentRead(() =>
			[...this.runs.values()].filter((run) => roomId === undefined || run.roomId === roomId).sort(compareCreated),
		);
	}

	async getRun(runId: RunId): Promise<TeamRun | undefined> {
		return this.consistentRead(() => this.runs.get(runId));
	}

	async readRunSnapshot(runId: RunId): Promise<RunSnapshot | undefined> {
		return this.consistentRead(() => {
			const run = this.runs.get(runId);
			if (!run) return undefined;
			const room = this.roomOrThrow(run.roomId);
			return {
				room,
				run,
				tasks: [...this.tasks.values()].filter((task) => task.runId === runId).sort(compareTasks),
				attempts: [...this.attempts.values()].filter((attempt) => attempt.runId === runId).sort(compareAttempts),
				handoffs: [...this.handoffs.values()].filter((handoff) => handoff.runId === runId).sort(compareCreated),
				approvals: [...this.approvals.values()].filter((approval) => approval.runId === runId).sort(compareCreated),
				artifacts: [...this.artifacts.values()].filter((artifact) => artifact.runId === runId).sort(compareCreated),
				latestRoomSeq: this.roomSequences.get(room.id) ?? 0,
			};
		});
	}

	private taskFromDraft(run: TeamRun, draft: TaskDraft, id: TaskId, at: number): TeamTask {
		if (!draft.title.trim() || !draft.instructions.trim()) {
			throw new CollaborationConflictError("INVALID_ARGUMENT", "task title and instructions are required");
		}
		const dependencies = [...new Set(draft.dependencies ?? [])].map((taskId) => ({ taskId }));
		const join = clone(draft.join ?? { kind: "all" as const });
		validateJoin(join, dependencies.length);
		const retry = clone(draft.retry ?? { maxAttempts: 1 });
		positiveInt(retry.maxAttempts, "retry.maxAttempts");
		if (retry.backoffMs !== undefined) finiteNonNegative(retry.backoffMs, "retry.backoffMs");
		if (draft.resultGate && (
			draft.resultGate.kind !== "review_verdict"
			|| (draft.resultGate.policy !== undefined && draft.resultGate.policy !== "independent-v1")
		)) {
			throw new CollaborationConflictError("INVALID_REVIEW_POLICY", "unsupported task result gate");
		}
		const assignedAgentId = draft.assignedAgentId === undefined
			? undefined
			: this.assertRoomMember(run.roomId, draft.assignedAgentId, "assignedAgentId");
		return {
			id,
			runId: run.id,
			title: draft.title.trim(),
			instructions: draft.instructions.trim(),
			...(assignedAgentId ? { assignedAgentId } : {}),
			status: "blocked",
			dependencies,
			join,
			retry,
			...(draft.resultGate ? { resultGate: clone(draft.resultGate) } : {}),
			priority: draft.priority ?? 0,
			createdAt: at,
			updatedAt: at,
		};
	}

	private prepareTasks(run: TeamRun, drafts: readonly TaskDraft[], at: number): TeamTask[] {
		if (drafts.length === 0) {
			throw new CollaborationConflictError("INVALID_ARGUMENT", "at least one task is required");
		}
		const ids = drafts.map((draft) => draft.id ?? randomUUID());
		if (new Set(ids).size !== ids.length) {
			throw new CollaborationConflictError("TASK_EXISTS", "duplicate task id in command");
		}
		for (const id of ids) {
			if (this.tasks.has(id)) throw new CollaborationConflictError("TASK_EXISTS", `task already exists: ${id}`);
		}
		const proposed = drafts.map((draft, index) => this.taskFromDraft(run, draft, ids[index]!, at));
		const known = new Set([
			...[...this.tasks.values()].filter((task) => task.runId === run.id).map((task) => task.id),
			...ids,
		]);
		for (const task of proposed) {
			for (const dependency of task.dependencies) {
				if (dependency.taskId === task.id) {
					throw new CollaborationConflictError("DAG_CYCLE", `task ${task.id} depends on itself`);
				}
				if (!known.has(dependency.taskId)) {
					throw new CollaborationConflictError("UNKNOWN_DEPENDENCY", `unknown dependency: ${dependency.taskId}`);
				}
			}
		}
		this.assertAcyclic(run.id, proposed);
		this.assertIndependentReviewPolicies(run.id, proposed);
		return proposed;
	}

	private commitTasks(run: TeamRun, tasks: readonly TeamTask[], at: number): void {
		for (const task of tasks) {
			this.tasks.set(task.id, task);
			this.emit("task.created", run.roomId, at, {
				runId: run.id,
				taskId: task.id,
				payload: { title: task.title, assignedAgentId: task.assignedAgentId },
			});
		}
	}

	async addTasks(command: AddTasksCommand): Promise<CommandResult<TeamTask[]>> {
		return this.command("addTasks", command, (at) => {
			const run = this.runOrThrow(command.runId);
			if (run.status !== "created" && run.status !== "running") {
				throw new CollaborationConflictError("INVALID_RUN_STATE", `cannot add tasks to ${run.status} run`);
			}
			const proposed = this.prepareTasks(run, command.tasks, at);
			this.commitTasks(run, proposed, at);
			if (run.status === "running") this.refreshTaskReadiness(run.id, at);
			return proposed;
		});
	}

	async listTasks(runId: RunId): Promise<TeamTask[]> {
		return this.consistentRead(() => [...this.tasks.values()].filter((task) => task.runId === runId).sort(compareTasks));
	}

	async getTask(taskId: TaskId): Promise<TeamTask | undefined> {
		return this.consistentRead(() => this.tasks.get(taskId));
	}

	async claimReadyTask(command: ClaimReadyTaskCommand): Promise<CommandResult<TaskAttempt | undefined>> {
		return this.command("claimReadyTask", command, (at) => {
			positiveInt(command.leaseDurationMs, "leaseDurationMs");
			const candidates = [...this.tasks.values()]
				.filter((task) => {
					if (task.status !== "ready" || (task.nextAttemptAt ?? 0) > at) return false;
					if (command.runId !== undefined && task.runId !== command.runId) return false;
					if (command.taskId !== undefined && task.id !== command.taskId) return false;
					if (command.agentId !== undefined && task.assignedAgentId !== undefined && task.assignedAgentId !== command.agentId) return false;
					return this.runs.get(task.runId)?.status === "running";
				})
				.sort(compareTasks);
			for (const task of candidates) {
				const claimedAgentId = task.assignedAgentId ?? command.agentId;
				if (claimedAgentId && [...this.attempts.values()].some((attempt) => {
					if (!LIVE_ATTEMPT_STATUSES.has(attempt.status) || attempt.lease.expiresAt <= at) return false;
					return (attempt.agentId ?? this.tasks.get(attempt.taskId)?.assignedAgentId) === claimedAgentId;
				})) {
					// Enforced inside the authority transaction, not merely by one
					// runtime's process-local busy set, so shared Convex runtimes cannot
					// concurrently drive the same agent workspace.
					continue;
				}
				const run = this.runOrThrow(task.runId);
				const blocked = this.budgetBlock(run, at);
				if (blocked) {
					// An attempt slot is reserved when it is claimed. Reaching the
					// global attempt ceiling blocks further claims, but must not cancel
					// the final already-running attempt that consumed the reservation.
					if (blocked === "concurrency" || (blocked === "attempts" && run.usage.activeAttempts > 0)) {
						continue;
					}
					this.stopRunForBudget(run, blocked, at);
					continue;
				}
				const prior = this.taskAttempts(task.id);
				if (
					prior.length >= task.retry.maxAttempts
					&& prior.at(-1)?.status !== "handed_off"
					&& prior.at(-1)?.status !== "delegated"
				) {
					task.status = "failed";
					task.failureReason = "task attempt budget exhausted";
					task.updatedAt = at;
					this.emit("task.failed", run.roomId, at, { runId: run.id, taskId: task.id, payload: { reason: task.failureReason } });
					this.refreshTaskReadiness(run.id, at);
					this.finishRunIfTerminal(run.id, at);
					continue;
				}
				const number = prior.length + 1;
				const fence = (prior.at(-1)?.lease.fence ?? 0) + 1;
				const attempt: TaskAttempt = {
					id: randomUUID(),
					runId: run.id,
					taskId: task.id,
					...(claimedAgentId ? { agentId: claimedAgentId } : {}),
					number,
					status: "running",
					lease: {
						ownerId: command.workerId,
						token: randomUUID(),
						fence,
						expiresAt: at + command.leaseDurationMs,
					},
					...(command.runtimeRunId ? { runtimeRunId: command.runtimeRunId } : {}),
					usage: { tokens: 0, costUsd: 0 },
					startedAt: at,
					updatedAt: at,
				};
				this.attempts.set(attempt.id, attempt);
				task.status = "running";
				task.nextAttemptAt = undefined;
				task.updatedAt = at;
				run.usage.attempts += 1;
				run.usage.activeAttempts += 1;
				run.updatedAt = at;
				this.emit("attempt.claimed", run.roomId, at, {
					runId: run.id,
					taskId: task.id,
					attemptId: attempt.id,
					payload: { workerId: command.workerId, ...(claimedAgentId ? { agentId: claimedAgentId } : {}), fence, leaseExpiresAt: attempt.lease.expiresAt },
				});
				this.emit("task.started", run.roomId, at, { runId: run.id, taskId: task.id, attemptId: attempt.id });
				return attempt;
			}
			const concurrencyOnly = [...this.runs.values()].some((run) => {
				if (command.runId !== undefined && run.id !== command.runId) return false;
				return this.budgetBlock(run, at) === "concurrency";
			});
			if (concurrencyOnly && candidates.length > 0) throw new CollaborationBudgetError("concurrency");
			return undefined;
		});
	}

	async renewAttemptLease(command: RenewAttemptLeaseCommand): Promise<CommandResult<TaskAttempt>> {
		return this.command("renewAttemptLease", command, (at) => {
			positiveInt(command.leaseDurationMs, "leaseDurationMs");
			const attempt = this.attemptOrThrow(command.attemptId);
			this.verifyLease(attempt, command.leaseToken, command.fence, at);
			attempt.lease.expiresAt = at + command.leaseDurationMs;
			attempt.updatedAt = at;
			const run = this.runOrThrow(attempt.runId);
			this.emit("attempt.lease_renewed", run.roomId, at, {
				runId: run.id,
				taskId: attempt.taskId,
				attemptId: attempt.id,
				payload: { fence: attempt.lease.fence, leaseExpiresAt: attempt.lease.expiresAt },
			});
			return attempt;
		});
	}

	async completeAttempt(command: CompleteAttemptCommand): Promise<CommandResult<TaskAttempt>> {
		return this.command("completeAttempt", command, (at) => {
			const attempt = this.attemptOrThrow(command.attemptId);
			this.verifyLease(attempt, command.leaseToken, command.fence, at, new Set(["running"]));
			const task = this.taskOrThrow(attempt.taskId);
			const run = this.runOrThrow(attempt.runId);
			if (run.status !== "running" || task.status !== "running") {
				throw new CollaborationConflictError("STALE_ATTEMPT", "run or task is no longer active");
			}
			const topologyFailure = task.resultGate?.policy === "independent-v1"
				? this.independentReviewPolicyFailure(run.id)
				: undefined;
			const reviewerAttemptFailure = task.resultGate?.policy === "independent-v1"
				&& attempt.agentId !== task.assignedAgentId
				? `independent review attempt ${attempt.id} is not owned by assigned reviewer ${task.assignedAgentId ?? "<missing>"}`
				: undefined;
			const gateFailure = topologyFailure ?? reviewerAttemptFailure ?? taskResultGateFailure(
				task.resultGate,
				command.result,
				this.dependenciesFor(task),
			);
			if (gateFailure) {
				this.addUsage(run, attempt, command.usage);
				attempt.status = "failed";
				attempt.errorCode = "RESULT_GATE_FAILED";
				attempt.errorMessage = gateFailure;
				attempt.result = clone(command.result);
				attempt.finishedAt = at;
				attempt.updatedAt = at;
				this.emit("attempt.failed", run.roomId, at, {
					runId: run.id,
					taskId: task.id,
					attemptId: attempt.id,
					payload: { errorCode: "RESULT_GATE_FAILED", errorMessage: gateFailure },
				});
				this.scheduleOrFailTask(task, attempt, at, { retryable: false });
				task.result = clone(command.result);
				// A failed result gate is itself a durable review outcome. Preserve
				// completion-carried diagnostics (reports, logs, screenshots, and so
				// on) under the exact fenced attempt that produced the failing verdict.
				// This remains inside the semantic command transaction: an invalid or
				// duplicate artifact rolls the failed completion back in full.
				for (const artifactInput of command.artifacts ?? []) {
					this.insertArtifact({
						...artifactInput,
						id: artifactInput.id ?? randomUUID(),
						runId: run.id,
						taskId: task.id,
						attemptId: attempt.id,
						createdAt: at,
					}, at);
				}
				const block = this.budgetBlock(run, at, { allowReservedAttemptsToFinish: true });
				if (block && block !== "concurrency") this.stopRunForBudget(run, block, at);
				else {
					this.refreshTaskReadiness(run.id, at);
					this.finishRunIfTerminal(run.id, at);
				}
				return attempt;
			}
			this.addUsage(run, attempt, command.usage);
			attempt.status = "succeeded";
			attempt.result = clone(command.result);
			attempt.finishedAt = at;
			attempt.updatedAt = at;
			task.status = "succeeded";
			task.result = clone(command.result);
			task.updatedAt = at;
			run.updatedAt = at;
			this.emit("attempt.succeeded", run.roomId, at, { runId: run.id, taskId: task.id, attemptId: attempt.id });
			this.emit("task.succeeded", run.roomId, at, { runId: run.id, taskId: task.id, attemptId: attempt.id });
			for (const artifactInput of command.artifacts ?? []) {
				this.insertArtifact({
					...artifactInput,
					id: artifactInput.id ?? randomUUID(),
					runId: run.id,
					taskId: task.id,
					attemptId: attempt.id,
					createdAt: at,
				}, at);
			}
			this.refreshTaskReadiness(run.id, at);
			const terminal = this.hasTerminalTaskGraph(run.id);
			const block = terminal
				? this.terminalBudgetViolation(run, at)
				: this.budgetBlock(run, at, { allowReservedAttemptsToFinish: true });
			if (block && block !== "concurrency") this.stopRunForBudget(run, block, at);
			else this.finishRunIfTerminal(run.id, at);
			return attempt;
		});
	}

	async failAttempt(command: FailAttemptCommand): Promise<CommandResult<TaskAttempt>> {
		return this.command("failAttempt", command, (at) => {
			const attempt = this.attemptOrThrow(command.attemptId);
			this.verifyLease(attempt, command.leaseToken, command.fence, at);
			const task = this.taskOrThrow(attempt.taskId);
			const run = this.runOrThrow(attempt.runId);
			this.addUsage(run, attempt, command.usage);
			attempt.status = "failed";
			attempt.errorCode = command.errorCode;
			attempt.errorMessage = command.errorMessage;
			attempt.finishedAt = at;
			attempt.updatedAt = at;
			this.emit("attempt.failed", run.roomId, at, {
				runId: run.id,
				taskId: task.id,
				attemptId: attempt.id,
				payload: { errorCode: command.errorCode, errorMessage: command.errorMessage },
			});
			const retryable = command.retryable ?? (
				task.retry.retryableCodes === undefined ||
				(command.errorCode !== undefined && task.retry.retryableCodes.includes(command.errorCode))
			);
			this.scheduleOrFailTask(task, attempt, at, { retryable });
			const block = this.budgetBlock(run, at, { allowReservedAttemptsToFinish: true });
			if (block && block !== "concurrency") this.stopRunForBudget(run, block, at);
			else {
				this.refreshTaskReadiness(run.id, at);
				this.finishRunIfTerminal(run.id, at);
			}
			return attempt;
		});
	}

	async delegateAttemptChildren(
		command: DelegateAttemptChildrenCommand,
	): Promise<CommandResult<DelegateAttemptChildrenResult>> {
		return this.command("delegateAttemptChildren", command, (at) => {
			if (semanticCommandByteLength(command) > MAX_ATOMIC_DELEGATION_COMMAND_BYTES) {
				throw new CollaborationConflictError(
					"INVALID_ARGUMENT",
					`atomic delegation command exceeds ${MAX_ATOMIC_DELEGATION_COMMAND_BYTES} bytes`,
				);
			}
			if (command.tasks.length < 1 || command.tasks.length > MAX_DELEGATED_CHILDREN_PER_COMMAND) {
				throw new CollaborationConflictError(
					"INVALID_ARGUMENT",
					`worker delegation requires 1-${MAX_DELEGATED_CHILDREN_PER_COMMAND} child tasks`,
				);
			}
			const requestKey = command.requestKey.trim();
			if (!requestKey || requestKey.length > 128) {
				throw new CollaborationConflictError("INVALID_ARGUMENT", "requestKey must contain 1-128 characters");
			}
			const delegationKind = command.delegationKind ?? "subtask";
			if (delegationKind !== "subtask" && delegationKind !== "rework" && delegationKind !== "consultation") {
				throw new CollaborationConflictError("INVALID_ARGUMENT", "delegationKind must be subtask, rework, or consultation");
			}

			const attempt = this.attemptOrThrow(command.attemptId);
			// A retry by request key is allowed after the first command terminalized
			// the attempt, but it still has to prove the exact original capability.
			if (attempt.lease.token !== command.leaseToken || attempt.lease.fence !== command.fence) {
				throw new CollaborationConflictError("FENCE_MISMATCH", `attempt ${attempt.id} lease is stale`);
			}
			const requestHash = fingerprint({
				requestKey,
				delegationKind,
				tasks: command.tasks,
			});
			const existing = [...this.tasks.values()]
				.filter((task) => task.delegatedByAttemptId === attempt.id && task.requestKey === requestKey)
				.sort(compareTasks);
			if (existing.length > 0) {
				if (
					attempt.status !== "delegated"
					|| attempt.delegationRequestKey !== requestKey
					|| existing.length !== command.tasks.length
					|| existing.some((task) => task.delegationRequestHash !== requestHash)
				) {
					throw new CollaborationConflictError(
						"DELEGATION_REQUEST_CONFLICT",
						`requestKey ${requestKey} was already used for different child work`,
					);
				}
				return {
					parentTask: this.taskOrThrow(attempt.taskId),
					children: existing,
					yieldedAttempt: attempt,
					deduplicated: true,
				};
			}
			if (attempt.status === "delegated") {
				throw new CollaborationConflictError(
					"DELEGATION_REQUEST_CONFLICT",
					`attempt ${attempt.id} already yielded to another delegation request`,
				);
			}
			this.verifyLease(attempt, command.leaseToken, command.fence, at, new Set(["running"]));
			const parent = this.taskOrThrow(attempt.taskId);
			const run = this.runOrThrow(attempt.runId);
			if (run.status !== "running" || parent.status !== "running") {
				throw new CollaborationConflictError("STALE_ATTEMPT", "run or parent task is no longer active");
			}
			if ([...this.handoffs.values()].some(
				(handoff) => handoff.fromAttemptId === attempt.id && handoff.status === "offered",
			)) {
				throw new CollaborationConflictError("HANDOFF_PENDING", "resolve the ownership-transfer handoff before delegating child work");
			}

			let parentDepth = 0;
			let ancestor: TeamTask | undefined = parent;
			const ancestors = new Set<TaskId>();
			while (ancestor.parentTaskId !== undefined) {
				if (ancestors.has(ancestor.id)) {
					throw new CollaborationConflictError("DELEGATION_CYCLE", `delegation ancestry cycles at ${ancestor.id}`);
				}
				ancestors.add(ancestor.id);
				const next = this.taskOrThrow(ancestor.parentTaskId);
				if (next.runId !== run.id) {
					throw new CollaborationConflictError("DELEGATION_SCOPE_MISMATCH", "delegation ancestry crosses runs");
				}
				ancestor = next;
				parentDepth += 1;
			}
			const childDepth = parentDepth + 1;
			if (childDepth > MAX_DELEGATION_DEPTH) {
				throw new CollaborationConflictError(
					"DELEGATION_DEPTH_EXCEEDED",
					`worker delegation supports at most ${MAX_DELEGATION_DEPTH} nested levels`,
				);
			}
			const delegatedCount = [...this.tasks.values()].filter(
				(task) => task.runId === run.id && task.parentTaskId !== undefined,
			).length;
			if (delegatedCount + command.tasks.length > MAX_DELEGATED_CHILDREN_PER_RUN) {
				throw new CollaborationConflictError(
					"DELEGATION_LIMIT_EXCEEDED",
					`run supports at most ${MAX_DELEGATED_CHILDREN_PER_RUN} delegated child tasks`,
				);
			}
			const budgetBlock = this.budgetBlock(run, at, { allowReservedAttemptsToFinish: true });
			if (budgetBlock && budgetBlock !== "concurrency") throw new CollaborationBudgetError(budgetBlock);
			const futureAttemptClaims = command.tasks.length + 1;
			if (
				run.budgets.maxAttempts !== undefined
				&& run.usage.attempts + futureAttemptClaims > run.budgets.maxAttempts
			) {
				throw new CollaborationBudgetError("attempts");
			}

			const children = this.prepareTasks(run, command.tasks, at);
			for (const child of children) {
				child.parentTaskId = parent.id;
				child.delegatedByAttemptId = attempt.id;
				child.delegationKind = delegationKind;
				child.requestKey = requestKey;
				child.delegationRequestHash = requestHash;
				child.delegationDepth = childDepth;
			}
			this.assertDelegationAcyclic(run.id, children);
			this.assertIndependentReviewPolicies(run.id, children);

			attempt.status = "delegated";
			attempt.delegationRequestKey = requestKey;
			attempt.delegationKind = delegationKind;
			attempt.finishedAt = at;
			attempt.updatedAt = at;
			attempt.usageDueAt = at + TERMINAL_USAGE_SETTLEMENT_GRACE_MS;
			run.usage.activeAttempts = Math.max(0, run.usage.activeAttempts - 1);
			run.updatedAt = at;
			parent.status = "waiting_children";
			parent.nextAttemptAt = undefined;
			parent.updatedAt = at;
			this.commitTasks(run, children, at);
			this.emit("attempt.delegated", run.roomId, at, {
				runId: run.id,
				taskId: parent.id,
				attemptId: attempt.id,
				payload: { requestKey, delegationKind, childTaskIds: children.map((child) => child.id) },
			});
			this.emit("task.waiting_children", run.roomId, at, {
				runId: run.id,
				taskId: parent.id,
				attemptId: attempt.id,
				payload: { requestKey, delegationKind, childTaskIds: children.map((child) => child.id) },
			});
			this.refreshTaskReadiness(run.id, at);
			return { parentTask: parent, children, yieldedAttempt: attempt, deduplicated: false };
		});
	}

	async recordAttemptUsage(command: RecordAttemptUsageCommand): Promise<CommandResult<TaskAttempt>> {
		return this.command("recordAttemptUsage", command, (at) => {
			const attempt = this.attemptOrThrow(command.attemptId);
			if (attempt.lease.token !== command.leaseToken || attempt.lease.fence !== command.fence) {
				throw new CollaborationConflictError("FENCE_MISMATCH", `attempt ${attempt.id} lease is stale`);
			}
			if (LIVE_ATTEMPT_STATUSES.has(attempt.status)) {
				throw new CollaborationConflictError("ATTEMPT_STILL_ACTIVE", `attempt ${attempt.id} is still active`);
			}
			const tokens = command.usage.tokens ?? 0;
			const costUsd = command.usage.costUsd ?? 0;
			const costComplete = command.usage.costComplete ?? true;
			finiteNonNegative(tokens, "usage.tokens");
			finiteNonNegative(costUsd, "usage.costUsd");
			if (attempt.usageRecorded) {
				const same = attempt.usage.tokens === tokens &&
					attempt.usage.costUsd === costUsd &&
					(attempt.usage.costComplete ?? true) === costComplete;
				if (!same) {
					throw new CollaborationConflictError("USAGE_ALREADY_RECORDED", `attempt ${attempt.id} usage was already recorded`);
				}
				return attempt;
			}
			const run = this.runOrThrow(attempt.runId);
			attempt.usage = { tokens, costUsd, costComplete };
			attempt.usageRecorded = true;
			attempt.updatedAt = Math.max(attempt.updatedAt, at);
			run.usage.tokens += tokens;
			run.usage.costUsd += costUsd;
			run.usage.costComplete = (run.usage.costComplete ?? true) && costComplete;
			run.updatedAt = Math.max(run.updatedAt, at);
			this.emit("attempt.usage_recorded", run.roomId, at, {
				runId: run.id,
				taskId: attempt.taskId,
				attemptId: attempt.id,
				payload: { tokens, costUsd, costComplete },
			});
			if (run.status === "running") {
				const block = this.hasTerminalTaskGraph(run.id)
					? this.terminalBudgetViolation(run, at)
					: this.budgetBlock(run, at, { allowReservedAttemptsToFinish: true });
				if (block && block !== "concurrency") this.stopRunForBudget(run, block, at);
				else {
					this.refreshTaskReadiness(run.id, at);
					this.finishRunIfTerminal(run.id, at);
				}
			} else if (run.status === "completed") {
				// A cancelled, timed-out, or handed-off provider turn can settle only
				// after the useful task graph has completed. Its spend still belongs to
				// this run and may invalidate the earlier successful disposition.
				const block = this.terminalBudgetViolation(run, run.finishedAt ?? at);
				if (block) this.failCompletedRunForLateBudget(run, block, at);
			}
			return attempt;
		});
	}

	async cancelTask(command: CancelTaskCommand): Promise<CommandResult<TeamTask>> {
		return this.command("cancelTask", command, (at) => {
			const task = this.taskOrThrow(command.taskId);
			if (task.status === "succeeded" || task.status === "failed") {
				throw new CollaborationConflictError("TASK_TERMINAL", `task is already ${task.status}`);
			}
			this.markTaskCancelled(task, at, command.reason ?? "task cancelled");
			this.refreshTaskReadiness(task.runId, at);
			this.finishRunIfTerminal(task.runId, at);
			return task;
		});
	}

	async retryTask(command: RetryTaskCommand): Promise<CommandResult<TeamTask>> {
		return this.command("retryTask", command, (at) => {
			const task = this.taskOrThrow(command.taskId);
			const run = this.runOrThrow(task.runId);
			if (run.status !== "running" && run.status !== "failed") {
				throw new CollaborationConflictError("INVALID_RUN_STATE", `run is ${run.status}`);
			}
			if (!["failed", "cancelled", "skipped"].includes(task.status)) {
				throw new CollaborationConflictError("INVALID_TASK_STATE", `task is ${task.status}`);
			}
			if (task.parentTaskId !== undefined) {
				const parent = this.taskOrThrow(task.parentTaskId);
				const currentDelegation = this.taskAttempts(parent.id)
					.slice()
					.reverse()
					.find((attempt) => attempt.status === "delegated");
				if (
					parent.status !== "waiting_children"
					|| currentDelegation?.id !== task.delegatedByAttemptId
				) {
					throw new CollaborationConflictError(
						"DELEGATION_ALREADY_RETURNED",
						`delegated child ${task.id} already returned to parent ${parent.id}`,
					);
				}
			}
			const delay = command.delayMs ?? 0;
			finiteNonNegative(delay, "delayMs");
			const block = this.budgetBlock(run, at, { allowReservedAttemptsToFinish: true });
			if (block && block !== "concurrency") throw new CollaborationBudgetError(block);
			const evaluation = evaluateJoinCondition(task.join, this.dependenciesFor(task));
			if (evaluation === "impossible") throw new CollaborationConflictError("JOIN_IMPOSSIBLE", "dependencies cannot satisfy this task");
			if (run.status === "failed") {
				const competingRun = [...this.runs.values()].find((candidate) =>
					candidate.id !== run.id && candidate.roomId === run.roomId && ["created", "running"].includes(candidate.status));
				if (competingRun) {
					throw new CollaborationConflictError("ROOM_ACTIVE_RUN_EXISTS", `room ${run.roomId} already has active run ${competingRun.id}`);
				}
				run.status = "running";
				run.failureReason = undefined;
				run.finishedAt = undefined;
				run.usage.finishedAt = undefined;
				run.updatedAt = at;
				this.emit("run.started", run.roomId, at, { runId: run.id, payload: { resumed: true } });
			}
			const attempts = this.taskAttempts(task.id).length;
			if (attempts >= task.retry.maxAttempts) task.retry.maxAttempts = attempts + 1;
			task.status = evaluation === "satisfied" ? "ready" : "blocked";
			task.nextAttemptAt = at + delay;
			task.failureReason = undefined;
			task.result = undefined;
			task.cancelledByJoin = undefined;
			task.updatedAt = at;
			this.emit("task.retry_scheduled", run.roomId, at, {
				runId: run.id,
				taskId: task.id,
				payload: { nextAttemptAt: task.nextAttemptAt, manual: true },
			});
			// A failed upstream task may already have propagated `skipped` through
			// the DAG. Reopen only those dependency-derived descendants; their join
			// conditions will be re-evaluated as the retried branch settles.
			let changed = true;
			while (changed) {
				changed = false;
				for (const dependent of this.tasks.values()) {
					if (dependent.runId !== run.id || dependent.status !== "skipped") continue;
					if (dependent.failureReason !== "dependency join condition became impossible") continue;
					if (!dependent.dependencies.some(({ taskId }) => {
						const dependency = this.tasks.get(taskId);
						return dependency?.id === task.id || dependency?.status === "blocked";
					})) continue;
					dependent.status = "blocked";
					dependent.failureReason = undefined;
					dependent.result = undefined;
					dependent.updatedAt = at;
					this.emit("task.retry_scheduled", run.roomId, at, {
						runId: run.id,
						taskId: dependent.id,
						payload: { manual: true, reopenedByTaskId: task.id },
					});
					changed = true;
				}
			}
			return task;
		});
	}

	async cancelRun(command: CancelRunCommand): Promise<CommandResult<TeamRun>> {
		return this.command("cancelRun", command, (at) => {
			const run = this.runOrThrow(command.runId);
			if (run.status === "completed" || run.status === "failed") {
				throw new CollaborationConflictError("RUN_TERMINAL", `run is already ${run.status}`);
			}
			if (run.status === "cancelled") return run;
			const reason = command.reason ?? "run cancelled";
			for (const task of this.tasks.values()) {
				if (task.runId === run.id && !isTerminalTask(task)) this.markTaskCancelled(task, at, reason);
			}
			run.status = "cancelled";
			run.cancelReason = reason;
			run.finishedAt = at;
			run.updatedAt = at;
			run.usage.finishedAt = at;
			this.emit("run.cancelled", run.roomId, at, { runId: run.id, payload: { reason } });
			return run;
		});
	}

	async getAttempt(attemptId: AttemptId): Promise<TaskAttempt | undefined> {
		return this.consistentRead(() => this.attempts.get(attemptId));
	}

	async listAttempts(taskId: TaskId): Promise<TaskAttempt[]> {
		return this.consistentRead(() => this.taskAttempts(taskId));
	}

	async offerHandoff(command: OfferHandoffCommand): Promise<CommandResult<Handoff>> {
		return this.command("offerHandoff", command, (at) => {
			const attempt = this.attemptOrThrow(command.attemptId);
			this.verifyLease(attempt, command.leaseToken, command.fence, at, new Set(["running"]));
			const task = this.taskOrThrow(attempt.taskId);
			const run = this.runOrThrow(attempt.runId);
			if (task.assignedAgentId !== undefined && task.assignedAgentId !== command.fromAgentId) {
				throw new CollaborationConflictError("HANDOFF_SENDER_MISMATCH", "handoff sender does not own the task");
			}
			if (command.fromAgentId === command.toAgentId) throw new CollaborationConflictError("INVALID_HANDOFF", "handoff target must differ");
			const toAgentId = this.assertRoomMember(run.roomId, command.toAgentId, "toAgentId");
			const expiresAt = command.expiresAt ?? at + DEFAULT_DECISION_TIMEOUT_MS;
			if (expiresAt <= at || expiresAt > at + MAX_DECISION_TIMEOUT_MS) {
				throw new CollaborationConflictError("INVALID_HANDOFF", "handoff expiry must be in the future");
			}
			if ([...this.handoffs.values()].some((handoff) => handoff.fromAttemptId === attempt.id && handoff.status === "offered")) {
				throw new CollaborationConflictError("HANDOFF_PENDING", "attempt already has a pending handoff");
			}
			const handoff: Handoff = {
				id: command.handoffId ?? randomUUID(),
				runId: run.id,
				taskId: task.id,
				fromAttemptId: attempt.id,
				fromAgentId: command.fromAgentId,
				toAgentId,
				...(command.reason ? { reason: command.reason } : {}),
				status: "offered",
				createdAt: at,
				updatedAt: at,
				expiresAt,
			};
			if (this.handoffs.has(handoff.id)) throw new CollaborationConflictError("HANDOFF_EXISTS", `handoff exists: ${handoff.id}`);
			this.handoffs.set(handoff.id, handoff);
			this.emit("handoff.offered", run.roomId, at, {
				runId: run.id,
				taskId: task.id,
				attemptId: attempt.id,
				payload: { handoffId: handoff.id, fromAgentId: handoff.fromAgentId, toAgentId: handoff.toAgentId },
			});
			return handoff;
		});
	}

	async acceptHandoff(command: RespondHandoffCommand): Promise<CommandResult<Handoff>> {
		return this.command("acceptHandoff", command, (at) => {
			const handoff = this.handoffs.get(command.handoffId);
			if (!handoff) throw new CollaborationNotFoundError("handoff", command.handoffId);
			if (handoff.status !== "offered") throw new CollaborationConflictError("HANDOFF_RESOLVED", `handoff is ${handoff.status}`);
			if (handoff.toAgentId !== command.respondingAgentId) throw new CollaborationConflictError("HANDOFF_TARGET_MISMATCH", "only the target agent can accept");
			if (handoff.expiresAt !== undefined && handoff.expiresAt <= at) throw new CollaborationConflictError("HANDOFF_EXPIRED", "handoff expired");
			const attempt = this.attemptOrThrow(handoff.fromAttemptId);
			const task = this.taskOrThrow(handoff.taskId);
			const run = this.runOrThrow(handoff.runId);
			this.assertRoomMember(run.roomId, handoff.toAgentId, "toAgentId");
			if (!LIVE_ATTEMPT_STATUSES.has(attempt.status)) throw new CollaborationConflictError("STALE_ATTEMPT", `attempt is ${attempt.status}`);
			if (attempt.lease.expiresAt <= at) throw new CollaborationConflictError("LEASE_EXPIRED", "handoff source attempt lease expired");
			this.assertIndependentReviewPolicies(
				run.id,
				[],
				new Map([[task.id, handoff.toAgentId]]),
			);
			attempt.status = "handed_off";
			attempt.finishedAt = at;
			attempt.updatedAt = at;
			attempt.usageDueAt = at + TERMINAL_USAGE_SETTLEMENT_GRACE_MS;
			run.usage.activeAttempts = Math.max(0, run.usage.activeAttempts - 1);
			task.assignedAgentId = handoff.toAgentId;
			task.status = "ready";
			task.nextAttemptAt = at;
			task.updatedAt = at;
			handoff.status = "accepted";
			handoff.updatedAt = at;
			handoff.resolvedAt = at;
			this.emit("attempt.handed_off", run.roomId, at, {
				runId: run.id,
				taskId: task.id,
				attemptId: attempt.id,
				payload: { handoffId: handoff.id, toAgentId: handoff.toAgentId },
			});
			this.emit("handoff.accepted", run.roomId, at, {
				runId: run.id,
				taskId: task.id,
				attemptId: attempt.id,
				payload: { handoffId: handoff.id, toAgentId: handoff.toAgentId },
			});
			this.emit("task.handed_off", run.roomId, at, {
				runId: run.id,
				taskId: task.id,
				attemptId: attempt.id,
				payload: { toAgentId: handoff.toAgentId },
			});
			return handoff;
		});
	}

	async rejectHandoff(command: RespondHandoffCommand): Promise<CommandResult<Handoff>> {
		return this.command("rejectHandoff", command, (at) => {
			const handoff = this.handoffs.get(command.handoffId);
			if (!handoff) throw new CollaborationNotFoundError("handoff", command.handoffId);
			if (handoff.status !== "offered") throw new CollaborationConflictError("HANDOFF_RESOLVED", `handoff is ${handoff.status}`);
			if (handoff.toAgentId !== command.respondingAgentId) throw new CollaborationConflictError("HANDOFF_TARGET_MISMATCH", "only the target agent can reject");
			if (handoff.expiresAt !== undefined && handoff.expiresAt <= at) throw new CollaborationConflictError("HANDOFF_EXPIRED", "handoff expired");
			handoff.status = "rejected";
			handoff.reason = command.reason ?? handoff.reason;
			handoff.updatedAt = at;
			handoff.resolvedAt = at;
			const run = this.runOrThrow(handoff.runId);
			this.emit("handoff.rejected", run.roomId, at, {
				runId: run.id,
				taskId: handoff.taskId,
				attemptId: handoff.fromAttemptId,
				payload: { handoffId: handoff.id, reason: command.reason },
			});
			return handoff;
		});
	}

	async listHandoffs(runId: RunId): Promise<Handoff[]> {
		return this.consistentRead(() => [...this.handoffs.values()].filter((handoff) => handoff.runId === runId).sort(compareCreated));
	}

	async requestApproval(command: RequestApprovalCommand): Promise<CommandResult<TeamApproval>> {
		return this.command("requestApproval", command, (at) => {
			const attempt = this.attemptOrThrow(command.attemptId);
			this.verifyLease(attempt, command.leaseToken, command.fence, at, new Set(["running"]));
			const task = this.taskOrThrow(attempt.taskId);
			const run = this.runOrThrow(attempt.runId);
			if ([...this.approvals.values()].some((approval) => approval.attemptId === attempt.id && approval.status === "pending")) {
				throw new CollaborationConflictError("APPROVAL_PENDING", "attempt already has a pending approval");
			}
			const expiresAt = command.expiresAt ?? at + DEFAULT_DECISION_TIMEOUT_MS;
			if (expiresAt <= at || expiresAt > at + MAX_DECISION_TIMEOUT_MS) {
				throw new CollaborationConflictError("INVALID_APPROVAL", "approval expiry must be in the future");
			}
			const approval: TeamApproval = {
				id: command.approvalId ?? randomUUID(),
				runId: run.id,
				taskId: task.id,
				attemptId: attempt.id,
				kind: command.kind,
				prompt: command.prompt,
				status: "pending",
				requestedBy: command.requestedBy,
				createdAt: at,
				updatedAt: at,
				expiresAt,
			};
			if (this.approvals.has(approval.id)) throw new CollaborationConflictError("APPROVAL_EXISTS", `approval exists: ${approval.id}`);
			this.approvals.set(approval.id, approval);
			attempt.status = "waiting_approval";
			attempt.updatedAt = at;
			task.status = "waiting_approval";
			task.updatedAt = at;
			this.emit("approval.requested", run.roomId, at, {
				runId: run.id,
				taskId: task.id,
				attemptId: attempt.id,
				payload: { approvalId: approval.id, kind: approval.kind, prompt: approval.prompt },
			});
			return approval;
		});
	}

	async resolveApproval(command: ResolveApprovalCommand): Promise<CommandResult<TeamApproval>> {
		return this.command("resolveApproval", command, (at) => {
			const approval = this.approvals.get(command.approvalId);
			if (!approval) throw new CollaborationNotFoundError("approval", command.approvalId);
			if (approval.status !== "pending") throw new CollaborationConflictError("APPROVAL_RESOLVED", `approval is ${approval.status}`);
			if (approval.expiresAt !== undefined && approval.expiresAt <= at) throw new CollaborationConflictError("APPROVAL_EXPIRED", "approval expired");
			const attempt = this.attemptOrThrow(approval.attemptId);
			const task = this.taskOrThrow(approval.taskId);
			const run = this.runOrThrow(approval.runId);
			approval.status = command.decision;
			approval.resolution = command.resolution;
			approval.resolvedAt = at;
			approval.updatedAt = at;
			this.emit("approval.resolved", run.roomId, at, {
				runId: run.id,
				taskId: task.id,
				attemptId: attempt.id,
				payload: { approvalId: approval.id, decision: command.decision, resolution: command.resolution },
			});
			if (command.decision === "approved") {
				if (attempt.status !== "waiting_approval") throw new CollaborationConflictError("STALE_ATTEMPT", `attempt is ${attempt.status}`);
				if (attempt.lease.expiresAt <= at) {
					attempt.status = "lost";
					attempt.finishedAt = at;
					attempt.updatedAt = at;
					attempt.usageDueAt = at + TERMINAL_USAGE_SETTLEMENT_GRACE_MS;
					run.usage.activeAttempts = Math.max(0, run.usage.activeAttempts - 1);
					attempt.errorCode = "LEASE_EXPIRED";
					attempt.errorMessage = "approval resolved after attempt lease expired";
					const retryable = task.retry.retryableCodes === undefined ||
						task.retry.retryableCodes.includes("LEASE_EXPIRED");
					const outcome = this.scheduleOrFailTask(task, attempt, at, { retryable });
					this.settleUnknownAttemptUsage(attempt, at);
					if (outcome === "failed") {
						this.refreshTaskReadiness(run.id, at);
						this.finishRunIfTerminal(run.id, at);
					}
				} else {
					attempt.status = "running";
					attempt.updatedAt = at;
					task.status = "running";
					task.updatedAt = at;
				}
			} else {
				if (LIVE_ATTEMPT_STATUSES.has(attempt.status)) {
					attempt.status = "failed";
					attempt.errorCode = "APPROVAL_REJECTED";
					attempt.errorMessage = command.resolution ?? "approval rejected";
					attempt.finishedAt = at;
					attempt.updatedAt = at;
					attempt.usageDueAt = at + TERMINAL_USAGE_SETTLEMENT_GRACE_MS;
					run.usage.activeAttempts = Math.max(0, run.usage.activeAttempts - 1);
					this.scheduleOrFailTask(task, attempt, at, { retryable: false });
				}
				this.refreshTaskReadiness(run.id, at);
				this.finishRunIfTerminal(run.id, at);
			}
			return approval;
		});
	}

	async listApprovals(runId: RunId): Promise<TeamApproval[]> {
		return this.consistentRead(() => [...this.approvals.values()].filter((approval) => approval.runId === runId).sort(compareCreated));
	}

	private insertArtifact(artifact: Artifact, at: number): Artifact {
		if (this.artifacts.has(artifact.id)) throw new CollaborationConflictError("ARTIFACT_EXISTS", `artifact exists: ${artifact.id}`);
		const run = this.runOrThrow(artifact.runId);
		if (artifact.taskId !== undefined && this.taskOrThrow(artifact.taskId).runId !== run.id) {
			throw new CollaborationConflictError("ARTIFACT_SCOPE_MISMATCH", "artifact task belongs to another run");
		}
		if (artifact.attemptId !== undefined && this.attemptOrThrow(artifact.attemptId).runId !== run.id) {
			throw new CollaborationConflictError("ARTIFACT_SCOPE_MISMATCH", "artifact attempt belongs to another run");
		}
		this.artifacts.set(artifact.id, artifact);
		this.emit("artifact.created", run.roomId, at, {
			runId: run.id,
			...(artifact.taskId ? { taskId: artifact.taskId } : {}),
			...(artifact.attemptId ? { attemptId: artifact.attemptId } : {}),
			payload: { artifactId: artifact.id, kind: artifact.kind, name: artifact.name, uri: artifact.uri },
		});
		return artifact;
	}

	async addArtifact(command: AddArtifactCommand): Promise<CommandResult<Artifact>> {
		return this.command("addArtifact", command, (at) => {
			if ((command.leaseToken === undefined) !== (command.fence === undefined)) {
				throw new CollaborationConflictError("INVALID_ARGUMENT", "artifact leaseToken and fence must be supplied together");
			}
			if (command.attemptId !== undefined && command.leaseToken !== undefined && command.fence !== undefined) {
				const attempt = this.attemptOrThrow(command.attemptId);
				this.verifyLease(attempt, command.leaseToken, command.fence, at);
			}
			const artifact: Artifact = {
				id: command.artifactId ?? randomUUID(),
				runId: command.runId,
				...(command.taskId ? { taskId: command.taskId } : {}),
				...(command.attemptId ? { attemptId: command.attemptId } : {}),
				kind: command.kind,
				name: command.name,
				uri: command.uri,
				...(command.mimeType ? { mimeType: command.mimeType } : {}),
				...(command.bytes !== undefined ? { bytes: command.bytes } : {}),
				...(command.sha256 ? { sha256: command.sha256 } : {}),
				metadata: clone(command.metadata ?? {}),
				createdAt: at,
			};
			return this.insertArtifact(artifact, at);
		});
	}

	async listArtifacts(runId: RunId): Promise<Artifact[]> {
		return this.consistentRead(() => [...this.artifacts.values()].filter((artifact) => artifact.runId === runId).sort(compareCreated));
	}

	async postMessage(command: PostRoomMessageCommand): Promise<CommandResult<RoomMessage>> {
		return this.command("postMessage", command, (at) => {
			const room = this.roomOrThrow(command.roomId);
			if (room.status !== "open") {
				throw new CollaborationConflictError("ROOM_ARCHIVED", "cannot post to an archived room");
			}
			const authorId = command.authorId.trim();
			if (!authorId) throw new CollaborationConflictError("INVALID_ARGUMENT", "authorId is required");
			if (["agent", "coordinator"].includes(command.authorKind) && !room.members.some((member) => member.agentId === authorId)) {
				throw new CollaborationConflictError("AGENT_NOT_IN_ROOM", `agent ${authorId} is not a member of room ${room.id}`);
			}
			if (command.authorKind === "coordinator" && resolveRoomCoordinatorAgentId(room) !== authorId) {
				throw new CollaborationConflictError("NOT_ROOM_COORDINATOR", `agent ${authorId} is not the coordinator of room ${room.id}`);
			}
			const content = command.content.trim();
			if (!content) throw new CollaborationConflictError("INVALID_ARGUMENT", "message content is required");
			if (content.length > MAX_MESSAGE_CONTENT_CHARS) {
				throw new CollaborationConflictError("INVALID_ARGUMENT", `message content cannot exceed ${MAX_MESSAGE_CONTENT_CHARS} characters`);
			}
			const mentions = uniqueTrimmed(command.mentions ?? [], "mentions", MAX_MESSAGE_MENTIONS);
			const memberIds = new Set(room.members.map((member) => member.agentId));
			const unknownMention = mentions.find((agentId) => !memberIds.has(agentId));
			if (unknownMention) {
				throw new CollaborationConflictError("AGENT_NOT_IN_ROOM", `mentioned agent ${unknownMention} is not a member of room ${room.id}`);
			}

			let runId = command.runId;
			let taskId = command.taskId;
			let attemptId = command.attemptId;
			if (attemptId) {
				const attempt = this.attemptOrThrow(attemptId);
				if (attempt.runId !== runId && runId !== undefined) {
					throw new CollaborationConflictError("ATTEMPT_SCOPE_MISMATCH", "message attempt belongs to another run");
				}
				if (attempt.taskId !== taskId && taskId !== undefined) {
					throw new CollaborationConflictError("ATTEMPT_SCOPE_MISMATCH", "message attempt belongs to another task");
				}
				runId = attempt.runId;
				taskId = attempt.taskId;
				if (command.authorKind === "agent") {
					if (command.leaseToken === undefined || command.fence === undefined) {
						throw new CollaborationConflictError("FENCE_REQUIRED", "agent messages require an active attempt fence");
					}
					this.verifyLease(attempt, command.leaseToken, command.fence, at);
					if (attempt.agentId !== authorId) {
						throw new CollaborationConflictError("ATTEMPT_SCOPE_MISMATCH", "message author does not own this attempt");
					}
				}
			} else if (command.authorKind === "agent") {
				throw new CollaborationConflictError("FENCE_REQUIRED", "agent messages require an active attempt");
			}
			if (taskId) {
				const task = this.taskOrThrow(taskId);
				if (runId !== undefined && task.runId !== runId) {
					throw new CollaborationConflictError("TASK_SCOPE_MISMATCH", "message task belongs to another run");
				}
				runId = task.runId;
			}
			if (runId) {
				const run = this.runOrThrow(runId);
				if (run.roomId !== room.id) {
					throw new CollaborationConflictError("RUN_SCOPE_MISMATCH", "message run belongs to another room");
				}
			}

			let threadRootMessageId: MessageId | undefined;
			if (command.replyToMessageId) {
				const parent = this.messageOrThrow(command.replyToMessageId);
				if (parent.roomId !== room.id) {
					throw new CollaborationConflictError("MESSAGE_SCOPE_MISMATCH", "reply target belongs to another room");
				}
				threadRootMessageId = parent.threadRootMessageId ?? parent.id;
				if (command.threadRootMessageId && command.threadRootMessageId !== threadRootMessageId) {
					throw new CollaborationConflictError("THREAD_ROOT_MISMATCH", "thread root does not match reply target");
				}
			} else if (command.threadRootMessageId) {
				throw new CollaborationConflictError("INVALID_ARGUMENT", "threadRootMessageId requires replyToMessageId");
			}

			const attachments = validateMessageAttachments(command.attachments ?? []);
			for (const attachment of attachments) {
				if (!attachment.artifactId) continue;
				const artifact = this.artifacts.get(attachment.artifactId);
				if (!artifact) throw new CollaborationNotFoundError("artifact", attachment.artifactId);
				const artifactRun = this.runOrThrow(artifact.runId);
				if (artifactRun.roomId !== room.id) {
					throw new CollaborationConflictError("ARTIFACT_SCOPE_MISMATCH", "message attachment belongs to another room");
				}
			}

			const id = command.messageId ?? randomUUID();
			if (this.messages.has(id)) throw new CollaborationConflictError("MESSAGE_EXISTS", `message already exists: ${id}`);
			const message: RoomMessage = {
				id,
				roomId: room.id,
				authorId,
				authorKind: command.authorKind,
				source: command.source ?? "chat",
				content,
				mentions,
				attachments,
				reactions: [],
				...(command.replyToMessageId ? { replyToMessageId: command.replyToMessageId } : {}),
				...(threadRootMessageId ? { threadRootMessageId } : {}),
				...(runId ? { runId } : {}),
				...(taskId ? { taskId } : {}),
				...(attemptId ? { attemptId } : {}),
				createdAt: at,
				updatedAt: at,
			};
			this.messages.set(id, message);
			this.emit("message.posted", room.id, at, {
				...(runId ? { runId } : {}),
				...(taskId ? { taskId } : {}),
				...(attemptId ? { attemptId } : {}),
				payload: {
					messageId: id,
					authorId,
					authorKind: command.authorKind,
					source: message.source,
					mentions,
					...(threadRootMessageId ? { threadRootMessageId } : {}),
					attachmentCount: attachments.length,
				},
			});
			return message;
		});
	}

	async editMessage(command: EditRoomMessageCommand): Promise<CommandResult<RoomMessage>> {
		return this.command("editMessage", command, (at) => {
			const message = this.messageOrThrow(command.messageId);
			const room = this.roomOrThrow(message.roomId);
			if (room.status !== "open") throw new CollaborationConflictError("ROOM_ARCHIVED", "archived room is immutable");
			if (command.actorKind !== "owner" && message.authorId !== command.actorId) {
				throw new CollaborationConflictError("MESSAGE_AUTHOR_MISMATCH", "only the author or owner can edit this message");
			}
			if (message.deletedAt !== undefined) throw new CollaborationConflictError("MESSAGE_DELETED", "deleted messages cannot be edited");
			const content = command.content.trim();
			if (!content) throw new CollaborationConflictError("INVALID_ARGUMENT", "message content is required");
			if (content.length > MAX_MESSAGE_CONTENT_CHARS) {
				throw new CollaborationConflictError("INVALID_ARGUMENT", `message content cannot exceed ${MAX_MESSAGE_CONTENT_CHARS} characters`);
			}
			const mentions = uniqueTrimmed(command.mentions ?? [], "mentions", MAX_MESSAGE_MENTIONS);
			const members = new Set(room.members.map((member) => member.agentId));
			const unknownMention = mentions.find((agentId) => !members.has(agentId));
			if (unknownMention) throw new CollaborationConflictError("AGENT_NOT_IN_ROOM", `mentioned agent ${unknownMention} is not a member of room ${room.id}`);
			message.content = content;
			message.mentions = mentions;
			message.editedAt = at;
			message.updatedAt = at;
			this.emit("message.edited", room.id, at, { payload: { messageId: message.id, mentions } });
			return message;
		});
	}

	async deleteMessage(command: DeleteRoomMessageCommand): Promise<CommandResult<RoomMessage>> {
		return this.command("deleteMessage", command, (at) => {
			const message = this.messageOrThrow(command.messageId);
			const room = this.roomOrThrow(message.roomId);
			if (room.status !== "open") throw new CollaborationConflictError("ROOM_ARCHIVED", "archived room is immutable");
			if (command.actorKind !== "owner" && message.authorId !== command.actorId) {
				throw new CollaborationConflictError("MESSAGE_AUTHOR_MISMATCH", "only the author or owner can delete this message");
			}
			if (message.deletedAt === undefined) {
				message.content = "";
				message.mentions = [];
				message.attachments = [];
				message.deletedAt = at;
				message.updatedAt = at;
				this.emit("message.deleted", room.id, at, { payload: { messageId: message.id } });
			}
			return message;
		});
	}

	async reactMessage(command: ReactRoomMessageCommand): Promise<CommandResult<RoomMessage>> {
		return this.command("reactMessage", command, (at) => {
			const message = this.messageOrThrow(command.messageId);
			const room = this.roomOrThrow(message.roomId);
			if (room.status !== "open") throw new CollaborationConflictError("ROOM_ARCHIVED", "archived room is immutable");
			if (message.deletedAt !== undefined) throw new CollaborationConflictError("MESSAGE_DELETED", "deleted messages cannot be reacted to");
			if (command.actorKind === "agent" && !room.members.some((member) => member.agentId === command.actorId)) {
				throw new CollaborationConflictError("AGENT_NOT_IN_ROOM", `agent ${command.actorId} is not a member of room ${room.id}`);
			}
			const key = command.key.trim();
			if (!key || key.length > 64) throw new CollaborationConflictError("INVALID_ARGUMENT", "reaction key must contain 1-64 characters");
			let reaction = message.reactions.find((item) => item.key === key);
			const wasPresent = reaction?.actorIds.includes(command.actorId) ?? false;
			if (command.present && !wasPresent) {
				if (!reaction) {
					reaction = { key, actorIds: [] };
					message.reactions.push(reaction);
				}
				reaction.actorIds.push(command.actorId);
				reaction.actorIds.sort();
				message.reactions.sort((left, right) => left.key.localeCompare(right.key));
				message.updatedAt = at;
				this.emit("message.reacted", room.id, at, { payload: { messageId: message.id, actorId: command.actorId, key } });
			} else if (!command.present && wasPresent && reaction) {
				reaction.actorIds = reaction.actorIds.filter((actorId) => actorId !== command.actorId);
				if (reaction.actorIds.length === 0) message.reactions = message.reactions.filter((item) => item !== reaction);
				message.updatedAt = at;
				this.emit("message.unreacted", room.id, at, { payload: { messageId: message.id, actorId: command.actorId, key } });
			}
			return message;
		});
	}

	async pinMessage(command: PinRoomMessageCommand): Promise<CommandResult<RoomMessage>> {
		return this.command("pinMessage", command, (at) => {
			const message = this.messageOrThrow(command.messageId);
			const room = this.roomOrThrow(message.roomId);
			if (room.status !== "open") throw new CollaborationConflictError("ROOM_ARCHIVED", "archived room is immutable");
			if (message.deletedAt !== undefined) throw new CollaborationConflictError("MESSAGE_DELETED", "deleted messages cannot be pinned");
			const coordinator = typeof room.metadata.coordinatorAgentId === "string"
				? room.metadata.coordinatorAgentId
				: room.members.find((member) => member.role === "coordinator")?.agentId;
			if (command.actorKind !== "owner" && command.actorId !== coordinator && command.actorId !== room.createdBy) {
				throw new CollaborationConflictError("MESSAGE_PIN_FORBIDDEN", "only the owner or room coordinator can pin messages");
			}
			const isPinned = message.pinnedAt !== undefined;
			if (command.pinned !== isPinned) {
				if (command.pinned) {
					message.pinnedAt = at;
					message.pinnedBy = command.actorId;
				} else {
					delete message.pinnedAt;
					delete message.pinnedBy;
				}
				message.updatedAt = at;
				this.emit(command.pinned ? "message.pinned" : "message.unpinned", room.id, at, {
					payload: { messageId: message.id, actorId: command.actorId },
				});
			}
			return message;
		});
	}

	async getMessage(messageId: MessageId): Promise<RoomMessage | undefined> {
		return this.consistentRead(() => this.messages.get(messageId));
	}

	async listMessages(query: MessageQuery): Promise<RoomMessage[]> {
		return this.consistentRead(() => {
			this.roomOrThrow(query.roomId);
			if (query.rootOnly && query.threadRootMessageId) {
				throw new CollaborationConflictError("INVALID_ARGUMENT", "rootOnly and threadRootMessageId are mutually exclusive");
			}
			if (query.beforeMessageId && query.beforeCreatedAt !== undefined) {
				throw new CollaborationConflictError("INVALID_ARGUMENT", "beforeMessageId and beforeCreatedAt are mutually exclusive");
			}
			if (query.afterMessageId && query.afterCreatedAt !== undefined) {
				throw new CollaborationConflictError("INVALID_ARGUMENT", "afterMessageId and afterCreatedAt are mutually exclusive");
			}
			const beforeMessage = query.beforeMessageId ? this.messageOrThrow(query.beforeMessageId) : undefined;
			const afterMessage = query.afterMessageId ? this.messageOrThrow(query.afterMessageId) : undefined;
			for (const cursor of [beforeMessage, afterMessage]) {
				if (cursor && cursor.roomId !== query.roomId) {
					throw new CollaborationConflictError("MESSAGE_SCOPE_MISMATCH", "message cursor belongs to another room");
				}
			}
			const limit = Math.max(1, Math.min(query.limit ?? 100, 500));
			const values = [...this.messages.values()]
				.filter((message) => message.roomId === query.roomId)
				.filter((message) => query.includeDeleted === true || message.deletedAt === undefined)
				.filter((message) => query.threadRootMessageId === undefined || message.threadRootMessageId === query.threadRootMessageId)
				.filter((message) => query.rootOnly !== true || message.threadRootMessageId === undefined)
				.filter((message) => beforeMessage === undefined || compareCreated(message, beforeMessage) < 0)
				.filter((message) => afterMessage === undefined || compareCreated(message, afterMessage) > 0)
				.filter((message) => query.beforeCreatedAt === undefined || message.createdAt < query.beforeCreatedAt)
				.filter((message) => query.afterCreatedAt === undefined || message.createdAt > query.afterCreatedAt)
				.sort(compareCreated);
			return query.afterMessageId !== undefined || query.afterCreatedAt !== undefined
				? values.slice(0, limit)
				: values.slice(-limit);
		});
	}

	async searchMessages(query: MessageSearchQuery): Promise<RoomMessage[]> {
		return this.consistentRead(() => {
			this.roomOrThrow(query.roomId);
			const needle = normalizeSearchText(query.query.trim());
			if (!needle) throw new CollaborationConflictError("INVALID_ARGUMENT", "search query is required");
			const limit = Math.max(1, Math.min(query.limit ?? 50, 200));
			return [...this.messages.values()]
				.filter((message) => message.roomId === query.roomId && message.deletedAt === undefined)
				.filter((message) => query.authorId === undefined || message.authorId === query.authorId)
				.filter((message) => query.mentionAgentId === undefined || message.mentions.includes(query.mentionAgentId))
				.filter((message) => query.pinnedOnly !== true || message.pinnedAt !== undefined)
				.filter((message) => normalizeSearchText(message.content).includes(needle))
				.sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
				.slice(0, limit);
		});
	}

	async getRoomMetrics(roomId: RoomId): Promise<RoomMetrics> {
		return this.consistentRead(() => {
			this.roomOrThrow(roomId);
			const runs = [...this.runs.values()].filter((run) => run.roomId === roomId);
			const runIds = new Set(runs.map((run) => run.id));
			const tasks = [...this.tasks.values()].filter((task) => runIds.has(task.runId));
			const messages = [...this.messages.values()].filter((message) => message.roomId === roomId && message.deletedAt === undefined);
			const rootsWithReplies = new Set(messages.flatMap((message) => message.threadRootMessageId ? [message.threadRootMessageId] : []));
			return {
				messageCount: messages.length,
				threadCount: messages.filter((message) => message.threadRootMessageId === undefined)
					.filter((root) => rootsWithReplies.has(root.id)).length,
				mentionCount: messages.reduce((total, message) => total + message.mentions.length, 0),
				pinnedMessageCount: messages.filter((message) => message.pinnedAt !== undefined).length,
				activeRuns: runs.filter((run) => run.status === "created" || run.status === "running").length,
				pendingTasks: tasks.filter((task) => task.status === "blocked" || task.status === "ready" || task.status === "waiting_children" || task.status === "waiting_approval").length,
				runningTasks: tasks.filter((task) => task.status === "running").length,
				succeededTasks: tasks.filter((task) => task.status === "succeeded").length,
				failedTasks: tasks.filter((task) => task.status === "failed").length,
				pendingApprovals: [...this.approvals.values()].filter((approval) => runIds.has(approval.runId) && approval.status === "pending").length,
				openHandoffs: [...this.handoffs.values()].filter((handoff) => runIds.has(handoff.runId) && handoff.status === "offered").length,
				tokens: runs.reduce((total, run) => total + run.usage.tokens, 0),
				costUsd: runs.reduce((total, run) => total + run.usage.costUsd, 0),
				costComplete: runs.every((run) => run.usage.costComplete !== false),
			};
		});
	}

	async readEvents(query: EventQuery): Promise<CollaborationEvent[]> {
		return this.consistentRead(() => {
			const limit = Math.max(0, Math.min(query.limit ?? 500, 5_000));
			return this.events
				.filter((event) => query.roomId === undefined || event.roomId === query.roomId)
				.filter((event) => query.runId === undefined || event.runId === query.runId)
				.filter((event) => event.roomSeq > (query.afterRoomSeq ?? 0))
				.sort((a, b) => a.roomId.localeCompare(b.roomId) || a.roomSeq - b.roomSeq)
				.slice(0, limit);
		});
	}

	async claimOutbox(command: ClaimOutboxCommand): Promise<CommandResult<CollaborationOutboxItem[]>> {
		return this.command("claimOutbox", command, (at) => {
			positiveInt(command.leaseDurationMs, "leaseDurationMs");
			const limit = Math.max(1, Math.min(command.limit ?? 100, 1_000));
			const rows = [...this.outbox.values()];
			const eligible = [...this.outbox.values()]
				.filter((item) =>
					(item.status === "pending" && item.nextAttemptAt <= at) ||
					(item.status === "claimed" && (item.claimExpiresAt ?? 0) <= at),
				)
				// Never publish roomSeq N+1 while an earlier row in that room is
				// pending/claimed. Retry backoff must not reorder the durable stream.
				.filter((item) => !rows.some((prior) =>
					prior.event.roomId === item.event.roomId &&
					prior.event.roomSeq < item.event.roomSeq &&
					prior.status !== "acked" &&
					prior.status !== "dead",
				))
				.sort((a, b) =>
					a.nextAttemptAt - b.nextAttemptAt ||
					a.event.roomId.localeCompare(b.event.roomId) ||
					a.event.roomSeq - b.event.roomSeq,
				)
				.slice(0, limit);
			for (const item of eligible) {
				item.status = "claimed";
				item.claimOwner = command.workerId;
				item.claimToken = randomUUID();
				item.claimFence += 1;
				item.claimExpiresAt = at + command.leaseDurationMs;
				item.attempts += 1;
				item.updatedAt = at;
			}
			return eligible;
		});
	}

	private verifyOutboxClaim(item: CollaborationOutboxItem, token: string, fence: number, at: number): void {
		if (item.status !== "claimed" || item.claimToken !== token || item.claimFence !== fence) {
			throw new CollaborationConflictError("OUTBOX_FENCE_MISMATCH", `outbox claim is stale: ${item.id}`);
		}
		if ((item.claimExpiresAt ?? 0) <= at) throw new CollaborationConflictError("OUTBOX_LEASE_EXPIRED", `outbox claim expired: ${item.id}`);
	}

	async ackOutbox(command: AckOutboxCommand): Promise<CommandResult<CollaborationOutboxItem>> {
		return this.command("ackOutbox", command, (at) => {
			const item = this.outbox.get(command.outboxId);
			if (!item) throw new CollaborationNotFoundError("outbox item", command.outboxId);
			this.verifyOutboxClaim(item, command.claimToken, command.fence, at);
			item.status = "acked";
			item.claimOwner = undefined;
			item.claimToken = undefined;
			item.claimExpiresAt = undefined;
			item.updatedAt = at;
			return item;
		});
	}

	async nackOutbox(command: NackOutboxCommand): Promise<CommandResult<CollaborationOutboxItem>> {
		return this.command("nackOutbox", command, (at) => {
			const item = this.outbox.get(command.outboxId);
			if (!item) throw new CollaborationNotFoundError("outbox item", command.outboxId);
			this.verifyOutboxClaim(item, command.claimToken, command.fence, at);
			item.status = command.dead === true ? "dead" : "pending";
			item.nextAttemptAt = command.retryAt ?? at;
			item.lastError = command.error;
			item.claimOwner = undefined;
			item.claimToken = undefined;
			item.claimExpiresAt = undefined;
			item.updatedAt = at;
			return item;
		});
	}

	private expireAttempt(attempt: TaskAttempt, at: number, retryDelayMs: number): "retried" | "failed" {
		const task = this.taskOrThrow(attempt.taskId);
		const run = this.runOrThrow(attempt.runId);
		attempt.status = "timed_out";
		attempt.errorCode = "LEASE_EXPIRED";
		attempt.errorMessage = "attempt lease expired before completion";
		attempt.finishedAt = at;
		attempt.updatedAt = at;
		run.usage.activeAttempts = Math.max(0, run.usage.activeAttempts - 1);
		this.emit("attempt.timed_out", run.roomId, at, {
			runId: run.id,
			taskId: task.id,
			attemptId: attempt.id,
			payload: { fence: attempt.lease.fence },
		});
		const retryable = task.retry.retryableCodes === undefined ||
			task.retry.retryableCodes.includes("LEASE_EXPIRED");
		return this.scheduleOrFailTask(task, attempt, at, { retryable, retryDelayMs });
	}

	private settleUnknownAttemptUsage(attempt: TaskAttempt, at: number): void {
		if (attempt.usageRecorded === true) return;
		const run = this.runOrThrow(attempt.runId);
		attempt.usage = { tokens: 0, costUsd: 0, costComplete: false };
		attempt.usageRecorded = true;
		run.usage.costComplete = false;
		attempt.updatedAt = Math.max(attempt.updatedAt, at);
		this.emit("attempt.usage_recorded", run.roomId, at, {
			runId: run.id,
			taskId: attempt.taskId,
			attemptId: attempt.id,
			payload: { tokens: 0, costUsd: 0, costComplete: false, reconciledUnknown: true },
		});
	}

	async reconcile(command: ReconcileCommand): Promise<CommandResult<ReconciliationReport>> {
		return this.command("reconcile", command, (at) => {
			const retryDelayMs = command.retryDelayMs ?? 0;
			finiteNonNegative(retryDelayMs, "retryDelayMs");
			const report: ReconciliationReport = {
				expiredAttempts: [],
				expiredHandoffs: [],
				expiredApprovals: [],
				requeuedTasks: [],
				failedTasks: [],
				completedRuns: [],
				failedRuns: [],
			};
			for (const attempt of this.attempts.values()) {
				if (!LIVE_ATTEMPT_STATUSES.has(attempt.status) || attempt.lease.expiresAt > at) continue;
				const outcome = this.expireAttempt(attempt, at, retryDelayMs);
				report.expiredAttempts.push(attempt.id);
				(outcome === "retried" ? report.requeuedTasks : report.failedTasks).push(attempt.taskId);
			}
			for (const handoff of this.handoffs.values()) {
				if (handoff.status !== "offered" || handoff.expiresAt === undefined || handoff.expiresAt > at) continue;
				handoff.status = "expired";
				handoff.updatedAt = at;
				handoff.resolvedAt = at;
				report.expiredHandoffs.push(handoff.id);
				const run = this.runOrThrow(handoff.runId);
				this.emit("handoff.expired", run.roomId, at, {
					runId: run.id,
					taskId: handoff.taskId,
					attemptId: handoff.fromAttemptId,
					payload: { handoffId: handoff.id },
				});
			}
			for (const approval of this.approvals.values()) {
				if (approval.status !== "pending" || approval.expiresAt === undefined || approval.expiresAt > at) continue;
				approval.status = "expired";
				approval.updatedAt = at;
				approval.resolvedAt = at;
				report.expiredApprovals.push(approval.id);
				const run = this.runOrThrow(approval.runId);
				this.emit("approval.expired", run.roomId, at, {
					runId: run.id,
					taskId: approval.taskId,
					attemptId: approval.attemptId,
					payload: { approvalId: approval.id },
				});
				const attempt = this.attemptOrThrow(approval.attemptId);
				if (LIVE_ATTEMPT_STATUSES.has(attempt.status)) {
					const task = this.taskOrThrow(approval.taskId);
					attempt.status = "failed";
					attempt.errorCode = "APPROVAL_EXPIRED";
					attempt.errorMessage = "approval expired before resolution";
					attempt.finishedAt = at;
					attempt.updatedAt = at;
					attempt.usageDueAt = at + TERMINAL_USAGE_SETTLEMENT_GRACE_MS;
					run.usage.activeAttempts = Math.max(0, run.usage.activeAttempts - 1);
					const outcome = this.scheduleOrFailTask(task, attempt, at, { retryable: false });
					(outcome === "retried" ? report.requeuedTasks : report.failedTasks).push(task.id);
				}
			}
			for (const attempt of this.attempts.values()) {
				if (LIVE_ATTEMPT_STATUSES.has(attempt.status) || attempt.usageRecorded === true) continue;
				if ((attempt.usageDueAt ?? attempt.lease.expiresAt) > at) continue;
				this.settleUnknownAttemptUsage(attempt, at);
			}
			for (const run of this.runs.values()) {
				if (run.status !== "running") continue;
				const block = this.hasTerminalTaskGraph(run.id)
					? this.terminalBudgetViolation(run, at)
					: this.budgetBlock(run, at, { allowReservedAttemptsToFinish: true });
				if (block && block !== "concurrency") {
					this.stopRunForBudget(run, block, at);
					if (!report.failedRuns.includes(run.id)) report.failedRuns.push(run.id);
				} else {
					this.refreshTaskReadiness(run.id, at);
					const result = this.finishRunIfTerminal(run.id, at);
					if (result === "completed") report.completedRuns.push(run.id);
					if (result === "failed") report.failedRuns.push(run.id);
				}
			}
			return report;
		});
	}

	async readSnapshot(): Promise<CollaborationStoreSnapshot> {
		return this.consistentRead(() => ({
			rooms: [...this.rooms.values()].sort(compareCreated),
			runs: [...this.runs.values()].sort(compareCreated),
			tasks: [...this.tasks.values()].sort(compareCreated),
			attempts: [...this.attempts.values()].sort(compareAttempts),
			handoffs: [...this.handoffs.values()].sort(compareCreated),
			approvals: [...this.approvals.values()].sort(compareCreated),
			artifacts: [...this.artifacts.values()].sort(compareCreated),
			messages: [...this.messages.values()].sort(compareCreated),
			events: [...this.events].sort((a, b) => a.roomId.localeCompare(b.roomId) || a.roomSeq - b.roomSeq),
			outbox: [...this.outbox.values()].sort(compareCreated),
			commandReceipts: [...this.receipts.values()].sort((a, b) => a.committedAt - b.committedAt || a.commandId.localeCompare(b.commandId)),
			roomSequences: [...this.roomSequences]
				.map(([roomId, roomSeq]) => ({ roomId, roomSeq }))
				.sort((a, b) => a.roomId.localeCompare(b.roomId)),
		}));
	}
}
