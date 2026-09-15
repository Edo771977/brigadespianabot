import type { CollaborationStore, CommandResult } from "./store.js";
import { parseTeamChatSessionKey } from "./session-key.js";
import type { RoomMessage } from "./types.js";

export interface PersistTeamChatReplyOptions {
	store: CollaborationStore;
	sessionKey: string;
	reply: string;
	turnId: string;
	now?: number;
}

/**
 * Persist one settled coordinator reply into the room's public conversation.
 * The turn id is both the command receipt and message identity, so replay after
 * an uncertain commit cannot duplicate the answer.
 */
export async function persistTeamChatReply(
	options: PersistTeamChatReplyOptions,
): Promise<CommandResult<RoomMessage> | undefined> {
	const target = parseTeamChatSessionKey(options.sessionKey);
	const content = options.reply.trim();
	if (!target || !content) return undefined;
	const room = await options.store.getRoom(target.roomId);
	if (!room || room.status !== "open") return undefined;
	const memberIds = new Set(room.members.map((member) => member.agentId));
	if (!memberIds.has(target.agentId)) return undefined;
	const mentions: string[] = [];
	for (const match of content.matchAll(/(^|\s)@([A-Za-z0-9_-]+)/gu)) {
		const mentioned = match[2];
		if (!mentioned) continue;
		if (memberIds.has(mentioned) && !mentions.includes(mentioned)) mentions.push(mentioned);
	}
	return options.store.postMessage({
		commandId: `team-chat.reply:${options.turnId}`,
		messageId: `team-chat-reply:${options.turnId}`,
		roomId: target.roomId,
		authorId: target.agentId,
		authorKind: "coordinator",
		source: "chat",
		content,
		mentions,
		...(options.now !== undefined ? { now: options.now } : {}),
	});
}
