import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { InMemoryCollaborationStore } from "./memory-store.js";

async function roomStore(): Promise<InMemoryCollaborationStore> {
	const store = new InMemoryCollaborationStore();
	await store.createRoom({
		commandId: "room:create",
		roomId: "room-1",
		title: "Product room",
		createdBy: "owner",
		members: [
			{ agentId: "lead", role: "coordinator" },
			{ agentId: "research" },
		],
		metadata: { coordinatorAgentId: "lead" },
		now: 1,
	});
	return store;
}

describe("Team room messages", () => {
	it("persists public threads, mentions, reactions, pins, search, and metrics", async () => {
		const store = await roomStore();
		const root = await store.postMessage({
			commandId: "message:root",
			messageId: "message-1",
			roomId: "room-1",
			authorId: "owner",
			authorKind: "owner",
			content: "Please verify the launch evidence",
			mentions: ["research"],
			now: 2,
		});
		assert.equal(root.value.threadRootMessageId, undefined);
		assert.deepEqual(root.events.map((event) => event.type), ["message.posted"]);

		const reply = await store.postMessage({
			commandId: "message:reply",
			messageId: "message-2",
			roomId: "room-1",
			authorId: "owner",
			authorKind: "owner",
			content: "Focus on the pricing claim",
			replyToMessageId: "message-1",
			now: 3,
		});
		assert.equal(reply.value.threadRootMessageId, "message-1");
		assert.deepEqual((await store.listMessages({ roomId: "room-1", rootOnly: true })).map((message) => message.id), ["message-1"]);
		assert.deepEqual((await store.listMessages({ roomId: "room-1", threadRootMessageId: "message-1" })).map((message) => message.id), ["message-2"]);

		const reacted = await store.reactMessage({
			commandId: "message:react",
			messageId: "message-1",
			actorId: "research",
			actorKind: "agent",
			key: "ack",
			present: true,
			now: 4,
		});
		assert.deepEqual(reacted.value.reactions, [{ key: "ack", actorIds: ["research"] }]);

		const pinned = await store.pinMessage({
			commandId: "message:pin",
			messageId: "message-1",
			actorId: "lead",
			actorKind: "agent",
			pinned: true,
			now: 5,
		});
		assert.equal(pinned.value.pinnedBy, "lead");
		assert.deepEqual((await store.searchMessages({ roomId: "room-1", query: "LAUNCH", pinnedOnly: true })).map((message) => message.id), ["message-1"]);

		const metrics = await store.getRoomMetrics("room-1");
		assert.deepEqual(
			{ messages: metrics.messageCount, threads: metrics.threadCount, mentions: metrics.mentionCount, pins: metrics.pinnedMessageCount },
			{ messages: 2, threads: 1, mentions: 1, pins: 1 },
		);
	});

	it("requires a live fence for agent-authored messages and preserves idempotency", async () => {
		const store = await roomStore();
		const delegated = await store.delegateRun({
			commandId: "run:delegate",
			runId: "run-1",
			roomId: "room-1",
			objective: "Verify evidence",
			createdBy: "owner",
			tasks: [{ id: "task-1", title: "Research", instructions: "Check evidence", assignedAgentId: "research" }],
			now: 10,
		});
		assert.equal(delegated.value.run.status, "running");
		const claimed = await store.claimReadyTask({
			commandId: "attempt:claim",
			taskId: "task-1",
			agentId: "research",
			workerId: "worker-1",
			leaseDurationMs: 5_000,
			now: 11,
		});
		const attempt = claimed.value;
		assert.ok(attempt);

		await assert.rejects(
			store.postMessage({
				commandId: "message:missing-fence",
				roomId: "room-1",
				authorId: "research",
				authorKind: "agent",
				content: "Working",
				attemptId: attempt.id,
				now: 12,
			}),
			(error: unknown) => (error as { code?: string }).code === "FENCE_REQUIRED",
		);

		const command = {
			commandId: "message:agent",
			messageId: "message-agent",
			roomId: "room-1",
			authorId: "research",
			authorKind: "agent" as const,
			source: "task" as const,
			content: "Evidence check is in progress",
			runId: "run-1",
			taskId: "task-1",
			attemptId: attempt.id,
			leaseToken: attempt.lease.token,
			fence: attempt.lease.fence,
			now: 12,
		};
		const first = await store.postMessage(command);
		const replay = await store.postMessage({ ...command, now: 13 });
		assert.equal(first.replayed, false);
		assert.equal(replay.replayed, true);
		assert.equal((await store.listMessages({ roomId: "room-1" })).length, 1);
	});

	it("soft-deletes content while retaining a thread tombstone", async () => {
		const store = await roomStore();
		await store.postMessage({
			commandId: "message:create",
			messageId: "message-1",
			roomId: "room-1",
			authorId: "owner",
			authorKind: "owner",
			content: "Temporary note",
			now: 2,
		});
		const deleted = await store.deleteMessage({
			commandId: "message:delete",
			messageId: "message-1",
			actorId: "owner",
			actorKind: "owner",
			now: 3,
		});
		assert.equal(deleted.value.content, "");
		assert.equal(deleted.value.deletedAt, 3);
		assert.equal((await store.listMessages({ roomId: "room-1" })).length, 0);
		assert.equal((await store.listMessages({ roomId: "room-1", includeDeleted: true })).length, 1);
	});
});
