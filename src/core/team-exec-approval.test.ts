import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ApprovalRequest } from "../agents/approval-bridge.js";
import { buildTeamAttemptSessionKey, buildTeamChatSessionKey } from "../collaboration/session-key.js";
import { toTeamExecApprovalRequest } from "./team-exec-approval.js";

function request(sessionId: string): ApprovalRequest {
	return {
		id: "approval-1",
		createdAt: 41,
		command: "npm test",
		toolName: "bash",
		cwd: "/workspace",
		timeoutMs: 300_000,
		decisions: ["allow-once", "deny"],
		agentId: "reviewer",
		sessionId,
	};
}

describe("toTeamExecApprovalRequest", () => {
	it("derives authoritative room, agent, and attempt routing from the session", () => {
		const sessionId = buildTeamAttemptSessionKey("room/one", "reviewer", "attempt:7");
		assert.deepEqual(toTeamExecApprovalRequest(request(sessionId), 99), {
			id: "approval-1",
			roomId: "room/one",
			attemptId: "attempt:7",
			agentId: "reviewer",
			sessionId,
			command: "npm test",
			toolName: "bash",
			cwd: "/workspace",
			timeoutMs: 300_000,
			decisions: ["allow-once", "deny"],
			createdAt: 41,
			revision: 0,
		});
	});

	it("does not expose ordinary or coordinator-chat approvals as Team worker approvals", () => {
		assert.equal(toTeamExecApprovalRequest(request("agent:main:main")), undefined);
		assert.equal(
			toTeamExecApprovalRequest(request(buildTeamChatSessionKey("room", "main"))),
			undefined,
		);
	});
});
