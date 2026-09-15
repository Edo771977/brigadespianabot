import assert from "node:assert/strict";
import test from "node:test";

import { taskResultGateFailure } from "./result-gate.js";
import { pageTeamTaskResult } from "./task-result-page.js";

test("review verdict gate requires an explicit leading pass token", () => {
	const gate = { kind: "review_verdict" } as const;
	assert.equal(taskResultGateFailure(gate, "REVIEW: PASS\nVerified."), undefined);
	assert.equal(taskResultGateFailure(gate, " review: pass Verified."), undefined);
	assert.match(taskResultGateFailure(gate, "REVIEW: FAIL\nBroken.") ?? "", /explicit REVIEW: PASS/);
	assert.match(taskResultGateFailure(gate, "The review passes") ?? "", /explicit REVIEW: PASS/);
	assert.match(taskResultGateFailure(gate, { verdict: "pass" }) ?? "", /explicit REVIEW: PASS/);
});

test("independent review verdict requires canonical exact dependency evidence", () => {
	const gate = { kind: "review_verdict", policy: "independent-v1" } as const;
	const dependencies = [
		{ id: "z-task", runId: "run", result: { ok: true } },
		{ id: "a-task", runId: "run", result: "complete" },
	] as never[];
	const evidence = JSON.stringify({
		"a-task": pageTeamTaskResult(dependencies[1]!).sha256,
		"z-task": pageTeamTaskResult(dependencies[0]!).sha256,
	});
	assert.equal(
		taskResultGateFailure(gate, `REVIEW: PASS\nEVIDENCE: ${evidence}\nVerified.`, dependencies),
		undefined,
	);
	for (const result of [
		"REVIEW: PASS",
		`review: pass\nEVIDENCE: ${evidence}`,
		`REVIEW: PASS\nEVIDENCE: ${JSON.stringify({ "a-task": pageTeamTaskResult(dependencies[1]!).sha256 })}`,
		`REVIEW: PASS\nEVIDENCE: ${JSON.stringify({ "z-task": pageTeamTaskResult(dependencies[0]!).sha256, "a-task": pageTeamTaskResult(dependencies[1]!).sha256 })}`,
	]) {
		assert.match(taskResultGateFailure(gate, result, dependencies) ?? "", /exact|exactly/);
	}
});
