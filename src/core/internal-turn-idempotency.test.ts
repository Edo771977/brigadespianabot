import assert from "node:assert/strict";
import test from "node:test";

import { completedInternalTurnReply, hasCompletedInternalTurn } from "./internal-turn-idempotency.js";

const marker = (key: string) => ({
	type: "custom_message",
	customType: "brigade-internal-turn",
	details: { idempotencyKey: key },
});

test("completed hidden turn is replay-idempotent after a durable final answer", () => {
	assert.equal(hasCompletedInternalTurn([
		marker("event-1"),
		{ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [] } },
		{ type: "message", message: { role: "toolResult", content: [] } },
		{ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] } },
	], "event-1"), true);
});

test("failed hidden turn cannot borrow a later operator answer", () => {
	assert.equal(hasCompletedInternalTurn([
		marker("event-1"),
		{ type: "message", message: { role: "assistant", stopReason: "error", content: [] } },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
		{ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "hi" }] } },
	], "event-1"), false);
});

test("a completed hidden reply can be recovered for an idempotent side effect", () => {
	assert.equal(completedInternalTurnReply([
		marker("event-1"),
		{ type: "message", message: { role: "assistant", stopReason: "length", content: [{ type: "text", text: "Part one. " }] } },
		{ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Part two." }] } },
	], "event-1"), "Part one. Part two.");
});
