import assert from "node:assert/strict";
import test from "node:test";
import { TeamCoordinator, type TeamTaskExecutor } from "./coordinator.js";
import { InMemoryCollaborationStore } from "./memory-store.js";

async function makeRun(): Promise<InMemoryCollaborationStore> {
	const store = new InMemoryCollaborationStore();
	await store.createRoom({
		commandId: "room",
		roomId: "room",
		title: "Room",
		createdBy: "owner",
		members: [{ agentId: "alice" }, { agentId: "bob" }],
		now: 1,
	});
	await store.createRun({
		commandId: "run",
		runId: "run",
		roomId: "room",
		objective: "Objective",
		createdBy: "owner",
		budgets: { maxConcurrency: 2 },
		now: 2,
	});
	await store.addTasks({
		commandId: "tasks",
		runId: "run",
		tasks: [
			{ id: "a", title: "A", instructions: "A", assignedAgentId: "alice", retry: { maxAttempts: 2 } },
			{ id: "b", title: "B", instructions: "B", assignedAgentId: "bob" },
			{ id: "join", title: "Join", instructions: "Join", dependencies: ["a", "b"] },
		],
		now: 3,
	});
	await store.startRun({ commandId: "start", runId: "run", now: 4 });
	return store;
}

test("coordinator fans out to the run concurrency budget, then executes the join", async () => {
	const store = await makeRun();
	let command = 0;
	let now = 10;
	const seen: string[] = [];
	const executor: TeamTaskExecutor = {
		async execute(request) {
			seen.push(request.task.id);
			assert.equal(request.context.attemptId, request.attempt.id);
			assert.equal(request.context.teamRunId, "run");
			return { status: "succeeded", result: `${request.task.id}-done`, usage: { tokens: 1, costUsd: 0.01 } };
		},
	};
	const coordinator = new TeamCoordinator({
		store,
		executor,
		workerId: "coordinator",
		leaseDurationMs: 10_000,
		leaseRenewIntervalMs: 3_000,
		now: () => now++,
		commandId: () => `coordinator.${command++}`,
	});
	const first = await coordinator.tick({ runId: "run" });
	assert.equal(first.claimed, 2);
	assert.deepEqual(new Set(seen), new Set(["a", "b"]));
	assert.equal((await store.getTask("join"))?.status, "ready");
	const second = await coordinator.tick({ runId: "run" });
	assert.equal(second.claimed, 1);
	assert.equal(seen.at(-1), "join");
	assert.equal((await store.getRun("run"))?.status, "completed");
});

test("coordinator records an executor failure, then claims the durable retry", async () => {
	const store = await makeRun();
	await store.cancelTask({ commandId: "cancel-b", taskId: "b", now: 5 });
	let invocation = 0;
	let command = 0;
	let now = 10;
	const coordinator = new TeamCoordinator({
		store,
		workerId: "coordinator",
		leaseDurationMs: 10_000,
		leaseRenewIntervalMs: 3_000,
		now: () => now++,
		commandId: () => `retry.${command++}`,
			executor: {
			async execute() {
				invocation += 1;
				return invocation === 1
					? { status: "failed", errorCode: "TRANSIENT", errorMessage: "try again", retryable: true }
					: { status: "succeeded", result: "done" };
			},
		},
	});
	const first = await coordinator.tick({ runId: "run", agentId: "alice" });
	assert.equal(first.results[0]?.status, "failed");
	assert.equal((await store.getTask("a"))?.status, "ready");
	const second = await coordinator.tick({ runId: "run", agentId: "alice" });
	assert.equal(second.results[0]?.status, "succeeded");
	assert.equal((await store.listAttempts("a")).length, 2);
});

test("coordinator honors retryableCodes even when the executor requests a retry", async () => {
	const original = await makeRun();
	await original.cancelTask({ commandId: "cancel-b", taskId: "b", now: 5 });
	const snapshot = await original.readSnapshot();
	const task = snapshot.tasks.find((candidate) => candidate.id === "a");
	assert.ok(task);
	task.retry.retryableCodes = ["RATE_LIMIT"];
	const store = new InMemoryCollaborationStore(snapshot);
	let command = 0;
	let now = 10;
	const coordinator = new TeamCoordinator({
		store,
		workerId: "coordinator",
		leaseDurationMs: 10_000,
		leaseRenewIntervalMs: 3_000,
		now: () => now++,
		commandId: () => `retry-filter.${command++}`,
		executor: {
			async execute() {
				return { status: "failed", errorCode: "EXECUTOR_ERROR", errorMessage: "permanent", retryable: true };
			},
		},
	});
	const tick = await coordinator.tick({ runId: "run", agentId: "alice" });
	assert.equal(tick.results[0]?.status, "failed");
	assert.equal((await store.getTask("a"))?.status, "failed");
	assert.equal((await store.listAttempts("a")).length, 1);
});

