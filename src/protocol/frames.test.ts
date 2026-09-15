/**
 * Unit tests for `isFrame` — the wire guard the client runs on every inbound
 * message. The reliable-streaming work widened it to accept `tick` + `shutdown`
 * (previously silently dropped) and the `event` frame to carry an optional
 * `seq`. See `../protocol.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { EVENT_NAMES, isFrame, PI_EVENT_TYPES, REQUEST_METHODS } from "../protocol.js";

test("isFrame accepts req / res / event", () => {
	assert.equal(isFrame({ type: "req", id: "r1", method: "prompt" }), true);
	assert.equal(isFrame({ type: "res", id: "r1", ok: true }), true);
	assert.equal(isFrame({ type: "event", event: "pi", payload: {} }), true);
});

test("isFrame accepts an event frame carrying a per-session seq", () => {
	assert.equal(isFrame({ type: "event", event: "pi", payload: { sessionId: "s1" }, seq: 7 }), true);
});

test("isFrame accepts tick + shutdown + hello-ok (no longer dropped)", () => {
	assert.equal(isFrame({ type: "tick", ts: 1234 }), true);
	assert.equal(isFrame({ type: "shutdown", reason: "restart" }), true);
	assert.equal(isFrame({ type: "hello-ok", protocol: 1, server: { version: "x", connId: "c", epoch: "e" } }), true);
});

test("isFrame rejects non-frames", () => {
	assert.equal(isFrame(null), false);
	assert.equal(isFrame(undefined), false);
	assert.equal(isFrame(42), false);
	assert.equal(isFrame("event"), false);
	assert.equal(isFrame({}), false);
	assert.equal(isFrame({ type: "nope" }), false);
});

test("REQUEST_METHODS is non-empty, unique, and includes the core methods a client needs", () => {
	assert.ok(REQUEST_METHODS.length > 20, `only ${REQUEST_METHODS.length} methods`);
	assert.equal(new Set(REQUEST_METHODS).size, REQUEST_METHODS.length, "duplicate method names");
	for (const m of ["prompt", "resume", "subscribe", "get-state", "approval-resolve"]) {
		assert.ok((REQUEST_METHODS as readonly string[]).includes(m), `REQUEST_METHODS missing ${m}`);
	}
});

test("EVENT_NAMES is exactly the broadcast event set", () => {
	assert.deepEqual(
		[...EVENT_NAMES].sort(),
		[
			"approval-request",
			"error",
			"log",
			"pi",
			"state",
			"system-event",
			"team-approval-request",
			"team-approval-resolved",
			"team-event",
			"team-progress",
		].sort(),
	);
});

test("PI_EVENT_TYPES includes the render-critical inner event types", () => {
	for (const t of [
		"agent_start",
		"message_update",
		"message_end",
		"tool_execution_start",
		"tool_execution_end",
		"agent_end",
	]) {
		assert.ok((PI_EVENT_TYPES as readonly string[]).includes(t), `PI_EVENT_TYPES missing ${t}`);
	}
});
