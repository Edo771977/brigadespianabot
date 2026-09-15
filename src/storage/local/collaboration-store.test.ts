import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

import { CollaborationDomainError } from "../../collaboration/types.js";
import { LocalBrigadeStore } from "./index.js";
import { LocalCollaborationJournal } from "./collaboration-journal.js";
import { LocalCollaborationStore } from "./collaboration-store.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "brigade-collaboration-store-"));
	roots.push(root);
	return root;
}

async function openStore(root: string): Promise<LocalCollaborationStore> {
	const store = new LocalCollaborationStore(root);
	await store.init();
	return store;
}

async function seedSingleTaskRun(
	store: LocalCollaborationStore,
	opts: { retryAttempts?: number; leaseDurationMs?: number } = {},
) {
	await store.createRoom({
		commandId: "create-room",
		roomId: "room-1",
		title: "Release room",
		createdBy: "owner",
		now: 1,
	});
	await store.createRun({
		commandId: "create-run",
		runId: "run-1",
		roomId: "room-1",
		objective: "Ship the release",
		createdBy: "owner",
		now: 2,
	});
	await store.addTasks({
		commandId: "add-task",
		runId: "run-1",
		tasks: [
			{
				id: "task-1",
				title: "Verify",
				instructions: "Run verification",
				retry: { maxAttempts: opts.retryAttempts ?? 1 },
			},
		],
		now: 3,
	});
	await store.startRun({ commandId: "start-run", runId: "run-1", now: 4 });
	return store.claimReadyTask({
		commandId: "claim-task",
		runId: "run-1",
		workerId: "worker-1",
		leaseDurationMs: opts.leaseDurationMs ?? 100,
		now: 5,
	});
}

