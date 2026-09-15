// src/collaboration/store.ts
//
// Adapter-stable Team Mode persistence contract. Mutations are semantic,
// serialized by the adapter, and idempotent by commandId. A filesystem or
// Convex implementation must commit state changes, events and outbox rows in
// one atomic operation.

import type {
	ApprovalId,
	Artifact,
	ArtifactId,
	AttemptId,
	AttemptUsage,
	CollaborationEvent,
	CollaborationOutboxItem,
	CollaborationRoom,
	DelegationKind,
	Handoff,
	HandoffId,
	JoinCondition,
	MessageId,
	OutboxId,
	RetryPolicy,
	RoomId,
	RunBudgets,
	RunId,
	RunSnapshot,
	TaskAttempt,
	TaskId,
	TeamApproval,
	TeamRun,
	TeamTask,
	RoomMessage,
	RoomMessageAttachment,
	RoomMessageAuthorKind,
	RoomMessageSource,
	RoomMetrics,
	ReconciliationReport,
} from "./types.js";

export interface CommandResult<T> {
	value: T;
	/** True when the adapter returned the already-committed command result. */
	replayed: boolean;
	events: CollaborationEvent[];
}

export interface CommandMeta {
	/** Globally unique mutation key. Reusing it must not repeat side effects. */
	commandId: string;
	/** Milliseconds since Unix epoch; adapters may default this to Date.now(). */
	now?: number;
}

/** Command-side room member shape; the store owns the durable joinedAt stamp. */
export interface TeamMemberInput {
	agentId: string;
	role?: string;
	joinedAt?: number;
}

export interface CreateRoomCommand extends CommandMeta {
	roomId?: RoomId;
	title: string;
	createdBy: string;
	members?: TeamMemberInput[];
	metadata?: Record<string, unknown>;
}

export interface UpdateRoomCommand extends CommandMeta {
	roomId: RoomId;
	title?: string;
	members?: TeamMemberInput[];
	metadata?: Record<string, unknown>;
}

export interface ArchiveRoomCommand extends CommandMeta {
	roomId: RoomId;
}

export interface CreateRunCommand extends CommandMeta {
	runId?: RunId;
	roomId: RoomId;
	objective: string;
	createdBy: string;
	budgets?: RunBudgets;
	metadata?: Record<string, unknown>;
}

export interface StartRunCommand extends CommandMeta {
	runId: RunId;
}

export interface TaskDraft {
	id?: TaskId;
	title: string;
	instructions: string;
	assignedAgentId?: string;
	dependencies?: TaskId[];
	join?: JoinCondition;
	retry?: RetryPolicy;
	resultGate?: import("./types.js").TaskResultGate;
	priority?: number;
}

export interface AddTasksCommand extends CommandMeta {
	runId: RunId;
	tasks: TaskDraft[];
}

/**
 * Lowest-common-denominator limit for one atomic delegation command.
 *
 * The durable receipt contains the materialized run and tasks, so keeping the
 * semantic command below 512 KiB leaves conservative headroom below Convex's
 * per-document limit after task defaults and event ids are added. Enforcing the
 * same limit in the reference store keeps filesystem and Convex behavior equal.
 */
export const MAX_ATOMIC_DELEGATION_COMMAND_BYTES = 512 * 1024;

/** Atomically create a run, add its complete DAG, and make it runnable. */
export interface DelegateRunCommand extends CommandMeta {
	runId?: RunId;
	roomId: RoomId;
	objective: string;
	createdBy: string;
	budgets?: RunBudgets;
	metadata?: Record<string, unknown>;
	tasks: TaskDraft[];
}

export interface DelegateRunResult {
	run: TeamRun;
	tasks: TeamTask[];
}

export interface ClaimReadyTaskCommand extends CommandMeta {
	workerId: string;
	leaseDurationMs: number;
	runId?: RunId;
	/** Exact scheduler selection. Prevents a run-scoped claim from taking a
	 * different ready task whose resolved agent does not match the plan. */
	taskId?: TaskId;
	agentId?: string;
	runtimeRunId?: string;
}

