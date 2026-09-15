/**
 * Team Mode's transport contract.
 *
 * Durable state is represented by `CollaborationEvent` and ordered with a
 * room-scoped cursor. Live token/tool progress is intentionally a separate,
 * lossy event class: it may be coalesced under backpressure and never advances
 * the durable room cursor.
 */

import type {
	ApprovalId,
	Artifact,
	AttemptId,
	CollaborationEvent,
	CollaborationRoom,
	Handoff,
	HandoffId,
	JoinCondition,
	MessageId,
	RoomId,
	RoomMessage,
	RoomMessageAttachment,
	RoomMetrics,
	RetryPolicy,
	RunBudgets,
	RunId,
	RunSnapshot,
	RunStatus,
	TaskAttempt,
	TaskId,
	TeamApproval,
	TeamRun,
	TeamTask,
} from "../collaboration/types.js";
import type { DelegateRunResult } from "../collaboration/store.js";
import type { TeamTaskResultPage } from "../collaboration/task-result-page.js";

export type { TeamTaskResultPage } from "../collaboration/task-result-page.js";

export const TEAM_REQUEST_METHODS = [
	"team.rooms.list",
	"team.rooms.create",
	"team.rooms.update",
	"team.rooms.archive",
	"team.rooms.metrics",
	"team.messages.list",
	"team.messages.search",
	"team.messages.post",
	"team.messages.edit",
	"team.messages.delete",
	"team.messages.react",
	"team.messages.pin",
	"team.runs.list",
	"team.runs.create",
	"team.runs.delegate",
	"team.runs.start",
	"team.runs.get",
	"team.runs.cancel",
	"team.tasks.list",
	"team.tasks.result",
	"team.tasks.add",
	"team.tasks.cancel",
	"team.tasks.retry",
	"team.handoffs.list",
	"team.handoffs.respond",
	"team.approvals.list",
	"team.approvals.resolve",
	"team.artifacts.list",
	"team.events.list",
	"team.resume",
] as const;

export type TeamRequestMethod = (typeof TEAM_REQUEST_METHODS)[number];

export const TEAM_EVENT_NAMES = [
	"team-event",
	"team-progress",
	"team-approval-request",
	"team-approval-resolved",
] as const;

export type TeamEventName = (typeof TEAM_EVENT_NAMES)[number];

const TEAM_EVENT_NAME_SET: ReadonlySet<string> = new Set(TEAM_EVENT_NAMES);

/** Keep production routing tied to the advertised Team event contract. */
export function isTeamEventName(value: string): value is TeamEventName {
	return TEAM_EVENT_NAME_SET.has(value);
}

/** Feature flags added to `hello-ok.features.capabilities`. */
export const TEAM_PROTOCOL_CAPABILITIES = [
	/** Namespaced room/run/task command surface. */
	"team.rooms",
	/** Durable events use a strictly monotonic, room-scoped replay cursor. */
	"team.events.room-seq",
	/** No Team Mode frames are sent without an explicit room subscription. */
	"team.subscribe.rooms",
	/** Ephemeral attempt progress is a separate per-room opt-in. */
	"team.progress.opt-in",
	/** A reconnect can atomically request current state plus cursor replay. */
	"team.resume",
	/** Team chats use isolated coordinator sessions and a single orchestration surface. */
	"team.coordinator-chat.v2",
	/** Attempt exec approvals have request/resolved revisions and reconnect snapshots. */
	"team.exec-approvals.revision",
	/** Room list hydration includes cursors, active runs, and pending decisions. */
	"team.rooms.list-summary",
	/** `subscribe { roomId }` installs routing before returning that room's summary. */
	"team.subscribe.snapshot",
	/** Complete run creation, DAG insertion, and start commit atomically. */
	"team.runs.delegate.atomic",
	/** Long task results are available through a bounded lossless page API. */
	"team.tasks.result.page",
	/** Review gates can opt into authority-enforced independent-v1 semantics. */
	"team.review-policy.independent-v1",
	/** Rooms expose durable messages, replies, threads, mentions, pins, and reactions. */
	"team.messages.threads.v1",
	/** Room metrics are authoritative projections over durable collaboration state. */
	"team.rooms.metrics.v1",
] as const;

