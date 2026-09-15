import { buildTeamChatSessionKey } from "./session-key.js";
import { resolveRoomCoordinatorAgentId } from "./room-coordinator.js";
import type { CollaborationStore } from "./store.js";
import type { CollaborationEvent } from "./types.js";

const TERMINAL_RUN_EVENTS = new Set(["run.completed", "run.failed", "run.cancelled"]);
const DECISION_EVENTS = new Set(["approval.requested", "handoff.offered"]);

export interface DeliverTeamCoordinatorReturnOptions {
	event: CollaborationEvent;
	store: CollaborationStore;
	defaultAgentId: string;
	validateAgentId: (agentId: string) => boolean;
	wake: (options: { reason: string; agentId: string; sessionKey: string; text: string }) => Promise<void> | void;
}

/**
 * Close the collaboration loop in code, independent of worker tool compliance.
 * Durable terminal results and pending decisions emit only a trusted wake
 * signal into the canonical room coordinator's separate chat transcript.
 */
export async function deliverTeamCoordinatorReturn(
	options: DeliverTeamCoordinatorReturnOptions,
): Promise<boolean> {
	if ((!TERMINAL_RUN_EVENTS.has(options.event.type) && !DECISION_EVENTS.has(options.event.type)) || !options.event.runId) return false;
	const run = await options.store.getRun(options.event.runId);
	const room = await options.store.getRoom(options.event.roomId);
	if (!run || !room) return false;
	if (TERMINAL_RUN_EVENTS.has(options.event.type)) {
		const expectedStatus = options.event.type === "run.completed"
			? "completed"
			: options.event.type === "run.cancelled"
				? "cancelled"
				: "failed";
		// Outbox rows may be delivered after a manual retry reopened the run.
		// Never narrate an obsolete terminal state to the operator.
		if (run.status !== expectedStatus) return false;
	}
	if (options.event.type === "approval.requested") {
		const approvalId = typeof options.event.payload.approvalId === "string"
			? options.event.payload.approvalId
			: options.event.eventId;
		const approval = (await options.store.listApprovals(run.id)).find((candidate) => candidate.id === approvalId);
		if (approval?.status !== "pending") return false;
	}
	if (options.event.type === "handoff.offered") {
		const handoffId = typeof options.event.payload.handoffId === "string"
			? options.event.payload.handoffId
			: options.event.eventId;
		const handoff = (await options.store.listHandoffs(run.id)).find((candidate) => candidate.id === handoffId);
		if (handoff?.status !== "offered") return false;
	}
	const coordinatorAgentId = resolveRoomCoordinatorAgentId(room, {
		validateAgentId: options.validateAgentId,
	});
	if (!coordinatorAgentId) return false;
	const sessionKey = buildTeamChatSessionKey(room.id, coordinatorAgentId);
	let text: string;
	let reason: string;
	if (options.event.type === "approval.requested") {
		const approvalId = typeof options.event.payload.approvalId === "string"
			? options.event.payload.approvalId
			: options.event.eventId;
		text = `Team run ${run.id} is waiting for operator approval ${approvalId}. Read authoritative pending decisions with team({action:"status",runId:${JSON.stringify(run.id)}}), then ask the operator one concise decision question. Never approve or reject on their behalf.`;
		reason = "team-decision";
	} else if (options.event.type === "handoff.offered") {
		const handoffId = typeof options.event.payload.handoffId === "string"
			? options.event.payload.handoffId
			: options.event.eventId;
		text = `Team run ${run.id} has a proposed task reassignment ${handoffId} waiting for the operator. Read authoritative pending decisions with team({action:"status",runId:${JSON.stringify(run.id)}}), then ask one concise approve-or-decline question. Never decide on their behalf.`;
		reason = "team-decision";
	} else {
		const outcome = run.status === "completed"
			? "completed"
			: run.status === "cancelled"
				? "was cancelled"
				: "failed";
		text = `Team run ${run.id} ${outcome}. Read its durable status and worker results (compact) with team({action:"status",runId:${JSON.stringify(run.id)}}). For every result needed in the answer that is marked truncated, page the complete exact value with team({action:"read_result",runId:${JSON.stringify(run.id)},taskId:"<task-id>",offset:0}) and continue at nextOffset until complete while keeping sha256 consistent. Then return one concise synthesized answer to the operator. Do not launch another run unless the operator asks.`;
		reason = "team-complete";
	}
	// Deliver the trusted notification as the exact hidden turn input. A shared
	// per-session inbox is intentionally not involved: an operator turn admitted
	// ahead of this wake must never consume or reorder a Team completion event.
	// If the provider turn fails, the outbox remains unacknowledged and retries
	// this same deterministic input.
	await options.wake({ reason, agentId: coordinatorAgentId, sessionKey, text });
	return true;
}
