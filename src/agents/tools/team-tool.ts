/**
 * `team` — owner-only conversational control plane for durable Team Mode.
 *
 * This is intentionally a semantic store client, not another scheduler. Every
 * mutation goes through `BrigadeStore.collaboration` with an idempotency key;
 * the active runtime service is only kicked after the durable commit.
 */

import { randomUUID } from "node:crypto";

import { Type } from "typebox";

import type { AgentToolResult } from "@earendil-works/pi-agent-core";

import { kickActiveTeamRuntime } from "../../collaboration/runtime-service.js";
import { parseTeamChatSessionKey } from "../../collaboration/session-key.js";
import { resolveConfiguredRoomCoordinatorAgentId } from "../../collaboration/room-coordinator.js";
import {
	MAX_TEAM_RESULT_PAGE_CHARS,
	pageTeamTaskResult,
	type TeamTaskResultPage,
} from "../../collaboration/task-result-page.js";
import type {
	CollaborationStore,
	TaskDraft,
} from "../../collaboration/store.js";
import { CollaborationConflictError, CollaborationDomainError } from "../../collaboration/types.js";
import type {
	CollaborationRoom,
	RunSnapshot,
	TeamRun,
} from "../../collaboration/types.js";
import { getRuntimeContext } from "../../storage/runtime-context.js";
import { loadConfig } from "../../core/config.js";
import { isConfiguredAgentId } from "../configured-agent.js";
import {
	BrigadeToolAuthorizationError,
	BrigadeToolInputError,
	jsonResult,
	readNumberParam,
	readStringParam,
} from "./common.js";
import type { BrigadeTool } from "./types.js";

const JoinSchema = Type.Union([
	Type.Object({ kind: Type.Literal("all") }),
	Type.Object({
		kind: Type.Literal("any"),
		cancelRemaining: Type.Optional(Type.Boolean()),
	}),
	Type.Object({
		kind: Type.Literal("quorum"),
		minimum: Type.Integer({ minimum: 1 }),
		cancelRemaining: Type.Optional(Type.Boolean()),
	}),
]);

const TaskDraftSchema = Type.Object({
	id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	title: Type.String({ minLength: 1, maxLength: 512 }),
	instructions: Type.String({ minLength: 1, maxLength: 32_000 }),
	assignedAgentId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	dependencies: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 1_000 })),
	join: Type.Optional(JoinSchema),
	retry: Type.Optional(
		Type.Object({
			maxAttempts: Type.Integer({ minimum: 1, maximum: 100 }),
			backoffMs: Type.Optional(Type.Integer({ minimum: 0 })),
			retryableCodes: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 100 })),
		}),
	),
	resultGate: Type.Optional(Type.Object({
		kind: Type.Literal("review_verdict"),
		policy: Type.Optional(Type.Literal("independent-v1")),
	})),
	priority: Type.Optional(Type.Integer()),
});

const BudgetsSchema = Type.Object({
	maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
	maxCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
	maxDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
	maxConcurrency: Type.Optional(Type.Integer({ minimum: 1 })),
	maxAttempts: Type.Optional(Type.Integer({ minimum: 1 })),
});

const TeamParams = Type.Object({
	action: Type.Union(
		[
			Type.Literal("list_rooms"),
			Type.Literal("create_room"),
			Type.Literal("update_room"),
			Type.Literal("archive_room"),
			Type.Literal("list_messages"),
			Type.Literal("search_messages"),
			Type.Literal("post_message"),
			Type.Literal("list_runs"),
			Type.Literal("create_run"),
			Type.Literal("delegate"),
			Type.Literal("add_tasks"),
			Type.Literal("start_run"),
			Type.Literal("status"),
			Type.Literal("read_result"),
			Type.Literal("cancel_run"),
			Type.Literal("cancel_task"),
			Type.Literal("retry_task"),
			Type.Literal("resolve_approval"),
			Type.Literal("respond_handoff"),
		],
		{
			description:
				"Durable Team Mode operation. Create, update, or archive a room; delegate a complete run; and inspect progress or pending decisions.",
		},
	),
	roomId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	messageId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	content: Type.Optional(Type.String({ minLength: 1, maxLength: 100_000 })),
	query: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
	mentions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 64 })),
	replyToMessageId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	threadRootMessageId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	pinnedOnly: Type.Optional(Type.Boolean()),
	afterCreatedAt: Type.Optional(Type.Integer({ minimum: 0 })),
	runId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	approvalId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	handoffId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
	title: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
	objective: Type.Optional(Type.String({ minLength: 1, maxLength: 32_000 })),
	reason: Type.Optional(Type.String({ maxLength: 8_000 })),
	resolution: Type.Optional(Type.String({ maxLength: 8_000 })),
	delayMs: Type.Optional(Type.Integer({ description: "retry_task: optional delay before the task becomes claimable.", minimum: 0 })),
	offset: Type.Optional(Type.Integer({ description: "read_result: zero-based character offset; defaults to 0.", minimum: 0 })),
	limit: Type.Optional(Type.Integer({
		description: "read_result: maximum exact characters in this page; defaults to 8000.",
		minimum: 1,
		maximum: MAX_TEAM_RESULT_PAGE_CHARS,
	})),
	decision: Type.Optional(
		Type.Union([
			Type.Literal("approved"),
			Type.Literal("rejected"),
			Type.Literal("accepted"),
		]),
	),
	members: Type.Optional(
		Type.Array(
			Type.Object({
				agentId: Type.String({ minLength: 1, maxLength: 128 }),
				role: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
			}),
			{ maxItems: 1_000 },
		),
	),
	budgets: Type.Optional(BudgetsSchema),
	tasks: Type.Optional(Type.Array(TaskDraftSchema, { minItems: 1, maxItems: 256 })),
	metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

