import { strict as assert } from "node:assert";
import { test } from "node:test";

import { deliverTeamCoordinatorReturn } from "./coordinator-return.js";
import { InMemoryCollaborationStore } from "./memory-store.js";
import { buildTeamChatSessionKey } from "./session-key.js";
import type { CollaborationEvent } from "./types.js";

test("a terminal run is returned once to its configured room coordinator", async () => {
	let now = 1;
	const store = new InMemoryCollaborationStore();
	await store.createRoom({
		commandId: "room",
		roomId: "room",
		title: "Room",
		createdBy: "owner",
		members: [{ agentId: "lead" }, { agentId: "worker" }],
		metadata: { coordinatorAgentId: "lead" },
		now: now++,
	});
	await store.createRun({ commandId: "run", runId: "run", roomId: "room", objective: "Work", createdBy: "owner", now: now++ });
	await store.addTasks({ commandId: "tasks", runId: "run", tasks: [{ id: "task", title: "Task", instructions: "Do it", assignedAgentId: "worker" }], now: now++ });
	await store.startRun({ commandId: "start", runId: "run", now: now++ });
	const attempt = (await store.claimReadyTask({ commandId: "claim", workerId: "runtime", agentId: "worker", leaseDurationMs: 1_000, now: now++ })).value;
	assert.ok(attempt);
	const completed = await store.completeAttempt({ commandId: "complete", attemptId: attempt.id, leaseToken: attempt.lease.token, fence: attempt.lease.fence, result: "done", now: now++ });
	const terminal = completed.events.find((event) => event.type === "run.completed");
	assert.ok(terminal);
	const wakes: Array<{ reason: string; agentId: string; sessionKey: string; text: string }> = [];
	const delivered = await deliverTeamCoordinatorReturn({
		event: terminal,
		store,
		defaultAgentId: "main",
		validateAgentId: (id) => ["main", "lead", "worker"].includes(id),
		wake: (options) => { wakes.push(options); },
	});
	assert.equal(delivered, true);
	assert.equal(wakes[0]?.reason, "team-complete");
	assert.equal(wakes[0]?.agentId, "lead");
	assert.equal(wakes[0]?.sessionKey, buildTeamChatSessionKey("room", "lead"));
	assert.match(wakes[0]!.text, /durable status and worker results/);
	assert.match(wakes[0]!.text, /action:"read_result"/);
	assert.match(wakes[0]!.text, /continue at nextOffset until complete/);
	assert.doesNotMatch(wakes[0]!.text, /Do it|done/);
	await assert.rejects(
		deliverTeamCoordinatorReturn({
			event: terminal,
			store,
			defaultAgentId: "main",
			validateAgentId: () => true,
			wake: async () => { throw new Error("provider unavailable"); },
		}),
		/provider unavailable/,
		"the outbox publisher must observe coordinator dispatch failure and retry",
	);

	let retryWakeCount = 0;
	const retryTexts: string[] = [];
	const retryDelivery = () => deliverTeamCoordinatorReturn({
		event: terminal,
		store,
		defaultAgentId: "main",
		validateAgentId: () => true,
		wake: async ({ text }) => {
			retryWakeCount += 1;
			retryTexts.push(text);
			if (retryWakeCount === 1) throw new Error("failed before inbox drain");
		},
	});
	await assert.rejects(retryDelivery(), /failed before inbox drain/);
	assert.equal(await retryDelivery(), true, "the durable event remains retryable after a failed wake");
	assert.equal(retryWakeCount, 2);
	assert.equal(retryTexts[0], retryTexts[1], "outbox retry delivers the same deterministic turn input");
});

test("a room without explicit coordinator returns results to its member creator", async () => {
	let now = 1;
	const store = new InMemoryCollaborationStore();
	await store.createRoom({
		commandId: "room",
		roomId: "room",
		title: "Room",
		createdBy: "main",
		members: [{ agentId: "main" }, { agentId: "worker" }],
		now: now++,
	});
	await store.createRun({ commandId: "run", runId: "run", roomId: "room", objective: "Work", createdBy: "main", now: now++ });
	await store.addTasks({ commandId: "tasks", runId: "run", tasks: [{ id: "task", title: "Task", instructions: "Do it", assignedAgentId: "worker" }], now: now++ });
	await store.startRun({ commandId: "start", runId: "run", now: now++ });
	const attempt = (await store.claimReadyTask({ commandId: "claim", workerId: "runtime", agentId: "worker", leaseDurationMs: 1_000, now: now++ })).value;
	assert.ok(attempt);
	const completed = await store.completeAttempt({ commandId: "complete", attemptId: attempt.id, leaseToken: attempt.lease.token, fence: attempt.lease.fence, result: "done", now: now++ });
	const terminal = completed.events.find((event) => event.type === "run.completed");
	assert.ok(terminal);
	const wakes: Array<{ agentId: string; sessionKey: string }> = [];
	await deliverTeamCoordinatorReturn({
		event: terminal,
		store,
		defaultAgentId: "main",
		validateAgentId: (id) => ["main", "worker"].includes(id),
		wake: ({ agentId, sessionKey }) => { wakes.push({ agentId, sessionKey }); },
	});
	assert.deepEqual(wakes, [{ agentId: "main", sessionKey: buildTeamChatSessionKey("room", "main") }]);
});

