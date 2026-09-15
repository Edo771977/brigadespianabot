import { wrapUntrustedDataBlock } from "../system-prompt/sanitize.js";
import { parseTeamChatSessionKey } from "./session-key.js";
import { resolveConfiguredRoomCoordinatorAgentId } from "./room-coordinator.js";
import type { CollaborationStore } from "./store.js";

export interface BuildTeamChatContextOptions {
	store: CollaborationStore;
	sessionKey: string;
	agentId: string;
	/** Live configured-agent check; prevents deleted coordinator split-brain. */
	validateAgentId?: (agentId: string) => boolean | Promise<boolean>;
}

function compactResult(value: unknown): string {
	let text: string;
	if (typeof value === "string") text = value;
	else {
		try {
			text = JSON.stringify(value);
		} catch {
			text = "[unserializable result]";
		}
	}
	return text.length > 1_000
		? `${text.slice(0, 1_000)}...[truncated ${text.length - 1_000} chars]`
		: text;
}

/**
 * Build the live, room-scoped coordinator anchor injected below the prompt
 * cache boundary. Room content is user-controlled, so it is clipped and
 * fenced as untrusted data; the behavioural instructions stay outside it.
 */
export async function buildTeamChatContext(
	options: BuildTeamChatContextOptions,
): Promise<string | undefined> {
	const target = parseTeamChatSessionKey(options.sessionKey);
	if (!target || target.agentId !== options.agentId) return undefined;
	const room = await options.store.getRoom(target.roomId);
	if (!room) {
		return [
			"## Active Team Room",
			"This conversation is bound to a Team room that no longer exists. Call `team({action:\"list_rooms\"})` before making room or run claims.",
		].join("\n\n");
	}
	const coordinatorAgentId = await resolveConfiguredRoomCoordinatorAgentId(
		room,
		options.validateAgentId ?? (() => true),
	);
	if (!coordinatorAgentId || coordinatorAgentId !== options.agentId) {
		return [
			"## Active Team Room",
			`This session is not the canonical coordinator for Team room ${room.id}. Do not coordinate, delegate, report room state, or mutate this room from this session.`,
		].join("\n\n");
	}
	const runs = (await options.store.listRuns(room.id))
		.sort((a, b) => b.updatedAt - a.updatedAt);
	const activeRun = runs.find((run) => run.status === "created" || run.status === "running");
	const lastTerminalRun = runs.find((run) => run.status !== "created" && run.status !== "running");
	const snapshot = activeRun
		? await options.store.readRunSnapshot(activeRun.id)
		: undefined;
	const tasks = snapshot?.tasks ?? [];
	const statusCounts = Object.fromEntries(
		[...new Set(tasks.map((task) => task.status))]
			.sort()
			.map((status) => [status, tasks.filter((task) => task.status === status).length]),
	);
	const data = {
		room: {
			id: room.id,
			title: room.title,
			status: room.status,
			members: room.members.map(({ agentId, role }) => ({ agentId, ...(role ? { role } : {}) })),
		},
		activeRun: activeRun
			? {
				id: activeRun.id,
				status: activeRun.status,
				objective: activeRun.objective,
				budgets: activeRun.budgets,
				usage: activeRun.usage,
				tasks: statusCounts,
				pendingApprovals: snapshot?.approvals.filter((item) => item.status === "pending").length ?? 0,
				openHandoffs: snapshot?.handoffs.filter((item) => item.status === "offered").length ?? 0,
				recentResults: tasks
					.filter((task) => task.status === "succeeded" && task.result !== undefined)
					.sort((a, b) => b.updatedAt - a.updatedAt)
					.slice(0, 5)
					.map((task) => ({
						taskId: task.id,
						title: task.title,
						...(task.assignedAgentId ? { agentId: task.assignedAgentId } : {}),
						result: compactResult(task.result),
					})),
			}
			: null,
		lastTerminalRun: lastTerminalRun
			? {
				id: lastTerminalRun.id,
				status: lastTerminalRun.status,
				objective: lastTerminalRun.objective,
				finishedAt: lastTerminalRun.finishedAt,
				failureReason: lastTerminalRun.failureReason,
				cancelReason: lastTerminalRun.cancelReason,
			}
			: null,
	};
	return [
		"## Active Team Room",
		"You are the coordinator for the room below. Treat activeRun as live orientation, not proof of current status: call the `team` tool before reporting progress or making a decision. lastTerminalRun is history; never reuse its objective or resolve vague pronouns against it unless the operator explicitly refers to that run. Reuse this room id when the operator asks this room to delegate concrete work.",
		wrapUntrustedDataBlock({ label: "team-room", text: JSON.stringify(data), maxChars: 8_000 }),
	].join("\n\n");
}
