import { strict as assert } from "node:assert";
import { test } from "node:test";

import { buildTeamAttemptSessionKey } from "../../collaboration/session-key.js";
import {
	handleSessionsDelete,
	handleSessionsPatch,
	handleSessionsSend,
} from "./sessions.js";

test("ordinary session mutations cannot target a private Team attempt", async () => {
	const sessionKey = buildTeamAttemptSessionKey("room", "worker", "attempt");
	const refused = (error: unknown): boolean => error instanceof Error
		&& error.name === "SessionsAccessForbiddenError"
		&& /private runtime state/.test(error.message);

	await assert.rejects(
		handleSessionsSend(
			{ sessionKey, message: "inject this" },
			{ runAgentTurn: async () => ({ ok: true }) },
		),
		refused,
	);
	await assert.rejects(
		handleSessionsPatch({ sessionKey, patch: { modelId: "different" } }),
		refused,
	);
	await assert.rejects(
		handleSessionsDelete({ sessionKey }, { isLive: () => false }),
		refused,
	);
});
