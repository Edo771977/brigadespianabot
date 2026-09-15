// src/collaboration/types.ts
//
// Durable Team Mode domain vocabulary. These records describe persisted state;
// execution adapters and UIs consume them but do not own their transitions.

export type RoomId = string;
export type RunId = string;
export type TaskId = string;
export type AttemptId = string;
export type HandoffId = string;
export type ApprovalId = string;
export type ArtifactId = string;
export type MessageId = string;
export type EventId = string;
export type OutboxId = string;

export interface TeamMember {
	agentId: string;
	role?: string;
	joinedAt: number;
}

export type RoomStatus = "open" | "archived";

export interface CollaborationRoom {
	id: RoomId;
	title: string;
	createdBy: string;
	status: RoomStatus;
	members: TeamMember[];
	metadata: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
}

export interface RunBudgets {
	/** Maximum provider tokens attributed to the run. */
	maxTokens?: number;
	/** Maximum estimated provider spend in USD. */
	maxCostUsd?: number;
	/** Maximum elapsed wall-clock time from run start, in milliseconds. */
	maxDurationMs?: number;
	/** Maximum simultaneously leased attempts. */
	maxConcurrency?: number;
	/** Optional hard ceiling on total attempts, including retries. */
	maxAttempts?: number;
}

export interface RunUsage {
	tokens: number;
	costUsd: number;
	/** False once any attempt came from a transport that could not provide a
	 * complete monetary cost. A configured cost ceiling then fails closed. */
	costComplete?: boolean;
	attempts: number;
	activeAttempts: number;
	startedAt?: number;
	finishedAt?: number;
}

export type RunStatus =
	| "created"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

export interface TeamRun {
	id: RunId;
	roomId: RoomId;
	status: RunStatus;
	objective: string;
	budgets: RunBudgets;
	usage: RunUsage;
	createdBy: string;
	cancelReason?: string;
	failureReason?: string;
	metadata: Record<string, unknown>;
	createdAt: number;
	updatedAt: number;
	startedAt?: number;
	finishedAt?: number;
}

export type JoinCondition =
	| { kind: "all" }
	| { kind: "any"; cancelRemaining?: boolean }
	| { kind: "quorum"; minimum: number; cancelRemaining?: boolean };

export interface TaskDependency {
	taskId: TaskId;
}

export interface RetryPolicy {
	/** Total attempts including the first attempt. */
	maxAttempts: number;
	backoffMs?: number;
	/** If set, only failures with one of these codes are retried. */
	retryableCodes?: string[];
}

/** Optional machine-enforced acceptance rule for a task result. The legacy
 * shape remains verdict-only; `independent-v1` opts into authority-checked
 * reviewer separation and dependency-result evidence. */
export type TaskResultGate = {
	kind: "review_verdict";
	policy?: "independent-v1";
};

/** A delegated child contributes assigned work, repairs a prior result, or
 * returns a specialist consultation. All use the same durable parent/child join; the distinction is preserved
 * for prompts, audit events, and future policy. */
export type DelegationKind = "subtask" | "rework" | "consultation";

export type TaskStatus =
	| "blocked"
	| "ready"
	| "running"
	| "waiting_approval"
	| "waiting_children"
	| "succeeded"
	| "failed"
	| "cancelled"
	| "skipped"
	| "handed_off";

export interface TeamTask {
	id: TaskId;
	runId: RunId;
	title: string;
	instructions: string;
	assignedAgentId?: string;
	status: TaskStatus;
	dependencies: TaskDependency[];
	join: JoinCondition;
	retry: RetryPolicy;
	resultGate?: TaskResultGate;
	/** Durable worker-created lineage. Root/planned tasks omit these fields. */
	parentTaskId?: TaskId;
	delegatedByAttemptId?: AttemptId;
	delegationKind?: DelegationKind;
	requestKey?: string;
	delegationRequestHash?: string;
	delegationDepth?: number;
	priority: number;
	nextAttemptAt?: number;
	result?: unknown;
	failureReason?: string;
	/** Set when an any/quorum join deliberately stops an unneeded branch.
	 * Unlike an operator cancellation, this is a successful terminal disposition
	 * and must not make an otherwise successful run fail. */
	cancelledByJoin?: TaskId;
	createdAt: number;
	updatedAt: number;
}

