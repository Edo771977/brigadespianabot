/** Team Mode gateway method adapters. Transport registration lives in server.ts. */

import { randomUUID } from "node:crypto";

import type {
	CollaborationStore,
	CollaborationStoreSnapshot,
	CommandResult,
	TaskDraft,
	TeamMemberInput as StoreTeamMemberInput,
} from "../../collaboration/store.js";
import {
	MAX_TEAM_RESULT_PAGE_CHARS,
	pageTeamTaskResult,
} from "../../collaboration/task-result-page.js";
import { resolveConfiguredRoomCoordinatorAgentId } from "../../collaboration/room-coordinator.js";
import {
	CollaborationBudgetError,
	CollaborationConflictError,
	CollaborationDomainError,
	CollaborationNotFoundError,
	type CollaborationEvent,
	type CollaborationRoom,
	type JoinCondition,
	type RoomMessageAttachment,
	type RoomMetrics,
	type RetryPolicy,
	type RoomId,
	type RunBudgets,
	type RunId,
	type RunSnapshot,
	type RunStatus,
	type TaskAttempt,
} from "../../collaboration/types.js";
import type {
	TeamAttemptSnapshot,
	TeamCommandResult,
	TeamEventPage,
	TeamExecApprovalRequest,
	TeamRequestMethod,
	TeamRequestParams,
	TeamResponseFor,
	TeamRoomListSummary,
	TeamResumeResult,
	TeamRunSnapshot,
	TeamTaskInput,
} from "../../protocol/team.js";

const DEFAULT_EVENT_LIMIT = 200;
const MAX_EVENT_LIMIT = 500;
const MAX_ID_LENGTH = 256;
const MAX_SHORT_TEXT_LENGTH = 4_096;
const MAX_LONG_TEXT_LENGTH = 100_000;

const RUN_STATUSES = new Set<RunStatus>([
	"created",
	"running",
	"completed",
	"failed",
	"cancelled",
]);

export type TeamMethodErrorCode =
	| "INVALID_REQUEST"
	| "TEAM_NOT_FOUND"
	| "TEAM_CONFLICT"
	| "TEAM_BUDGET_EXHAUSTED"
	| "TEAM_DOMAIN_ERROR";

/** Error shape consumed directly by the gateway response framer. */
export class TeamMethodError extends Error {
	constructor(
		public readonly code: TeamMethodErrorCode,
		message: string,
		public readonly details?: Record<string, unknown>,
		public readonly retryable = false,
	) {
		super(message);
		this.name = "TeamMethodError";
	}
}

export interface TeamMethodHandlerDeps {
	store: CollaborationStore;
	/** Live gateway agent catalogue. Team mutations reject unknown targets
	 * before committing durable room/task state. */
	validateAgentId: (agentId: string) => boolean | Promise<boolean>;
	/** Agent automatically installed as coordinator when a room is created with
	 * no members. Production passes the gateway's primary agent. */
	defaultAgentId?: string;
	/** Single-operator attribution; defaults to the local owner identity. */
	actorId?: string;
	/** Deterministic injection point for tests; production uses UUIDs. */
	commandIdFactory?: () => string;
	/** Wake hint after transitions that can make orchestration work runnable. */
	kickCoordinator?: (runId: RunId) => Promise<void> | void;
	/** Push committed durable events to live room subscribers. */
	publishEvents?: (events: readonly CollaborationEvent[]) => Promise<void> | void;
	/** Process-local exec approvals for Team attempts. Durable task state remains
	 * authoritative; this recovery list prevents reconnect-only invisible waits. */
	listPendingExecApprovals?: (roomId: RoomId) => readonly TeamExecApprovalRequest[];
	/** Monotonic process-local revision paired atomically with the pending list. */
	getExecApprovalRevision?: (roomId: RoomId) => number;
}

export type TeamMethodHandlers = {
	[M in TeamRequestMethod]: (
		params: TeamRequestParams[M],
	) => Promise<TeamResponseFor[M]>;
};

function buildRoomListSummaries(
	snapshot: CollaborationStoreSnapshot,
	rooms: readonly CollaborationRoom[],
	deps: Pick<TeamMethodHandlerDeps, "listPendingExecApprovals" | "getExecApprovalRevision">,
): TeamRoomListSummary[] {
	const runById = new Map(snapshot.runs.map((run) => [run.id, run]));
	const runsByRoom = new Map<RoomId, typeof snapshot.runs>();
	for (const run of snapshot.runs) {
		const runs = runsByRoom.get(run.roomId) ?? [];
		runs.push(run);
		runsByRoom.set(run.roomId, runs);
	}
	const decisionIdsByRoom = new Map<RoomId, string[]>();
	const addDecision = (runId: RunId, id: string): void => {
		const roomId = runById.get(runId)?.roomId;
		if (!roomId) return;
		const ids = decisionIdsByRoom.get(roomId) ?? [];
		ids.push(id);
		decisionIdsByRoom.set(roomId, ids);
	};
	for (const approval of snapshot.approvals) {
		if (approval.status === "pending") addDecision(approval.runId, `approval:${approval.id}`);
	}
	for (const handoff of snapshot.handoffs) {
		if (handoff.status === "offered") addDecision(handoff.runId, `handoff:${handoff.id}`);
	}
	const roomSequences = new Map(snapshot.roomSequences?.map(({ roomId, roomSeq }) => [roomId, roomSeq]));
	return rooms.map((room) => {
		const runs = [...(runsByRoom.get(room.id) ?? [])]
			.sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id));
		const run = runs.find((candidate) => candidate.status === "created" || candidate.status === "running")
			?? runs[0];
		return {
			roomId: room.id,
			...(run ? { run } : {}),
			headRoomSeq: roomSequences.get(room.id) ?? 0,
			pendingDecisionIds: [...(decisionIdsByRoom.get(room.id) ?? [])],
			pendingExecApprovals: [...(deps.listPendingExecApprovals?.(room.id) ?? [])],
			execApprovalRevision: deps.getExecApprovalRevision?.(room.id) ?? 0,
		};
	});
}

function roomMetricsFromSnapshot(snapshot: CollaborationStoreSnapshot, roomId: RoomId): RoomMetrics {
	const runs = snapshot.runs.filter((run) => run.roomId === roomId);
	const runIds = new Set(runs.map((run) => run.id));
	const tasks = snapshot.tasks.filter((task) => runIds.has(task.runId));
	const messages = (snapshot.messages ?? []).filter((message) => message.roomId === roomId && message.deletedAt === undefined);
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
		pendingApprovals: snapshot.approvals.filter((approval) => runIds.has(approval.runId) && approval.status === "pending").length,
		openHandoffs: snapshot.handoffs.filter((handoff) => runIds.has(handoff.runId) && handoff.status === "offered").length,
		tokens: runs.reduce((total, run) => total + run.usage.tokens, 0),
		costUsd: runs.reduce((total, run) => total + run.usage.costUsd, 0),
		costComplete: runs.every((run) => run.usage.costComplete !== false),
	};
}

/** Convert collaboration state-machine failures into stable wire error codes. */
export function mapTeamMethodError(error: unknown): unknown {
	if (error instanceof TeamMethodError) return error;
	if (error instanceof CollaborationNotFoundError) {
		return new TeamMethodError("TEAM_NOT_FOUND", error.message, {
			domainCode: error.code,
		});
	}
	if (error instanceof CollaborationBudgetError) {
		return new TeamMethodError("TEAM_BUDGET_EXHAUSTED", error.message, {
			domainCode: error.code,
			reason: error.reason,
		});
	}
	if (error instanceof CollaborationConflictError) {
		return new TeamMethodError("TEAM_CONFLICT", error.message, {
			domainCode: error.code,
		});
	}
	if (error instanceof CollaborationDomainError) {
		return new TeamMethodError("TEAM_DOMAIN_ERROR", error.message, {
			domainCode: error.code,
		});
	}
	return error;
}

