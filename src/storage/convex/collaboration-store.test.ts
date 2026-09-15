import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { CollaborationStoreSnapshot } from "../../collaboration/store.js";
import { CollaborationDomainError } from "../../collaboration/types.js";

import {
	applyCollaborationDelta,
	ConvexCollaborationStore,
	emptyCollaborationSnapshot,
	type CollaborationSnapshotDelta,
} from "./collaboration-store.js";

class FakeConvexCollaborationAuthority {
	revision = 0;
	snapshot = emptyCollaborationSnapshot();
	mutationCalls = 0;
	forcedConflicts = 0;
	queryNames: string[] = [];
	private barrier:
		| {
			remaining: number;
			waiting: Array<(value: { revision: number; snapshot: CollaborationStoreSnapshot }) => void>;
			captured: { revision: number; snapshot: CollaborationStoreSnapshot };
		}
		| undefined;

	readonly client = {
		query: async (reference: unknown, args: Record<string, unknown>) => {
			const functionName = reference && typeof reference === "object"
				? (reference as Record<symbol, unknown>)[Symbol.for("functionName")]
				: undefined;
			if (typeof functionName === "string") this.queryNames.push(functionName);
			if (functionName === "collaboration:getRoom") {
				return structuredClone(
					this.snapshot.rooms.find((room) => room.id === args.roomId) ?? null,
				);
			}
			if (functionName === "collaboration:getRun") {
				return structuredClone(
					this.snapshot.runs.find((run) => run.id === args.runId) ?? null,
				);
			}
			if (functionName === "collaboration:readEvents") {
				const afterRoomSeq = typeof args.afterRoomSeq === "number" ? args.afterRoomSeq : 0;
				const limit = typeof args.limit === "number" ? args.limit : 500;
				return structuredClone(this.snapshot.events
					.filter((event) => args.roomId === undefined || event.roomId === args.roomId)
					.filter((event) => args.runId === undefined || event.runId === args.runId)
					.filter((event) => event.roomSeq > afterRoomSeq)
					.sort((left, right) => left.roomId.localeCompare(right.roomId) || left.roomSeq - right.roomSeq)
					.slice(0, limit));
			}
			const response = {
				revision: this.revision,
				snapshot: structuredClone(this.snapshot),
			};
			if (!this.barrier) return response;
			return new Promise<typeof response>((resolve) => {
				const barrier = this.barrier;
				assert.ok(barrier);
				barrier.waiting.push(resolve);
				barrier.remaining -= 1;
				if (barrier.remaining === 0) {
					this.barrier = undefined;
					for (const release of barrier.waiting) release(structuredClone(barrier.captured));
				}
			});
		},
		mutation: async (_reference: unknown, args: Record<string, unknown>) => {
			this.mutationCalls += 1;
			if (this.forcedConflicts > 0) {
				this.forcedConflicts -= 1;
				this.revision += 1;
				throw Object.assign(new Error("COLLABORATION_OCC_CONFLICT"), {
					data: { code: "COLLABORATION_OCC_CONFLICT", actualRevision: this.revision },
				});
			}
			if (args.expectedRevision !== this.revision) {
				throw Object.assign(new Error("COLLABORATION_OCC_CONFLICT"), {
					data: { code: "COLLABORATION_OCC_CONFLICT", actualRevision: this.revision },
				});
			}
			this.snapshot = applyCollaborationDelta(
				this.snapshot,
				args.delta as CollaborationSnapshotDelta,
			);
			this.revision += 1;
			return { revision: this.revision };
		},
	};

	armReadBarrier(readers: number): void {
		this.barrier = {
			remaining: readers,
			waiting: [],
			captured: {
				revision: this.revision,
				snapshot: structuredClone(this.snapshot),
			},
		};
	}
}

function makeStore(authority: FakeConvexCollaborationAuthority): ConvexCollaborationStore {
	return new ConvexCollaborationStore({
		client: authority.client as never,
		ownerId: "owner-1",
	});
}

