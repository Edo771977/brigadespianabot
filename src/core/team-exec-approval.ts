import type { ApprovalRequest } from "../agents/approval-bridge.js";
import { parseTeamAttemptSessionKey } from "../collaboration/session-key.js";
import type { TeamExecApprovalRequest } from "../protocol/team.js";

/** Convert a generic exec-gate prompt into a room-routable Team frame.
 * Ordinary and coordinator-chat sessions intentionally return undefined. */
export function toTeamExecApprovalRequest(
	request: ApprovalRequest,
	now = Date.now(),
	revision = 0,
): TeamExecApprovalRequest | undefined {
	const attempt = request.sessionId ? parseTeamAttemptSessionKey(request.sessionId) : undefined;
	if (!attempt || !request.sessionId) return undefined;
	return {
		id: request.id,
		roomId: attempt.roomId,
		attemptId: attempt.attemptId,
		agentId: attempt.agentId,
		sessionId: request.sessionId,
		command: request.command,
		toolName: request.toolName,
		...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
		timeoutMs: request.timeoutMs,
		decisions: request.decisions,
		createdAt: request.createdAt ?? now,
		revision,
	};
}
