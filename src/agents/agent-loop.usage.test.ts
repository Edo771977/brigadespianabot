import assert from "node:assert/strict";
import test from "node:test";

import { summarizeTurnUsage } from "./agent-loop.js";

test("summarizeTurnUsage attributes only this turn's assistant round-trips", () => {
	const result = summarizeTurnUsage([
		{ role: "assistant", usage: { input: 900, output: 100, cost: { total: 9 } } },
		{ role: "user", content: "new task" },
		{ role: "assistant", usage: { input: 10, output: 3, cacheRead: 2, cost: { total: 0.01 } } },
		{ role: "toolResult", content: [] },
		{ role: "assistant", usage: { input: 4, output: 6, cacheWrite: 1, cost: { total: 0.02 } } },
	], 1);

	assert.deepEqual(result, {
		input: 14,
		output: 9,
		cacheRead: 2,
		cacheWrite: 1,
		totalTokens: 26,
		costUsd: 0.03,
		costComplete: true,
	});
});

test("summarizeTurnUsage keeps unknown cost incomplete", () => {
	const result = summarizeTurnUsage([
		{ role: "assistant", usage: { input: 5, output: 2, costKnown: false } },
	], 0);

	assert.equal(result.totalTokens, 7);
	assert.equal(result.costUsd, 0);
	assert.equal(result.costComplete, false);
});