export type TeamProtocolCapability = (typeof TEAM_PROTOCOL_CAPABILITIES)[number];

/**
 * Stable pushed payload for a durable Team Mode transition.
 *
 * `runId`, `taskId`, and `attemptId` form a progressively narrower reference:
 * room events omit all three, run events carry `runId`, and task/attempt events
 * carry the references that exist at that level.
 */
export type TeamLifecycleEvent<T = Record<string, unknown>> = CollaborationEvent<T>;

export type TeamProgressKind =
	| "assistant.delta"
	| "thinking.delta"
	| "tool.started"
	| "tool.updated"
	| "tool.finished"
	| "attempt.heartbeat";

/**
 * Lossy, replaceable progress for one active attempt.
 *
 * Consumers discard a frame whose `progressSeq` is not newer than the last
 * frame seen for its `attemptId`. A gateway may coalesce these frames under
 * backpressure. They have no `roomSeq`, by design: dropping progress must not
 * create a hole in the durable replay stream.
 */
export interface TeamProgressEvent<T = Record<string, unknown>> {
	progressId: string;
	progressSeq: number;
	roomId: RoomId;
	runId: RunId;
	taskId: TaskId;
	attemptId: AttemptId;
	agentId?: string;
	kind: TeamProgressKind;
	payload: T;
	emittedAt: number;
}

/** Ephemeral shell approval raised by a leased Team attempt. It is routed only
 * to subscribers of the owning room and is also returned by `team.resume`
 * while pending, so a reconnect cannot leave a live attempt waiting invisibly. */
export interface TeamExecApprovalRequest {
	id: string;
	roomId: RoomId;
	attemptId: AttemptId;
	agentId: string;
	sessionId: string;
	command: string;
	toolName: string;
	cwd?: string;
	timeoutMs: number;
	decisions: ReadonlyArray<"allow-once" | "allow-always" | "allow-pattern" | "allow-session" | "deny">;
	createdAt: number;
	/** Monotonic within one gateway process for this room's exec approvals. */
	revision: number;
}

export interface TeamExecApprovalResolved {
	id: string;
	roomId: RoomId;
	attemptId: AttemptId;
	agentId: string;
	sessionId: string;
	decision: "allow-once" | "allow-always" | "allow-pattern" | "allow-session" | "deny";
	resolvedAt: number;
	/** Monotonic within one gateway process for this room's exec approvals. */
	revision: number;
}

export interface TeamEventPayloadMap {
	"team-event": TeamLifecycleEvent;
	"team-progress": TeamProgressEvent;
	"team-approval-request": TeamExecApprovalRequest;
	"team-approval-resolved": TeamExecApprovalResolved;
}

export interface TeamMemberInput {
	agentId: string;
	role?: string;
}

/** Persistence-neutral input for adding one task to a run. */
export interface TeamTaskInput {
	id?: TaskId;
	title: string;
	instructions: string;
	assignedAgentId?: string;
	dependencies?: TaskId[];
	join?: JoinCondition;
	retry?: RetryPolicy;
	resultGate?: import("../collaboration/types.js").TaskResultGate;
	priority?: number;
}

/** Idempotent mutation acknowledgement exposed on the wire. */
export interface TeamCommandResult<T> {
	value: T;
	/** True when `commandId` matched a previously committed mutation. */
	replayed: boolean;
	events: TeamLifecycleEvent[];
}

export interface TeamEventPage {
	events: TeamLifecycleEvent[];
	/** Current durable cursor for the room, even when `events` is empty. */
	headRoomSeq: number;
	/** True when more retained events follow this page. */
	hasMore: boolean;
	/** Feed this value back as `afterRoomSeq` to fetch the next page. */
	nextAfterRoomSeq?: number;
}

