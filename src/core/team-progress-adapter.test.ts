import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentBusEvent } from "../agents/agent-event-bus.js";
import {
	createTeamProgressAdapter,
	TeamProgressTextRedactor,
	toTeamProgressUpdate,
} from "./team-progress-adapter.js";

function pi(piEvent: unknown): AgentBusEvent {
	return {
		type: "pi",
		runId: "runtime-1",
		agentId: "researcher",
		sessionId: "session-1",
		piEvent,
	};
}

describe("toTeamProgressUpdate", () => {
	it("maps visible assistant deltas and suppresses private thinking", () => {
		assert.deepEqual(
			toTeamProgressUpdate(pi({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "hello" },
			})),
			{ kind: "assistant.delta", payload: { delta: "hello" } },
		);
		assert.equal(
			toTeamProgressUpdate(pi({
				type: "message_update",
				assistantMessageEvent: { type: "thinking_delta", delta: "checking" },
			})),
			undefined,
		);
	});

	it("keeps tag-based private reasoning hidden across split text deltas", () => {
		const redact = new TeamProgressTextRedactor();
		assert.equal(redact.push("Visible <th"), "Visible ");
		assert.equal(redact.push("ink>secret"), "");
		assert.equal(redact.push(" plan</thi"), "");
		assert.equal(redact.push("nk>answer"), "answer");
	});

	it("redacts tag-based reasoning before per-attempt progress broadcast", () => {
		const adapt = createTeamProgressAdapter();
		assert.equal(adapt(pi({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "<thin" },
		})), undefined);
		assert.deepEqual(adapt(pi({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", delta: "k>private</think>public" },
		})), { kind: "assistant.delta", payload: { delta: "public" } });
	});

	it("maps tool phases without leaking arguments or results", () => {
		const start = toTeamProgressUpdate(pi({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "bash",
			args: { password: "must-not-leak" },
		}));
		const end = toTeamProgressUpdate(pi({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: { secret: "must-not-leak" },
			isError: true,
		}));
		assert.deepEqual(start, {
			kind: "tool.started",
			payload: { toolCallId: "call-1", toolName: "bash" },
		});
		assert.deepEqual(end, {
			kind: "tool.finished",
			payload: { toolCallId: "call-1", toolName: "bash", isError: true },
		});
		assert.doesNotMatch(JSON.stringify([start, end]), /must-not-leak/);
	});

	it("maps heartbeats and ignores unrelated lifecycle events", () => {
		assert.deepEqual(toTeamProgressUpdate({
			type: "turn-heartbeat",
			runId: "runtime-1",
			elapsedMs: 12_000,
		}), {
			kind: "attempt.heartbeat",
			payload: { elapsedMs: 12_000 },
		});
		assert.equal(toTeamProgressUpdate({
			type: "turn-settled",
			runId: "runtime-1",
			agentId: "researcher",
			sessionId: "session-1",
			provider: "provider",
			modelId: "model",
		}), undefined);
	});
});