export interface RenewAttemptLeaseCommand extends CommandMeta {
	attemptId: AttemptId;
	leaseToken: string;
	fence: number;
	leaseDurationMs: number;
}

export interface CompleteAttemptCommand extends CommandMeta {
	attemptId: AttemptId;
	leaseToken: string;
	fence: number;
	result?: unknown;
	usage?: Partial<AttemptUsage>;
	artifacts?: Array<Omit<Artifact, "id" | "runId" | "taskId" | "attemptId" | "createdAt"> & { id?: ArtifactId }>;
}

export interface FailAttemptCommand extends CommandMeta {
	attemptId: AttemptId;
	leaseToken: string;
	fence: number;
	errorCode?: string;
	errorMessage: string;
	usage?: Partial<AttemptUsage>;
	retryable?: boolean;
}

/** Attribute a provider result that settled after another durable command
 * already made the attempt terminal (for example accepted handoff or rejected
 * approval). The original fence still proves which execution produced it. */
export interface RecordAttemptUsageCommand extends CommandMeta {
	attemptId: AttemptId;
	leaseToken: string;
	fence: number;
	usage: Partial<AttemptUsage>;
}

export const MAX_DELEGATED_CHILDREN_PER_COMMAND = 4;
export const MAX_DELEGATED_CHILDREN_PER_RUN = 24;
export const MAX_DELEGATION_DEPTH = 4;

/** A child task must have an explicit room-member owner. This keeps worker
 * delegation deterministic across runtimes and prevents fallback-agent drift. */
export interface DelegatedChildTaskDraft extends Omit<TaskDraft, "assignedAgentId"> {
	assignedAgentId: string;
}

export interface DelegateAttemptChildrenCommand extends CommandMeta {
	attemptId: AttemptId;
	leaseToken: string;
	fence: number;
	/** Stable model/client retry key, scoped to the source attempt. */
	requestKey: string;
	delegationKind?: DelegationKind;
	tasks: DelegatedChildTaskDraft[];
}

export interface DelegateAttemptChildrenResult {
	parentTask: TeamTask;
	children: TeamTask[];
	yieldedAttempt: TaskAttempt;
	/** True when a new command id resolved an already-committed request key. */
	deduplicated: boolean;
}

export interface CancelTaskCommand extends CommandMeta {
	taskId: TaskId;
	reason?: string;
}

export interface RetryTaskCommand extends CommandMeta {
	taskId: TaskId;
	delayMs?: number;
}

export interface CancelRunCommand extends CommandMeta {
	runId: RunId;
	reason?: string;
}

export interface OfferHandoffCommand extends CommandMeta {
	handoffId?: HandoffId;
	attemptId: AttemptId;
	leaseToken: string;
	fence: number;
	fromAgentId: string;
	toAgentId: string;
	reason?: string;
	expiresAt?: number;
}

export interface RespondHandoffCommand extends CommandMeta {
	handoffId: HandoffId;
	respondingAgentId: string;
	reason?: string;
}

export interface RequestApprovalCommand extends CommandMeta {
	approvalId?: ApprovalId;
	attemptId: AttemptId;
	leaseToken: string;
	fence: number;
	kind: string;
	prompt: string;
	requestedBy: string;
	expiresAt?: number;
}

export interface ResolveApprovalCommand extends CommandMeta {
	approvalId: ApprovalId;
	decision: "approved" | "rejected";
	resolution?: string;
}

export interface AddArtifactCommand extends CommandMeta {
	artifactId?: ArtifactId;
	runId: RunId;
	taskId?: TaskId;
	attemptId?: AttemptId;
	/** Optional active-attempt proof used by the agent-scoped safe context. */
	leaseToken?: string;
	fence?: number;
	kind: string;
	name: string;
	uri: string;
	mimeType?: string;
	bytes?: number;
	sha256?: string;
	metadata?: Record<string, unknown>;
}