function hasCode(code: string): (error: unknown) => boolean {
	return (error) => error instanceof CollaborationDomainError && error.code === code;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("LocalCollaborationStore", () => {
	it("replays long update history without cloning accumulated state per transaction", async () => {
		const root = await makeRoot();
		const journal = new LocalCollaborationJournal<{
			schemaVersion: 1;
			operation: string;
			commandId: string;
			delta: { rooms: { upserts: unknown[]; deletes: string[] } };
		}>(root);
		await journal.init();
		for (let index = 0; index < 24; index += 1) {
			await journal.transact(() => ({
				payload: {
					schemaVersion: 1,
					operation: "updateRoom",
					commandId: `history.${index}`,
					delta: {
						rooms: {
							upserts: [{
								id: "room",
								title: `Room ${index}`,
								createdBy: "owner",
								status: "open",
								members: [],
								metadata: {},
								createdAt: 1,
								updatedAt: index + 1,
							}],
							deletes: [],
						},
					},
				},
				result: undefined,
			}));
		}
		await journal.close();

		const store = await openStore(root);
		const originalStructuredClone = globalThis.structuredClone;
		let cloneCalls = 0;
		globalThis.structuredClone = ((...args: Parameters<typeof structuredClone>) => {
			cloneCalls += 1;
			return originalStructuredClone(...args);
		}) as typeof structuredClone;
		try {
			assert.deepEqual((await store.listRooms()).map(({ title }) => title), ["Room 23"]);
		} finally {
			globalThis.structuredClone = originalStructuredClone;
			await store.close();
		}
		assert.ok(cloneCalls < 10, `replay cloned accumulated state ${cloneCalls} times`);
	});

	it("persists worker-child delegation lineage and yielded usage gates across restart", async () => {
		const root = await makeRoot();
		const first = await openStore(root);
		await first.createRoom({
			commandId: "child.room",
			roomId: "room",
			title: "Room",
			createdBy: "owner",
			members: [{ agentId: "alice" }, { agentId: "bob" }],
			now: 1,
		});
		await first.createRun({ commandId: "child.run", runId: "run", roomId: "room", objective: "Coordinate", createdBy: "owner", now: 2 });
		await first.addTasks({
			commandId: "child.tasks",
			runId: "run",
			tasks: [{ id: "parent", title: "Parent", instructions: "Coordinate", assignedAgentId: "alice" }],
			now: 3,
		});
		await first.startRun({ commandId: "child.start", runId: "run", now: 4 });
		const source = (await first.claimReadyTask({ commandId: "child.claim", runId: "run", taskId: "parent", agentId: "alice", workerId: "worker", leaseDurationMs: 100, now: 5 })).value!;
		await first.delegateAttemptChildren({
			commandId: "child.delegate",
			attemptId: source.id,
			leaseToken: source.lease.token,
			fence: source.lease.fence,
			requestKey: "child-v1",
			delegationKind: "consultation",
			tasks: [{ id: "child", title: "Child", instructions: "Answer", assignedAgentId: "bob" }],
			now: 6,
		});
		await first.close();

		const reopened = await openStore(root);
		assert.equal((await reopened.getTask("parent"))?.status, "waiting_children");
		assert.deepEqual(
			((await reopened.getTask("child")) && {
				parentTaskId: (await reopened.getTask("child"))?.parentTaskId,
				delegatedByAttemptId: (await reopened.getTask("child"))?.delegatedByAttemptId,
				delegationKind: (await reopened.getTask("child"))?.delegationKind,
				requestKey: (await reopened.getTask("child"))?.requestKey,
			}),
			{ parentTaskId: "parent", delegatedByAttemptId: source.id, delegationKind: "consultation", requestKey: "child-v1" },
		);
		assert.equal((await reopened.getAttempt(source.id))?.status, "delegated");
		await reopened.close();
	});

	it("preserves and enforces a final review gate after journal restart", async () => {
		const root = await makeRoot();
		const first = await openStore(root);
		await first.createRoom({ commandId: "gate.room", roomId: "room", title: "Room", createdBy: "owner", now: 1 });
		await first.createRun({ commandId: "gate.run", runId: "run", roomId: "room", objective: "Verify", createdBy: "owner", now: 2 });
		await first.addTasks({
			commandId: "gate.tasks",
			runId: "run",
			tasks: [{ id: "gate", title: "Gate", instructions: "Verify", resultGate: { kind: "review_verdict" } }],
			now: 3,
		});
		await first.startRun({ commandId: "gate.start", runId: "run", now: 4 });
		await first.close();

		const reopened = await openStore(root);
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
		assert.equal((await reopened.getRun("run"))?.status, "failed");
		await reopened.close();

		const verified = await openStore(root);
		assert.deepEqual((await verified.listArtifacts("run"))[0], {
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
		await verified.close();
	});

	it("preserves independent-v1 review policy after journal restart", async () => {
		const root = await makeRoot();
		const first = await openStore(root);
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
		await first.close();

		const reopened = await openStore(root);
		assert.deepEqual((await reopened.getTask("review"))?.resultGate, { kind: "review_verdict", policy: "independent-v1" });
		await reopened.startRun({ commandId: "strict.start", runId: "run", now: 4 });
		assert.equal((await reopened.getRun("run"))?.status, "running");
		await reopened.close();
	});

	it("commits an entire delegated run as one journal transaction", async () => {
		const root = await makeRoot();
		const first = await openStore(root);
		await first.createRoom({ commandId: "room", roomId: "room", title: "Room", createdBy: "owner", now: 1 });
		const journalPath = path.join(root, "collaboration", "journal.jsonl");
		const linesBefore = (await fs.readFile(journalPath, "utf8")).trim().split("\n").length;
		await first.delegateRun({
			commandId: "delegate",
			runId: "run",
			roomId: "room",
			objective: "Deliver",
			createdBy: "owner",
			tasks: [
				{ id: "make", title: "Make", instructions: "Make" },
				{ id: "review", title: "Review", instructions: "Review", dependencies: ["make"] },
			],
			now: 2,
		});
		const linesAfter = (await fs.readFile(journalPath, "utf8")).trim().split("\n").length;
		assert.equal(linesAfter, linesBefore + 1);
		await first.close();

		const reopened = await openStore(root);
		assert.equal((await reopened.getRun("run"))?.status, "running");
		assert.deepEqual((await reopened.listTasks("run")).map((task) => task.status), ["ready", "blocked"]);
		assert.equal((await reopened.readSnapshot()).commandReceipts.filter((receipt) => receipt.commandId === "delegate").length, 1);
		await reopened.close();
	});

	it("does not append a journal transaction for an oversized atomic delegation", async () => {
		const root = await makeRoot();
		const store = await openStore(root);
		await store.createRoom({ commandId: "room", roomId: "room", title: "Room", createdBy: "owner", now: 1 });
		const journalPath = path.join(root, "collaboration", "journal.jsonl");
		const journalBefore = await fs.readFile(journalPath, "utf8");
		const snapshotBefore = await store.readSnapshot();
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
		assert.equal(await fs.readFile(journalPath, "utf8"), journalBefore);
		assert.deepEqual(await store.readSnapshot(), snapshotBefore);
		await store.close();
	});

	it("replays durable state and command receipts without duplicate events", async () => {
		const root = await makeRoot();
		const first = await openStore(root);
		const claim = await seedSingleTaskRun(first);
		assert.ok(claim.value);
		const beforeRestart = await first.readSnapshot();
		const eventCursor = beforeRestart.events.at(-2)?.roomSeq;
		assert.ok(eventCursor !== undefined);
		await first.close();

		const reopened = await openStore(root);
		assert.deepEqual(await reopened.readSnapshot(), beforeRestart);

		const replay = await reopened.createRoom({
			commandId: "create-room",
			roomId: "room-1",
			title: "Release room",
			createdBy: "owner",
			now: 1,
		});
		assert.equal(replay.replayed, true);
		assert.equal(replay.value.id, "room-1");
		assert.deepEqual(await reopened.readSnapshot(), beforeRestart);

		await assert.rejects(
			() =>
				reopened.createRoom({
					commandId: "create-room",
					roomId: "different-room",
					title: "Different payload",
					createdBy: "owner",
					now: 1,
				}),
			hasCode("IDEMPOTENCY_CONFLICT"),
		);

		const resumed = await reopened.readEvents({ roomId: "room-1", afterRoomSeq: eventCursor });
		assert.deepEqual(
			resumed.map((event) => event.roomSeq),
			beforeRestart.events
				.filter((event) => event.roomId === "room-1" && event.roomSeq > eventCursor)
				.map((event) => event.roomSeq),
		);
		assert.equal(beforeRestart.outbox.length, beforeRestart.events.length);
		assert.deepEqual(
			new Set(beforeRestart.outbox.map((item) => item.event.eventId)),
			new Set(beforeRestart.events.map((event) => event.eventId)),
		);
		await reopened.close();
	});

	it("recovers expired leases and advances fencing tokens after restart", async () => {
		const root = await makeRoot();
		const first = await openStore(root);
		const initialClaim = await seedSingleTaskRun(first, { retryAttempts: 2, leaseDurationMs: 10 });
		const initialAttempt = initialClaim.value;
		assert.ok(initialAttempt);
		await first.close();

		const reopened = await openStore(root);
		const reconciliation = await reopened.reconcile({
			commandId: "reconcile-expired",
			retryDelayMs: 0,
			now: 16,
		});
		assert.deepEqual(reconciliation.value.expiredAttempts, [initialAttempt.id]);
		assert.deepEqual(reconciliation.value.requeuedTasks, ["task-1"]);

		await assert.rejects(
			() =>
				reopened.completeAttempt({
					commandId: "late-completion",
					attemptId: initialAttempt.id,
					leaseToken: initialAttempt.lease.token,
					fence: initialAttempt.lease.fence,
					result: "too late",
					now: 17,
				}),
			hasCode("STALE_ATTEMPT"),
		);

		const retry = await reopened.claimReadyTask({
			commandId: "claim-retry",
			runId: "run-1",
			workerId: "worker-2",
			leaseDurationMs: 10,
			now: 17,
		});
		assert.ok(retry.value);
		assert.equal(retry.value.number, 2);
		assert.equal(retry.value.lease.fence, initialAttempt.lease.fence + 1);
		await reopened.close();
	});

	it("preserves all, any, and quorum joins across restart", async () => {
		const root = await makeRoot();
		const first = await openStore(root);
		await first.createRoom({
			commandId: "room-joins",
			roomId: "room-joins",
			title: "Join room",
			createdBy: "owner",
			members: [{ agentId: "agent-a" }, { agentId: "agent-b" }],
			now: 1,
		});
		await first.createRun({
			commandId: "run-joins",
			runId: "run-joins",
			roomId: "room-joins",
			objective: "Evaluate joins",
			createdBy: "owner",
			now: 2,
		});
		await first.addTasks({
			commandId: "tasks-joins",
			runId: "run-joins",
			tasks: [
				{ id: "root-a", title: "A", instructions: "A", assignedAgentId: "agent-a" },
				{ id: "root-b", title: "B", instructions: "B", assignedAgentId: "agent-b" },
				{ id: "join-all", title: "All", instructions: "All", dependencies: ["root-a", "root-b"], join: { kind: "all" } },
				{ id: "join-any", title: "Any", instructions: "Any", dependencies: ["root-a", "root-b"], join: { kind: "any" } },
				{ id: "join-quorum", title: "Quorum", instructions: "Quorum", dependencies: ["root-a", "root-b"], join: { kind: "quorum", minimum: 2 } },
			],
			now: 3,
		});
		await first.startRun({ commandId: "start-joins", runId: "run-joins", now: 4 });

		const claimA = await first.claimReadyTask({
			commandId: "claim-a",
			runId: "run-joins",
			agentId: "agent-a",
			workerId: "worker-a",
			leaseDurationMs: 100,
			now: 5,
		});
		assert.ok(claimA.value);
		await first.completeAttempt({
			commandId: "complete-a",
			attemptId: claimA.value.id,
			leaseToken: claimA.value.lease.token,
			fence: claimA.value.lease.fence,
			now: 6,
		});
		assert.equal((await first.getTask("join-any"))?.status, "ready");
		assert.equal((await first.getTask("join-all"))?.status, "blocked");
		assert.equal((await first.getTask("join-quorum"))?.status, "blocked");
		await first.close();

		const reopened = await openStore(root);
		const claimB = await reopened.claimReadyTask({
			commandId: "claim-b",
			runId: "run-joins",
			taskId: "root-b",
			agentId: "agent-b",
			workerId: "worker-b",
			leaseDurationMs: 100,
			now: 7,
		});
		assert.ok(claimB.value);
		await reopened.completeAttempt({
			commandId: "complete-b",
			attemptId: claimB.value.id,
			leaseToken: claimB.value.lease.token,
			fence: claimB.value.lease.fence,
			now: 8,
		});
		assert.equal((await reopened.getTask("join-all"))?.status, "ready");
		assert.equal((await reopened.getTask("join-any"))?.status, "ready");
		assert.equal((await reopened.getTask("join-quorum"))?.status, "ready");
		await reopened.close();
	});

	it("persists run concurrency budgets and active usage", async () => {
		const root = await makeRoot();
		const first = await openStore(root);
		await first.createRoom({
			commandId: "budget-room",
			roomId: "budget-room",
			title: "Budget",
			createdBy: "owner",
			members: [{ agentId: "agent-a" }, { agentId: "agent-b" }],
			now: 1,
		});
		await first.createRun({
			commandId: "budget-run",
			runId: "budget-run",
			roomId: "budget-room",
			objective: "Stay bounded",
			createdBy: "owner",
			budgets: { maxConcurrency: 1, maxTokens: 100, maxCostUsd: 1, maxDurationMs: 1_000, maxAttempts: 3 },
			now: 2,
		});
		await first.addTasks({
			commandId: "budget-tasks",
			runId: "budget-run",
			tasks: [
				{ id: "budget-a", title: "A", instructions: "A", assignedAgentId: "agent-a" },
				{ id: "budget-b", title: "B", instructions: "B", assignedAgentId: "agent-b" },
			],
			now: 3,
		});
		await first.startRun({ commandId: "budget-start", runId: "budget-run", now: 4 });
		const claim = await first.claimReadyTask({
			commandId: "budget-claim-a",
			runId: "budget-run",
			agentId: "agent-a",
			workerId: "worker-a",
			leaseDurationMs: 100,
			now: 5,
		});
		assert.ok(claim.value);
		await first.close();

		const reopened = await openStore(root);
		assert.deepEqual((await reopened.getRun("budget-run"))?.budgets, {
			maxConcurrency: 1,
			maxTokens: 100,
			maxCostUsd: 1,
			maxDurationMs: 1_000,
			maxAttempts: 3,
		});
		assert.equal((await reopened.getRun("budget-run"))?.usage.activeAttempts, 1);
		await assert.rejects(
			() =>
				reopened.claimReadyTask({
					commandId: "budget-claim-b-blocked",
					runId: "budget-run",
					agentId: "agent-b",
					workerId: "worker-b",
					leaseDurationMs: 100,
					now: 6,
				}),
			hasCode("BUDGET_EXHAUSTED"),
		);
		await reopened.close();
	});

	it("persists public room threads and their projections across restart", async () => {
		const root = await makeRoot();
		const first = await openStore(root);
		await first.createRoom({
			commandId: "messages.room",
			roomId: "messages-room",
			title: "Messages",
			createdBy: "owner",
			members: [{ agentId: "lead", role: "coordinator" }, { agentId: "reviewer" }],
			now: 1,
		});
		const rootMessage = (await first.postMessage({
			commandId: "messages.root",
			messageId: "root-message",
			roomId: "messages-room",
			authorId: "owner",
			authorKind: "owner",
			source: "chat",
			content: "Review the plan with @reviewer",
			mentions: ["reviewer"],
			attachments: [{ name: "plan.md", uri: "workspace://plan.md" }],
			now: 2,
		})).value;
		await first.postMessage({
			commandId: "messages.reply",
			messageId: "reply-message",
			roomId: "messages-room",
			authorId: "lead",
			authorKind: "coordinator",
			source: "chat",
			content: "The review is queued.",
			replyToMessageId: rootMessage.id,
			now: 3,
		});
		await first.reactMessage({
			commandId: "messages.react",
			messageId: rootMessage.id,
			actorId: "owner",
			actorKind: "owner",
			key: "acknowledged",
			present: true,
			now: 4,
		});
		await first.pinMessage({
			commandId: "messages.pin",
			messageId: rootMessage.id,
			actorId: "owner",
			actorKind: "owner",
			pinned: true,
			now: 5,
		});
		await first.close();

		const reopened = await openStore(root);
		const messages = await reopened.listMessages({ roomId: "messages-room" });
		assert.deepEqual(messages.map((message) => message.id), ["root-message", "reply-message"]);
		assert.equal(messages[1]?.threadRootMessageId, "root-message");
		assert.deepEqual(messages[0]?.reactions, [{ key: "acknowledged", actorIds: ["owner"] }]);
		assert.equal(messages[0]?.pinnedBy, "owner");
		assert.equal((await reopened.searchMessages({ roomId: "messages-room", query: "review" })).length, 2);
		assert.deepEqual(await reopened.getRoomMetrics("messages-room"), {
			messageCount: 2,
			threadCount: 1,
			mentionCount: 1,
			pinnedMessageCount: 1,
			activeRuns: 0,
			pendingTasks: 0,
			runningTasks: 0,
			succeededTasks: 0,
			failedTasks: 0,
			pendingApprovals: 0,
			openHandoffs: 0,
			tokens: 0,
			costUsd: 0,
			costComplete: true,
		});
		await reopened.close();
	});

	it("linearizes semantic claims made by separate store instances", async () => {
		const root = await makeRoot();
		const left = await openStore(root);
		await left.createRoom({
			commandId: "concurrent-room",
			roomId: "concurrent-room",
			title: "Concurrent room",
			createdBy: "owner",
			now: 1,
		});
		await left.createRun({
			commandId: "concurrent-run",
			runId: "concurrent-run",
			roomId: "concurrent-room",
			objective: "Claim once",
			createdBy: "owner",
			now: 2,
		});
		await left.addTasks({
			commandId: "concurrent-task",
			runId: "concurrent-run",
			tasks: [{ id: "only-task", title: "Only", instructions: "Claim only once" }],
			now: 3,
		});
		await left.startRun({ commandId: "concurrent-start", runId: "concurrent-run", now: 4 });
		const right = await openStore(root);

		const claims = await Promise.all([
			left.claimReadyTask({
				commandId: "concurrent-claim-left",
				runId: "concurrent-run",
				workerId: "left",
				leaseDurationMs: 100,
				now: 5,
			}),
			right.claimReadyTask({
				commandId: "concurrent-claim-right",
				runId: "concurrent-run",
				workerId: "right",
				leaseDurationMs: 100,
				now: 5,
			}),
		]);
		assert.equal(claims.filter((result) => result.value !== undefined).length, 1);
		assert.equal((await left.listAttempts("only-task")).length, 1);
		assert.equal((await right.getRun("concurrent-run"))?.usage.activeAttempts, 1);
		await left.close();
		await right.close();
	});

	it("is initialized and closed by LocalBrigadeStore", async () => {
		const root = await makeRoot();
		const facade = new LocalBrigadeStore({ stateDir: root });
		await facade.init();
		await facade.collaboration.createRoom({
			commandId: "facade-room",
			roomId: "facade-room",
			title: "Facade room",
			createdBy: "owner",
			now: 1,
		});
		await facade.close();

		const reopened = new LocalBrigadeStore({ stateDir: root });
		await reopened.init();
		assert.equal((await reopened.collaboration.getRoom("facade-room"))?.title, "Facade room");
		await reopened.close();
	});
});