/**
 * Wire-safe attempt state. Lease owner/token/fence are execution credentials
 * and never cross the gateway boundary; UIs only need the expiry timestamp.
 */
export type TeamAttemptSnapshot = Omit<TaskAttempt, "lease"> & {
	leaseExpiresAt: number;
};

/** Public run state with every attempt credential-redacted. */
export type TeamRunSnapshot = Omit<RunSnapshot, "attempts"> & {
	attempts: TeamAttemptSnapshot[];
};

export interface TeamResumeResult {
	room: CollaborationRoom;
	/** Most recent public room messages, oldest first. */
	messages: RoomMessage[];
	metrics: RoomMetrics;
	runs: TeamRun[];
	/** Runtime shell prompts currently waiting inside attempts in this room. */
	pendingExecApprovals: TeamExecApprovalRequest[];
	/** Authoritative process-local revision for pendingExecApprovals. */
	execApprovalRevision: number;
	/** Full selected-run state, when the caller supplied `runId`. */
	run?: TeamRunSnapshot;
	/** Durable transitions newer than the caller's cursor. */
	events: TeamLifecycleEvent[];
	/** Current durable cursor for the room. */
	headRoomSeq: number;
	/** False when retention removed part of the requested interval. */
	replayComplete: boolean;
	/** True when the replay was page-limited and can be continued. */
	hasMore: boolean;
	nextAfterRoomSeq?: number;
}

/** Compact reconnect state for every room, returned in one rooms.list read. */
export interface TeamRoomListSummary {
	roomId: RoomId;
	/** Active run when present, otherwise the most recently updated run. */
	run?: TeamRun;
	headRoomSeq: number;
	pendingDecisionIds: string[];
	pendingExecApprovals: TeamExecApprovalRequest[];
	execApprovalRevision: number;
}

export interface TeamRequestParams {
	"team.rooms.list": { includeArchived?: boolean } | void;
	"team.rooms.create": {
		commandId?: string;
		roomId?: RoomId;
		title: string;
		members?: TeamMemberInput[];
		metadata?: Record<string, unknown>;
	};
	"team.rooms.update": {
		commandId?: string;
		roomId: RoomId;
		title?: string;
		members?: TeamMemberInput[];
		metadata?: Record<string, unknown>;
	};
	"team.rooms.archive": { commandId?: string; roomId: RoomId };
	"team.rooms.metrics": { roomId: RoomId };
	"team.messages.list": {
		roomId: RoomId;
		threadRootMessageId?: MessageId;
		rootOnly?: boolean;
		includeDeleted?: boolean;
		beforeCreatedAt?: number;
		afterCreatedAt?: number;
		limit?: number;
	};
	"team.messages.search": {
		roomId: RoomId;
		query: string;
		authorId?: string;
		mentionAgentId?: string;
		pinnedOnly?: boolean;
		limit?: number;
	};
	"team.messages.post": {
		commandId?: string;
		messageId?: MessageId;
		roomId: RoomId;
		content: string;
		mentions?: string[];
		attachments?: RoomMessageAttachment[];
		replyToMessageId?: MessageId;
		threadRootMessageId?: MessageId;
		runId?: RunId;
		taskId?: TaskId;
	};
	"team.messages.edit": {
		commandId?: string;
		messageId: MessageId;
		content: string;
		mentions?: string[];
	};
	"team.messages.delete": { commandId?: string; messageId: MessageId };
	"team.messages.react": {
		commandId?: string;
		messageId: MessageId;
		key: string;
		present: boolean;
	};
	"team.messages.pin": {
		commandId?: string;
		messageId: MessageId;
		pinned: boolean;
	};
	"team.runs.list": { roomId: RoomId; statuses?: RunStatus[] };
	"team.runs.create": {
		commandId?: string;
		runId?: RunId;
		roomId: RoomId;
		objective: string;
		budgets?: RunBudgets;
		metadata?: Record<string, unknown>;
	};
	"team.runs.delegate": {
		commandId: string;
		runId?: RunId;
		roomId: RoomId;
		objective: string;
		budgets?: RunBudgets;
		metadata?: Record<string, unknown>;
		tasks: TeamTaskInput[];
	};
	"team.runs.start": { commandId?: string; runId: RunId };
	"team.runs.get": { runId: RunId };
	"team.runs.cancel": { commandId?: string; runId: RunId; reason?: string };
	"team.tasks.list": { runId: RunId };
	"team.tasks.result": { runId: RunId; taskId: TaskId; offset?: number; limit?: number };
	"team.tasks.add": { commandId?: string; runId: RunId; tasks: TeamTaskInput[] };
	"team.tasks.cancel": { commandId?: string; taskId: TaskId; reason?: string };
	"team.tasks.retry": { commandId?: string; taskId: TaskId; delayMs?: number };
	"team.handoffs.list": { runId: RunId };
	"team.handoffs.respond": {
		commandId?: string;
		handoffId: HandoffId;
		decision: "accept" | "reject";
		reason?: string;
	};
	"team.approvals.list": { runId: RunId };
	"team.approvals.resolve": {
		commandId?: string;
		approvalId: ApprovalId;
		decision: "approved" | "rejected";
		resolution?: string;
	};
	"team.artifacts.list": { runId: RunId };
	"team.events.list": {
		roomId: RoomId;
		runId?: RunId;
		afterRoomSeq?: number;
		limit?: number;
	};
	"team.resume": {
		roomId: RoomId;
		runId?: RunId;
		afterRoomSeq?: number;
		limit?: number;
	};
}

