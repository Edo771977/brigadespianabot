import assert from "node:assert/strict";
import test from "node:test";

import { applyProtectedTeamPromptLayer } from "./agent-loop.js";

test("ordinary explicit system prompt overrides remain byte-identical", () => {
	assert.equal(applyProtectedTeamPromptLayer({ override: "Exact custom persona" }), "Exact custom persona");
});

test("Team workers retain their code-owned role contract with an override", () => {
	const prompt = applyProtectedTeamPromptLayer({ override: "Custom worker", teamWorkerMode: true });
	assert.match(prompt, /^Custom worker/);
	assert.match(prompt, /# Team Task Context/);
	assert.match(prompt, /durable assigned task/);
});

test("Team room coordinators retain Team guidance and live room context with an override", () => {
	const prompt = applyProtectedTeamPromptLayer({
		override: "Custom lead",
		teamChatContextBlock: "## Active Team Room\n\nroom-1",
	});
	assert.match(prompt, /^Custom lead/);
	assert.match(prompt, /## Team Mode/);
	assert.match(prompt, /## Active Team Room/);
});
