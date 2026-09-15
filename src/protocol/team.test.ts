import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	EVENT_NAMES,
	REQUEST_METHODS,
	TEAM_EVENT_NAMES,
	TEAM_REQUEST_METHODS,
	type EventPayload,
	type RequestParams,
	type ResponseFor,
} from "../protocol.js";
import { PROTOCOL_CAPABILITIES } from "./handshake.js";
import { isTeamEventName, TEAM_PROTOCOL_CAPABILITIES } from "./team.js";

type Extends<Left, Right> = Left extends Right ? true : false;
type Assert<T extends true> = T;

type _AllTeamMethodsHaveParams = Assert<
	Extends<(typeof TEAM_REQUEST_METHODS)[number], keyof RequestParams>
>;
type _AllTeamMethodsHaveResponses = Assert<
	Extends<(typeof TEAM_REQUEST_METHODS)[number], keyof ResponseFor>
>;
type _AllTeamEventsHavePayloads = Assert<
	Extends<(typeof TEAM_EVENT_NAMES)[number], keyof EventPayload>
>;

describe("Team Mode protocol discovery", () => {
	it("uses the advertised event list as the production routing discriminator", () => {
		for (const event of TEAM_EVENT_NAMES) assert.equal(isTeamEventName(event), true);
		for (const event of ["pi", "approval-request", "team-made-up"]) {
			assert.equal(isTeamEventName(event), false);
		}
	});
	it("advertises every Team Mode request exactly once", () => {
		assert.equal(new Set(TEAM_REQUEST_METHODS).size, TEAM_REQUEST_METHODS.length);
		for (const method of TEAM_REQUEST_METHODS) {
			assert.equal(
				REQUEST_METHODS.filter((candidate) => candidate === method).length,
				1,
				`request discovery mismatch for ${method}`,
			);
		}
	});

	it("advertises all pushed Team Mode event classes exactly once", () => {
		assert.deepEqual(TEAM_EVENT_NAMES, [
			"team-event",
			"team-progress",
			"team-approval-request",
			"team-approval-resolved",
		]);
		for (const event of TEAM_EVENT_NAMES) {
			assert.equal(
				EVENT_NAMES.filter((candidate) => candidate === event).length,
				1,
				`event discovery mismatch for ${event}`,
			);
		}
	});

	it("advertises replay, room isolation, and progress negotiation", () => {
		for (const capability of TEAM_PROTOCOL_CAPABILITIES) {
			assert.equal(
				PROTOCOL_CAPABILITIES.filter((candidate) => candidate === capability).length,
				1,
				`capability discovery mismatch for ${capability}`,
			);
		}
		assert.ok(TEAM_PROTOCOL_CAPABILITIES.includes("team.subscribe.snapshot"));
		assert.ok(TEAM_PROTOCOL_CAPABILITIES.includes("team.tasks.result.page"));
		assert.ok(TEAM_PROTOCOL_CAPABILITIES.includes("team.review-policy.independent-v1"));
		assert.ok(TEAM_PROTOCOL_CAPABILITIES.includes("team.messages.threads.v1"));
		assert.ok(TEAM_PROTOCOL_CAPABILITIES.includes("team.rooms.metrics.v1"));
	});
});

describe("Team Mode room subscription response", () => {
	it("keeps legacy success payload-less and types the post-install room summary", () => {
		const legacy: ResponseFor["subscribe"] = undefined;
		const summary = {
			roomId: "room-1",
			headRoomSeq: 12,
			pendingDecisionIds: ["approval:approval-1"],
			pendingExecApprovals: [],
			execApprovalRevision: 3,
		} satisfies Exclude<ResponseFor["subscribe"], void>;

		assert.equal(legacy, undefined);
		assert.equal(summary.roomId, "room-1");
		assert.equal(summary.headRoomSeq, 12);
	});
});

describe("Team Mode event payload contract", () => {
	it("carries the durable room cursor and task-attempt references", () => {
		const event: EventPayload["team-event"] = {
			eventId: "event-9",
			roomId: "room-1",
			roomSeq: 9,
			type: "attempt.succeeded",
			runId: "run-1",
			taskId: "task-1",
			attemptId: "attempt-1",
			commandId: "command-1",
			payload: { result: "ok" },
			createdAt: 123,
		};

		assert.deepEqual(
			{
				eventId: event.eventId,
				roomId: event.roomId,
				roomSeq: event.roomSeq,
				runId: event.runId,
				taskId: event.taskId,
				attemptId: event.attemptId,
			},
			{
				eventId: "event-9",
				roomId: "room-1",
				roomSeq: 9,
				runId: "run-1",
				taskId: "task-1",
				attemptId: "attempt-1",
			},
		);
	});

	it("keeps ephemeral progress out of the durable room sequence", () => {
		const progress: EventPayload["team-progress"] = {
			progressId: "progress-4",
			progressSeq: 4,
			roomId: "room-1",
			runId: "run-1",
			taskId: "task-1",
			attemptId: "attempt-1",
			kind: "assistant.delta",
			payload: { delta: "hi" },
			emittedAt: 123,
		};

		assert.equal(progress.progressSeq, 4);
		assert.equal("roomSeq" in progress, false);
	});
});