export interface PostRoomMessageCommand extends CommandMeta {
	messageId?: MessageId;
	roomId: RoomId;
	authorId: string;
	authorKind: RoomMessageAuthorKind;
	source?: RoomMessageSource;
	content: string;
	mentions?: string[];
	attachments?: RoomMessageAttachment[];
	replyToMessageId?: MessageId;
	threadRootMessageId?: MessageId;
	runId?: RunId;
	taskId?: TaskId;
	attemptId?: AttemptId;
	/** Attempt-scoped posts must prove the currently active execution. */
	leaseToken?: string;
	fence?: number;
}

export interface EditRoomMessageCommand extends CommandMeta {
	messageId: MessageId;
	actorId: string;
	actorKind: RoomMessageAuthorKind;
	content: string;
	mentions?: string[];
}

export interface DeleteRoomMessageCommand extends CommandMeta {
	messageId: MessageId;
	actorId: string;
	actorKind: RoomMessageAuthorKind;
}

export interface ReactRoomMessageCommand extends CommandMeta {
	messageId: MessageId;
	actorId: string;
	actorKind: RoomMessageAuthorKind;
	key: string;
	present: boolean;
}

export interface PinRoomMessageCommand extends CommandMeta {
	messageId: MessageId;
	actorId: string;
	actorKind: RoomMessageAuthorKind;
	pinned: boolean;
}

export interface MessageQuery {
	roomId: RoomId;
	threadRootMessageId?: MessageId;
	rootOnly?: boolean;
	includeDeleted?: boolean;
	beforeMessageId?: MessageId;
	afterMessageId?: MessageId;
	beforeCreatedAt?: number;
	afterCreatedAt?: number;
	limit?: number;
}

export interface MessageSearchQuery {
	roomId: RoomId;
	query: string;
	authorId?: string;
	mentionAgentId?: string;
	pinnedOnly?: boolean;
	limit?: number;
}

export interface ReconcileCommand extends CommandMeta {
	/** Optional delay before retrying an attempt whose lease expired. */
	retryDelayMs?: number;
}

export interface EventQuery {
	roomId?: RoomId;
	runId?: RunId;
	afterRoomSeq?: number;
	limit?: number;
}

export interface ClaimOutboxCommand extends CommandMeta {
	workerId: string;
	leaseDurationMs: number;
	limit?: number;
}

export interface AckOutboxCommand extends CommandMeta {
	outboxId: OutboxId;
	claimToken: string;
	fence: number;
}

export interface NackOutboxCommand extends CommandMeta {
	outboxId: OutboxId;
	claimToken: string;
	fence: number;
	error: string;
	retryAt?: number;
	dead?: boolean;
}

export interface CollaborationStoreSnapshot {
	rooms: CollaborationRoom[];
	runs: TeamRun[];
	tasks: TeamTask[];
	attempts: TaskAttempt[];
	handoffs: Handoff[];
	approvals: TeamApproval[];
	artifacts: Artifact[];
	/** Optional only for backward-compatible snapshot import; current writers always emit it. */
	messages?: RoomMessage[];
	events: CollaborationEvent[];
	outbox: CollaborationOutboxItem[];
	/** Durable idempotency receipts. Adapters may compact these by retention policy. */
	commandReceipts: CollaborationCommandReceipt[];
	/** Materialized room cursors avoid an unbounded event scan during hydration. */
	roomSequences?: Array<{ roomId: RoomId; roomSeq: number }>;
}

export interface CollaborationCommandReceipt {
	commandId: string;
	operation: string;
	fingerprint: string;
	value: unknown;
	eventIds: string[];
	committedAt: number;
}

export interface CollaborationStore {
	createRoom(command: CreateRoomCommand): Promise<CommandResult<CollaborationRoom>>;
	updateRoom(command: UpdateRoomCommand): Promise<CommandResult<CollaborationRoom>>;
	archiveRoom(command: ArchiveRoomCommand): Promise<CommandResult<CollaborationRoom>>;
	listRooms(): Promise<CollaborationRoom[]>;
	getRoom(roomId: RoomId): Promise<CollaborationRoom | undefined>;