function hasCode(code: string): (error: unknown) => boolean {
	return (error) => error instanceof CollaborationDomainError && error.code === code;
}

async function seedReadyTask(store: ConvexCollaborationStore): Promise<void> {
	await store.createRoom({
		commandId: "room-command",
		roomId: "room-1",
		title: "Team room",
		createdBy: "owner",
		now: 1,
	});
	await store.createRun({
		commandId: "run-command",
		runId: "run-1",
		roomId: "room-1",
		objective: "Work together",
		createdBy: "owner",
		budgets: { maxConcurrency: 1 },
		now: 2,
	});
	await store.addTasks({
		commandId: "tasks-command",
		runId: "run-1",
		tasks: [
			{
				id: "task-1",
				title: "Task",
				instructions: "Do the work",
				retry: { maxAttempts: 2 },
			},
		],
		now: 3,
	});
	await store.startRun({ commandId: "start-command", runId: "run-1", now: 4 });
}

describe("ConvexCollaborationStore", () => {
	it("round-trips worker delegation through the shared snapshot authority", async () => {
		const authority = new FakeConvexCollaborationAuthority();
		const first = makeStore(authority);
		await first.createRoom({
			commandId: "child.room",
			roomId: "room",
			title: "Room",
			createdBy: "owner",
			members: [{ agentId: "alice" }, { agentId: "bob" }],
			now: 1,
		});
		await first.createRun({ commandId: "child.run", runId: "run", roomId: "room", objective: "Coordinate", createdBy: "owner", now: 2 });
		await first.addTasks({ commandId: "child.tasks", runId: "run", tasks: [{ id: "parent", title: "Parent", instructions: "Coordinate", assignedAgentId: "alice" }], now: 3 });
		await first.startRun({ commandId: "child.start", runId: "run", now: 4 });
		const source = (await first.claimReadyTask({ commandId: "child.claim", runId: "run", taskId: "parent", agentId: "alice", workerId: "worker", leaseDurationMs: 100, now: 5 })).value!;
		await first.delegateAttemptChildren({
			commandId: "child.delegate",
			attemptId: source.id,
			leaseToken: source.lease.token,
			fence: source.lease.fence,
			requestKey: "child-v1",
			tasks: [{ id: "child", title: "Child", instructions: "Work", assignedAgentId: "bob" }],
			now: 6,
		});

		const fresh = makeStore(authority);
		assert.equal((await fresh.getTask("parent"))?.status, "waiting_children");
		assert.equal((await fresh.getTask("child"))?.parentTaskId, "parent");
		assert.equal((await fresh.getTask("child"))?.delegatedByAttemptId, source.id);
		assert.equal((await fresh.getAttempt(source.id))?.status, "delegated");
	});

	it("uses indexed point queries for room and run validation reads", async () => {
		const authority = new FakeConvexCollaborationAuthority();
		const store = makeStore(authority);
		await store.createRoom({ commandId: "room", roomId: "room", title: "Room", createdBy: "owner", now: 1 });
		await store.createRun({ commandId: "run", runId: "run", roomId: "room", objective: "Validate", createdBy: "owner", now: 2 });
		authority.queryNames = [];

		assert.equal((await store.getRoom("room"))?.title, "Room");
		assert.equal((await store.getRun("run"))?.objective, "Validate");
		assert.equal(await store.getRoom("missing"), undefined);
		assert.equal(await store.getRun("missing"), undefined);
		assert.deepEqual(authority.queryNames, [
			"collaboration:getRoom",
			"collaboration:getRun",
			"collaboration:getRoom",
			"collaboration:getRun",
		]);
	});

	it("round-trips and enforces a final review gate through a fresh adapter", async () => {
		const authority = new FakeConvexCollaborationAuthority();
		const first = makeStore(authority);
		await first.createRoom({ commandId: "gate.room", roomId: "room", title: "Room", createdBy: "owner", now: 1 });
		await first.createRun({ commandId: "gate.run", runId: "run", roomId: "room", objective: "Verify", createdBy: "owner", now: 2 });
		await first.addTasks({
			commandId: "gate.tasks",
			runId: "run",
			tasks: [{ id: "gate", title: "Gate", instructions: "Verify", resultGate: { kind: "review_verdict" } }],
			now: 3,
		});
		await first.startRun({ commandId: "gate.start", runId: "run", now: 4 });

		const reopened = makeStore(authority);
		assert.deepEqual((await reopened.getTask("gate"))?.resultGate, { kind: "review_verdict" });
		const claim = await reopened.claimReadyTask({ commandId: "gate.claim", runId: "run", workerId: "worker", leaseDurationMs: 100, now: 5 });
		assert.ok(claim.value);
		const completed = await reopened.completeAttempt({
			commandId: "gate.complete",
			attemptId: claim.value.id,
			leaseToken: claim.value.lease.token,
			fence: claim.value.lease.fence,
			result: "REVIEW: FAIL\nStill broken.",
			artifacts: [{ id: "gate-diagnostics", kind: "review-report", name: "Diagnostics", uri: "artifact://gate-diagnostics", metadata: { check: "failed" } }],
			now: 6,
		});
		assert.equal(completed.value.status, "failed");
		assert.equal((await makeStore(authority).getRun("run"))?.status, "failed");
		assert.deepEqual((await makeStore(authority).listArtifacts("run"))[0], {
			id: "gate-diagnostics",
			runId: "run",
			taskId: "gate",
			attemptId: claim.value.id,
			kind: "review-report",
			name: "Diagnostics",
			uri: "artifact://gate-diagnostics",
			metadata: { check: "failed" },
			createdAt: 6,
		});
	});

	it("round-trips independent-v1 review policy through a fresh adapter", async () => {
		const authority = new FakeConvexCollaborationAuthority();
		const first = makeStore(authority);
		await first.createRoom({ commandId: "strict.room", roomId: "room", title: "Room", createdBy: "owner", members: [{ agentId: "maker" }, { agentId: "reviewer" }], now: 1 });
		await first.createRun({ commandId: "strict.run", runId: "run", roomId: "room", objective: "Verify", createdBy: "owner", now: 2 });
		await first.addTasks({
			commandId: "strict.tasks",
			runId: "run",
			tasks: [
				{ id: "make", title: "Make", instructions: "Build", assignedAgentId: "maker" },
				{ id: "review", title: "Review", instructions: "Verify", assignedAgentId: "reviewer", dependencies: ["make"], resultGate: { kind: "review_verdict", policy: "independent-v1" } },
			],
			now: 3,
		});

		const reopened = makeStore(authority);
		assert.deepEqual((await reopened.getTask("review"))?.resultGate, { kind: "review_verdict", policy: "independent-v1" });
		await reopened.startRun({ commandId: "strict.start", runId: "run", now: 4 });
		assert.equal((await reopened.getRun("run"))?.status, "running");
	});

	it("commits and replays a delegated reviewer DAG as one Convex mutation", async () => {
		const authority = new FakeConvexCollaborationAuthority();
		const store = makeStore(authority);
		await store.createRoom({ commandId: "room", roomId: "room", title: "Room", createdBy: "owner", now: 1 });
		const before = authority.mutationCalls;
		const command = {
			commandId: "delegate",
			runId: "run",
			roomId: "room",
			objective: "Deliver",
			createdBy: "owner",
			tasks: [
				{ id: "make", title: "Make", instructions: "Make" },
				{ id: "review", title: "Review", instructions: "Review", dependencies: ["make"] },
			],
		};
		const delegated = await store.delegateRun(command);
		assert.equal(authority.mutationCalls, before + 1);
		assert.equal(delegated.value.run.status, "running");
		assert.ok(delegated.events.every((event) => event.commandId === command.commandId));
		const after = authority.mutationCalls;
		assert.equal((await makeStore(authority).delegateRun(command)).replayed, true);
		assert.equal(authority.mutationCalls, after, "receipt replay performs no mutation");
		const snapshot = await store.readSnapshot();
		assert.equal(snapshot.runs.length, 1);
		assert.equal(snapshot.tasks.length, 2);
		assert.equal(snapshot.commandReceipts.filter((receipt) => receipt.commandId === "delegate").length, 1);
	});

	it("does not issue a Convex mutation for an oversized atomic delegation", async () => {
		const authority = new FakeConvexCollaborationAuthority();
		const store = makeStore(authority);
		await store.createRoom({ commandId: "room", roomId: "room", title: "Room", createdBy: "owner", now: 1 });
		const mutationsBefore = authority.mutationCalls;
		const snapshotBefore = structuredClone(authority.snapshot);
		await assert.rejects(
			() => store.delegateRun({
				commandId: "oversized",
				runId: "run",
				roomId: "room",
				objective: "Oversized",
				createdBy: "owner",
				tasks: Array.from({ length: 6 }, (_, index) => ({
					id: `task-${index}`,
					title: `Task ${index}`,
					instructions: "x".repeat(90_000),
				})),
				now: 2,
			}),
			hasCode("INVALID_ARGUMENT"),
		);
		assert.equal(authority.mutationCalls, mutationsBefore);
		assert.deepEqual(authority.snapshot, snapshotBefore);
	});

	it("persists command receipts and replays an omitted-now command after restart", async () => {
		const authority = new FakeConvexCollaborationAuthority();
		const first = makeStore(authority);
		const command = {
			commandId: "create-without-now",
			roomId: "room-1",
			title: "Durable room",
			createdBy: "owner",
		};
		const created = await first.createRoom(command);
		assert.equal(created.replayed, false);
		const mutationsAfterCreate = authority.mutationCalls;

		const reopened = makeStore(authority);
		const replayed = await reopened.createRoom(command);
		assert.equal(replayed.replayed, true);
		assert.equal(replayed.value.id, created.value.id);
		assert.deepEqual(
			replayed.events.map((event) => event.eventId),
			created.events.map((event) => event.eventId),
		);
		assert.equal(authority.mutationCalls, mutationsAfterCreate);
		assert.equal((await reopened.createRoom({ ...command, now: 999 })).replayed, true);
		assert.equal(authority.mutationCalls, mutationsAfterCreate);
		assert.equal((await reopened.readSnapshot()).rooms.length, 1);
	});

	it("recomputes and commits once after an OCC conflict", async () => {
		const authority = new FakeConvexCollaborationAuthority();
		authority.forcedConflicts = 1;
		const store = makeStore(authority);
		const result = await store.createRoom({
			commandId: "occ-room",
			roomId: "room-1",
			title: "OCC room",
			createdBy: "owner",
			now: 1,
		});
		assert.equal(result.replayed, false);
		assert.equal(authority.mutationCalls, 2);
		const snapshot = await store.readSnapshot();
		assert.equal(snapshot.rooms.length, 1);
		assert.deepEqual(
			result.events.map((event) => event.eventId),
			snapshot.events.map((event) => event.eventId),
		);
	});

	it("linearizes concurrent claims and preserves one active lease", async () => {
		const authority = new FakeConvexCollaborationAuthority();
		const left = makeStore(authority);
		const right = makeStore(authority);
		await seedReadyTask(left);
		authority.armReadBarrier(2);

		const claims = await Promise.all([
			left.claimReadyTask({
				commandId: "claim-left",
				runId: "run-1",
				workerId: "left",
				leaseDurationMs: 10,
				now: 5,
			}),
			right.claimReadyTask({
				commandId: "claim-right",
				runId: "run-1",
				workerId: "right",
				leaseDurationMs: 10,
				now: 5,
			}),
		]);
		assert.equal(claims.filter((claim) => claim.value !== undefined).length, 1);
		assert.equal((await left.listAttempts("task-1")).length, 1);
		assert.equal((await right.getRun("run-1"))?.usage.activeAttempts, 1);
	});

	it("recovers an expired lease with a higher fence after adapter restart", async () => {
		const authority = new FakeConvexCollaborationAuthority();
		const first = makeStore(authority);
		await seedReadyTask(first);
		const claim = await first.claimReadyTask({
			commandId: "initial-claim",
			runId: "run-1",
			workerId: "worker-1",
			leaseDurationMs: 10,
			now: 5,
		});
		const initialAttempt = claim.value;
		assert.ok(initialAttempt);

		const reopened = makeStore(authority);
		const reconciled = await reopened.reconcile({
			commandId: "reconcile",
			now: 16,
		});
		assert.deepEqual(reconciled.value.expiredAttempts, [initialAttempt.id]);
		await assert.rejects(
			() =>
				reopened.completeAttempt({
					commandId: "late-complete",
					attemptId: initialAttempt.id,
					leaseToken: initialAttempt.lease.token,
					fence: initialAttempt.lease.fence,
					now: 17,
				}),
			hasCode("STALE_ATTEMPT"),
		);
		const retry = await reopened.claimReadyTask({
			commandId: "retry-claim",
			runId: "run-1",
			workerId: "worker-2",
			leaseDurationMs: 10,
			now: 17,
		});
		assert.ok(retry.value);
		assert.equal(retry.value.lease.fence, initialAttempt.lease.fence + 1);
	});

	it("keeps public room messages in parity across Convex adapter instances", async () => {
		const authority = new FakeConvexCollaborationAuthority();
		const first = makeStore(authority);
		await first.createRoom({
			commandId: "messages.room",
			roomId: "messages-room",
			title: "Messages",
			createdBy: "owner",
			members: [{ agentId: "lead", role: "coordinator" }, { agentId: "reviewer" }],
			now: 1,
		});
		await first.postMessage({
			commandId: "messages.root",
			messageId: "root-message",
			roomId: "messages-room",
			authorId: "owner",
			authorKind: "owner",
			source: "chat",
			content: "Please ask @reviewer for evidence",
			mentions: ["reviewer"],
			now: 2,
		});
		await first.postMessage({
			commandId: "messages.reply",
			messageId: "reply-message",
			roomId: "messages-room",
			authorId: "lead",
			authorKind: "coordinator",
			source: "chat",
			content: "Evidence returned in this thread.",
			replyToMessageId: "root-message",
			now: 3,
		});

		const reopened = makeStore(authority);
		assert.deepEqual((await reopened.listMessages({ roomId: "messages-room" })).map((message) => message.id), [
			"root-message",
			"reply-message",
		]);
		assert.deepEqual((await reopened.searchMessages({
			roomId: "messages-room",
			query: "evidence",
		})).map((message) => message.id).sort(), ["reply-message", "root-message"]);
		assert.equal((await reopened.getRoomMetrics("messages-room")).threadCount, 1);
		assert.equal((await reopened.readSnapshot()).messages?.length, 2);
	});

	it("imports large normalized snapshots in bounded idempotent batches", async () => {
		const authority = new FakeConvexCollaborationAuthority();
		const store = makeStore(authority);
		await store.createRoom({
			commandId: "stale-room-command",
			roomId: "stale-room",
			title: "Stale target-only room",
			createdBy: "owner",
			now: 1,
		});
		const snapshot = emptyCollaborationSnapshot();
		snapshot.rooms = Array.from({ length: 130 }, (_, index) => ({
			id: `room-${index}`,
			title: `Room ${index}`,
			createdBy: "owner",
			status: "open" as const,
			members: [],
			metadata: {},
			createdAt: index,
			updatedAt: index,
		}));

		await store.importSnapshot(snapshot);
		assert.equal(authority.mutationCalls, 4);
		const imported = await store.readSnapshot();
		assert.equal(imported.rooms.length, 130);
		assert.equal(imported.rooms.some((room) => room.id === "stale-room"), false);
		await store.importSnapshot(snapshot);
		assert.equal(authority.mutationCalls, 4);
	});
});
