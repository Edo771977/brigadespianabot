import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	extractTeamFrameTags,
	installTeamRoomSubscriptionThenSnapshot,
	shouldDeliverTeamFrame,
	type TeamRoomSubscriptions,
} from "./team-subscription-filter.js";

function subscriptions(entries: Array<[string, boolean]>): TeamRoomSubscriptions {
	return new Map(entries.map(([roomId, includeProgress]) => [roomId, { includeProgress }]));
}

describe("Team Mode room subscription filtering", () => {
	it("never broadcasts Team Mode events to a client with no room subscription", () => {
		assert.equal(shouldDeliverTeamFrame(undefined, { roomId: "room-a" }, "team-event"), false);
		assert.equal(shouldDeliverTeamFrame(new Map(), { roomId: "room-a" }, "team-event"), false);
	});

	it("routes durable lifecycle events only to subscribers of that room", () => {
		const subs = subscriptions([["room-a", false]]);
		assert.equal(shouldDeliverTeamFrame(subs, { roomId: "room-a" }, "team-event"), true);
		assert.equal(shouldDeliverTeamFrame(subs, { roomId: "room-a" }, "team-approval-request"), true);
		assert.equal(shouldDeliverTeamFrame(subs, { roomId: "room-a" }, "team-approval-resolved"), true);
		assert.equal(shouldDeliverTeamFrame(subs, { roomId: "room-b" }, "team-event"), false);
	});

	it("requires a per-room opt-in for ephemeral progress", () => {
		const subs = subscriptions([
			["room-a", false],
			["room-b", true],
		]);
		assert.equal(shouldDeliverTeamFrame(subs, { roomId: "room-a" }, "team-progress"), false);
		assert.equal(shouldDeliverTeamFrame(subs, { roomId: "room-b" }, "team-progress"), true);
	});

	it("refuses frames without a valid room routing key", () => {
		const subs = subscriptions([["room-a", true]]);
		assert.equal(shouldDeliverTeamFrame(subs, {}, "team-event"), false);
		assert.equal(shouldDeliverTeamFrame(subs, { roomId: "   " }, "team-progress"), false);
	});
});

describe("Team Mode room subscription snapshots", () => {
	it("installs routing before reading the authoritative snapshot", async () => {
		const order: string[] = [];
		const snapshot = await installTeamRoomSubscriptionThenSnapshot(
			() => order.push("installed"),
			async () => {
				order.push("snapshot");
				return { roomId: "room-a", headRoomSeq: 9 };
			},
			() => order.push("restored"),
		);

		assert.deepEqual(order, ["installed", "snapshot"]);
		assert.deepEqual(snapshot, { roomId: "room-a", headRoomSeq: 9 });
	});

	it("restores the previous routing state when the snapshot read fails", async () => {
		const order: string[] = [];
		await assert.rejects(
			installTeamRoomSubscriptionThenSnapshot(
				() => order.push("installed"),
				async () => {
					order.push("snapshot");
					throw new Error("snapshot unavailable");
				},
				() => order.push("restored"),
			),
			/snapshot unavailable/,
		);
		assert.deepEqual(order, ["installed", "snapshot", "restored"]);
	});
});

describe("extractTeamFrameTags", () => {
	it("extracts and trims a string roomId", () => {
		assert.deepEqual(extractTeamFrameTags({ roomId: "  room-a  ", runId: "run-1" }), {
			roomId: "room-a",
		});
	});

	it("does not coerce malformed payloads", () => {
		for (const payload of [null, undefined, "room-a", 42, {}, { roomId: 42 }, { roomId: "" }]) {
			assert.deepEqual(extractTeamFrameTags(payload), {});
		}
	});
});