	createRun(command: CreateRunCommand): Promise<CommandResult<TeamRun>>;
	delegateRun(command: DelegateRunCommand): Promise<CommandResult<DelegateRunResult>>;
	startRun(command: StartRunCommand): Promise<CommandResult<TeamRun>>;
	listRuns(roomId?: RoomId): Promise<TeamRun[]>;
	getRun(runId: RunId): Promise<TeamRun | undefined>;
	readRunSnapshot(runId: RunId): Promise<RunSnapshot | undefined>;

	addTasks(command: AddTasksCommand): Promise<CommandResult<TeamTask[]>>;
	listTasks(runId: RunId): Promise<TeamTask[]>;
	getTask(taskId: TaskId): Promise<TeamTask | undefined>;
	claimReadyTask(command: ClaimReadyTaskCommand): Promise<CommandResult<TaskAttempt | undefined>>;
	renewAttemptLease(command: RenewAttemptLeaseCommand): Promise<CommandResult<TaskAttempt>>;
	completeAttempt(command: CompleteAttemptCommand): Promise<CommandResult<TaskAttempt>>;
	failAttempt(command: FailAttemptCommand): Promise<CommandResult<TaskAttempt>>;
	delegateAttemptChildren(command: DelegateAttemptChildrenCommand): Promise<CommandResult<DelegateAttemptChildrenResult>>;
	recordAttemptUsage(command: RecordAttemptUsageCommand): Promise<CommandResult<TaskAttempt>>;
	cancelTask(command: CancelTaskCommand): Promise<CommandResult<TeamTask>>;
	retryTask(command: RetryTaskCommand): Promise<CommandResult<TeamTask>>;
	cancelRun(command: CancelRunCommand): Promise<CommandResult<TeamRun>>;
	getAttempt(attemptId: AttemptId): Promise<TaskAttempt | undefined>;
	listAttempts(taskId: TaskId): Promise<TaskAttempt[]>;

	offerHandoff(command: OfferHandoffCommand): Promise<CommandResult<Handoff>>;
	acceptHandoff(command: RespondHandoffCommand): Promise<CommandResult<Handoff>>;
	rejectHandoff(command: RespondHandoffCommand): Promise<CommandResult<Handoff>>;
	listHandoffs(runId: RunId): Promise<Handoff[]>;

	requestApproval(command: RequestApprovalCommand): Promise<CommandResult<TeamApproval>>;
	resolveApproval(command: ResolveApprovalCommand): Promise<CommandResult<TeamApproval>>;
	listApprovals(runId: RunId): Promise<TeamApproval[]>;

	addArtifact(command: AddArtifactCommand): Promise<CommandResult<Artifact>>;
	listArtifacts(runId: RunId): Promise<Artifact[]>;

	postMessage(command: PostRoomMessageCommand): Promise<CommandResult<RoomMessage>>;
	editMessage(command: EditRoomMessageCommand): Promise<CommandResult<RoomMessage>>;
	deleteMessage(command: DeleteRoomMessageCommand): Promise<CommandResult<RoomMessage>>;
	reactMessage(command: ReactRoomMessageCommand): Promise<CommandResult<RoomMessage>>;
	pinMessage(command: PinRoomMessageCommand): Promise<CommandResult<RoomMessage>>;
	getMessage(messageId: MessageId): Promise<RoomMessage | undefined>;
	listMessages(query: MessageQuery): Promise<RoomMessage[]>;
	searchMessages(query: MessageSearchQuery): Promise<RoomMessage[]>;
	getRoomMetrics(roomId: RoomId): Promise<RoomMetrics>;

	readEvents(query: EventQuery): Promise<CollaborationEvent[]>;
	claimOutbox(command: ClaimOutboxCommand): Promise<CommandResult<CollaborationOutboxItem[]>>;
	ackOutbox(command: AckOutboxCommand): Promise<CommandResult<CollaborationOutboxItem>>;
	nackOutbox(command: NackOutboxCommand): Promise<CommandResult<CollaborationOutboxItem>>;

	reconcile(command: ReconcileCommand): Promise<CommandResult<ReconciliationReport>>;
	readSnapshot(): Promise<CollaborationStoreSnapshot>;
}