export interface AttemptUsage {
	tokens: number;
	costUsd: number;
	costComplete?: boolean;
}

export type AttemptStatus =
	| "running"
	| "waiting_approval"
	| "succeeded"
	| "failed"
	| "timed_out"
	| "cancelled"
	| "lost"
	| "handed_off"
	| "delegated";

export interface AttemptLease {
	ownerId: string;
	token: string;
	fence: number;
	expiresAt: number;
}

export interface TaskAttempt {
	id: AttemptId;
	runId: RunId;
	taskId: TaskId;
	/** Resolved agent identity persisted at claim time for cross-runtime exclusion. */
	agentId?: string;
	number: number;
	status: AttemptStatus;
	lease: AttemptLease;
	runtimeRunId?: string;
	result?: unknown;
	errorCode?: string;
	errorMessage?: string;
	usage: AttemptUsage;
	/** Prevents a late terminal callback from attributing the same provider
	 * usage twice under two different command ids. */
	usageRecorded?: boolean;
	/** Durable grace deadline for a provider callback that is unwinding after
	 * an external terminal transition such as cancellation or handoff. */
	usageDueAt?: number;
	delegationRequestKey?: string;
	delegationKind?: DelegationKind;
	startedAt: number;
	updatedAt: number;
	finishedAt?: number;
}

export type HandoffStatus = "offered" | "accepted" | "rejected" | "cancelled" | "expired";