/**
 * Build all Team Mode handlers over one storage adapter.
 *
 * The returned object is intentionally registration-agnostic so the WebSocket
 * and in-process gateway paths can install the exact same functions.
 */
export function createTeamMethodHandlers(deps: TeamMethodHandlerDeps): TeamMethodHandlers {
	const actorId = optionalString(deps.actorId, "actorId", MAX_ID_LENGTH) ?? "owner";
	const defaultAgentId = optionalString(deps.defaultAgentId, "defaultAgentId", MAX_ID_LENGTH) ?? "main";
	const makeCommandId = deps.commandIdFactory ?? randomUUID;

	const commandId = (value: unknown, method: TeamRequestMethod): string =>
		optionalString(value, `${method}.commandId`, MAX_ID_LENGTH) ??
		`team:${method}:${makeCommandId()}`;

	const completeMutation = async <T>(
		result: CommandResult<T>,
		kickRunId?: RunId,
	): Promise<TeamCommandResult<T>> => {
		if (!result.replayed && result.events.length > 0 && deps.publishEvents) {
			// Authority has already committed and the durable outbox owns reliable
			// delivery. A live-publish hint must not turn a successful mutation into
			// a hung or failed RPC.
			void Promise.resolve()
				.then(() => deps.publishEvents?.(result.events))
				.catch(() => undefined);
		}
		if (!result.replayed && kickRunId && deps.kickCoordinator) {
			// The durable command is already committed. Waking the coordinator is a
			// background hint and must never hold the RPC open for the lifetime of a
			// run (including while an attempt waits for an exec approval).
			void Promise.resolve()
				.then(() => deps.kickCoordinator?.(kickRunId))
				.catch(() => undefined);
		}
		return result;
	};

	const run = async <T>(operation: () => Promise<T>): Promise<T> => {
		try {
			return await operation();
		} catch (error) {
			throw mapTeamMethodError(error);
		}
	};

	const requireConfiguredAgents = async (
		agentIds: readonly string[],
		field: string,
	): Promise<void> => {
		for (const agentId of new Set(agentIds)) {
			if (!(await deps.validateAgentId(agentId))) {
				throw new TeamMethodError(
					"INVALID_REQUEST",
					`${field} references an unknown configured agent: ${agentId}`,
					{ field, agentId },
				);
			}
		}
	};

	const prepareTaskAssigneesInRoom = async (
		roomId: RoomId,
		tasks: readonly TaskDraft[],
		field: string,
	): Promise<TaskDraft[]> => {
		const room = await requireRoom(deps.store, roomId);
		const coordinatorAgentId = await resolveConfiguredRoomCoordinatorAgentId(room, deps.validateAgentId);
		if (tasks.some((task) => !task.assignedAgentId) && !coordinatorAgentId) {
			throw new TeamMethodError(
				"INVALID_REQUEST",
				`${field} requires an explicit assignee because room ${room.id} has no configured coordinator`,
				{ field, roomId: room.id },
			);
		}
		const materialized = tasks.map((task) => task.assignedAgentId
			? { ...task }
			: { ...task, assignedAgentId: coordinatorAgentId! });
		const assignees = materialized.map((task) => task.assignedAgentId!);
		await requireConfiguredAgents(assignees, field);
		const members = new Set(room.members.map((member) => member.agentId));
		const nonMember = assignees.find((agentId) => !members.has(agentId));
		if (nonMember) {
			throw new TeamMethodError(
				"INVALID_REQUEST",
				`${field} references agent ${nonMember}, which is not a member of room ${room.id}`,
				{ field, agentId: nonMember, roomId: room.id },
			);
		}
		return materialized;
	};

	const prepareTaskAssignees = async (runId: RunId, tasks: readonly TaskDraft[]): Promise<TaskDraft[]> => {
		const runState = await deps.store.getRun(runId);
		if (!runState) throw notFound("run", runId);
		return prepareTaskAssigneesInRoom(runState.roomId, tasks, "team.tasks.add.tasks[].assignedAgentId");
	};

	const requireMessageMentions = async (roomId: RoomId, mentions: readonly string[], field: string): Promise<void> => {
		await requireConfiguredAgents(mentions, field);
		const room = await requireRoom(deps.store, roomId);
		const members = new Set(room.members.map((member) => member.agentId));
		const nonMember = mentions.find((agentId) => !members.has(agentId));
		if (nonMember) {
			throw new TeamMethodError(
				"INVALID_REQUEST",
				`${field} references agent ${nonMember}, which is not a member of room ${room.id}`,
				{ field, agentId: nonMember, roomId: room.id },
			);
		}
	};

	return {
		"team.rooms.list": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.rooms.list", true);
				assertOnlyKeys(p, ["includeArchived"], "team.rooms.list");
				const includeArchived = optionalBoolean(
					p.includeArchived,
					"team.rooms.list.includeArchived",
				);
				const snapshot = await deps.store.readSnapshot();
				const rooms = snapshot.rooms;
				const visibleRooms = includeArchived === true
					? rooms
					: rooms.filter((room) => room.status !== "archived");
				return {
					rooms: visibleRooms,
					summaries: buildRoomListSummaries(snapshot, visibleRooms, deps),
				};
			}),

		"team.rooms.create": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.rooms.create");
				assertOnlyKeys(
					p,
					["commandId", "roomId", "title", "members", "metadata"],
					"team.rooms.create",
				);
				const roomId = optionalString(
					p.roomId,
					"team.rooms.create.roomId",
					MAX_ID_LENGTH,
				);
				let members = p.members === undefined
					? []
					: parseMembers(p.members, "team.rooms.create.members");
				let metadata = p.metadata === undefined
					? undefined
					: parseMetadata(p.metadata, "team.rooms.create.metadata");
				if (members.length === 0) {
					const requestedCoordinator = metadata?.coordinatorAgentId;
					if (requestedCoordinator !== undefined && (typeof requestedCoordinator !== "string" || requestedCoordinator.trim().length === 0)) {
						invalid("team.rooms.create.metadata.coordinatorAgentId must be a non-empty string");
					}
					const coordinatorAgentId = typeof requestedCoordinator === "string"
						? requestedCoordinator.trim()
						: defaultAgentId;
					await requireConfiguredAgents([coordinatorAgentId], "team.rooms.create.defaultAgentId");
					members = [{ agentId: coordinatorAgentId, role: "coordinator" }];
					metadata = { ...(metadata ?? {}), coordinatorAgentId };
				}
				await requireConfiguredAgents(
					members.map((member) => member.agentId),
					"team.rooms.create.members[].agentId",
				);
				await validateRoomCoordinator(metadata, members, "team.rooms.create", requireConfiguredAgents);
				const result = await deps.store.createRoom({
					commandId: commandId(p.commandId, "team.rooms.create"),
					...(roomId ? { roomId } : {}),
					title: requiredString(
						p.title,
						"team.rooms.create.title",
						MAX_SHORT_TEXT_LENGTH,
					),
					createdBy: actorId,
					members,
					...(metadata !== undefined ? { metadata } : {}),
				});
				return completeMutation(result);
			}),

		"team.rooms.update": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.rooms.update");
				assertOnlyKeys(
					p,
					["commandId", "roomId", "title", "members", "metadata"],
					"team.rooms.update",
				);
				if (p.title === undefined && p.members === undefined && p.metadata === undefined) {
					invalid("team.rooms.update requires at least one field to update");
				}
				const roomId = requiredId(p.roomId, "team.rooms.update.roomId");
				const members = p.members === undefined
					? undefined
					: parseMembers(p.members, "team.rooms.update.members");
				const metadata = p.metadata === undefined
					? undefined
					: parseMetadata(p.metadata, "team.rooms.update.metadata");
				if (members) {
					await requireConfiguredAgents(
						members.map((member) => member.agentId),
						"team.rooms.update.members[].agentId",
					);
				}
				const currentRoom = await deps.store.getRoom(roomId);
				if (currentRoom) {
					await validateRoomCoordinator(
						metadata ?? currentRoom.metadata,
						members ?? currentRoom.members,
						"team.rooms.update",
						requireConfiguredAgents,
					);
				}
				const result = await deps.store.updateRoom({
					commandId: commandId(p.commandId, "team.rooms.update"),
					roomId,
					...(p.title !== undefined
						? {
								title: requiredString(
									p.title,
									"team.rooms.update.title",
									MAX_SHORT_TEXT_LENGTH,
								),
							}
						: {}),
					...(members ? { members } : {}),
					...(metadata !== undefined ? { metadata } : {}),
				});
				return completeMutation(result);
			}),

		"team.rooms.archive": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.rooms.archive");
				assertOnlyKeys(p, ["commandId", "roomId"], "team.rooms.archive");
				const result = await deps.store.archiveRoom({
					commandId: commandId(p.commandId, "team.rooms.archive"),
					roomId: requiredId(p.roomId, "team.rooms.archive.roomId"),
				});
				return completeMutation(result);
			}),

		"team.rooms.metrics": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.rooms.metrics");
				assertOnlyKeys(p, ["roomId"], "team.rooms.metrics");
				return deps.store.getRoomMetrics(requiredId(p.roomId, "team.rooms.metrics.roomId"));
			}),

		"team.messages.list": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.messages.list");
				assertOnlyKeys(
					p,
					[
						"roomId",
						"threadRootMessageId",
						"rootOnly",
						"includeDeleted",
						"beforeMessageId",
						"afterMessageId",
						"beforeCreatedAt",
						"afterCreatedAt",
						"limit",
					],
					"team.messages.list",
				);
				const roomId = requiredId(p.roomId, "team.messages.list.roomId");
				await requireRoom(deps.store, roomId);
				const threadRootMessageId = optionalString(p.threadRootMessageId, "team.messages.list.threadRootMessageId", MAX_ID_LENGTH);
				const rootOnly = optionalBoolean(p.rootOnly, "team.messages.list.rootOnly");
				const includeDeleted = optionalBoolean(p.includeDeleted, "team.messages.list.includeDeleted");
				const beforeMessageId = optionalString(p.beforeMessageId, "team.messages.list.beforeMessageId", MAX_ID_LENGTH);
				const afterMessageId = optionalString(p.afterMessageId, "team.messages.list.afterMessageId", MAX_ID_LENGTH);
				const beforeCreatedAt = p.beforeCreatedAt === undefined ? undefined : nonNegativeInteger(p.beforeCreatedAt, "team.messages.list.beforeCreatedAt");
				const afterCreatedAt = p.afterCreatedAt === undefined ? undefined : nonNegativeInteger(p.afterCreatedAt, "team.messages.list.afterCreatedAt");
				const limit = p.limit === undefined ? undefined : positiveInteger(p.limit, "team.messages.list.limit", 500);
				return { messages: await deps.store.listMessages({
					roomId,
					...(threadRootMessageId ? { threadRootMessageId } : {}),
					...(rootOnly !== undefined ? { rootOnly } : {}),
					...(includeDeleted !== undefined ? { includeDeleted } : {}),
					...(beforeMessageId ? { beforeMessageId } : {}),
					...(afterMessageId ? { afterMessageId } : {}),
					...(beforeCreatedAt !== undefined ? { beforeCreatedAt } : {}),
					...(afterCreatedAt !== undefined ? { afterCreatedAt } : {}),
					...(limit !== undefined ? { limit } : {}),
				}) };
			}),

		"team.messages.search": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.messages.search");
				assertOnlyKeys(p, ["roomId", "query", "authorId", "mentionAgentId", "pinnedOnly", "limit"], "team.messages.search");
				const roomId = requiredId(p.roomId, "team.messages.search.roomId");
				await requireRoom(deps.store, roomId);
				const authorId = optionalString(p.authorId, "team.messages.search.authorId", MAX_ID_LENGTH);
				const mentionAgentId = optionalString(p.mentionAgentId, "team.messages.search.mentionAgentId", MAX_ID_LENGTH);
				const pinnedOnly = optionalBoolean(p.pinnedOnly, "team.messages.search.pinnedOnly");
				const limit = p.limit === undefined ? undefined : positiveInteger(p.limit, "team.messages.search.limit", 200);
				return { messages: await deps.store.searchMessages({
					roomId,
					query: requiredString(p.query, "team.messages.search.query", MAX_SHORT_TEXT_LENGTH),
					...(authorId ? { authorId } : {}),
					...(mentionAgentId ? { mentionAgentId } : {}),
					...(pinnedOnly !== undefined ? { pinnedOnly } : {}),
					...(limit !== undefined ? { limit } : {}),
				}) };
			}),

		"team.messages.post": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.messages.post");
				assertOnlyKeys(
					p,
					["commandId", "messageId", "roomId", "content", "mentions", "attachments", "replyToMessageId", "threadRootMessageId", "runId", "taskId"],
					"team.messages.post",
				);
				const roomId = requiredId(p.roomId, "team.messages.post.roomId");
				const mentions = parseStringArray(p.mentions, "team.messages.post.mentions", 64);
				await requireMessageMentions(roomId, mentions, "team.messages.post.mentions[]");
				const result = await deps.store.postMessage({
					commandId: commandId(p.commandId, "team.messages.post"),
					...(p.messageId !== undefined ? { messageId: requiredId(p.messageId, "team.messages.post.messageId") } : {}),
					roomId,
					authorId: actorId,
					authorKind: "owner",
					source: "chat",
					content: requiredString(p.content, "team.messages.post.content", MAX_LONG_TEXT_LENGTH),
					mentions,
					attachments: parseMessageAttachments(p.attachments, "team.messages.post.attachments"),
					...(p.replyToMessageId !== undefined ? { replyToMessageId: requiredId(p.replyToMessageId, "team.messages.post.replyToMessageId") } : {}),
					...(p.threadRootMessageId !== undefined ? { threadRootMessageId: requiredId(p.threadRootMessageId, "team.messages.post.threadRootMessageId") } : {}),
					...(p.runId !== undefined ? { runId: requiredId(p.runId, "team.messages.post.runId") } : {}),
					...(p.taskId !== undefined ? { taskId: requiredId(p.taskId, "team.messages.post.taskId") } : {}),
				});
				return completeMutation(result);
			}),

		"team.messages.edit": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.messages.edit");
				assertOnlyKeys(p, ["commandId", "messageId", "content", "mentions"], "team.messages.edit");
				const mentions = parseStringArray(p.mentions, "team.messages.edit.mentions", 64);
				const messageId = requiredId(p.messageId, "team.messages.edit.messageId");
				const existing = await deps.store.getMessage(messageId);
				if (!existing) throw notFound("message", messageId);
				await requireMessageMentions(existing.roomId, mentions, "team.messages.edit.mentions[]");
				return completeMutation(await deps.store.editMessage({
					commandId: commandId(p.commandId, "team.messages.edit"),
					messageId,
					actorId,
					actorKind: "owner",
					content: requiredString(p.content, "team.messages.edit.content", MAX_LONG_TEXT_LENGTH),
					mentions,
				}));
			}),

		"team.messages.delete": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.messages.delete");
				assertOnlyKeys(p, ["commandId", "messageId"], "team.messages.delete");
				return completeMutation(await deps.store.deleteMessage({
					commandId: commandId(p.commandId, "team.messages.delete"),
					messageId: requiredId(p.messageId, "team.messages.delete.messageId"),
					actorId,
					actorKind: "owner",
				}));
			}),

		"team.messages.react": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.messages.react");
				assertOnlyKeys(p, ["commandId", "messageId", "key", "present"], "team.messages.react");
				const present = optionalBoolean(p.present, "team.messages.react.present");
				if (present === undefined) invalid("team.messages.react.present is required");
				return completeMutation(await deps.store.reactMessage({
					commandId: commandId(p.commandId, "team.messages.react"),
					messageId: requiredId(p.messageId, "team.messages.react.messageId"),
					actorId,
					actorKind: "owner",
					key: requiredString(p.key, "team.messages.react.key", 64),
					present,
				}));
			}),

		"team.messages.pin": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.messages.pin");
				assertOnlyKeys(p, ["commandId", "messageId", "pinned"], "team.messages.pin");
				const pinned = optionalBoolean(p.pinned, "team.messages.pin.pinned");
				if (pinned === undefined) invalid("team.messages.pin.pinned is required");
				return completeMutation(await deps.store.pinMessage({
					commandId: commandId(p.commandId, "team.messages.pin"),
					messageId: requiredId(p.messageId, "team.messages.pin.messageId"),
					actorId,
					actorKind: "owner",
					pinned,
				}));
			}),

		"team.runs.list": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.runs.list");
				assertOnlyKeys(p, ["roomId", "statuses"], "team.runs.list");
				const roomId = requiredId(p.roomId, "team.runs.list.roomId");
				await requireRoom(deps.store, roomId);
				const statuses = parseRunStatuses(p.statuses);
				const runs = await deps.store.listRuns(roomId);
				return { runs: statuses ? runs.filter((item) => statuses.has(item.status)) : runs };
			}),

		"team.runs.create": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.runs.create");
				assertOnlyKeys(
					p,
					["commandId", "runId", "roomId", "objective", "budgets", "metadata"],
					"team.runs.create",
				);
				const runId = optionalString(
					p.runId,
					"team.runs.create.runId",
					MAX_ID_LENGTH,
				);
				const result = await deps.store.createRun({
					commandId: commandId(p.commandId, "team.runs.create"),
					...(runId ? { runId } : {}),
					roomId: requiredId(p.roomId, "team.runs.create.roomId"),
					objective: requiredString(
						p.objective,
						"team.runs.create.objective",
						MAX_LONG_TEXT_LENGTH,
					),
					createdBy: actorId,
					...(p.budgets !== undefined
						? { budgets: parseBudgets(p.budgets, "team.runs.create.budgets") }
						: {}),
					...(p.metadata !== undefined
						? { metadata: parseMetadata(p.metadata, "team.runs.create.metadata") }
						: {}),
				});
				return completeMutation(result);
			}),

		"team.runs.delegate": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.runs.delegate");
				assertOnlyKeys(
					p,
					["commandId", "runId", "roomId", "objective", "budgets", "metadata", "tasks"],
					"team.runs.delegate",
				);
				const roomId = requiredId(p.roomId, "team.runs.delegate.roomId");
				const tasks = await prepareTaskAssigneesInRoom(
					roomId,
					parseTasks(p.tasks, "team.runs.delegate.tasks", 256),
					"team.runs.delegate.tasks[].assignedAgentId",
				);
				const result = await deps.store.delegateRun({
					commandId: requiredId(p.commandId, "team.runs.delegate.commandId"),
					...(p.runId !== undefined
						? { runId: requiredId(p.runId, "team.runs.delegate.runId") }
						: {}),
					roomId,
					objective: requiredString(
						p.objective,
						"team.runs.delegate.objective",
						MAX_LONG_TEXT_LENGTH,
					),
					createdBy: actorId,
					tasks,
					...(p.budgets !== undefined
						? { budgets: parseBudgets(p.budgets, "team.runs.delegate.budgets") }
						: {}),
					...(p.metadata !== undefined
						? { metadata: parseMetadata(p.metadata, "team.runs.delegate.metadata") }
						: {}),
				});
				return completeMutation(result, result.value.run.id);
			}),

		"team.runs.start": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.runs.start");
				assertOnlyKeys(p, ["commandId", "runId"], "team.runs.start");
				const runId = requiredId(p.runId, "team.runs.start.runId");
				const result = await deps.store.startRun({
					commandId: commandId(p.commandId, "team.runs.start"),
					runId,
				});
				return completeMutation(result, runId);
			}),

		"team.runs.get": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.runs.get");
				assertOnlyKeys(p, ["runId"], "team.runs.get");
				const runId = requiredId(p.runId, "team.runs.get.runId");
				const snapshot = await deps.store.readRunSnapshot(runId);
				if (!snapshot) throw notFound("run", runId);
				return publicRunSnapshot(snapshot);
			}),

		"team.runs.cancel": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.runs.cancel");
				assertOnlyKeys(p, ["commandId", "runId", "reason"], "team.runs.cancel");
				const runId = requiredId(p.runId, "team.runs.cancel.runId");
				const result = await deps.store.cancelRun({
					commandId: commandId(p.commandId, "team.runs.cancel"),
					runId,
					...(p.reason !== undefined
						? { reason: requiredString(p.reason, "team.runs.cancel.reason", MAX_SHORT_TEXT_LENGTH) }
						: {}),
				});
				return completeMutation(result, runId);
			}),

		"team.tasks.list": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.tasks.list");
				assertOnlyKeys(p, ["runId"], "team.tasks.list");
				const runId = requiredId(p.runId, "team.tasks.list.runId");
				await requireRun(deps.store, runId);
				return { tasks: await deps.store.listTasks(runId) };
			}),

		"team.tasks.result": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.tasks.result");
				assertOnlyKeys(p, ["runId", "taskId", "offset", "limit"], "team.tasks.result");
				const runId = requiredId(p.runId, "team.tasks.result.runId");
				const taskId = requiredId(p.taskId, "team.tasks.result.taskId");
				const offset = p.offset === undefined
					? undefined
					: nonNegativeInteger(p.offset, "team.tasks.result.offset");
				const limit = p.limit === undefined
					? undefined
					: positiveInteger(p.limit, "team.tasks.result.limit", MAX_TEAM_RESULT_PAGE_CHARS);
				await requireRun(deps.store, runId);
				const task = await deps.store.getTask(taskId);
				if (!task || task.runId !== runId) throw notFound("task", taskId);
				return pageTeamTaskResult(task, {
					...(offset !== undefined ? { offset } : {}),
					...(limit !== undefined ? { limit } : {}),
				});
			}),

		"team.tasks.add": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.tasks.add");
				assertOnlyKeys(p, ["commandId", "runId", "tasks"], "team.tasks.add");
				const runId = requiredId(p.runId, "team.tasks.add.runId");
				const tasks = await prepareTaskAssignees(runId, parseTasks(p.tasks));
				const result = await deps.store.addTasks({
					commandId: commandId(p.commandId, "team.tasks.add"),
					runId,
					tasks,
				});
				return completeMutation(result, runId);
			}),

		"team.tasks.cancel": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.tasks.cancel");
				assertOnlyKeys(p, ["commandId", "taskId", "reason"], "team.tasks.cancel");
				const taskId = requiredId(p.taskId, "team.tasks.cancel.taskId");
				const result = await deps.store.cancelTask({
					commandId: commandId(p.commandId, "team.tasks.cancel"),
					taskId,
					...(p.reason !== undefined
						? { reason: requiredString(p.reason, "team.tasks.cancel.reason", MAX_SHORT_TEXT_LENGTH) }
						: {}),
				});
				return completeMutation(result, result.value.runId);
			}),

		"team.tasks.retry": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.tasks.retry");
				assertOnlyKeys(p, ["commandId", "taskId", "delayMs"], "team.tasks.retry");
				const result = await deps.store.retryTask({
					commandId: commandId(p.commandId, "team.tasks.retry"),
					taskId: requiredId(p.taskId, "team.tasks.retry.taskId"),
					...(p.delayMs !== undefined
						? { delayMs: nonNegativeInteger(p.delayMs, "team.tasks.retry.delayMs") }
						: {}),
				});
				return completeMutation(result, result.value.runId);
			}),

		"team.handoffs.list": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.handoffs.list");
				assertOnlyKeys(p, ["runId"], "team.handoffs.list");
				const runId = requiredId(p.runId, "team.handoffs.list.runId");
				await requireRun(deps.store, runId);
				return { handoffs: await deps.store.listHandoffs(runId) };
			}),

		"team.handoffs.respond": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.handoffs.respond");
				assertOnlyKeys(
					p,
					["commandId", "handoffId", "decision", "reason"],
					"team.handoffs.respond",
				);
				if (p.decision !== "accept" && p.decision !== "reject") {
					invalid('team.handoffs.respond.decision must be "accept" or "reject"');
				}
				const handoffId = requiredId(
					p.handoffId,
					"team.handoffs.respond.handoffId",
				);
				// The authenticated operator is authorising the response on behalf
				// of the target team member. The domain store deliberately requires
				// the target agent id (so agent-driven responses remain fenced), but
				// passing the operator's actor id here would make every UI response
				// fail HANDOFF_TARGET_MISMATCH unless an agent happened to be named
				// "owner". Resolve the durable target instead of trusting a caller-
				// supplied identity.
				const handoff = (await deps.store.readSnapshot()).handoffs.find(
					(candidate) => candidate.id === handoffId,
				);
				if (!handoff) throw notFound("handoff", handoffId);
				const mutation = p.decision === "accept"
					? deps.store.acceptHandoff.bind(deps.store)
					: deps.store.rejectHandoff.bind(deps.store);
				const result = await mutation({
					commandId: commandId(p.commandId, "team.handoffs.respond"),
					handoffId,
					respondingAgentId: handoff.toAgentId,
					...(p.reason !== undefined
						? {
								reason: requiredString(
									p.reason,
									"team.handoffs.respond.reason",
									MAX_SHORT_TEXT_LENGTH,
								),
							}
						: {}),
				});
				return completeMutation(result, result.value.runId);
			}),

		"team.approvals.list": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.approvals.list");
				assertOnlyKeys(p, ["runId"], "team.approvals.list");
				const runId = requiredId(p.runId, "team.approvals.list.runId");
				await requireRun(deps.store, runId);
				return { approvals: await deps.store.listApprovals(runId) };
			}),

		"team.approvals.resolve": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.approvals.resolve");
				assertOnlyKeys(
					p,
					["commandId", "approvalId", "decision", "resolution"],
					"team.approvals.resolve",
				);
				if (p.decision !== "approved" && p.decision !== "rejected") {
					invalid('team.approvals.resolve.decision must be "approved" or "rejected"');
				}
				const result = await deps.store.resolveApproval({
					commandId: commandId(p.commandId, "team.approvals.resolve"),
					approvalId: requiredId(p.approvalId, "team.approvals.resolve.approvalId"),
					decision: p.decision,
					...(p.resolution !== undefined
						? {
								resolution: requiredString(
									p.resolution,
									"team.approvals.resolve.resolution",
									MAX_LONG_TEXT_LENGTH,
								),
							}
						: {}),
				});
				return completeMutation(result, result.value.runId);
			}),

		"team.artifacts.list": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.artifacts.list");
				assertOnlyKeys(p, ["runId"], "team.artifacts.list");
				const runId = requiredId(p.runId, "team.artifacts.list.runId");
				await requireRun(deps.store, runId);
				return { artifacts: await deps.store.listArtifacts(runId) };
			}),

		"team.events.list": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.events.list");
				assertOnlyKeys(
					p,
					["roomId", "runId", "afterRoomSeq", "limit"],
					"team.events.list",
				);
				const roomId = requiredId(p.roomId, "team.events.list.roomId");
				const afterRoomSeq = parseCursor(
					p.afterRoomSeq,
					"team.events.list.afterRoomSeq",
				);
				const limit = parseLimit(p.limit, "team.events.list.limit");
				await requireRoom(deps.store, roomId);
				const runId = optionalString(p.runId, "team.events.list.runId", MAX_ID_LENGTH);
				if (runId) {
					const selectedRun = await deps.store.getRun(runId);
					if (!selectedRun || selectedRun.roomId !== roomId) throw notFound("run", runId);
				}
				return pageStoredEvents(deps.store, {
					roomId,
					...(runId ? { runId } : {}),
					afterRoomSeq,
					limit,
				});
			}),

		"team.resume": async (raw) =>
			run(async () => {
				const p = paramsObject(raw, "team.resume");
				assertOnlyKeys(
					p,
					["roomId", "runId", "afterRoomSeq", "limit"],
					"team.resume",
				);
				const roomId = requiredId(p.roomId, "team.resume.roomId");
				const runId = optionalString(p.runId, "team.resume.runId", MAX_ID_LENGTH);
				const afterRoomSeq = parseCursor(p.afterRoomSeq, "team.resume.afterRoomSeq");
				const limit = parseLimit(p.limit, "team.resume.limit");
				const snapshot = await deps.store.readSnapshot();
				const room = requireRoomInSnapshot(snapshot, roomId);
				const runs = snapshot.runs.filter((item) => item.roomId === roomId);
				const page = pageEvents(snapshot, {
					roomId,
					afterRoomSeq,
					limit,
				});
				const result: TeamResumeResult = {
					room,
					messages: (snapshot.messages ?? [])
						.filter((message) => message.roomId === roomId)
						.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
						.slice(-100),
					metrics: roomMetricsFromSnapshot(snapshot, roomId),
					runs,
					pendingExecApprovals: [...(deps.listPendingExecApprovals?.(roomId) ?? [])],
					execApprovalRevision: deps.getExecApprovalRevision?.(roomId) ?? 0,
					...(runId ? { run: buildRunSnapshot(snapshot, runId, roomId, page.headRoomSeq) } : {}),
					events: page.events,
					headRoomSeq: page.headRoomSeq,
					replayComplete: isReplayComplete(snapshot, roomId, afterRoomSeq, page.headRoomSeq),
					hasMore: page.hasMore,
					...(page.nextAfterRoomSeq !== undefined
						? { nextAfterRoomSeq: page.nextAfterRoomSeq }
						: {}),
				};
				return result;
			}),
	};
}

