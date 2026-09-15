import assert from "node:assert/strict";
import test from "node:test";

import { resolveTeamModelFallbacks } from "./team-model-fallback.js";

test("Team workers prefer the coordinator model and retain configured fallbacks", () => {
	assert.deepEqual(resolveTeamModelFallbacks({
		primary: { provider: "claude-cli", modelId: "claude-opus" },
		coordinator: { provider: "openai-codex", modelId: "gpt-codex" },
		configured: [
			{ provider: "openai-codex", modelId: "gpt-codex" },
			{ provider: "openrouter", modelId: "fallback" },
		],
	}), [
		{ provider: "openai-codex", modelId: "gpt-codex" },
		{ provider: "openrouter", modelId: "fallback" },
	]);
});

test("Team worker fallback never repeats its primary model", () => {
	assert.deepEqual(resolveTeamModelFallbacks({
		primary: { provider: "openai", modelId: "primary" },
		coordinator: { provider: "openai", modelId: "primary" },
		configured: [{ provider: "openai", modelId: "primary" }],
	}), []);
});
