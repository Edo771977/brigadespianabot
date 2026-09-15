import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryCollaborationStore } from "./memory-store.js";
import { buildTeamChatSessionKey } from "./session-key.js";
import { persistTeamChatReply } from "./team-chat-message.js";

describe("persistTeamChatReply", () => {
	it("turns a coordinator answer into one idempotent public room message", async () => {
		const store = new InMemoryCollaborationStore();
		await store.createRoom({
			commandId: "room",
			roomId: "room-1",
			title: "Room",
			createdBy: "owner",
			members: [{ agentId: "lead", role: "coordinator" }, { agentId: "reviewer" }],
			now: 1,
		});
		const input = {
			store,
			sessionKey: buildTeamChatSessionKey("room-1", "lead"),
			reply: "  Done. @reviewer can inspect the evidence.  ",
			turnId: "turn-1",
			now: 2,
		};
		const first = await persistTeamChatReply(input);
		const replay = await persistTeamChatReply(input);

		assert.equal(first?.value.authorKind, "coordinator");
		assert.equal(first?.value.content, "Done. @reviewer can inspect the evidence.");
		assert.deepEqual(first?.value.mentions, ["reviewer"]);
		assert.equal(replay?.replayed, true);
		assert.equal((await store.listMessages({ roomId: "room-1" })).length, 1);
	});

	it("ignores ordinary sessions and closed rooms", async () => {
		const store = new InMemoryCollaborationStore();
		assert.equal(await persistTeamChatReply({ store, sessionKey: "agent:main:main", reply: "Hello", turnId: "turn" }), undefined);
		await store.createRoom({ commandId: "room", roomId: "closed", title: "Closed", createdBy: "owner", members: [{ agentId: "lead", role: "coordinator" }], now: 1 });
		await store.archiveRoom({ commandId: "archive", roomId: "closed", now: 2 });
		assert.equal(await persistTeamChatReply({ store, sessionKey: buildTeamChatSessionKey("closed", "lead"), reply: "Hello", turnId: "turn" }), undefined);
	});
});
