import assert from "node:assert/strict";
import test from "node:test";

import { pageTeamTaskResult } from "./task-result-page.js";
import { CollaborationConflictError } from "./types.js";

test("task result pages reconstruct exact long text with one stable digest", () => {
	const source = `start-${"x".repeat(17)}-🦁-${"y".repeat(19)}-end`;
	const task = { id: "source", runId: "run", result: source } as never;
	const chunks: string[] = [];
	let offset = 0;
	let digest: string | undefined;
	for (;;) {
		const page = pageTeamTaskResult(task, { offset, limit: 7 });
		chunks.push(page.content);
		digest ??= page.sha256;
		assert.equal(page.sha256, digest);
		assert.equal(page.offset, offset);
		if (page.complete) break;
		assert.equal(page.nextOffset, page.endOffset);
		offset = page.nextOffset!;
	}
	assert.equal(chunks.join(""), source);
});

test("structured results use an exact compact JSON representation", () => {
	const result = { ok: true, nested: ["one", 2, null] };
	const page = pageTeamTaskResult({ id: "source", runId: "run", result } as never);
	assert.equal(page.format, "json");
	assert.equal(page.content, JSON.stringify(result));
	assert.equal(page.complete, true);
});

test("task result paging fails closed for absent results and invalid cursors", () => {
	assert.throws(
		() => pageTeamTaskResult({ id: "pending", runId: "run" } as never),
		(error: unknown) => error instanceof CollaborationConflictError && error.code === "RESULT_NOT_AVAILABLE",
	);
	assert.throws(
		() => pageTeamTaskResult({ id: "done", runId: "run", result: "abc" } as never, { offset: 4 }),
		(error: unknown) => error instanceof CollaborationConflictError && error.code === "INVALID_ARGUMENT",
	);
});
