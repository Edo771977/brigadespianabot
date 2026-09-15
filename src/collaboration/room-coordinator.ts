import type { CollaborationRoom } from "./types.js";

export interface ResolveRoomCoordinatorOptions {
	validateAgentId?: (agentId: string) => boolean;
}

/** Resolve one room-owned coordinator identity without process-global fallbacks. */
export function resolveRoomCoordinatorAgentId(
	room: CollaborationRoom,
	options: ResolveRoomCoordinatorOptions = {},
): string | undefined {
	const memberIds = new Set(room.members.map((member) => member.agentId));
	const isValid = (value: unknown): value is string =>
		typeof value === "string"
		&& value.trim().length > 0
		&& memberIds.has(value.trim())
		&& (options.validateAgentId?.(value.trim()) ?? true);
	const roleCoordinator = room.members.find((member) => member.role === "coordinator")?.agentId;
	for (const candidate of [room.metadata.coordinatorAgentId, roleCoordinator, room.createdBy]) {
		if (isValid(candidate)) return candidate.trim();
	}
	return room.members.map((member) => member.agentId).find(isValid);
}

/** Async variant for config-backed validation seams used by agent turns/tools. */
export async function resolveConfiguredRoomCoordinatorAgentId(
	room: CollaborationRoom,
	validateAgentId: (agentId: string) => boolean | Promise<boolean>,
): Promise<string | undefined> {
	const memberIds = new Set(room.members.map((member) => member.agentId));
	const roleCoordinator = room.members.find((member) => member.role === "coordinator")?.agentId;
	const candidates = [
		room.metadata.coordinatorAgentId,
		roleCoordinator,
		room.createdBy,
		...room.members.map((member) => member.agentId),
	];
	const visited = new Set<string>();
	for (const value of candidates) {
		if (typeof value !== "string") continue;
		const candidate = value.trim();
		if (!candidate || visited.has(candidate) || !memberIds.has(candidate)) continue;
		visited.add(candidate);
		if (await validateAgentId(candidate)) return candidate;
	}
	return undefined;
}
