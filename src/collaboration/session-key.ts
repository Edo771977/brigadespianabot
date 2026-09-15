// Stable, room-scoped teammate sessions keep one agent's Team conversation
// coherent while different rooms remain isolated.

import { CollaborationConflictError } from "./types.js";

const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function buildTeamSessionKey(roomId: string, agentId: string): string {
	if (!roomId) throw new CollaborationConflictError("INVALID_ROOM_ID", "roomId is required");
	if (!AGENT_ID_PATTERN.test(agentId)) {
		throw new CollaborationConflictError("INVALID_AGENT_ID", `invalid Team agent id: ${agentId}`);
	}
	return `agent:${agentId}:team:${Buffer.from(roomId, "utf8").toString("base64url")}`;
}

/** One isolated provider transcript per durable attempt. The shorter `team`
 * key remains the room+agent reservation slot and is never executed directly. */
export function buildTeamAttemptSessionKey(
	roomId: string,
	agentId: string,
	attemptId: string,
): string {
	if (!attemptId) throw new CollaborationConflictError("INVALID_ATTEMPT_ID", "attemptId is required");
	const slot = buildTeamSessionKey(roomId, agentId);
	return `${slot}:attempt:${Buffer.from(attemptId, "utf8").toString("base64url")}`;
}

/** Stable operator-facing conversation for one room coordinator. Team workers
 * use the separate `team` namespace above and must never share this transcript. */
export function buildTeamChatSessionKey(roomId: string, agentId: string): string {
	if (!roomId) throw new CollaborationConflictError("INVALID_ROOM_ID", "roomId is required");
	if (!AGENT_ID_PATTERN.test(agentId)) {
		throw new CollaborationConflictError("INVALID_AGENT_ID", `invalid Team agent id: ${agentId}`);
	}
	return `agent:${agentId}:team-chat:${Buffer.from(roomId, "utf8").toString("base64url")}`;
}

export function parseTeamSessionKey(sessionKey: string): { roomId: string; agentId: string } | undefined {
	return parseRoomScopedSessionKey(sessionKey, "team");
}

export function parseTeamChatSessionKey(sessionKey: string): { roomId: string; agentId: string } | undefined {
	return parseRoomScopedSessionKey(sessionKey, "team-chat");
}

export function parseTeamAttemptSessionKey(
	sessionKey: string,
): { roomId: string; agentId: string; attemptId: string } | undefined {
	const match = /^agent:([^:]+):team:([^:]+):attempt:([^:]+)$/u.exec(sessionKey);
	if (!match?.[1] || !match[2] || !match[3] || !AGENT_ID_PATTERN.test(match[1])) return undefined;
	try {
		const roomId = decodeBase64Url(match[2]);
		const attemptId = decodeBase64Url(match[3]);
		if (!roomId || !attemptId) return undefined;
		return { agentId: match[1], roomId, attemptId };
	} catch {
		return undefined;
	}
}

function decodeBase64Url(value: string): string | undefined {
	const decoded = Buffer.from(value, "base64url").toString("utf8");
	return decoded && Buffer.from(decoded, "utf8").toString("base64url") === value
		? decoded
		: undefined;
}

function parseRoomScopedSessionKey(
	sessionKey: string,
	namespace: "team" | "team-chat",
): { roomId: string; agentId: string } | undefined {
	const match = new RegExp(`^agent:([^:]+):${namespace}:([^:]+)$`, "u").exec(sessionKey);
	if (!match?.[1] || !match[2] || !AGENT_ID_PATTERN.test(match[1])) return undefined;
	try {
		const roomId = decodeBase64Url(match[2]);
		if (!roomId) return undefined;
		return { agentId: match[1], roomId };
	} catch {
		return undefined;
	}
}
