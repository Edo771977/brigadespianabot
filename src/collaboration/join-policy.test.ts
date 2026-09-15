import assert from "node:assert/strict";
import test from "node:test";
import { evaluateJoinCondition } from "./memory-store.js";
import type { TaskStatus, TeamTask } from "./types.js";

function dependency(id: string, status: TaskStatus): TeamTask {
	return {
		id,
		runId: "run",
		title: id,
		instructions: id,
		status,
		dependencies: [],
		join: { kind: "all" },
		retry: { maxAttempts: 1 },
		priority: 0,
		createdAt: 0,
		updatedAt: 0,
	};
}

test("all join waits, succeeds, and becomes impossible on a terminal failure", () => {
	assert.equal(evaluateJoinCondition({ kind: "all" }, []), "satisfied");
	assert.equal(
		evaluateJoinCondition({ kind: "all" }, [dependency("a", "succeeded"), dependency("b", "running")]),
		"waiting",
	);
	assert.equal(
		evaluateJoinCondition({ kind: "all" }, [dependency("a", "succeeded"), dependency("b", "succeeded")]),
		"satisfied",
	);
	assert.equal(
		evaluateJoinCondition({ kind: "all" }, [dependency("a", "failed"), dependency("b", "running")]),
		"impossible",
	);
});

test("any join unlocks on first success and fails only when all branches are terminal", () => {
	assert.equal(
		evaluateJoinCondition({ kind: "any" }, [dependency("a", "failed"), dependency("b", "running")]),
		"waiting",
	);
	assert.equal(
		evaluateJoinCondition({ kind: "any" }, [dependency("a", "succeeded"), dependency("b", "running")]),
		"satisfied",
	);
	assert.equal(
		evaluateJoinCondition({ kind: "any" }, [dependency("a", "failed"), dependency("b", "cancelled")]),
		"impossible",
	);
});

test("quorum joins fail early when successes plus remaining cannot reach minimum", () => {
	const join = { kind: "quorum", minimum: 2 } as const;
	assert.equal(
		evaluateJoinCondition(join, [dependency("a", "succeeded"), dependency("b", "running"), dependency("c", "failed")]),
		"waiting",
	);
	assert.equal(
		evaluateJoinCondition(join, [dependency("a", "succeeded"), dependency("b", "succeeded"), dependency("c", "running")]),
		"satisfied",
	);
	assert.equal(
		evaluateJoinCondition(join, [dependency("a", "succeeded"), dependency("b", "failed"), dependency("c", "cancelled")]),
		"impossible",
	);
});