type TeamAction =
	| "list_rooms"
	| "create_room"
	| "update_room"
	| "archive_room"
	| "list_messages"
	| "search_messages"
	| "post_message"
	| "list_runs"
	| "create_run"
	| "delegate"
	| "add_tasks"
	| "start_run"
	| "status"
	| "read_result"
	| "cancel_run"
	| "cancel_task"
	| "retry_task"
	| "resolve_approval"
	| "respond_handoff";

export interface TeamToolResult {
	action: TeamAction;
	ok: boolean;
	message: string;
	commandId?: string;
	latestRoomSeq?: number;
	room?: unknown;
	rooms?: unknown[];
	run?: unknown;
	runs?: unknown[];
	tasks?: unknown[];
	snapshot?: unknown;
	approval?: unknown;
	handoff?: unknown;
	resultPage?: TeamTaskResultPage;
	messages?: unknown[];
	roomMessage?: unknown;
	errorCode?: string;
}

export interface MakeTeamToolOptions {
	agentId: string;
	/** Focused-test seam; production always resolves RuntimeContext lazily. */
	store?: CollaborationStore;
	now?: () => number;
	commandId?: (toolCallId: string, action: TeamAction) => string;
	kick?: () => Promise<void> | void;
	/** Test/embedding seam. Production falls back to the live Brigade config. */
	validateAgentId?: (agentId: string) => boolean | Promise<boolean>;
	/** Operator-facing Team chat. When present, room operations are scoped to it. */
	sessionKey?: string;
	/** Synthetic coordinator returns may inspect Team state but cannot mutate it. */
	readOnly?: boolean;
}

function isConfiguredAgent(agentIdValue: string, currentAgentId: string): boolean {
	return isConfiguredAgentId(loadConfig(), agentIdValue, currentAgentId);
}

function roomSummary(room: CollaborationRoom): Record<string, unknown> {
	return {
		id: room.id,
		title: room.title,
		status: room.status,
		members: room.members.map(({ agentId, role }) => ({ agentId, ...(role ? { role } : {}) })),
		createdBy: room.createdBy,
		createdAt: room.createdAt,
		updatedAt: room.updatedAt,
	};
}

function runSummary(run: TeamRun): Record<string, unknown> {
	return {
		id: run.id,
		roomId: run.roomId,
		status: run.status,
		objective: run.objective,
		budgets: run.budgets,
		usage: run.usage,
		...(run.cancelReason ? { cancelReason: run.cancelReason } : {}),
		...(run.failureReason ? { failureReason: run.failureReason } : {}),
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
		...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
	};
}

function compactResult(value: unknown, maxChars = 4_000): unknown {
	if (typeof value === "string") {
		return value.length > maxChars
			? `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`
			: value;
	}
	try {
		const encoded = JSON.stringify(value);
		if (encoded.length <= maxChars) return value;
		return `${encoded.slice(0, maxChars)}...[truncated ${encoded.length - maxChars} chars]`;
	} catch {
		return "[unserializable task result]";
	}
}