test("generic coordinator cannot complete a task whose final review gate fails", async () => {
	const store = new InMemoryCollaborationStore();
	await store.createRoom({ commandId: "review.room", roomId: "review-room", title: "Review", createdBy: "owner", members: [{ agentId: "reviewer" }], now: 1 });
	await store.createRun({ commandId: "review.run", runId: "review-run", roomId: "review-room", objective: "Verify", createdBy: "owner", now: 2 });
	await store.addTasks({
		commandId: "review.tasks",
		runId: "review-run",
		tasks: [{ id: "review", title: "Review", instructions: "Verify", assignedAgentId: "reviewer", resultGate: { kind: "review_verdict" } }],
		now: 3,
	});
	await store.startRun({ commandId: "review.start", runId: "review-run", now: 4 });
	let command = 0;
	const coordinator = new TeamCoordinator({
		store,
		workerId: "coordinator",
		now: () => 10 + command,
		commandId: () => `review.${command++}`,
		executor: { async execute() { return { status: "succeeded", result: "REVIEW: FAIL\nStill broken." }; } },
	});

	const tick = await coordinator.tick({ runId: "review-run" });
	assert.equal(tick.results[0]?.status, "failed");
	assert.match(tick.results[0]?.error ?? "", /explicit REVIEW: PASS/);
	assert.equal((await store.getTask("review"))?.status, "failed");
	assert.match(String((await store.getTask("review"))?.result), /Still broken/);
	assert.equal((await store.getRun("review-run"))?.status, "failed");
});

test("coordinator asks the executor to cancel when a task times out", async () => {
	const store = await makeRun();
	await store.cancelTask({ commandId: "cancel-b", taskId: "b", now: 5 });
	let cancelled: { attemptId: string; reason: string } | undefined;
	let command = 0;
	let now = 10;
	const coordinator = new TeamCoordinator({
		store,
		workerId: "coordinator",
		leaseDurationMs: 10_000,
		leaseRenewIntervalMs: 3_000,
		executionTimeoutMs: 10,
		now: () => now++,
		commandId: () => `timeout.${command++}`,
		executor: {
			async execute() {
				return await new Promise(() => undefined);
			},
			cancel(context, reason) {
				cancelled = { attemptId: context.attemptId, reason };
			},
		},
	});
	const tick = await coordinator.tick({ runId: "run", agentId: "alice" });
	assert.equal(tick.results[0]?.status, "failed");
	assert.equal(cancelled?.attemptId, tick.results[0]?.attemptId);
	assert.match(cancelled?.reason ?? "", /timed out/);
});

test("restart hydration plus coordinator reconciliation expires a lost lease and preserves its fence", async () => {
	const store = await makeRun();
	const first = await store.claimReadyTask({
		commandId: "lost.claim",
		runId: "run",
		agentId: "alice",
		workerId: "old-process",
		leaseDurationMs: 5,
		now: 10,
	});
	assert.ok(first.value);
	const restarted = new InMemoryCollaborationStore(await store.readSnapshot());
	let command = 0;
	const coordinator = new TeamCoordinator({
		store: restarted,
		workerId: "new-process",
		leaseDurationMs: 100,
		leaseRenewIntervalMs: 25,
		now: () => 20,
		commandId: () => `restart.${command++}`,
		executor: { async execute() { return { status: "succeeded" }; } },
	});
	const report = await coordinator.reconcile();
	assert.deepEqual(report.expiredAttempts, [first.value.id]);
	const tick = await coordinator.tick({ runId: "run", agentId: "alice" });
	assert.equal(tick.claimed, 1);
	const attempts = await restarted.listAttempts("a");
	assert.equal(attempts[1]?.lease.fence, first.value.lease.fence + 1);
	assert.equal(attempts[1]?.status, "succeeded");
});
