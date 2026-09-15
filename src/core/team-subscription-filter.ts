/**
 * Pure Team Mode WebSocket subscription filtering.
 *
 * Team events are deliberately opt-in. This differs from Brigade's legacy
 * agent/session stream, where a connection with no subscriptions receives the
 * firehose for backwards compatibility. Applying that fallback to Team Mode
 * would send every room to clients that predate rooms entirely.
 */

export type TeamEventClass =
	| "team-event"
	| "team-progress"
	| "team-approval-request"
	| "team-approval-resolved";

export interface TeamRoomSubscription {
	/** Ephemeral attempt progress is noisy, so it requires an explicit opt-in. */
	includeProgress: boolean;
}

export type TeamRoomSubscriptions = ReadonlyMap<string, TeamRoomSubscription>;

export interface TeamFrameTags {
	roomId?: string;
}

/**
 * Install a room subscription before reading its authoritative reconnect
 * snapshot. An event committed before installation is reflected in the
 * snapshot; an event committed afterwards is eligible for live delivery.
 * Restore the caller's previous subscription state if the read fails so a
 * failed re-subscribe cannot silently change its progress routing.
 */
export async function installTeamRoomSubscriptionThenSnapshot<Snapshot>(
	install: () => void,
	readSnapshot: () => Promise<Snapshot>,
	restore: () => void,
): Promise<Snapshot> {
	install();
	try {
		return await readSnapshot();
	} catch (error) {
		restore();
		throw error;
	}
}

/** Extract the routing key without coercing malformed wire payloads. */
export function extractTeamFrameTags(payload: unknown): TeamFrameTags {
	if (!payload || typeof payload !== "object") return {};
	const roomId = (payload as { roomId?: unknown }).roomId;
	return typeof roomId === "string" && roomId.trim().length > 0
		? { roomId: roomId.trim() }
		: {};
}

/**
 * Whether a connection should receive one Team Mode frame.
 *
 * Durable lifecycle events go to every explicit subscriber of the room.
 * Ephemeral progress goes only to room subscribers that opted into it.
 */
export function shouldDeliverTeamFrame(
	subscriptions: TeamRoomSubscriptions | undefined,
	tags: TeamFrameTags,
	eventClass: TeamEventClass,
): boolean {
	const roomId = tags.roomId?.trim();
	if (!roomId || !subscriptions) return false;
	const subscription = subscriptions.get(roomId);
	if (!subscription) return false;
	return eventClass !== "team-progress" || subscription.includeProgress;
}