function compactSnapshot(snapshot: RunSnapshot): Record<string, unknown> {
	return {
		room: roomSummary(snapshot.room),
		run: runSummary(snapshot.run),
		tasks: snapshot.tasks.map((task) => ({
			id: task.id,
			title: task.title,
			status: task.status,
			...(task.assignedAgentId ? { assignedAgentId: task.assignedAgentId } : {}),
			dependencies: task.dependencies.map((dependency) => dependency.taskId),
			join: task.join,
			retry: task.retry,
			...(task.resultGate ? { resultGate: task.resultGate } : {}),
			priority: task.priority,
			...(task.failureReason ? { failureReason: task.failureReason } : {}),
			...(task.result !== undefined ? { result: compactResult(task.result) } : {}),
		})),
		attempts: snapshot.attempts.map((attempt) => ({
			id: attempt.id,
			taskId: attempt.taskId,
			number: attempt.number,
			status: attempt.status,
			usage: attempt.usage,
			...(attempt.errorCode ? { errorCode: attempt.errorCode } : {}),
			...(attempt.errorMessage ? { errorMessage: attempt.errorMessage } : {}),
			...(attempt.result !== undefined ? { result: compactResult(attempt.result) } : {}),
			startedAt: attempt.startedAt,
			updatedAt: attempt.updatedAt,
			...(attempt.finishedAt !== undefined ? { finishedAt: attempt.finishedAt } : {}),
		})),
		pendingApprovals: snapshot.approvals
			.filter((approval) => approval.status === "pending")
			.map((approval) => ({
				id: approval.id,
				taskId: approval.taskId,
				attemptId: approval.attemptId,
				kind: approval.kind,
				prompt: approval.prompt,
				requestedBy: approval.requestedBy,
				...(approval.expiresAt !== undefined ? { expiresAt: approval.expiresAt } : {}),
			})),
		openHandoffs: snapshot.handoffs
			.filter((handoff) => handoff.status === "offered")
			.map((handoff) => ({
				id: handoff.id,
				taskId: handoff.taskId,
				fromAgentId: handoff.fromAgentId,
				toAgentId: handoff.toAgentId,
				...(handoff.reason ? { reason: handoff.reason } : {}),
				...(handoff.expiresAt !== undefined ? { expiresAt: handoff.expiresAt } : {}),
			})),
		artifacts: snapshot.artifacts.map((artifact) => ({
			id: artifact.id,
			...(artifact.taskId ? { taskId: artifact.taskId } : {}),
			kind: artifact.kind,
			name: artifact.name,
			uri: artifact.uri,
			...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
			...(artifact.bytes !== undefined ? { bytes: artifact.bytes } : {}),
		})),
		latestRoomSeq: snapshot.latestRoomSeq,
	};
}

function latestRoomSeq(events: Array<{ roomSeq: number }>): number | undefined {
	return events.reduce<number | undefined>(
		(latest, event) => latest === undefined ? event.roomSeq : Math.max(latest, event.roomSeq),
		undefined,
	);
}

function result(payload: TeamToolResult): AgentToolResult<TeamToolResult> {
	return jsonResult(payload) as AgentToolResult<TeamToolResult>;
}

function required(args: Record<string, unknown>, key: string): string {
	return readStringParam(args, key, { required: true });
}

function safeError(action: TeamAction, error: unknown): TeamToolResult {
	if (error instanceof CollaborationDomainError) {
		return {
			action,
			ok: false,
			errorCode: error.code,
			message: error.message.slice(0, 1_000),
		};
	}
	const message = error instanceof Error ? error.message : String(error);
	return { action, ok: false, message: message.slice(0, 1_000) };
}

