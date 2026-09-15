import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { InMemoryCollaborationStore } from "../../collaboration/memory-store.js";
import { buildTeamChatSessionKey } from "../../collaboration/session-key.js";
import { BrigadeToolAuthorizationError } from "./common.js";
import { makeTeamTool, type TeamToolResult } from "./team-tool.js";

function details(value: Awaited<ReturnType<ReturnType<typeof makeTeamTool>["execute"]>>): TeamToolResult {
	return value.details as TeamToolResult;
}

describe("team", () => {
	it("creates a room and run, installs an all/any/quorum DAG, starts it, and reports safe status", async () => {
		const store = new InMemoryCollaborationStore();
		let kicks = 0;
		const tool = makeTeamTool({
			agentId: "main",
			store,
			now: () => 10,
			kick: () => { kicks += 1; },
			validateAgentId: (agentId) => ["researcher", "writer"].includes(agentId),
		});
		assert.equal(tool.ownerOnly, true);

		const room = details(await tool.execute("room-call", {
			action: "create_room",
			roomId: "room",
			title: "Launch room",
			members: [{ agentId: "researcher" }, { agentId: "writer" }],
		}));
		assert.equal(room.ok, true);
		assert.equal(room.commandId, "team:create_room:room-call");
		assert.deepEqual(
			(await store.getRoom("room"))?.members.map((member) => member.agentId),
			["main", "researcher", "writer"],
		);

		const run = details(await tool.execute("run-call", {
			action: "create_run",
			runId: "run",
			roomId: "room",
			objective: "Prepare launch",
			budgets: { maxConcurrency: 3, maxAttempts: 10, maxTokens: 50_000 },
		}));
		assert.equal(run.ok, true);

		const dag = details(await tool.execute("tasks-call", {
			action: "add_tasks",
			runId: "run",
			tasks: [
				{ id: "research", title: "Research", instructions: "Collect evidence", assignedAgentId: "researcher" },
				{ id: "draft", title: "Draft", instructions: "Write draft", assignedAgentId: "writer" },
				{
					id: "review-any",
					title: "Review any",
					instructions: "Use the first successful input",
					dependencies: ["research", "draft"],
					join: { kind: "any", cancelRemaining: false },
				},
				{
					id: "publish-quorum",
					title: "Publish quorum",
					instructions: "Publish after two inputs",
					dependencies: ["research", "draft", "review-any"],
					join: { kind: "quorum", minimum: 2, cancelRemaining: true },
				},
				{
					id: "archive-all",
					title: "Archive all",
					instructions: "Archive every output",
					dependencies: ["publish-quorum"],
					join: { kind: "all" },
					resultGate: { kind: "review_verdict" },
				},
			],
		}));
		assert.equal(dag.ok, true);
		assert.equal(dag.tasks?.length, 5);
		assert.match(JSON.stringify(dag.tasks), /"resultGate":\{"kind":"review_verdict"\}/);
		assert.deepEqual((await store.getTask("archive-all"))?.resultGate, { kind: "review_verdict" });

		const started = details(await tool.execute("start-call", { action: "start_run", runId: "run" }));
		assert.equal(started.ok, true);
		assert.equal(kicks, 1);

		const statusResponse = await tool.execute("status-call", { action: "status", runId: "run" });
		const status = details(statusResponse);
		assert.equal(status.ok, true);
		assert.match(status.message, /Team run is running/);
		const rendered = JSON.stringify(statusResponse);
		assert.doesNotMatch(rendered, /leaseToken|claimToken|"token"|"fence"|"lease"/);

		const receipts = (await store.readSnapshot()).commandReceipts;
		assert.ok(receipts.some((receipt) => receipt.commandId === "team:create_room:room-call"));
	});

	it("uses stable command ids so a retried tool call is idempotent", async () => {
		const store = new InMemoryCollaborationStore();
		const tool = makeTeamTool({ agentId: "main", store, now: () => 10, kick: () => undefined });
		const input = { action: "create_room" as const, roomId: "room", title: "Idempotent room" };
		const first = details(await tool.execute("same-call", input));
		const second = details(await tool.execute("same-call", input));
		assert.equal(first.ok, true);
		assert.equal(second.ok, true);
		assert.match(second.message, /already created/i);
		assert.equal((await store.listRooms()).length, 1);
	});

	it("updates configured room membership and archives only terminal rooms", async () => {
		let now = 10;
		const store = new InMemoryCollaborationStore();
		const tool = makeTeamTool({
			agentId: "main",
			store,
			now: () => now++,
			kick: () => undefined,
			validateAgentId: (agentId) => ["main", "alice", "bob"].includes(agentId),
		});
		assert.equal(details(await tool.execute("create", {
			action: "create_room",
			roomId: "room",
			title: "Original",
			members: [{ agentId: "alice", role: "research" }],
			metadata: { purpose: "launch" },
		})).ok, true);

		const updated = details(await tool.execute("update", {
			action: "update_room",
			roomId: "room",
			title: "Launch room",
			members: [
				{ agentId: "main", role: "coordinator" },
				{ agentId: "alice", role: "research" },
				{ agentId: "bob", role: "review" },
			],
			metadata: { phase: "review" },
		}));
		assert.equal(updated.ok, true);
		assert.equal((updated.room as { title: string }).title, "Launch room");
		const room = await store.getRoom("room");
		assert.deepEqual(room?.members.map((member) => member.agentId), ["main", "alice", "bob"]);
		assert.deepEqual(room?.metadata, {
			purpose: "launch",
			coordinatorAgentId: "main",
			phase: "review",
		});

		await store.createRun({
			commandId: "active-run",
			runId: "run",
			roomId: "room",
			objective: "Active",
			createdBy: "main",
			now: now++,
		});
		const activeArchive = details(await tool.execute("archive-active", {
			action: "archive_room",
			roomId: "room",
		}));
		assert.equal(activeArchive.ok, false);
		assert.equal(activeArchive.errorCode, "ROOM_HAS_ACTIVE_RUNS");

		await store.cancelRun({ commandId: "cancel-run", runId: "run", now: now++ });
		const archived = details(await tool.execute("archive", {
			action: "archive_room",
			roomId: "room",
		}));
		assert.equal(archived.ok, true);
		assert.equal((archived.room as { status: string }).status, "archived");
	});

	it("keeps room management bound to the active Team chat", async () => {
		const store = new InMemoryCollaborationStore();
		await store.createRoom({
			commandId: "bound",
			roomId: "bound",
			title: "Bound",
			createdBy: "main",
			members: [{ agentId: "main", role: "coordinator" }],
			metadata: { coordinatorAgentId: "main" },
			now: 1,
		});
		await store.createRoom({
			commandId: "other",
			roomId: "other",
			title: "Other",
			createdBy: "main",
			members: [{ agentId: "main", role: "coordinator" }],
			metadata: { coordinatorAgentId: "main" },
			now: 1,
		});
		const tool = makeTeamTool({
			agentId: "main",
			sessionKey: buildTeamChatSessionKey("bound", "main"),
			store,
			now: () => 2,
			kick: () => undefined,
			validateAgentId: () => true,
		});
		const escaped = details(await tool.execute("escape", {
			action: "update_room",
			roomId: "other",
			title: "Escaped",
		}));
		assert.equal(escaped.ok, false);
		assert.equal(escaped.errorCode, "ROOM_SCOPE_MISMATCH");
		assert.equal((await store.getRoom("other"))?.title, "Other");
	});

	it("rejects unknown room members and configured non-member task assignees", async () => {
		const store = new InMemoryCollaborationStore();
		const configured = new Set(["alice", "bob"]);
		const tool = makeTeamTool({
			agentId: "main",
			store,
			now: () => 10,
			kick: () => undefined,
			validateAgentId: (agentId) => configured.has(agentId),
		});

		const unknown = details(await tool.execute("unknown-room", {
			action: "create_room",
			roomId: "invalid",
			title: "Invalid",
			members: [{ agentId: "ghost" }],
		}));
		assert.equal(unknown.ok, false);
		assert.equal(unknown.errorCode, "UNKNOWN_AGENT");
		assert.equal(await store.getRoom("invalid"), undefined);

		assert.equal(details(await tool.execute("room", {
			action: "create_room",
			roomId: "room",
			title: "Room",
			members: [{ agentId: "alice" }],
		})).ok, true);
		assert.equal(details(await tool.execute("run", {
			action: "create_run",
			runId: "run",
			roomId: "room",
			objective: "Work",
		})).ok, true);
		const nonMember = details(await tool.execute("tasks", {
			action: "add_tasks",
			runId: "run",
			tasks: [{ id: "task", title: "Task", instructions: "Work", assignedAgentId: "bob" }],
		}));
		assert.equal(nonMember.ok, false);
		assert.equal(nonMember.errorCode, "AGENT_NOT_IN_ROOM");
		assert.deepEqual(await store.listTasks("run"), []);
	});

	it("keeps the durable success when the best-effort worker wake fails", async () => {
		const store = new InMemoryCollaborationStore();
		await store.createRoom({ commandId: "seed.room", roomId: "room", title: "Room", createdBy: "main", now: 1 });
		await store.createRun({ commandId: "seed.run", runId: "run", roomId: "room", objective: "Run", createdBy: "main", now: 2 });
		await store.addTasks({ commandId: "seed.tasks", runId: "run", tasks: [{ id: "task", title: "Task", instructions: "Work" }], now: 3 });
		const tool = makeTeamTool({
			agentId: "main",
			store,
			now: () => 4,
			kick: () => { throw new Error("runtime temporarily unavailable"); },
		});
		const response = details(await tool.execute("start", { action: "start_run", runId: "run" }));
		assert.equal(response.ok, true);
		assert.equal((await store.getRun("run"))?.status, "running");
	});

	it("resolves an offered handoff and a pending approval, then wakes workers", async () => {
		let now = 1;
		const store = new InMemoryCollaborationStore();
		await store.createRoom({
			commandId: "seed.room",
			roomId: "room",
			title: "Room",
			createdBy: "main",
			members: [{ agentId: "alice" }, { agentId: "bob" }],
			now: now++,
		});
		await store.createRun({ commandId: "seed.run", runId: "run", roomId: "room", objective: "Ship", createdBy: "main", now: now++ });
		await store.addTasks({
			commandId: "seed.tasks",
			runId: "run",
			tasks: [{ id: "task", title: "Task", instructions: "Work", assignedAgentId: "alice", retry: { maxAttempts: 1 } }],
			now: now++,
		});
		await store.startRun({ commandId: "seed.start", runId: "run", now: now++ });
		const alice = (await store.claimReadyTask({ commandId: "seed.claim.alice", workerId: "worker", agentId: "alice", leaseDurationMs: 10_000, now: now++ })).value;
		assert.ok(alice);
		const offered = (await store.offerHandoff({
			commandId: "seed.handoff",
			attemptId: alice.id,
			leaseToken: alice.lease.token,
			fence: alice.lease.fence,
			fromAgentId: "alice",
			toAgentId: "bob",
			now: now++,
		})).value;

		let kicks = 0;
		const tool = makeTeamTool({ agentId: "main", store, now: () => now++, kick: () => { kicks += 1; } });
		const accepted = details(await tool.execute("accept-call", {
			action: "respond_handoff",
			runId: "run",
			handoffId: offered.id,
			decision: "accepted",
		}));
		assert.equal(accepted.ok, true);
		assert.equal((accepted.handoff as { status: string }).status, "accepted");

		const bob = (await store.claimReadyTask({ commandId: "seed.claim.bob", workerId: "worker", agentId: "bob", leaseDurationMs: 10_000, now: now++ })).value;
		assert.ok(bob);
		const approval = (await store.requestApproval({
			commandId: "seed.approval",
			attemptId: bob.id,
			leaseToken: bob.lease.token,
			fence: bob.lease.fence,
			kind: "deploy",
			prompt: "Deploy?",
			requestedBy: "bob",
			now: now++,
		})).value;
		const approved = details(await tool.execute("approve-call", {
			action: "resolve_approval",
			approvalId: approval.id,
			decision: "approved",
			resolution: "Proceed",
		}));
		assert.equal(approved.ok, true);
		assert.equal((approved.approval as { status: string }).status, "approved");
		assert.equal(kicks, 2);
	});

	it("returns domain conflicts as compact structured failures", async () => {
		const store = new InMemoryCollaborationStore();
		const tool = makeTeamTool({ agentId: "main", store, now: () => 1, kick: () => undefined });
		const response = details(await tool.execute("missing-call", { action: "start_run", runId: "missing" }));
		assert.equal(response.ok, false);
		assert.equal(response.errorCode, "NOT_FOUND");
		assert.match(response.message, /run not found/i);
	});

	it("keeps synthetic coordinator returns read-only at the tool boundary", async () => {
		const store = new InMemoryCollaborationStore();
		const tool = makeTeamTool({ agentId: "main", store, now: () => 1, readOnly: true });
		const status = details(await tool.execute("status-call", { action: "list_rooms" }));
		assert.equal(status.ok, true);
		await assert.rejects(
			tool.execute("mutating-call", { action: "create_room", title: "Forbidden", members: [{ agentId: "main" }] }),
			(error: unknown) => error instanceof BrigadeToolAuthorizationError && error.status === 403,
		);
		assert.deepEqual(await store.listRooms(), []);
	});

	it("lets a read-only room coordinator reconstruct one exact long result without leaving room scope", async () => {
		let now = 1;
		const store = new InMemoryCollaborationStore();
		const seedCompletedTask = async (roomId: string, runId: string, taskId: string, taskResult: string) => {
			await store.createRoom({
				commandId: `seed.${roomId}`,
				roomId,
				title: roomId,
				createdBy: "main",
				members: [{ agentId: "main", role: "coordinator" }],
				metadata: { coordinatorAgentId: "main" },
				now: now++,
			});
			await store.createRun({ commandId: `seed.${runId}`, runId, roomId, objective: "Work", createdBy: "main", now: now++ });
			await store.addTasks({ commandId: `seed.${taskId}`, runId, tasks: [{ id: taskId, title: taskId, instructions: "Work", assignedAgentId: "main" }], now: now++ });
			await store.startRun({ commandId: `seed.start.${runId}`, runId, now: now++ });
			const attempt = (await store.claimReadyTask({ commandId: `seed.claim.${taskId}`, runId, taskId, workerId: "runtime", agentId: "main", leaseDurationMs: 1_000, now: now++ })).value!;
			await store.completeAttempt({ commandId: `seed.complete.${taskId}`, attemptId: attempt.id, leaseToken: attempt.lease.token, fence: attempt.lease.fence, result: taskResult, now: now++ });
		};
		const longResult = `prefix-${"x".repeat(40_000)}-🦁-suffix`;
		await seedCompletedTask("bound-room", "bound-run", "bound-task", longResult);
		await seedCompletedTask("other-room", "other-run", "other-task", "private other result");
		const tool = makeTeamTool({
			agentId: "main",
			sessionKey: buildTeamChatSessionKey("bound-room", "main"),
			store,
			now: () => now++,
			readOnly: true,
			validateAgentId: () => true,
		});

		const first = details(await tool.execute("read-first", {
			action: "read_result",
			runId: "bound-run",
			taskId: "bound-task",
			offset: 0,
			limit: 32_000,
		}));
		assert.equal(first.ok, true);
		assert.ok(first.resultPage);
		assert.equal(first.resultPage.complete, false);
		assert.ok(first.resultPage.nextOffset);
		const second = details(await tool.execute("read-second", {
			action: "read_result",
			runId: "bound-run",
			taskId: "bound-task",
			offset: first.resultPage.nextOffset,
			limit: 32_000,
		}));
		assert.ok(second.resultPage);
		assert.equal(first.resultPage.content + second.resultPage.content, longResult);
		assert.equal(first.resultPage.sha256, second.resultPage.sha256);

		const escaped = details(await tool.execute("read-escape", {
			action: "read_result",
			runId: "other-run",
			taskId: "other-task",
		}));
		assert.equal(escaped.ok, false);
		assert.equal(escaped.errorCode, "ROOM_SCOPE_MISMATCH");
		assert.doesNotMatch(JSON.stringify(escaped), /private other result/);

		const status = details(await tool.execute("compact", { action: "status", runId: "bound-run" }));
		const compact = JSON.stringify(status);
		assert.match(compact, /truncated/);
		assert.ok(compact.length < longResult.length, "ordinary status remains compact");
	});

	it("binds room operations to the active Team chat and launches an idempotent delegation in one call", async () => {
		const store = new InMemoryCollaborationStore();
		await store.createRoom({
			commandId: "seed.room",
			roomId: "bound-room",
			title: "Bound room",
			createdBy: "main",
			members: [{ agentId: "main", role: "coordinator" }, { agentId: "alice" }],
			now: 1,
		});
		await store.createRoom({ commandId: "seed.other", roomId: "other-room", title: "Other", createdBy: "main", now: 1 });
		const tool = makeTeamTool({
			agentId: "main",
			sessionKey: buildTeamChatSessionKey("bound-room", "main"),
			store,
			now: () => 10,
			kick: () => undefined,
			validateAgentId: (id) => id === "main" || id === "alice",
		});

		const input = {
			action: "delegate" as const,
			runId: "delegated-run",
			objective: "Investigate and report",
			tasks: [{ id: "research", title: "Research", instructions: "Find evidence", assignedAgentId: "alice" }],
		};
		const first = details(await tool.execute("delegate-call", input));
		const replay = details(await tool.execute("delegate-call", input));
		assert.equal(first.ok, true);
		assert.equal(replay.ok, true);
		assert.equal((await store.getRun("delegated-run"))?.roomId, "bound-room");
		assert.equal((await store.listRuns("bound-room")).length, 1);
		assert.equal((await store.getRun("delegated-run"))?.status, "running");

		const escaped = details(await tool.execute("escape", {
			action: "create_run",
			roomId: "other-room",
			objective: "Wrong room",
		}));
		assert.equal(escaped.ok, false);
		assert.equal(escaped.errorCode, "ROOM_SCOPE_MISMATCH");
	});

	it("refuses delegation when the bound coordinator is not a room member", async () => {
		const store = new InMemoryCollaborationStore();
		await store.createRoom({
			commandId: "seed.room",
			roomId: "room",
			title: "Invalid coordinator room",
			createdBy: "main",
			members: [{ agentId: "worker" }],
			now: 1,
		});
		const tool = makeTeamTool({
			agentId: "main",
			sessionKey: buildTeamChatSessionKey("room", "main"),
			store,
			now: () => 2,
			kick: () => undefined,
			validateAgentId: () => true,
		});
		const response = details(await tool.execute("delegate", {
			action: "delegate",
			objective: "Do the work",
			tasks: [{ id: "task", title: "Work", instructions: "Work", assignedAgentId: "worker" }],
		}));
		assert.equal(response.ok, false);
		assert.equal(response.errorCode, "NOT_ROOM_COORDINATOR");
		assert.deepEqual(await store.listRuns("room"), []);
	});

	it("does not leave a created run when an atomic delegation has an invalid DAG", async () => {
		const store = new InMemoryCollaborationStore();
		await store.createRoom({
			commandId: "room",
			roomId: "room",
			title: "Room",
			createdBy: "main",
			members: [{ agentId: "main", role: "coordinator" }, { agentId: "worker" }],
			metadata: { coordinatorAgentId: "main" },
			now: 1,
		});
		const tool = makeTeamTool({
			agentId: "main",
			sessionKey: buildTeamChatSessionKey("room", "main"),
			store,
			now: () => 2,
			kick: () => undefined,
			validateAgentId: () => true,
		});
		const response = details(await tool.execute("bad-delegate", {
			action: "delegate",
			runId: "bad-run",
			objective: "Invalid graph",
			tasks: [{ id: "task", title: "Task", instructions: "Task", assignedAgentId: "worker", dependencies: ["missing"] }],
		}));
		assert.equal(response.ok, false);
		assert.equal(response.errorCode, "UNKNOWN_DEPENDENCY");
		assert.equal(await store.getRun("bad-run"), undefined);
	});

	it("lets a live member coordinate after the configured coordinator was deleted", async () => {
		const store = new InMemoryCollaborationStore();
		await store.createRoom({
			commandId: "seed.room",
			roomId: "room",
			title: "Coordinator fallback",
			createdBy: "deleted",
			members: [{ agentId: "deleted", role: "coordinator" }, { agentId: "worker" }],
			metadata: { coordinatorAgentId: "deleted" },
			now: 1,
		});
		const tool = makeTeamTool({
			agentId: "worker",
			sessionKey: buildTeamChatSessionKey("room", "worker"),
			store,
			now: () => 2,
			kick: () => undefined,
			validateAgentId: (candidate) => candidate === "worker",
		});
		const response = details(await tool.execute("list", { action: "list_rooms" }));
		assert.equal(response.ok, true);
	});

	it("returns bounded durable worker results without lease credentials", async () => {
		let now = 1;
		const store = new InMemoryCollaborationStore();
		await store.createRoom({ commandId: "seed.room", roomId: "room", title: "Room", createdBy: "main", members: [{ agentId: "alice" }], now: now++ });
		await store.createRun({ commandId: "seed.run", runId: "run", roomId: "room", objective: "Work", createdBy: "main", now: now++ });
		await store.addTasks({ commandId: "seed.tasks", runId: "run", tasks: [{ id: "task", title: "Task", instructions: "Private assignment", assignedAgentId: "alice" }], now: now++ });
		await store.startRun({ commandId: "seed.start", runId: "run", now: now++ });
		const attempt = (await store.claimReadyTask({ commandId: "seed.claim", workerId: "worker", agentId: "alice", leaseDurationMs: 10_000, now: now++ })).value;
		assert.ok(attempt);
		await store.completeAttempt({
			commandId: "seed.complete",
			attemptId: attempt.id,
			leaseToken: attempt.lease.token,
			fence: attempt.lease.fence,
			result: `RESULT:${"x".repeat(5_000)}`,
			now: now++,
		});
		const tool = makeTeamTool({ agentId: "main", store, now: () => now, kick: () => undefined });
		const response = await tool.execute("status", { action: "status", runId: "run" });
		const encoded = JSON.stringify(response);
		assert.match(encoded, /RESULT:/);
		assert.match(encoded, /truncated/);
		assert.doesNotMatch(encoded, /Private assignment|leaseToken|claimToken|"fence"/);
	});
});