function paramsObject(
	value: unknown,
	method: TeamRequestMethod,
	allowMissing = false,
): Record<string, unknown> {
	if (allowMissing && value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		invalid(`${method} params must be an object`);
	}
	return value as Record<string, unknown>;
}

function assertOnlyKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	method: TeamRequestMethod,
): void {
	const allowedSet = new Set(allowed);
	const extra = Object.keys(value).find((key) => !allowedSet.has(key));
	if (extra) invalid(`${method} received unknown field: ${extra}`);
}

function invalid(message: string): never {
	throw new TeamMethodError("INVALID_REQUEST", message);
}

function requiredString(value: unknown, field: string, maxLength: number): string {
	const parsed = optionalString(value, field, maxLength);
	if (parsed === undefined) invalid(`${field} is required`);
	return parsed;
}

function optionalString(
	value: unknown,
	field: string,
	maxLength: number,
): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") invalid(`${field} must be a string`);
	const parsed = value.trim();
	if (parsed.length === 0) invalid(`${field} must not be empty`);
	if (parsed.length > maxLength) invalid(`${field} must be at most ${maxLength} characters`);
	return parsed;
}

function requiredId(value: unknown, field: string): string {
	return requiredString(value, field, MAX_ID_LENGTH);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") invalid(`${field} must be a boolean`);
	return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		invalid(`${field} must be a non-negative safe integer`);
	}
	return value as number;
}