export function makeTeamTool(
	options: MakeTeamToolOptions,
): BrigadeTool<typeof TeamParams, TeamToolResult> {
	const resolveRuntime = () => options.store
		? { store: options.store, now: options.now ?? Date.now }
		: { store: getRuntimeContext().store.collaboration, now: options.now ?? getRuntimeContext().clock };
	const makeCommandId = options.commandId ?? ((toolCallId: string, action: TeamAction) =>
		toolCallId.trim().length > 0 ? `team:${action}:${toolCallId}` : `team:${action}:${randomUUID()}`);
	const kick = options.kick ?? kickActiveTeamRuntime;
	const validateAgentId = options.validateAgentId ?? ((agentId: string) =>
		isConfiguredAgent(agentId, options.agentId));
	const boundRoomId = options.sessionKey
		? parseTeamChatSessionKey(options.sessionKey)?.roomId
		: undefined;
	const scopedRoomId = (args: Record<string, unknown>, action: TeamAction): string => {
		const explicit = readStringParam(args, "roomId");
		if (boundRoomId && explicit && explicit !== boundRoomId) {
			throw new CollaborationConflictError(
				"ROOM_SCOPE_MISMATCH",
				`${action} cannot target room ${explicit} from Team chat ${boundRoomId}`,
			);
		}
		const resolved = explicit ?? boundRoomId;
		if (!resolved) throw new BrigadeToolInputError("roomId required outside a Team room chat");
		return resolved;
	};
	const requireRunInScope = async (store: CollaborationStore, runId: string): Promise<TeamRun | undefined> => {
		const run = await store.getRun(runId);
		if (boundRoomId && run && run.roomId !== boundRoomId) {
			throw new CollaborationConflictError(
				"ROOM_SCOPE_MISMATCH",
				`run ${runId} belongs to room ${run.roomId}, not active Team chat ${boundRoomId}`,
			);
		}
		return run;
	};
	const requireTaskInScope = async (store: CollaborationStore, taskId: string): Promise<void> => {
		if (!boundRoomId) return;
		const task = await store.getTask(taskId);
		if (!task) return;
		await requireRunInScope(store, task.runId);
	};
	const requireApprovalInScope = async (store: CollaborationStore, approvalId: string): Promise<void> => {
		if (!boundRoomId) return;
		const approval = (await store.readSnapshot()).approvals.find((item) => item.id === approvalId);
		if (!approval) return;
		await requireRunInScope(store, approval.runId);
	};
	const requireTaskAssigneesInRoom = async (
		store: CollaborationStore,
		runId: string,
		tasks: readonly TaskDraft[],
	): Promise<void> => {
		const run = await requireRunInScope(store, runId);
		if (!run) throw new CollaborationConflictError("NOT_FOUND", `Team run not found: ${runId}`);
		const room = await store.getRoom(run.roomId);
		if (!room) throw new CollaborationConflictError("NOT_FOUND", `Team room not found: ${run.roomId}`);
		const assignees = tasks.flatMap((task) => task.assignedAgentId ? [task.assignedAgentId] : []);
		await requireConfiguredAgents(assignees);
		const members = new Set(room.members.map((member) => member.agentId));
		const nonMember = assignees.find((agentId) => !members.has(agentId));
		if (nonMember) {
			throw new CollaborationConflictError(
				"AGENT_NOT_IN_ROOM",
				`Team task assignee ${nonMember} is not a member of room ${room.id}`,
			);
		}
	};
	const requireConfiguredAgents = async (agentIds: readonly string[]): Promise<void> => {
		for (const agentId of new Set(agentIds.map((value) => value.trim()))) {
			if (!(await validateAgentId(agentId))) {
				throw new CollaborationConflictError(
					"UNKNOWN_AGENT",
					`Team operation references an unknown configured agent: ${agentId}`,
				);
			}
		}
	};
	const notifyWorkers = (): void => {
		// The mutation is already committed before this hook runs. A missing,
		// stopped, or momentarily failing runtime must not turn that successful
		// durable command into a misleading tool failure; the runtime's idle poll
		// will discover the work later.
		try {
			void Promise.resolve(kick()).catch(() => undefined);
		} catch {
			// Best-effort wake only.
		}
	};

	return {
		name: "team",
		label: "Team",
		displaySummary: "orchestrating a Team run",
		ownerOnly: true,
		description: [
			options.readOnly
				? "Read-only durable Team Mode status for a trusted synthetic coordinator return."
				: "Owner-only durable Team Mode orchestration.",
			"Prefer delegate to validate and launch a complete task DAG in one call. The lower-level flow is create_room, create_run, add_tasks, start_run, then status. Use update_room to change the title or configured membership and archive_room only after every run is terminal.",
			"Inside a Team room chat, room operations default to and are restricted to that active room. Use list_messages/search_messages for public room context and post_message for a visible reply; an @mention alone never creates work.",
			"add_tasks accepts a DAG: dependencies are task ids; join.kind all waits for every dependency, any waits for one success, and quorum waits for join.minimum successes. cancelRemaining is valid for any/quorum.",
			"Set retry.maxAttempts per task and run budgets for tokens, cost, duration, concurrency, and attempts.",
			"status returns tasks, attempts, artifacts, pending approvals, and open handoffs without exposing lease credentials.",
			"status intentionally truncates long results. Use read_result with runId, taskId, and successive nextOffset values to read one complete exact result; sha256 identifies one encoded result.",
			"resolve_approval uses approved/rejected. respond_handoff uses accepted/rejected. Durable state commits before workers are woken.",
		].join(" "),
		parameters: TeamParams,
		execute: async (toolCallId, args): Promise<AgentToolResult<TeamToolResult>> => {
			const action = args.action;
			if (options.readOnly && !["status", "read_result", "list_rooms", "list_runs", "list_messages", "search_messages"].includes(action)) {
				throw new BrigadeToolAuthorizationError(
					`${action} requires an operator-authored Team turn; synthetic coordinator returns are read-only`,
				);
			}
			try {
				const runtime = resolveRuntime();
				const store = runtime.store;
				const now = runtime.now();
				const commandId = makeCommandId(toolCallId, action);
				if (boundRoomId) {
					const room = await store.getRoom(boundRoomId);
					if (!room) throw new CollaborationConflictError("NOT_FOUND", `Team room not found: ${boundRoomId}`);
					const coordinatorAgentId = await resolveConfiguredRoomCoordinatorAgentId(room, validateAgentId);
					if (coordinatorAgentId !== options.agentId) {
						throw new CollaborationConflictError(
							"NOT_ROOM_COORDINATOR",
							`Team room ${boundRoomId} is coordinated by ${coordinatorAgentId ?? "no configured member"}, not ${options.agentId}`,
						);
					}
				}
				switch (action) {
					case "list_rooms": {
						const rooms = await store.listRooms();
						return result({
							action,
							ok: true,
							message: `${rooms.length} Team room${rooms.length === 1 ? "" : "s"}.`,
							rooms: rooms.map(roomSummary),
						});
					}
					case "create_room": {
						const title = required(args, "title");
						if (args.members) {
							await requireConfiguredAgents(args.members.map((member) => member.agentId));
						}
						const members = [...(args.members ?? [])];
						if (!members.some((member) => member.agentId === options.agentId)) {
							members.unshift({ agentId: options.agentId, role: "coordinator" });
						}
						const created = await store.createRoom({
							commandId,
							now,
							...(args.roomId ? { roomId: args.roomId } : {}),
							title,
							createdBy: options.agentId,
							members,
							metadata: { ...(args.metadata ?? {}), coordinatorAgentId: options.agentId },
						});
						return result({
							action,
							ok: true,
							message: created.replayed ? "Team room already created by this command." : `Created Team room ${created.value.title}.`,
							commandId,
							latestRoomSeq: latestRoomSeq(created.events),
							room: roomSummary(created.value),
						});
					}
					case "update_room": {
						const roomId = scopedRoomId(args, action);
						const current = await store.getRoom(roomId);
						if (!current) {
							throw new CollaborationConflictError("NOT_FOUND", `Team room not found: ${roomId}`);
						}
						const title = readStringParam(args, "title");
						const members = args.members;
						const metadataPatch = args.metadata;
						if (title === undefined && members === undefined && metadataPatch === undefined) {
							throw new BrigadeToolInputError("update_room requires title, members, or metadata");
						}
						if (members) {
							await requireConfiguredAgents(members.map((member) => member.agentId));
						}
						const metadata = metadataPatch === undefined
							? undefined
							: { ...current.metadata, ...metadataPatch };
						if (metadata && typeof metadata.coordinatorAgentId === "string") {
							await requireConfiguredAgents([metadata.coordinatorAgentId]);
						}
						const updated = await store.updateRoom({
							commandId,
							now,
							roomId,
							...(title !== undefined ? { title } : {}),
							...(members !== undefined ? { members } : {}),
							...(metadata !== undefined ? { metadata } : {}),
						});
						return result({
							action,
							ok: true,
							message: updated.replayed
								? "Team room update was already committed by this command."
								: `Updated Team room ${updated.value.title}.`,
							commandId,
							latestRoomSeq: latestRoomSeq(updated.events),
							room: roomSummary(updated.value),
						});
					}
					case "archive_room": {
						const roomId = scopedRoomId(args, action);
						const archived = await store.archiveRoom({ commandId, now, roomId });
						return result({
							action,
							ok: true,
							message: archived.replayed
								? "Team room archive was already committed by this command."
								: `Archived Team room ${archived.value.title}.`,
							commandId,
							latestRoomSeq: latestRoomSeq(archived.events),
							room: roomSummary(archived.value),
						});
					}
					case "list_messages": {
						const roomId = scopedRoomId(args, action);
						const threadRootMessageId = readStringParam(args, "threadRootMessageId");
						const afterCreatedAt = readNumberParam(args, "afterCreatedAt", { integer: true, strict: true });
						const limit = readNumberParam(args, "limit", { integer: true, strict: true }) ?? 50;
						if (afterCreatedAt !== undefined && (!Number.isSafeInteger(afterCreatedAt) || afterCreatedAt < 0)) {
							throw new BrigadeToolInputError("afterCreatedAt must be a non-negative safe integer");
						}
						if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
							throw new BrigadeToolInputError("limit must be between 1 and 100 for list_messages");
						}
						const messages = await store.listMessages({
							roomId,
							...(threadRootMessageId ? { threadRootMessageId } : {}),
							...(afterCreatedAt !== undefined ? { afterCreatedAt } : {}),
							limit,
						});
						return result({ action, ok: true, message: `Read ${messages.length} public room message${messages.length === 1 ? "" : "s"}.`, messages });
					}
					case "search_messages": {
						const roomId = scopedRoomId(args, action);
						const query = required(args, "query");
						const limit = readNumberParam(args, "limit", { integer: true, strict: true }) ?? 50;
						if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
							throw new BrigadeToolInputError("limit must be between 1 and 100 for search_messages");
						}
						const messages = await store.searchMessages({ roomId, query, pinnedOnly: args.pinnedOnly ?? false, limit });
						return result({ action, ok: true, message: `Found ${messages.length} room message${messages.length === 1 ? "" : "s"}.`, messages });
					}
					case "post_message": {
						const roomId = scopedRoomId(args, action);
						const room = await store.getRoom(roomId);
						if (!room) throw new CollaborationConflictError("NOT_FOUND", `Team room not found: ${roomId}`);
						const mentions = [...(args.mentions ?? [])];
						await requireConfiguredAgents(mentions);
						const members = new Set(room.members.map((member) => member.agentId));
						const nonMember = mentions.find((agentId) => !members.has(agentId));
						if (nonMember) throw new CollaborationConflictError("AGENT_NOT_IN_ROOM", `mentioned agent ${nonMember} is not a member of room ${roomId}`);
						const posted = await store.postMessage({
							commandId,
							now,
							roomId,
							authorId: options.agentId,
							authorKind: "coordinator",
							source: "chat",
							content: required(args, "content"),
							mentions,
							...(args.replyToMessageId ? { replyToMessageId: args.replyToMessageId } : {}),
						});
						return result({
							action,
							ok: true,
							message: posted.replayed ? "Room message was already posted by this command." : "Posted a durable room message.",
							commandId,
							latestRoomSeq: latestRoomSeq(posted.events),
							roomMessage: posted.value,
						});
					}
					case "list_runs": {
						const roomId = readStringParam(args, "roomId") || boundRoomId;
						if (boundRoomId && roomId && roomId !== boundRoomId) {
							throw new CollaborationConflictError("ROOM_SCOPE_MISMATCH", `list_runs cannot leave active Team chat ${boundRoomId}`);
						}
						const runs = await store.listRuns(roomId);
						return result({
							action,
							ok: true,
							message: `${runs.length} Team run${runs.length === 1 ? "" : "s"}.`,
							runs: runs.map(runSummary),
						});
					}
					case "create_run": {
						const roomId = scopedRoomId(args, action);
						const objective = required(args, "objective");
						const created = await store.createRun({
							commandId,
							now,
							...(args.runId ? { runId: args.runId } : {}),
							roomId,
							objective,
							createdBy: options.agentId,
							...(args.budgets ? { budgets: args.budgets } : {}),
							...(args.metadata ? { metadata: args.metadata } : {}),
						});
						return result({
							action,
							ok: true,
							message: created.replayed ? "Team run already created by this command." : "Created Team run. Add its task DAG before starting it.",
							commandId,
							latestRoomSeq: latestRoomSeq(created.events),
							run: runSummary(created.value),
						});
					}
					case "delegate": {
						const roomId = scopedRoomId(args, action);
						const objective = required(args, "objective");
						if (!args.tasks || args.tasks.length === 0) {
							throw new BrigadeToolInputError("tasks required for delegate");
						}
						const tasks = args.tasks as TaskDraft[];
						const room = await store.getRoom(roomId);
						if (!room) throw new CollaborationConflictError("NOT_FOUND", `Team room not found: ${roomId}`);
						const assignees = tasks.flatMap((task) => task.assignedAgentId ? [task.assignedAgentId] : []);
						await requireConfiguredAgents(assignees);
						const members = new Set(room.members.map((member) => member.agentId));
						const nonMember = assignees.find((agentId) => !members.has(agentId));
						if (nonMember) {
							throw new CollaborationConflictError("AGENT_NOT_IN_ROOM", `Team task assignee ${nonMember} is not a member of room ${roomId}`);
						}
						const delegated = await store.delegateRun({
							commandId,
							now,
							...(args.runId ? { runId: args.runId } : {}),
							roomId,
							objective,
							createdBy: options.agentId,
							...(args.budgets ? { budgets: args.budgets } : {}),
							...(args.metadata ? { metadata: args.metadata } : {}),
							tasks,
						});
						if (!delegated.replayed) notifyWorkers();
						return result({
							action,
							ok: true,
							message: delegated.replayed ? "Team delegation was already launched by this command." : `Delegated ${delegated.value.tasks.length} task${delegated.value.tasks.length === 1 ? "" : "s"}; the Team run is active.`,
							commandId,
							latestRoomSeq: latestRoomSeq(delegated.events),
							run: runSummary(delegated.value.run),
							tasks: delegated.value.tasks.map((task) => ({
								id: task.id,
								title: task.title,
								status: task.status,
								...(task.assignedAgentId ? { assignedAgentId: task.assignedAgentId } : {}),
								dependencies: task.dependencies.map((dependency) => dependency.taskId),
								join: task.join,
								...(task.resultGate ? { resultGate: task.resultGate } : {}),
							})),
						});
					}
					case "add_tasks": {
						const runId = required(args, "runId");
						if (!args.tasks || args.tasks.length === 0) {
							throw new BrigadeToolInputError("tasks required for add_tasks");
						}
						const tasks = args.tasks as TaskDraft[];
						await requireTaskAssigneesInRoom(store, runId, tasks);
						const added = await store.addTasks({ commandId, now, runId, tasks });
						return result({
							action,
							ok: true,
							message: added.replayed ? "Task DAG already added by this command." : `Added ${added.value.length} task${added.value.length === 1 ? "" : "s"} to the Team run.`,
							commandId,
							latestRoomSeq: latestRoomSeq(added.events),
							tasks: added.value.map((task) => ({
								id: task.id,
								title: task.title,
								status: task.status,
								...(task.assignedAgentId ? { assignedAgentId: task.assignedAgentId } : {}),
							dependencies: task.dependencies.map((dependency) => dependency.taskId),
							join: task.join,
							...(task.resultGate ? { resultGate: task.resultGate } : {}),
						})),
						});
					}
					case "start_run": {
						const runId = required(args, "runId");
						await requireRunInScope(store, runId);
						const started = await store.startRun({ commandId, now, runId });
						notifyWorkers();
						return result({
							action,
							ok: true,
							message: started.replayed ? "Team run was already started by this command." : "Team run started; ready workers have been notified.",
							commandId,
							latestRoomSeq: latestRoomSeq(started.events),
							run: runSummary(started.value),
						});
					}
					case "status": {
						const runId = required(args, "runId");
						await requireRunInScope(store, runId);
						const snapshot = await store.readRunSnapshot(runId);
						if (!snapshot) {
							return result({ action, ok: false, errorCode: "NOT_FOUND", message: `Team run not found: ${runId}` });
						}
						return result({
							action,
							ok: true,
							message: `Team run is ${snapshot.run.status}; ${snapshot.tasks.filter((task) => task.status === "succeeded").length}/${snapshot.tasks.length} tasks succeeded.`,
							snapshot: compactSnapshot(snapshot),
							latestRoomSeq: snapshot.latestRoomSeq,
						});
					}
					case "read_result": {
						const runId = required(args, "runId");
						const scopedRun = await requireRunInScope(store, runId);
						if (!scopedRun) {
							throw new CollaborationConflictError("NOT_FOUND", `Team run not found: ${runId}`);
						}
						const taskId = required(args, "taskId");
						const task = await store.getTask(taskId);
						if (!task || task.runId !== runId) {
							throw new CollaborationConflictError("NOT_FOUND", `Team task not found in run ${runId}: ${taskId}`);
						}
						const offset = readNumberParam(args, "offset", { integer: true, strict: true });
						const limit = readNumberParam(args, "limit", { integer: true, strict: true });
						if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) {
							throw new BrigadeToolInputError("offset must be a non-negative safe integer");
						}
						if (
							limit !== undefined
							&& (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_TEAM_RESULT_PAGE_CHARS)
						) {
							throw new BrigadeToolInputError(
								`limit must be a positive safe integer no greater than ${MAX_TEAM_RESULT_PAGE_CHARS}`,
							);
						}
						const resultPage = pageTeamTaskResult(task, {
							...(offset !== undefined ? { offset } : {}),
							...(limit !== undefined ? { limit } : {}),
						});
						return result({
							action,
							ok: true,
							message: resultPage.complete
								? `Read the complete result for Team task ${taskId}.`
								: `Read result characters ${resultPage.offset}-${resultPage.endOffset} for Team task ${taskId}; continue at offset ${resultPage.nextOffset}.`,
							resultPage,
						});
					}
					case "cancel_run": {
						const runId = required(args, "runId");
						await requireRunInScope(store, runId);
						const reason = readStringParam(args, "reason");
						const cancelled = await store.cancelRun({ commandId, now, runId, ...(reason ? { reason } : {}) });
						notifyWorkers();
						return result({
							action,
							ok: true,
							message: "Team run cancelled durably.",
							commandId,
							latestRoomSeq: latestRoomSeq(cancelled.events),
							run: runSummary(cancelled.value),
						});
					}
					case "cancel_task": {
						const taskId = required(args, "taskId");
						await requireTaskInScope(store, taskId);
						const reason = readStringParam(args, "reason");
						const cancelled = await store.cancelTask({ commandId, now, taskId, ...(reason ? { reason } : {}) });
						notifyWorkers();
						return result({
							action,
							ok: true,
							message: "Team task cancelled durably.",
							commandId,
							latestRoomSeq: latestRoomSeq(cancelled.events),
							tasks: [{ id: cancelled.value.id, title: cancelled.value.title, status: cancelled.value.status }],
						});
					}
					case "retry_task": {
						const taskId = required(args, "taskId");
						await requireTaskInScope(store, taskId);
						const retried = await store.retryTask({
							commandId,
							now,
							taskId,
							...(args.delayMs !== undefined ? { delayMs: args.delayMs } : {}),
						});
						notifyWorkers();
						return result({
							action,
							ok: true,
							message: "Team task queued for retry.",
							commandId,
							latestRoomSeq: latestRoomSeq(retried.events),
							tasks: [{ id: retried.value.id, title: retried.value.title, status: retried.value.status }],
						});
					}
					case "resolve_approval": {
						const approvalId = required(args, "approvalId");
						await requireApprovalInScope(store, approvalId);
						if (args.decision !== "approved" && args.decision !== "rejected") {
							throw new BrigadeToolInputError("decision must be approved or rejected for resolve_approval");
						}
						const resolution = readStringParam(args, "resolution");
						const resolved = await store.resolveApproval({
							commandId,
							now,
							approvalId,
							decision: args.decision,
							...(resolution ? { resolution } : {}),
						});
						notifyWorkers();
						return result({
							action,
							ok: true,
							message: `Approval ${resolved.value.status}.`,
							commandId,
							latestRoomSeq: latestRoomSeq(resolved.events),
							approval: {
								id: resolved.value.id,
								status: resolved.value.status,
								kind: resolved.value.kind,
								...(resolved.value.resolution ? { resolution: resolved.value.resolution } : {}),
							},
						});
					}
					case "respond_handoff": {
						const runId = required(args, "runId");
						await requireRunInScope(store, runId);
						const handoffId = required(args, "handoffId");
						if (args.decision !== "accepted" && args.decision !== "rejected") {
							throw new BrigadeToolInputError("decision must be accepted or rejected for respond_handoff");
						}
						const handoff = (await store.listHandoffs(runId)).find((row) => row.id === handoffId);
						if (!handoff) {
							return result({ action, ok: false, errorCode: "NOT_FOUND", message: `Team handoff not found: ${handoffId}` });
						}
						const reason = readStringParam(args, "reason");
						const resolved = args.decision === "accepted"
							? await store.acceptHandoff({ commandId, now, handoffId, respondingAgentId: handoff.toAgentId, ...(reason ? { reason } : {}) })
							: await store.rejectHandoff({ commandId, now, handoffId, respondingAgentId: handoff.toAgentId, ...(reason ? { reason } : {}) });
						notifyWorkers();
						return result({
							action,
							ok: true,
							message: `Handoff ${resolved.value.status}.`,
							commandId,
							latestRoomSeq: latestRoomSeq(resolved.events),
							handoff: {
								id: resolved.value.id,
								status: resolved.value.status,
								fromAgentId: resolved.value.fromAgentId,
								toAgentId: resolved.value.toAgentId,
								...(resolved.value.reason ? { reason: resolved.value.reason } : {}),
							},
						});
					}
				}
			} catch (error) {
				return result(safeError(action, error));
			}
		},
	};
}