export interface TeamResponseFor {
	"team.rooms.list": { rooms: CollaborationRoom[]; summaries: TeamRoomListSummary[] };
	"team.rooms.create": TeamCommandResult<CollaborationRoom>;
	"team.rooms.update": TeamCommandResult<CollaborationRoom>;
	"team.rooms.archive": TeamCommandResult<CollaborationRoom>;
	"team.rooms.metrics": RoomMetrics;
	"team.messages.list": { messages: RoomMessage[] };
	"team.messages.search": { messages: RoomMessage[] };
	"team.messages.post": TeamCommandResult<RoomMessage>;
	"team.messages.edit": TeamCommandResult<RoomMessage>;
	"team.messages.delete": TeamCommandResult<RoomMessage>;
	"team.messages.react": TeamCommandResult<RoomMessage>;
	"team.messages.pin": TeamCommandResult<RoomMessage>;
	"team.runs.list": { runs: TeamRun[] };
	"team.runs.create": TeamCommandResult<TeamRun>;
	"team.runs.delegate": TeamCommandResult<DelegateRunResult>;
	"team.runs.start": TeamCommandResult<TeamRun>;
	"team.runs.get": TeamRunSnapshot;
	"team.runs.cancel": TeamCommandResult<TeamRun>;
	"team.tasks.list": { tasks: TeamTask[] };
	"team.tasks.result": TeamTaskResultPage;
	"team.tasks.add": TeamCommandResult<TeamTask[]>;
	"team.tasks.cancel": TeamCommandResult<TeamTask>;
	"team.tasks.retry": TeamCommandResult<TeamTask>;
	"team.handoffs.list": { handoffs: Handoff[] };
	"team.handoffs.respond": TeamCommandResult<Handoff>;
	"team.approvals.list": { approvals: TeamApproval[] };
	"team.approvals.resolve": TeamCommandResult<TeamApproval>;
	"team.artifacts.list": { artifacts: Artifact[] };
	"team.events.list": TeamEventPage;
	"team.resume": TeamResumeResult;
}