function positiveInteger(value: unknown, field: string, max?: number): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0 || (max && (value as number) > max)) {
		invalid(`${field} must be a positive safe integer${max ? ` no greater than ${max}` : ""}`);
	}
	return value as number;
}

function positiveNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		invalid(`${field} must be a positive finite number`);
	}
	return value;
}

function parseMetadata(value: unknown, field: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		invalid(`${field} must be an object`);
	}
	try {
		JSON.stringify(value);
	} catch {
		invalid(`${field} must be JSON serializable`);
	}
	return value as Record<string, unknown>;
}

function parseStringArray(value: unknown, field: string, maxItems: number): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) invalid(`${field} must be an array`);
	if (value.length > maxItems) invalid(`${field} cannot contain more than ${maxItems} values`);
	const result: string[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < value.length; index += 1) {
		const item = requiredId(value[index], `${field}[${index}]`);
		if (!seen.has(item)) {
			seen.add(item);
			result.push(item);
		}
	}
	return result;
}

function parseMessageAttachments(value: unknown, field: string): RoomMessageAttachment[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) invalid(`${field} must be an array`);
	if (value.length > 32) invalid(`${field} cannot contain more than 32 values`);
	return value.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) invalid(`${field}[${index}] must be an object`);
		const record = item as Record<string, unknown>;
		assertOnlyKeys(record, ["artifactId", "name", "uri", "mimeType", "bytes"], "team.messages.post");
		const artifactId = optionalString(record.artifactId, `${field}[${index}].artifactId`, MAX_ID_LENGTH);
		const uri = optionalString(record.uri, `${field}[${index}].uri`, 8_000);
		if (!artifactId && !uri) invalid(`${field}[${index}] requires artifactId or uri`);
		const mimeType = optionalString(record.mimeType, `${field}[${index}].mimeType`, 255);
		const bytes = record.bytes === undefined ? undefined : nonNegativeInteger(record.bytes, `${field}[${index}].bytes`);
		return {
			...(artifactId ? { artifactId } : {}),
			name: requiredString(record.name, `${field}[${index}].name`, 512),
			...(uri ? { uri } : {}),
			...(mimeType ? { mimeType } : {}),
			...(bytes !== undefined ? { bytes } : {}),
		};
	});
}

