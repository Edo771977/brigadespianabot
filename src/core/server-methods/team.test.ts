import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryCollaborationStore } from "../../collaboration/memory-store.js";
import { CollaborationConflictError } from "../../collaboration/types.js";
import { TEAM_REQUEST_METHODS } from "../../protocol/team.js";
import {
	createTeamMethodHandlers,
	mapTeamMethodError,
	TeamMethodError,
} from "./team.js";

const allowConfiguredAgent = (): boolean => true;

describe("createTeamMethodHandlers", () => {
	it("implements every advertised Team Mode RPC exactly once", () => {
		const handlers = createTeamMethodHandlers({ store: new InMemoryCollaborationStore(), validateAgentId: allowConfiguredAgent });
		assert.deepEqual(Object.keys(handlers).sort(), [...TEAM_REQUEST_METHODS].sort());
	});

	it("generates an idempotency key, attributes the owner, and publishes committed events", async () => {
		const store = new InMemoryCollaborationStore();
		const published: string[][] = [];
		const handlers = createTeamMethodHandlers({
			store,
			validateAgentId: allowConfiguredAgent,
			actorId: "operator",
			commandIdFactory: () => "generated-1",
			publishEvents: (events) => {
				published.push(events.map((event) => event.eventId));
			},
		});

		const result = await handlers["team.rooms.create"]({
			roomId: "room-1",
			title: "  Research room  ",
			members: [{ agentId: "analyst", role: "research" }],
		});

		assert.equal(result.value.createdBy, "operator");
		assert.equal(result.value.title, "Research room");
		assert.equal(result.value.members[0]?.agentId, "analyst");
		assert.ok(Number.isFinite(result.value.members[0]?.joinedAt));
		assert.equal(result.events[0]?.commandId, "team:team.rooms.create:generated-1");
		assert.deepEqual(published, [[result.events[0]!.eventId]]);
	});

	it("does not republish or re-kick an idempotent replay", async () => {
		const store = new InMemoryCollaborationStore();
		let publishCount = 0;
		let kickCount = 0;
		const handlers = createTeamMethodHandlers({
			store,
			validateAgentId: allowConfiguredAgent,
			publishEvents: () => {
				publishCount += 1;
			},
			kickCoordinator: () => {
				kickCount += 1;
			},
		});
		const firstRoom = await handlers["team.rooms.create"]({
			commandId: "room-command",
			roomId: "room-1",
			title: "Room",
			members: [{ agentId: "analyst" }],
		});
		const replayedRoom = await handlers["team.rooms.create"]({
			commandId: "room-command",
			roomId: "room-1",
			title: "Room",
			members: [{ agentId: "analyst" }],
		});
		assert.equal(replayedRoom.replayed, true);
		assert.equal(
			replayedRoom.value.members[0]?.joinedAt,
			firstRoom.value.members[0]?.joinedAt,
			"server-omitted membership timestamps remain replay-safe",
		);
		await handlers["team.runs.create"]({
			commandId: "run-command",
			runId: "run-1",
			roomId: "room-1",
			objective: "Ship it",
		});
		await handlers["team.tasks.add"]({
			commandId: "tasks-command",
			runId: "run-1",
			tasks: [{ id: "task-1", title: "Ship", instructions: "Ship it", assignedAgentId: "analyst" }],
		});
		const kicksBeforeStart = kickCount;
		const first = await handlers["team.runs.start"]({ commandId: "start-command", runId: "run-1" });
		const replay = await handlers["team.runs.start"]({ commandId: "start-command", runId: "run-1" });

		assert.equal(first.replayed, false);
		assert.equal(replay.replayed, true);
		assert.equal(publishCount, 4, "room create, run create, task add, and first run start publish");
		assert.equal(kickCount, kicksBeforeStart + 1, "only the first run start wakes the coordinator");
	});

	it("atomically delegates a complete reviewer DAG and never leaves a partial run", async () => {
		const store = new InMemoryCollaborationStore();
		let publishCount = 0;
		let kickCount = 0;
		const handlers = createTeamMethodHandlers({
			store,
			validateAgentId: (id) => id === "maker" || id === "reviewer",
			publishEvents: () => { publishCount += 1; },
			kickCoordinator: () => { kickCount += 1; },
		});
		await handlers["team.rooms.create"]({
			commandId: "room",
			roomId: "room",
			title: "Room",
			members: [{ agentId: "maker" }, { agentId: "reviewer" }],
		});
		publishCount = 0;
		const input = {
			commandId: "delegate",
			runId: "run",
			roomId: "room",
			objective: "Ship it",
			tasks: [
				{ id: "make", title: "Make", instructions: "Build", assignedAgentId: "maker" },
				{ id: "review", title: "Review", instructions: "Verify", assignedAgentId: "reviewer", dependencies: ["make"], resultGate: { kind: "review_verdict" as const, policy: "independent-v1" as const } },
			],
		};
		const first = await handlers["team.runs.delegate"](input);
		const replay = await handlers["team.runs.delegate"](input);
		assert.equal(first.value.run.status, "running");
		assert.deepEqual(first.value.tasks.find((task) => task.id === "review")?.resultGate, { kind: "review_verdict", policy: "independent-v1" });
		assert.equal(replay.replayed, true);
		assert.equal(publishCount, 1, "all launch events publish as one committed result");
		assert.equal(kickCount, 1, "only the initial commit wakes workers");

		await handlers["team.rooms.create"]({ commandId: "bad-room", roomId: "bad-room", title: "Bad", members: [{ agentId: "maker" }] });
		const before = await store.readSnapshot();
		await assert.rejects(
			handlers["team.runs.delegate"]({
				commandId: "bad-delegate",
				runId: "bad-run",
				roomId: "bad-room",
				objective: "Invalid",
				tasks: [{ id: "bad-task", title: "Bad", instructions: "Bad", assignedAgentId: "maker", dependencies: ["missing"] }],
			}),
			(error: unknown) => error instanceof TeamMethodError && error.code === "TEAM_CONFLICT",
		);
		assert.deepEqual(await store.readSnapshot(), before);
	});

	it("acknowledges a committed delegation without waiting for coordinator execution", async () => {
		const store = new InMemoryCollaborationStore();
		let kickCount = 0;
		const neverSettles = new Promise<void>(() => undefined);
		const handlers = createTeamMethodHandlers({
			store,
			validateAgentId: allowConfiguredAgent,
			kickCoordinator: () => {
				kickCount += 1;
				return neverSettles;
			},
		});
		await handlers["team.rooms.create"]({
			commandId: "room-command",
			roomId: "room-1",
			title: "Room",
			members: [{ agentId: "maker" }],
		});

		const result = await Promise.race([
			handlers["team.runs.delegate"]({
				commandId: "delegate-command",
				runId: "run-1",
				roomId: "room-1",
				objective: "Ship it",
				tasks: [{ id: "make", title: "Make", instructions: "Build", assignedAgentId: "maker" }],
			}),
			new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 1_000)),
		]);

		assert.notEqual(result, "timed-out");
		assert.equal(kickCount, 1);
		assert.equal((result as Awaited<ReturnType<typeof handlers["team.runs.delegate"]>>).value.run.status, "running");
	});

	it("does not let a stalled or rejected live publisher break a committed RPC", async () => {
		const store = new InMemoryCollaborationStore();
		let publishCalls = 0;
		const handlers = createTeamMethodHandlers({
			store,
			validateAgentId: allowConfiguredAgent,
			publishEvents: () => {
				publishCalls += 1;
				if (publishCalls === 1) return new Promise<void>(() => undefined);
				return Promise.reject(new Error("live lane unavailable"));
			},
		});
		const first = await Promise.race([
			handlers["team.rooms.create"]({ commandId: "room-one", roomId: "room-one", title: "One", members: [] }),
			new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 1_000)),
		]);
		assert.notEqual(first, "timed-out");
		const second = await handlers["team.rooms.create"]({ commandId: "room-two", roomId: "room-two", title: "Two", members: [] });
		assert.equal(second.value.id, "room-two");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(publishCalls, 2);
	});

	it("strictly validates top-level and nested request fields", async () => {
		const handlers = createTeamMethodHandlers({ store: new InMemoryCollaborationStore(), validateAgentId: allowConfiguredAgent });

		await assert.rejects(
			handlers["team.rooms.create"]({ title: "Room", surprise: true } as never),
			(error: unknown) =>
				error instanceof TeamMethodError &&
				error.code === "INVALID_REQUEST" &&
				/unknown field: surprise/.test(error.message),
		);
		await assert.rejects(
			handlers["team.tasks.add"]({
				runId: "run-1",
				tasks: [
					{
						id: "task-1",
						title: "Task",
						instructions: "Do it",
						dependencies: ["task-1"],
					},
				],
			}),
			(error: unknown) =>
				error instanceof TeamMethodError &&
				error.code === "INVALID_REQUEST" &&
				/cannot depend on itself/.test(error.message),
		);
		await assert.rejects(
			handlers["team.resume"]({ roomId: "room-1", limit: 501 }),
			(error: unknown) =>
				error instanceof TeamMethodError && error.code === "INVALID_REQUEST",
		);
		for (const resultGate of [
			{ kind: "made_up" },
			{ kind: "review_verdict", surprise: true },
			{ kind: "review_verdict", policy: "made_up" },
		]) {
			await assert.rejects(
				handlers["team.tasks.add"]({
					runId: "run-1",
					tasks: [{ id: "gated", title: "Gate", instructions: "Verify", resultGate }],
				} as never),
				(error: unknown) => error instanceof TeamMethodError && error.code === "INVALID_REQUEST",
			);
		}
		for (const input of [
			{ runId: "run-1", taskId: "task-1", limit: 32_001 },
			{ runId: "run-1", taskId: "task-1", offset: -1 },
			{ runId: "run-1", taskId: "task-1", surprise: true },
		]) {
			await assert.rejects(
				handlers["team.tasks.result"](input as never),
				(error: unknown) => error instanceof TeamMethodError && error.code === "INVALID_REQUEST",
			);
		}
	});

	it("pages an exact long task result and binds the task to the requested run", async () => {
		let now = 1;
		const store = new InMemoryCollaborationStore();
		const handlers = createTeamMethodHandlers({ store, validateAgentId: allowConfiguredAgent });
		await store.createRoom({ commandId: "result.room", roomId: "room", title: "Room", createdBy: "owner", now: now++ });
		await store.createRun({ commandId: "result.run", runId: "run", roomId: "room", objective: "Work", createdBy: "owner", now: now++ });
		await store.addTasks({ commandId: "result.task", runId: "run", tasks: [{ id: "task", title: "Task", instructions: "Work" }], now: now++ });
		await store.startRun({ commandId: "result.start", runId: "run", now: now++ });
		const attempt = (await store.claimReadyTask({ commandId: "result.claim", runId: "run", taskId: "task", workerId: "runtime", leaseDurationMs: 1_000, now: now++ })).value!;
		const fullResult = `head-${"z".repeat(40_000)}-🦁-tail`;
		await store.completeAttempt({ commandId: "result.complete", attemptId: attempt.id, leaseToken: attempt.lease.token, fence: attempt.lease.fence, result: fullResult, now: now++ });

		const first = await handlers["team.tasks.result"]({ runId: "run", taskId: "task", limit: 32_000 });
		assert.equal(first.complete, false);
		assert.equal(first.nextOffset, 32_000);
		const second = await handlers["team.tasks.result"]({ runId: "run", taskId: "task", offset: first.nextOffset, limit: 32_000 });
		assert.equal(first.content + second.content, fullResult);
		assert.equal(first.sha256, second.sha256);

		await store.createRun({ commandId: "result.other-run", runId: "other-run", roomId: "room", objective: "Other", createdBy: "owner", now: now++ });
		await assert.rejects(
			handlers["team.tasks.result"]({ runId: "other-run", taskId: "task" }),
			(error: unknown) => error instanceof TeamMethodError && error.code === "TEAM_NOT_FOUND",
		);
	});

	it("rejects unknown room members and non-member task assignees before mutation", async () => {
		const store = new InMemoryCollaborationStore();
		const configured = new Set(["alice", "bob"]);
		const handlers = createTeamMethodHandlers({
			store,
			validateAgentId: (agentId) => configured.has(agentId),
		});

		await assert.rejects(
			handlers["team.rooms.create"]({
				commandId: "unknown-room-member",
				roomId: "invalid-room",
				title: "Invalid",
				members: [{ agentId: "ghost" }],
			}),
			(error: unknown) =>
				error instanceof TeamMethodError &&
				error.code === "INVALID_REQUEST" &&
				error.details?.agentId === "ghost",
		);
		assert.equal(await store.getRoom("invalid-room"), undefined);

		await handlers["team.rooms.create"]({
			commandId: "valid-room",
			roomId: "room",
			title: "Room",
			members: [{ agentId: "alice" }],
		});
		await handlers["team.runs.create"]({
			commandId: "run",
			runId: "run",
			roomId: "room",
			objective: "Work",
		});
		await assert.rejects(
			handlers["team.tasks.add"]({
				commandId: "configured-non-member",
				runId: "run",
				tasks: [{ id: "task", title: "Task", instructions: "Work", assignedAgentId: "bob" }],
			}),
			(error: unknown) =>
				error instanceof TeamMethodError &&
				error.code === "INVALID_REQUEST" &&
				error.details?.agentId === "bob" &&
				error.details?.roomId === "room",
		);
		assert.deepEqual(await store.listTasks("run"), []);
		const assigned = await handlers["team.tasks.add"]({
			commandId: "default-to-coordinator",
			runId: "run",
			tasks: [{ id: "coordinator-task", title: "Task", instructions: "Work" }],
		});
		assert.equal(assigned.value[0]?.assignedAgentId, "alice");

		await assert.rejects(
			handlers["team.rooms.update"]({
				commandId: "unknown-update-member",
				roomId: "room",
				members: [{ agentId: "ghost" }],
			}),
			(error: unknown) =>
				error instanceof TeamMethodError && error.details?.agentId === "ghost",
		);
		assert.deepEqual((await store.getRoom("room"))?.members.map((member) => member.agentId), ["alice"]);
	});

	it("keeps an explicit room coordinator configured and in the room", async () => {
		const store = new InMemoryCollaborationStore();
		const handlers = createTeamMethodHandlers({
			store,
			validateAgentId: (agentId) => ["main", "reviewer"].includes(agentId),
		});
		await assert.rejects(
			handlers["team.rooms.create"]({
				commandId: "missing-coordinator-member",
				roomId: "invalid-room",
				title: "Invalid",
				members: [{ agentId: "reviewer" }],
				metadata: { coordinatorAgentId: "main" },
			}),
			(error: unknown) =>
				error instanceof TeamMethodError
				&& error.code === "INVALID_REQUEST"
				&& /must reference an agent/.test(error.message),
		);
		await handlers["team.rooms.create"]({
			commandId: "valid-room",
			roomId: "room",
			title: "Room",
			members: [{ agentId: "main", role: "coordinator" }, { agentId: "reviewer" }],
			metadata: { coordinatorAgentId: "main" },
		});
		await assert.rejects(
			handlers["team.rooms.update"]({
				commandId: "remove-coordinator",
				roomId: "room",
				members: [{ agentId: "reviewer" }],
			}),
			(error: unknown) =>
				error instanceof TeamMethodError
				&& error.code === "INVALID_REQUEST"
				&& /must reference an agent/.test(error.message),
		);
		assert.deepEqual(
			(await store.getRoom("room"))?.members.map((member) => member.agentId),
			["main", "reviewer"],
		);
	});

	it("returns one atomic resume snapshot plus a bounded room-sequence replay", async () => {
		const source = new InMemoryCollaborationStore();
		const setup = createTeamMethodHandlers({ store: source, validateAgentId: allowConfiguredAgent });
		await setup["team.rooms.create"]({ commandId: "c1", roomId: "room-1", title: "Room" });
		await setup["team.runs.create"]({
			commandId: "c2",
			runId: "run-1",
			roomId: "room-1",
			objective: "Objective",
		});
		await setup["team.tasks.add"]({
			commandId: "c3",
			runId: "run-1",
			tasks: [{ id: "task-1", title: "Task", instructions: "Do the task" }],
		});
		await setup["team.runs.start"]({ commandId: "c4", runId: "run-1" });

		const retained = await source.readSnapshot();
		retained.events = retained.events.filter((event) => event.roomSeq >= 3);
		const handlers = createTeamMethodHandlers({
			store: new InMemoryCollaborationStore(retained),
			validateAgentId: allowConfiguredAgent,
			listPendingExecApprovals: (roomId) => roomId === "room-1" ? [{
				id: "exec-approval",
				roomId,
				attemptId: "attempt-1",
				agentId: "worker",
				sessionId: "agent:worker:team:room:attempt:id",
				command: "npm test",
				toolName: "bash",
				timeoutMs: 300_000,
				decisions: ["allow-once", "deny"],
				createdAt: 6,
				revision: 7,
			}] : [],
			getExecApprovalRevision: (roomId) => roomId === "room-1" ? 7 : 0,
		});
		const resumed = await handlers["team.resume"]({
			roomId: "room-1",
			runId: "run-1",
			afterRoomSeq: 0,
			limit: 2,
		});

		assert.equal(resumed.run?.run.id, "run-1");
		assert.deepEqual(resumed.pendingExecApprovals.map((item) => item.id), ["exec-approval"]);
		assert.equal(resumed.execApprovalRevision, 7);
		assert.deepEqual(resumed.run?.tasks.map((task) => task.id), ["task-1"]);
		assert.deepEqual(resumed.events.map((event) => event.roomSeq), [3, 4]);
		assert.equal(resumed.headRoomSeq, 5);
		assert.equal(resumed.replayComplete, false, "retention removed room sequences 1 and 2");
		assert.equal(resumed.hasMore, true);
		assert.equal(resumed.nextAfterRoomSeq, 4);
	});

	it("hydrates every room's active work and pending exec approvals in one list", async () => {
		const store = new InMemoryCollaborationStore();
		const setup = createTeamMethodHandlers({ store, validateAgentId: allowConfiguredAgent });
		await setup["team.rooms.create"]({ commandId: "room-a", roomId: "room-a", title: "A" });
		await setup["team.rooms.create"]({ commandId: "room-b", roomId: "room-b", title: "B" });
		await setup["team.runs.create"]({
			commandId: "run-b",
			runId: "run-b",
			roomId: "room-b",
			objective: "Needs a decision",
		});
		const handlers = createTeamMethodHandlers({
			store,
			validateAgentId: allowConfiguredAgent,
			listPendingExecApprovals: (roomId) => roomId === "room-b" ? [{
				id: "exec-b",
				roomId,
				attemptId: "attempt-b",
				agentId: "worker",
				sessionId: "agent:worker:team:room-b:attempt:attempt-b",
				command: "npm test",
				toolName: "bash",
				timeoutMs: 300_000,
				decisions: ["allow-once", "deny"],
				createdAt: 4,
				revision: 3,
			}] : [],
			getExecApprovalRevision: (roomId) => roomId === "room-b" ? 3 : 0,
		});

		const listed = await handlers["team.rooms.list"]({});
		const roomA = listed.summaries.find((summary) => summary.roomId === "room-a");
		const roomB = listed.summaries.find((summary) => summary.roomId === "room-b");
		assert.equal(roomA?.run, undefined);
		assert.equal(roomB?.run?.id, "run-b");
		assert.equal(roomB?.run?.objective, "Needs a decision");
		assert.deepEqual(roomB?.pendingExecApprovals.map((item) => item.id), ["exec-b"]);
		assert.equal(roomB?.execApprovalRevision, 3);
		assert.ok((roomB?.headRoomSeq ?? 0) > 0);
	});

	it("redacts lease credentials from get and resume run snapshots", async () => {
		const store = new InMemoryCollaborationStore();
		const handlers = createTeamMethodHandlers({ store, validateAgentId: allowConfiguredAgent });
		await handlers["team.rooms.create"]({
			commandId: "room",
			roomId: "room-1",
			title: "Room",
			members: [{ agentId: "worker" }],
		});
		await handlers["team.runs.create"]({
			commandId: "run",
			runId: "run-1",
			roomId: "room-1",
			objective: "Objective",
		});
		await handlers["team.tasks.add"]({
			commandId: "task",
			runId: "run-1",
			tasks: [{ id: "task-1", title: "Task", instructions: "Do it", assignedAgentId: "worker" }],
		});
		await handlers["team.runs.start"]({ commandId: "start", runId: "run-1" });
		const claimed = (await store.claimReadyTask({
			commandId: "claim",
			runId: "run-1",
			workerId: "gateway:private-worker",
			leaseDurationMs: 10_000,
		})).value!;

		const direct = await handlers["team.runs.get"]({ runId: "run-1" });
		const resumed = await handlers["team.resume"]({ roomId: "room-1", runId: "run-1" });
		for (const snapshot of [direct, resumed.run!]) {
			assert.equal(snapshot.attempts[0]?.leaseExpiresAt, claimed.lease.expiresAt);
			assert.equal("lease" in snapshot.attempts[0]!, false);
			assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(claimed.lease.token));
		}
	});

	it("filters event pages by run without changing the room head cursor", async () => {
		const store = new InMemoryCollaborationStore();
		const setup = createTeamMethodHandlers({ store, validateAgentId: allowConfiguredAgent });
		await setup["team.rooms.create"]({ commandId: "room", roomId: "room-1", title: "Room" });
		await setup["team.runs.create"]({
			commandId: "run-1-command",
			runId: "run-1",
			roomId: "room-1",
			objective: "One",
		});
		await setup["team.runs.cancel"]({
			commandId: "run-1-cancel",
			runId: "run-1",
			reason: "make this a historical run",
		});
		await setup["team.runs.create"]({
			commandId: "run-2-command",
			runId: "run-2",
			roomId: "room-1",
			objective: "Two",
		});
		await setup["team.rooms.create"]({ commandId: "other-room", roomId: "room-2", title: "Other" });

		const reads: string[] = [];
		const boundedStore = new Proxy(store, {
			get(target, property, receiver) {
				if (property === "readSnapshot") {
					return () => {
						throw new Error("team.events.list must not hydrate the full collaboration snapshot");
					};
				}
				const value = Reflect.get(target, property, receiver);
				if (typeof value !== "function") return value;
				return (...args: unknown[]) => {
					if (property === "getRoom" || property === "getRun" || property === "readEvents") {
						reads.push(String(property));
					}
					return Reflect.apply(value, target, args);
				};
			},
		});
		const handlers = createTeamMethodHandlers({ store: boundedStore, validateAgentId: allowConfiguredAgent });

		const first = await handlers["team.events.list"]({ roomId: "room-1", runId: "run-1", limit: 1 });
		assert.deepEqual(first.events.map((event) => event.roomSeq), [2]);
		assert.equal(first.headRoomSeq, 4, "room head includes the other run's later event");
		assert.equal(first.hasMore, true);
		assert.equal(first.nextAfterRoomSeq, 2);

		const second = await handlers["team.events.list"]({
			roomId: "room-1",
			runId: "run-1",
			afterRoomSeq: first.nextAfterRoomSeq,
			limit: 1,
		});
		assert.deepEqual(second.events.map((event) => event.roomSeq), [3]);
		assert.equal(second.headRoomSeq, 4);
		assert.equal(second.hasMore, false);
		assert.equal(second.nextAfterRoomSeq, undefined);
		assert.deepEqual(reads.filter((operation) => operation === "getRoom"), ["getRoom", "getRoom"]);
		assert.deepEqual(reads.filter((operation) => operation === "getRun"), ["getRun", "getRun"]);
		assert.ok(reads.includes("readEvents"));

		const readsBeforeRejectedScope = reads.length;
		await assert.rejects(
			handlers["team.events.list"]({ roomId: "room-2", runId: "run-1" }),
			(error: unknown) => error instanceof TeamMethodError && error.code === "TEAM_NOT_FOUND",
		);
		assert.equal(reads.length, readsBeforeRejectedScope + 2, "room/run validation rejects before reading events");
		assert.deepEqual(reads.slice(-2), ["getRoom", "getRun"]);
	});

	it("keeps retained event paging and a stale future cursor exact without a snapshot read", async () => {
		const source = new InMemoryCollaborationStore();
		const setup = createTeamMethodHandlers({ store: source, validateAgentId: allowConfiguredAgent });
		await setup["team.rooms.create"]({ commandId: "c1", roomId: "room-1", title: "Room" });
		await setup["team.runs.create"]({
			commandId: "c2",
			runId: "run-1",
			roomId: "room-1",
			objective: "Objective",
		});
		await setup["team.tasks.add"]({
			commandId: "c3",
			runId: "run-1",
			tasks: [{ id: "task-1", title: "Task", instructions: "Do the task" }],
		});
		await setup["team.runs.start"]({ commandId: "c4", runId: "run-1" });

		const retained = await source.readSnapshot();
		retained.events = retained.events.filter((event) => event.roomSeq >= 3);
		const retainedStore = new InMemoryCollaborationStore(retained);
		const boundedStore = new Proxy(retainedStore, {
			get(target, property, receiver) {
				if (property === "readSnapshot") {
					return () => {
						throw new Error("team.events.list must not hydrate the full collaboration snapshot");
					};
				}
				const value = Reflect.get(target, property, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const handlers = createTeamMethodHandlers({ store: boundedStore, validateAgentId: allowConfiguredAgent });

		const first = await handlers["team.events.list"]({ roomId: "room-1", afterRoomSeq: 0, limit: 2 });
		assert.deepEqual(first.events.map((event) => event.roomSeq), [3, 4]);
		assert.equal(first.headRoomSeq, 5);
		assert.equal(first.hasMore, true);
		assert.equal(first.nextAfterRoomSeq, 4);

		const caughtUp = await handlers["team.events.list"]({ roomId: "room-1", afterRoomSeq: 5 });
		assert.deepEqual(caughtUp.events, []);
		assert.equal(caughtUp.headRoomSeq, 5);
		assert.equal(caughtUp.hasMore, false);

		const future = await handlers["team.events.list"]({ roomId: "room-1", afterRoomSeq: 99 });
		assert.deepEqual(future.events, []);
		assert.equal(future.headRoomSeq, 5);
		assert.equal(future.hasMore, false);
	});

	it("round-trips durable room threads, reactions, pins, search, metrics, and resume", async () => {
		const store = new InMemoryCollaborationStore();
		const published: string[] = [];
		const handlers = createTeamMethodHandlers({
			store,
			validateAgentId: allowConfiguredAgent,
			actorId: "operator",
			publishEvents: (events) => {
				published.push(...events.map((event) => event.type));
			},
		});
		await handlers["team.rooms.create"]({
			commandId: "room",
			roomId: "room-1",
			title: "Product room",
			members: [{ agentId: "lead", role: "coordinator" }, { agentId: "reviewer" }],
		});

		const root = await handlers["team.messages.post"]({
			commandId: "post-root",
			messageId: "message-root",
			roomId: "room-1",
			content: "Please review the release plan with @lead",
			mentions: ["lead"],
			attachments: [{ name: "brief.md", uri: "workspace://brief.md", mimeType: "text/markdown" }],
		});
		const reply = await handlers["team.messages.post"]({
			commandId: "post-reply",
			messageId: "message-reply",
			roomId: "room-1",
			content: "Adding the verification question here.",
			replyToMessageId: root.value.id,
		});
		await handlers["team.messages.react"]({
			commandId: "react",
			messageId: root.value.id,
			key: "acknowledged",
			present: true,
		});
		await handlers["team.messages.pin"]({
			commandId: "pin",
			messageId: root.value.id,
			pinned: true,
		});

		assert.equal(reply.value.threadRootMessageId, root.value.id);
		assert.deepEqual((await handlers["team.messages.list"]({ roomId: "room-1" })).messages.map((message) => message.id).sort(), [
			"message-reply",
			"message-root",
		]);
		assert.deepEqual((await handlers["team.messages.list"]({
			roomId: "room-1",
			threadRootMessageId: root.value.id,
		})).messages.map((message) => message.id), ["message-reply"]);
		const sharedTimestamp = Date.now() + 1_000;
		for (const messageId of ["cursor-a", "cursor-b", "cursor-c"]) {
			await store.postMessage({
				commandId: `cursor:${messageId}`,
				messageId,
				roomId: "room-1",
				authorId: "operator",
				authorKind: "owner",
				content: messageId,
				now: sharedTimestamp,
			});
		}
		assert.deepEqual((await handlers["team.messages.list"]({
			roomId: "room-1",
			afterMessageId: "cursor-a",
			limit: 1,
		})).messages.map((message) => message.id), ["cursor-b"]);
		assert.deepEqual((await handlers["team.messages.list"]({
			roomId: "room-1",
			beforeMessageId: "cursor-c",
			limit: 1,
		})).messages.map((message) => message.id), ["cursor-b"]);
		const searched = await handlers["team.messages.search"]({
			roomId: "room-1",
			query: "release plan",
			mentionAgentId: "lead",
			pinnedOnly: true,
		});
		assert.equal(searched.messages[0]?.id, root.value.id);
		assert.deepEqual(searched.messages[0]?.reactions, [{ key: "acknowledged", actorIds: ["operator"] }]);
		assert.equal(searched.messages[0]?.pinnedBy, "operator");

		const metrics = await handlers["team.rooms.metrics"]({ roomId: "room-1" });
		assert.equal(metrics.messageCount, 5);
		assert.equal(metrics.threadCount, 1);
		assert.equal(metrics.mentionCount, 1);
		assert.equal(metrics.pinnedMessageCount, 1);

		const resumed = await handlers["team.resume"]({ roomId: "room-1", afterRoomSeq: 0 });
		assert.deepEqual(resumed.messages.map((message) => message.id).sort(), [
			"cursor-a",
			"cursor-b",
			"cursor-c",
			"message-reply",
			"message-root",
		]);
		assert.deepEqual(resumed.metrics, metrics);
		assert.ok(published.includes("message.posted"));
		assert.ok(published.includes("message.reacted"));
		assert.ok(published.includes("message.pinned"));
	});

	it("lets the authenticated operator resolve a handoff for its durable target agent", async () => {
		const store = new InMemoryCollaborationStore();
		const now = Date.now();
		const handlers = createTeamMethodHandlers({ store, validateAgentId: allowConfiguredAgent, actorId: "operator" });
		await store.createRoom({
			commandId: "room",
			roomId: "room-1",
			title: "Room",
			createdBy: "operator",
			members: [{ agentId: "source" }, { agentId: "target" }],
			now,
		});
		await store.createRun({
			commandId: "run",
			runId: "run-1",
			roomId: "room-1",
			objective: "Objective",
			createdBy: "operator",
			now: now + 1,
		});
		await store.addTasks({
			commandId: "tasks",
			runId: "run-1",
			tasks: [{ id: "task-1", title: "Task", instructions: "Do it", assignedAgentId: "source" }],
			now: now + 2,
		});
		await store.startRun({ commandId: "start", runId: "run-1", now: now + 3 });
		const attempt = (await store.claimReadyTask({
			commandId: "claim",
			runId: "run-1",
			workerId: "worker",
			leaseDurationMs: 10_000,
			now: now + 4,
		})).value!;
		const handoff = (await store.offerHandoff({
			commandId: "offer",
			handoffId: "handoff-1",
			attemptId: attempt.id,
			leaseToken: attempt.lease.token,
			fence: attempt.lease.fence,
			fromAgentId: "source",
			toAgentId: "target",
			now: now + 5,
		})).value;

		const response = await handlers["team.handoffs.respond"]({
			commandId: "respond",
			handoffId: handoff.id,
			decision: "accept",
		});

		assert.equal(response.value.status, "accepted");
		assert.equal((await store.getTask("task-1"))?.assignedAgentId, "target");
	});

	it("maps domain failures to stable Team Mode wire errors", async () => {
		const handlers = createTeamMethodHandlers({ store: new InMemoryCollaborationStore(), validateAgentId: allowConfiguredAgent });
		await assert.rejects(
			handlers["team.runs.get"]({ runId: "missing" }),
			(error: unknown) =>
				error instanceof TeamMethodError &&
				error.code === "TEAM_NOT_FOUND" &&
				error.details?.kind === "run",
		);

		const mapped = mapTeamMethodError(
			new CollaborationConflictError("FENCE_MISMATCH", "stale attempt"),
		);
		assert.ok(mapped instanceof TeamMethodError);
		assert.equal(mapped.code, "TEAM_CONFLICT");
		assert.equal(mapped.retryable, false);
		assert.deepEqual(mapped.details, { domainCode: "FENCE_MISMATCH" });
	});
});