test("non-terminal events never wake a coordinator", async () => {
	const store = new InMemoryCollaborationStore();
	let woke = false;
	const delivered = await deliverTeamCoordinatorReturn({
		event: { eventId: "e", roomSeq: 1, type: "run.started", roomId: "room", runId: "run", commandId: "c", payload: {}, createdAt: 1 },
		store,
		defaultAgentId: "main",
		validateAgentId: () => true,
		wake: () => { woke = true; },
	});
	assert.equal(delivered, false);
	assert.equal(woke, false);
});

test("a pending approval wakes the room coordinator exactly once without deciding", async () => {
	const store = new InMemoryCollaborationStore();
	await store.createRoom({
		commandId: "room",
		roomId: "room",
		title: "Room",
		createdBy: "lead",
		members: [{ agentId: "lead", role: "coordinator" }, { agentId: "worker" }],
		metadata: { coordinatorAgentId: "lead" },
		now: 1,
	});
	await store.createRun({ commandId: "run", runId: "run", roomId: "room", objective: "Work", createdBy: "lead", now: 2 });
	await store.addTasks({ commandId: "tasks", runId: "run", tasks: [{ id: "task", title: "Task", instructions: "Do it", assignedAgentId: "worker" }], now: 3 });
	await store.startRun({ commandId: "start", runId: "run", now: 4 });
	const attempt = (await store.claimReadyTask({ commandId: "claim", runId: "run", taskId: "task", workerId: "runtime", agentId: "worker", leaseDurationMs: 1_000, now: 5 })).value;
	assert.ok(attempt);
	const requested = await store.requestApproval({
		commandId: "request",
		approvalId: "approval",
		attemptId: attempt.id,
		leaseToken: attempt.lease.token,
		fence: attempt.lease.fence,
		kind: "exec",
		prompt: "Run it?",
		requestedBy: "worker",
		now: 6,
	});
	const event = requested.events.find((candidate) => candidate.type === "approval.requested");
	assert.ok(event);
	const wakes: string[] = [];
	const prompts: string[] = [];
	const delivered = await deliverTeamCoordinatorReturn({
		event,
		store,
		defaultAgentId: "main",
		validateAgentId: () => true,
		wake: ({ reason, text }) => { wakes.push(reason); prompts.push(text); },
	});
	assert.equal(delivered, true);
	assert.deepEqual(wakes, ["team-decision"]);
	assert.match(prompts[0] ?? "", /waiting for operator approval approval/);
	assert.match(prompts[0] ?? "", /Never approve or reject/);
	await store.resolveApproval({ commandId: "resolve", approvalId: "approval", decision: "approved", now: 7 });
	assert.equal(await deliverTeamCoordinatorReturn({
		event,
		store,
		defaultAgentId: "main",
		validateAgentId: () => true,
		wake: () => { throw new Error("stale approval must not wake"); },
	}), false);
});

test("stale terminal and handoff events do not narrate obsolete state", async () => {
	const store = new InMemoryCollaborationStore();
	await store.createRoom({
		commandId: "room",
		roomId: "room",
		title: "Room",
		createdBy: "lead",
		members: [{ agentId: "lead", role: "coordinator" }, { agentId: "worker" }],
		metadata: { coordinatorAgentId: "lead" },
		now: 1,
	});
	await store.createRun({ commandId: "run", runId: "run", roomId: "room", objective: "Work", createdBy: "lead", now: 2 });
	await store.addTasks({ commandId: "tasks", runId: "run", tasks: [{ id: "task", title: "Task", instructions: "Do it", assignedAgentId: "worker" }], now: 3 });
	await store.startRun({ commandId: "start", runId: "run", now: 4 });
	const staleTerminal: CollaborationEvent = {
		eventId: "old-failure",
		roomSeq: 5,
		type: "run.failed",
		roomId: "room",
		runId: "run",
		commandId: "old",
		payload: {},
		createdAt: 5,
	};
	assert.equal(await deliverTeamCoordinatorReturn({
		event: staleTerminal,
		store,
		defaultAgentId: "main",
		validateAgentId: () => true,
		wake: () => { throw new Error("running run must not be described as failed"); },
	}), false);

	const attempt = (await store.claimReadyTask({ commandId: "claim", runId: "run", taskId: "task", workerId: "runtime", agentId: "worker", leaseDurationMs: 1_000, now: 6 })).value;
	assert.ok(attempt);
	const offered = await store.offerHandoff({
		commandId: "offer",
		handoffId: "handoff",
		attemptId: attempt.id,
		leaseToken: attempt.lease.token,
		fence: attempt.lease.fence,
		fromAgentId: "worker",
		toAgentId: "lead",
		now: 7,
	});
	const event = offered.events.find((candidate) => candidate.type === "handoff.offered");
	assert.ok(event);
	await store.rejectHandoff({ commandId: "reject", handoffId: "handoff", respondingAgentId: "lead", now: 8 });
	assert.equal(await deliverTeamCoordinatorReturn({
		event,
		store,
		defaultAgentId: "main",
		validateAgentId: () => true,
		wake: () => { throw new Error("resolved handoff must not wake"); },
	}), false);
});