async function validateRoomCoordinator(
	metadata: Record<string, unknown> | undefined,
	members: readonly { agentId: string }[],
	field: string,
	requireConfiguredAgents: (agentIds: readonly string[], field: string) => Promise<void>,
): Promise<void> {
	const coordinator = metadata?.coordinatorAgentId;
	if (coordinator === undefined) return;
	if (typeof coordinator !== "string" || coordinator.trim().length === 0) {
		invalid(`${field}.metadata.coordinatorAgentId must be a non-empty string`);
	}
	const coordinatorAgentId = coordinator.trim();
	await requireConfiguredAgents(
		[coordinatorAgentId],
		`${field}.metadata.coordinatorAgentId`,
	);
	if (!members.some((member) => member.agentId === coordinatorAgentId)) {
		invalid(
			`${field}.metadata.coordinatorAgentId must reference an agent in ${field}.members`,
		);
	}
}

function parseMembers(
	value: unknown,
	field: string,
): StoreTeamMemberInput[] {
	if (!Array.isArray(value)) invalid(`${field} must be an array`);
	const seen = new Set<string>();
	return value.map((raw, index) => {
		const member = paramsObject(raw, "team.rooms.update");
		assertOnlyKeys(member, ["agentId", "role"], "team.rooms.update");
		const agentId = requiredId(member.agentId, `${field}[${index}].agentId`);
		if (seen.has(agentId)) invalid(`${field} contains duplicate agentId: ${agentId}`);
		seen.add(agentId);
		return {
			agentId,
			...(member.role !== undefined
				? { role: requiredString(member.role, `${field}[${index}].role`, MAX_SHORT_TEXT_LENGTH) }
				: {}),
		};
	});
}