export interface Handoff {
	id: HandoffId;
	runId: RunId;
	taskId: TaskId;
	fromAttemptId: AttemptId;
	fromAgentId: string;
	toAgentId: string;
	reason?: string;
	status: HandoffStatus;
	createdAt: number;
	updatedAt: number;
	expiresAt?: number;
	resolvedAt?: number;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "cancelled" | "expired";

export interface TeamApproval {
	id: ApprovalId;
	runId: RunId;
	taskId: TaskId;
	attemptId: AttemptId;
	kind: string;
	prompt: string;
	status: ApprovalStatus;
	requestedBy: string;
	resolution?: string;
	createdAt: number;
	updatedAt: number;
	expiresAt?: number;
	resolvedAt?: number;
}

export interface Artifact {
	id: ArtifactId;
	runId: RunId;
	taskId?: TaskId;
	attemptId?: AttemptId;
	kind: string;
	name: string;
	uri: string;
	mimeType?: string;
	bytes?: number;
	sha256?: string;
	metadata: Record<string, unknown>;
	createdAt: number;
}

export type RoomMessageAuthorKind = "owner" | "agent" | "coordinator" | "system";
export type RoomMessageSource = "chat" | "task" | "system";

/** A message attachment references a durable artifact or a non-secret URI.
 * Binary payloads stay in the blob/file layer instead of inflating room state. */
export interface RoomMessageAttachment {
	artifactId?: ArtifactId;
	name: string;
	uri?: string;
	mimeType?: string;
	bytes?: number;
}

export interface RoomMessageReaction {
	key: string;
	actorIds: string[];
}

/** Public, durable conversation in a Team room. Threads are message relations,
 * not separate mutable containers: a reply names its root and optional parent. */
export interface RoomMessage {
	id: MessageId;
	roomId: RoomId;
	authorId: string;
	authorKind: RoomMessageAuthorKind;
	source: RoomMessageSource;
	content: string;
	mentions: string[];
	attachments: RoomMessageAttachment[];
	reactions: RoomMessageReaction[];
	replyToMessageId?: MessageId;
	threadRootMessageId?: MessageId;
	runId?: RunId;
	taskId?: TaskId;
	attemptId?: AttemptId;
	editedAt?: number;
	deletedAt?: number;
	pinnedAt?: number;
	pinnedBy?: string;
	createdAt: number;
	updatedAt: number;
}

export interface RoomMetrics {
	messageCount: number;
	threadCount: number;
	mentionCount: number;
	pinnedMessageCount: number;
	activeRuns: number;
	pendingTasks: number;
	runningTasks: number;
	succeededTasks: number;
	failedTasks: number;
	pendingApprovals: number;
	openHandoffs: number;
	tokens: number;
	costUsd: number;
	costComplete: boolean;
}

export type CollaborationEventType =
	| "room.created"
	| "room.updated"
	| "room.archived"
	| "run.created"
	| "run.started"
	| "run.completed"
	| "run.failed"
	| "run.cancelled"
	| "task.created"
	| "task.ready"
	| "task.started"
	| "task.retry_scheduled"
	| "task.succeeded"
	| "task.failed"
	| "task.cancelled"
	| "task.skipped"
	| "task.handed_off"
	| "task.waiting_children"
	| "task.children_settled"
	| "attempt.claimed"
	| "attempt.lease_renewed"
	| "attempt.succeeded"
	| "attempt.failed"
	| "attempt.timed_out"
	| "attempt.cancelled"
	| "attempt.lost"
	| "attempt.handed_off"
	| "attempt.delegated"
	| "attempt.usage_recorded"
	| "handoff.offered"
	| "handoff.accepted"
	| "handoff.rejected"
	| "handoff.cancelled"
	| "handoff.expired"
	| "approval.requested"
	| "approval.resolved"
	| "approval.cancelled"
	| "approval.expired"
	| "artifact.created"
	| "message.posted"
	| "message.edited"
	| "message.deleted"
	| "message.reacted"
	| "message.unreacted"
	| "message.pinned"
	| "message.unpinned";

export interface CollaborationEvent<T = Record<string, unknown>> {
	eventId: EventId;
	/** Strictly monotonic within the room, across every run and room event. */
	roomSeq: number;
	type: CollaborationEventType;
	roomId: RoomId;
	runId?: RunId;
	taskId?: TaskId;
	attemptId?: AttemptId;
	commandId: string;
	payload: T;
	createdAt: number;
}

export type OutboxStatus = "pending" | "claimed" | "acked" | "dead";

export interface CollaborationOutboxItem {
	id: OutboxId;
	event: CollaborationEvent;
	status: OutboxStatus;
	attempts: number;
	nextAttemptAt: number;
	claimOwner?: string;
	claimToken?: string;
	claimFence: number;
	claimExpiresAt?: number;
	lastError?: string;
	createdAt: number;
	updatedAt: number;
}

export interface RunSnapshot {
	room: CollaborationRoom;
	run: TeamRun;
	tasks: TeamTask[];
	attempts: TaskAttempt[];
	handoffs: Handoff[];
	approvals: TeamApproval[];
	artifacts: Artifact[];
	latestRoomSeq: number;
}

export interface ReconciliationReport {
	expiredAttempts: AttemptId[];
	expiredHandoffs: HandoffId[];
	expiredApprovals: ApprovalId[];
	requeuedTasks: TaskId[];
	failedTasks: TaskId[];
	completedRuns: RunId[];
	failedRuns: RunId[];
}

export type BudgetBlockReason = "tokens" | "cost" | "cost_unknown" | "duration" | "concurrency" | "attempts";

export class CollaborationDomainError extends Error {
	constructor(
		public readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "CollaborationDomainError";
	}
}

export class CollaborationNotFoundError extends CollaborationDomainError {
	constructor(kind: string, id: string) {
		super("NOT_FOUND", `${kind} not found: ${id}`);
		this.name = "CollaborationNotFoundError";
	}
}

export class CollaborationConflictError extends CollaborationDomainError {
	constructor(code: string, message: string) {
		super(code, message);
		this.name = "CollaborationConflictError";
	}
}

export class CollaborationBudgetError extends CollaborationDomainError {
	constructor(public readonly reason: BudgetBlockReason) {
		super("BUDGET_EXHAUSTED", `run budget exhausted: ${reason}`);
		this.name = "CollaborationBudgetError";
	}
}