function parseBudgets(value: unknown, field: string): RunBudgets {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		invalid(`${field} must be an object`);
	}
	const budget = value as Record<string, unknown>;
	const allowed = ["maxTokens", "maxCostUsd", "maxDurationMs", "maxConcurrency", "maxAttempts"];
	const extra = Object.keys(budget).find((key) => !allowed.includes(key));
	if (extra) invalid(`${field} received unknown field: ${extra}`);
	return {
		...(budget.maxTokens !== undefined
			? { maxTokens: positiveInteger(budget.maxTokens, `${field}.maxTokens`) }
			: {}),
		...(budget.maxCostUsd !== undefined
			? { maxCostUsd: positiveNumber(budget.maxCostUsd, `${field}.maxCostUsd`) }
			: {}),
		...(budget.maxDurationMs !== undefined
			? { maxDurationMs: positiveInteger(budget.maxDurationMs, `${field}.maxDurationMs`) }
			: {}),
		...(budget.maxConcurrency !== undefined
			? { maxConcurrency: positiveInteger(budget.maxConcurrency, `${field}.maxConcurrency`) }
			: {}),
		...(budget.maxAttempts !== undefined
			? { maxAttempts: positiveInteger(budget.maxAttempts, `${field}.maxAttempts`) }
			: {}),
	};
}

function parseTasks(value: unknown, field = "team.tasks.add.tasks", maxTasks = 500): TaskDraft[] {
	if (!Array.isArray(value) || value.length === 0) {
		invalid(`${field} must be a non-empty array`);
	}
	if (value.length > maxTasks) invalid(`${field} must contain at most ${maxTasks} tasks`);
	const ids = new Set<string>();
	return value.map((raw, index) => parseTask(raw as TeamTaskInput, index, ids, field));
}

function parseTask(value: unknown, index: number, ids: Set<string>, field: string): TaskDraft {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		invalid(`${field}[${index}] must be an object`);
	}
	const task = value as Record<string, unknown>;
	const allowed = [
		"id",
		"title",
		"instructions",
		"assignedAgentId",
		"dependencies",
		"join",
		"retry",
		"resultGate",
		"priority",
	];
	const extra = Object.keys(task).find((key) => !allowed.includes(key));
	if (extra) invalid(`${field}[${index}] received unknown field: ${extra}`);
	const id = optionalString(task.id, `${field}[${index}].id`, MAX_ID_LENGTH);
	if (id && ids.has(id)) invalid(`${field} contains duplicate id: ${id}`);
	if (id) ids.add(id);
	const dependencies = parseDependencies(task.dependencies, index, field);
	if (id && dependencies?.includes(id)) invalid(`task ${id} cannot depend on itself`);
	return {
		...(id ? { id } : {}),
		title: requiredString(
			task.title,
			`${field}[${index}].title`,
			MAX_SHORT_TEXT_LENGTH,
		),
		instructions: requiredString(
			task.instructions,
			`${field}[${index}].instructions`,
			MAX_LONG_TEXT_LENGTH,
		),
		...(task.assignedAgentId !== undefined
			? {
					assignedAgentId: requiredId(
						task.assignedAgentId,
						`${field}[${index}].assignedAgentId`,
					),
				}
			: {}),
		...(dependencies ? { dependencies } : {}),
		...(task.join !== undefined
			? { join: parseJoin(task.join, `${field}[${index}].join`) }
			: {}),
		...(task.retry !== undefined
			? { retry: parseRetry(task.retry, `${field}[${index}].retry`) }
			: {}),
		...(task.resultGate !== undefined
			? { resultGate: parseResultGate(task.resultGate, `${field}[${index}].resultGate`) }
			: {}),
		...(task.priority !== undefined
			? { priority: integer(task.priority, `${field}[${index}].priority`) }
			: {}),
	};
}

function parseResultGate(value: unknown, field: string): import("../../collaboration/types.js").TaskResultGate {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		invalid(`${field} must be an object`);
	}
	const gate = value as Record<string, unknown>;
	const extra = Object.keys(gate).find((key) => key !== "kind" && key !== "policy");
	if (extra) invalid(`${field} received unknown field: ${extra}`);
	if (gate.kind !== "review_verdict") invalid(`${field}.kind must be review_verdict`);
	if (gate.policy !== undefined && gate.policy !== "independent-v1") {
		invalid(`${field}.policy must be independent-v1`);
	}
	return {
		kind: "review_verdict",
		...(gate.policy === "independent-v1" ? { policy: gate.policy } : {}),
	};
}

function parseDependencies(value: unknown, taskIndex: number, field: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		invalid(`${field}[${taskIndex}].dependencies must be an array`);
	}
	const seen = new Set<string>();
	return value.map((dependency, index) => {
		const id = requiredId(
			dependency,
			`${field}[${taskIndex}].dependencies[${index}]`,
		);
		if (seen.has(id)) invalid(`task dependencies contain duplicate id: ${id}`);
		seen.add(id);
		return id;
	});
}

function parseJoin(value: unknown, field: string): JoinCondition {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		invalid(`${field} must be an object`);
	}
	const join = value as Record<string, unknown>;
	if (join.kind === "all") {
		if (Object.keys(join).some((key) => key !== "kind")) invalid(`${field} has fields invalid for all`);
		return { kind: "all" };
	}
	if (join.kind === "any") {
		if (Object.keys(join).some((key) => key !== "kind" && key !== "cancelRemaining")) {
			invalid(`${field} has fields invalid for any`);
		}
		return {
			kind: "any",
			...(join.cancelRemaining !== undefined
				? { cancelRemaining: optionalBoolean(join.cancelRemaining, `${field}.cancelRemaining`) }
				: {}),
		};
	}
	if (join.kind === "quorum") {
		if (
			Object.keys(join).some(
				(key) => key !== "kind" && key !== "minimum" && key !== "cancelRemaining",
			)
		) {
			invalid(`${field} has fields invalid for quorum`);
		}
		return {
			kind: "quorum",
			minimum: positiveInteger(join.minimum, `${field}.minimum`),
			...(join.cancelRemaining !== undefined
				? { cancelRemaining: optionalBoolean(join.cancelRemaining, `${field}.cancelRemaining`) }
				: {}),
		};
	}
	invalid(`${field}.kind must be "all", "any", or "quorum"`);
}

function parseRetry(value: unknown, field: string): RetryPolicy {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		invalid(`${field} must be an object`);
	}
	const retry = value as Record<string, unknown>;
	const extra = Object.keys(retry).find(
		(key) => !["maxAttempts", "backoffMs", "retryableCodes"].includes(key),
	);
	if (extra) invalid(`${field} received unknown field: ${extra}`);
	let retryableCodes: string[] | undefined;
	if (retry.retryableCodes !== undefined) {
		if (!Array.isArray(retry.retryableCodes)) invalid(`${field}.retryableCodes must be an array`);
		retryableCodes = retry.retryableCodes.map((code, index) =>
			requiredString(code, `${field}.retryableCodes[${index}]`, MAX_ID_LENGTH),
		);
		if (new Set(retryableCodes).size !== retryableCodes.length) {
			invalid(`${field}.retryableCodes must not contain duplicates`);
		}
	}
	return {
		maxAttempts: positiveInteger(retry.maxAttempts, `${field}.maxAttempts`, 100),
		...(retry.backoffMs !== undefined
			? { backoffMs: nonNegativeInteger(retry.backoffMs, `${field}.backoffMs`) }
			: {}),
		...(retryableCodes ? { retryableCodes } : {}),
	};
}

function integer(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value)) invalid(`${field} must be a safe integer`);
	return value as number;
}

function parseRunStatuses(value: unknown): Set<RunStatus> | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length === 0) {
		invalid("team.runs.list.statuses must be a non-empty array");
	}
	const result = new Set<RunStatus>();
	for (const status of value) {
		if (typeof status !== "string" || !RUN_STATUSES.has(status as RunStatus)) {
			invalid(`team.runs.list.statuses contains invalid status: ${String(status)}`);
		}
		result.add(status as RunStatus);
	}
	return result;
}

function parseCursor(value: unknown, field: string): number {
	return value === undefined ? 0 : nonNegativeInteger(value, field);
}

function parseLimit(value: unknown, field: string): number {
	return value === undefined ? DEFAULT_EVENT_LIMIT : positiveInteger(value, field, MAX_EVENT_LIMIT);
}

async function requireRoom(store: CollaborationStore, roomId: RoomId): Promise<CollaborationRoom> {
	const room = await store.getRoom(roomId);
	if (!room) throw notFound("room", roomId);
	return room;
}

async function requireRun(store: CollaborationStore, runId: RunId): Promise<void> {
	if (!(await store.getRun(runId))) throw notFound("run", runId);
}

function notFound(kind: string, id: string): TeamMethodError {
	return new TeamMethodError("TEAM_NOT_FOUND", `${kind} not found: ${id}`, { kind, id });
}

function requireRoomInSnapshot(
	snapshot: CollaborationStoreSnapshot,
	roomId: RoomId,
): CollaborationRoom {
	const room = snapshot.rooms.find((item) => item.id === roomId);
	if (!room) throw notFound("room", roomId);
	return room;
}

function requireRunInSnapshot(
	snapshot: CollaborationStoreSnapshot,
	runId: RunId,
	roomId: RoomId,
) {
	const run = snapshot.runs.find((item) => item.id === runId && item.roomId === roomId);
	if (!run) throw notFound("run", runId);
	return run;
}

function roomEvents(
	snapshot: CollaborationStoreSnapshot,
	roomId: RoomId,
): CollaborationEvent[] {
	return snapshot.events
		.filter((event) => event.roomId === roomId)
		.sort((left, right) => left.roomSeq - right.roomSeq);
}

function pageEvents(
	snapshot: CollaborationStoreSnapshot,
	query: { roomId: RoomId; runId?: RunId; afterRoomSeq: number; limit: number },
): TeamEventPage {
	const allRoomEvents = roomEvents(snapshot, query.roomId);
	const headRoomSeq = allRoomEvents.at(-1)?.roomSeq ?? 0;
	const candidates = allRoomEvents.filter(
		(event) =>
			event.roomSeq > query.afterRoomSeq &&
			(query.runId === undefined || event.runId === query.runId),
	);
	const hasMore = candidates.length > query.limit;
	const events = candidates.slice(0, query.limit);
	return {
		events,
		headRoomSeq,
		hasMore,
		...(hasMore && events.length > 0
			? { nextAfterRoomSeq: events[events.length - 1]!.roomSeq }
			: {}),
	};
}

const MIN_ROOM_HEAD_PROBE_LIMIT = 64;

/**
 * Read one activity page without hydrating the owner's complete collaboration
 * snapshot. The unfiltered probe establishes the room-wide cursor even when
 * the visible page is scoped to one run; the second read, when needed, applies
 * that run filter. `limit + 1` preserves exact hasMore semantics.
 */
async function pageStoredEvents(
	store: CollaborationStore,
	query: { roomId: RoomId; runId?: RunId; afterRoomSeq: number; limit: number },
): Promise<TeamEventPage> {
	const pageProbeLimit = query.limit + 1;
	const headProbeLimit = Math.max(MIN_ROOM_HEAD_PROBE_LIMIT, pageProbeLimit);
	const roomProbe = sortEvents(await store.readEvents({
		roomId: query.roomId,
		afterRoomSeq: query.afterRoomSeq,
		limit: headProbeLimit,
	}));
	let headRoomSeq = await retainedRoomHead(store, query.roomId, query.afterRoomSeq, roomProbe, headProbeLimit);
	const candidates = query.runId === undefined
		? roomProbe.slice(0, pageProbeLimit)
		: sortEvents(await store.readEvents({
			roomId: query.roomId,
			runId: query.runId,
			afterRoomSeq: query.afterRoomSeq,
			limit: pageProbeLimit,
		}));
	const observedLastSeq = candidates.at(-1)?.roomSeq ?? 0;
	// A matching event may commit between the room-head probe and the filtered
	// page read. Never return a head behind an event in the same response.
	headRoomSeq = Math.max(headRoomSeq, observedLastSeq);
	const hasMore = candidates.length > query.limit;
	const events = candidates.slice(0, query.limit);
	return {
		events,
		headRoomSeq,
		hasMore,
		...(hasMore && events.length > 0
			? { nextAfterRoomSeq: events[events.length - 1]!.roomSeq }
			: {}),
	};
}

function sortEvents(events: readonly CollaborationEvent[]): CollaborationEvent[] {
	return [...events].sort((left, right) => left.roomSeq - right.roomSeq);
}

/**
 * Resolve the latest retained room sequence through bounded indexed reads.
 * Usually the first probe already reaches the head. A full probe or a cursor
 * beyond the retained head falls back to a logarithmic search, capped by the
 * safe-integer room-sequence domain rather than by retained history size.
 *
 * This deliberately matches the prior snapshot behavior: if every event was
 * retained away, the visible retained head is zero even if the authority's
 * internal next-sequence counter is higher.
 */
async function retainedRoomHead(
	store: CollaborationStore,
	roomId: RoomId,
	afterRoomSeq: number,
	probe: readonly CollaborationEvent[],
	probeLimit: number,
): Promise<number> {
	const lastProbeSeq = probe.at(-1)?.roomSeq;
	if (lastProbeSeq !== undefined) {
		if (probe.length < probeLimit) return lastProbeSeq;
		return searchRetainedRoomHead(store, roomId, lastProbeSeq, Number.MAX_SAFE_INTEGER);
	}
	if (afterRoomSeq === 0) return 0;

	// The common caught-up case: the caller's cursor is the retained head.
	const atCursor = sortEvents(await store.readEvents({
		roomId,
		afterRoomSeq: afterRoomSeq - 1,
		limit: 1,
	}))[0];
	if (atCursor) {
		if (atCursor.roomSeq === afterRoomSeq) return afterRoomSeq;
		// A concurrent append may have landed between the empty probe and this read.
		return searchRetainedRoomHead(store, roomId, atCursor.roomSeq, Number.MAX_SAFE_INTEGER);
	}

	// A future/stale cursor can sit beyond the retained head. Find that head
	// without scanning every retained event.
	const first = sortEvents(await store.readEvents({ roomId, afterRoomSeq: 0, limit: 1 }))[0];
	if (!first) return 0;
	if (first.roomSeq >= afterRoomSeq) {
		return searchRetainedRoomHead(store, roomId, first.roomSeq, Number.MAX_SAFE_INTEGER);
	}
	return searchRetainedRoomHead(store, roomId, first.roomSeq, afterRoomSeq - 1);
}

async function searchRetainedRoomHead(
	store: CollaborationStore,
	roomId: RoomId,
	knownEventSeq: number,
	upperBound: number,
): Promise<number> {
	let low = knownEventSeq;
	let high = Math.max(knownEventSeq, upperBound);
	while (low < high) {
		const midpoint = low + Math.ceil((high - low) / 2);
		const event = (await store.readEvents({
			roomId,
			afterRoomSeq: midpoint - 1,
			limit: 1,
		}))[0];
		if (event) low = Math.max(midpoint, event.roomSeq);
		else high = midpoint - 1;
	}
	return low;
}

function isReplayComplete(
	snapshot: CollaborationStoreSnapshot,
	roomId: RoomId,
	afterRoomSeq: number,
	headRoomSeq: number,
): boolean {
	if (afterRoomSeq > headRoomSeq) return false;
	const oldestRoomSeq = roomEvents(snapshot, roomId)[0]?.roomSeq;
	return oldestRoomSeq === undefined || afterRoomSeq >= oldestRoomSeq - 1;
}

function buildRunSnapshot(
	snapshot: CollaborationStoreSnapshot,
	runId: RunId,
	roomId: RoomId,
	latestRoomSeq: number,
): TeamRunSnapshot {
	const room = requireRoomInSnapshot(snapshot, roomId);
	const selectedRun = requireRunInSnapshot(snapshot, runId, roomId);
	return {
		room,
		run: selectedRun,
		tasks: snapshot.tasks.filter((item) => item.runId === runId),
		attempts: snapshot.attempts
			.filter((item) => item.runId === runId)
			.map(publicAttemptSnapshot),
		handoffs: snapshot.handoffs.filter((item) => item.runId === runId),
		approvals: snapshot.approvals.filter((item) => item.runId === runId),
		artifacts: snapshot.artifacts.filter((item) => item.runId === runId),
		latestRoomSeq,
	};
}

/** Strip the lease capability before run state crosses the gateway boundary. */
function publicAttemptSnapshot(attempt: TaskAttempt): TeamAttemptSnapshot {
	const { lease, ...state } = attempt;
	return {
		...state,
		leaseExpiresAt: lease.expiresAt,
	};
}

function publicRunSnapshot(snapshot: RunSnapshot): TeamRunSnapshot {
	return {
		...snapshot,
		attempts: snapshot.attempts.map(publicAttemptSnapshot),
	};
}
