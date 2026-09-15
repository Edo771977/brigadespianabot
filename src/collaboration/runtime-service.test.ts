import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { requireActiveTeamExecutionContext } from "./execution-context.js";
import { InMemoryCollaborationStore } from "./memory-store.js";
import { TeamRuntimeService, type TeamTurnRunner } from "./runtime-service.js";
import { buildTeamAttemptSessionKey, buildTeamSessionKey, parseTeamSessionKey } from "./session-key.js";
import { CollaborationConflictError } from "./types.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}

async function addRun(
	store: InMemoryCollaborationStore,
	options: { roomId: string; runId: string; tasks: Array<{ id: string; agentId?: string; retry?: number; resultGate?: { kind: "review_verdict" } }>; concurrency?: number },
): Promise<void> {
	if (!(await store.getRoom(options.roomId))) {
		const members = new Set(
			options.tasks.flatMap((task) => task.agentId ? [task.agentId] : []),
		);
		if (options.tasks.some((task) => !task.agentId)) members.add("main");
		// Handoff-focused fixtures use bob as the successor even when the
		// initial task is assigned only to alice.
		members.add("bob");
		await store.createRoom({
			commandId: `room.${options.roomId}`,
			roomId: options.roomId,
			title: options.roomId,
			createdBy: "owner",
			members: [...members].map((agentId) => ({ agentId })),
			now: 1,
		});
	}
	await store.createRun({
		commandId: `run.${options.runId}`,
		runId: options.runId,
		roomId: options.roomId,
		objective: `Objective ${options.runId}`,
		createdBy: "owner",
		budgets: { maxConcurrency: options.concurrency ?? 10 },
		now: 2,
	});
	await store.addTasks({
		commandId: `tasks.${options.runId}`,
		runId: options.runId,
		tasks: options.tasks.map((task) => ({
			id: task.id,
			title: task.id,
			instructions: `Do ${task.id}`,
			...(task.agentId ? { assignedAgentId: task.agentId } : {}),
			...(task.retry ? { retry: { maxAttempts: task.retry } } : {}),
			...(task.resultGate ? { resultGate: task.resultGate } : {}),
		})),
		now: 3,
	});
	await store.startRun({ commandId: `start.${options.runId}`, runId: options.runId, now: 4 });
}

test("runtime converts a failed final review verdict into a durable run failure", async () => {
	const store = new InMemoryCollaborationStore();
	await addRun(store, {
		roomId: "review-room",
		runId: "review-run",
		tasks: [{ id: "final-review", agentId: "reviewer", resultGate: { kind: "review_verdict" } }],
	});
	const service = new TeamRuntimeService({
		store,
		workerId: "runtime",
		validateAgentId: () => true,
		idlePollMs: 10_000,
		runTurn: async () => ({
			reply: "REVIEW: FAIL\nThe revised output still misses a required check.",
			usage: { tokens: 9, costUsd: 0.01 },
		}),
	});

	await service.start();
	await service.waitForQuiescence();
	const attempt = (await store.listAttempts("final-review"))[0];
	assert.equal(attempt?.status, "failed");
	assert.equal(attempt?.errorCode, "RESULT_GATE_FAILED");
	assert.match(String(attempt?.result), /misses a required check/);
	assert.equal((await store.getRun("review-run"))?.status, "failed");
	assert.equal((await store.getRun("review-run"))?.usage.tokens, 9);
	await service.stop();
});

test("team session keys are stable, room-isolated and reversible", () => {
	const first = buildTeamSessionKey("room:with/slashes", "researcher");
	assert.equal(first, buildTeamSessionKey("room:with/slashes", "researcher"));
	assert.notEqual(first, buildTeamSessionKey("another-room", "researcher"));
	assert.deepEqual(parseTeamSessionKey(first), { roomId: "room:with/slashes", agentId: "researcher" });
	assert.equal(parseTeamSessionKey("agent:researcher:main"), undefined);
});

test("concurrent startup and kicks use one non-overlapping pump", async () => {
	const store = new InMemoryCollaborationStore();
	const originalReconcile = store.reconcile.bind(store);
	let reconciling = 0;
	let peakReconciling = 0;
	store.reconcile = async (command) => {
		reconciling += 1;
		peakReconciling = Math.max(peakReconciling, reconciling);
		await new Promise((resolve) => setTimeout(resolve, 5));
		try {
			return await originalReconcile(command);
		} finally {
			reconciling -= 1;
		}
	};
	const service = new TeamRuntimeService({
		store,
		workerId: "runtime",
		validateAgentId: () => true,
		idlePollMs: 10_000,
		runTurn: async () => ({ reply: "unused" }),
	});
	await Promise.all([service.start(), service.kick(), service.kick(), service.kick(), service.kick()]);
	assert.equal(peakReconciling, 1);
	await service.stop();
});

test("idle polling does not persist no-op reconcile, claim, or outbox receipts", async () => {
	const store = new InMemoryCollaborationStore();
	const service = new TeamRuntimeService({
		store,
		workerId: "runtime",
		validateAgentId: () => true,
		idlePollMs: 5,
		outboxPublisher: { publish: async () => undefined },
		runTurn: async () => ({ reply: "unused" }),
	});
	await service.start();
	const afterStartup = (await store.readSnapshot()).commandReceipts.length;
	await new Promise((resolve) => setTimeout(resolve, 35));
	assert.equal((await store.readSnapshot()).commandReceipts.length, afterStartup);
	await service.stop();
});

test("runtime persists final reply and normalized usage, with monotonic attempt progress", async () => {
	const store = new InMemoryCollaborationStore();
	await addRun(store, { roomId: "room", runId: "run", tasks: [{ id: "task", agentId: "alice" }] });
	const progress: Array<{ sequence: number; kind: string; delta?: string; agentId: string }> = [];
	let command = 0;
	const runner: TeamTurnRunner = async (request) => {
		assert.equal(request.sessionKey, buildTeamAttemptSessionKey("room", "alice", request.executionContext.attemptId));
		assert.equal(request.executionContext.runId, "run");
		assert.match(request.prompt, /attemptId:/);
		assert.match(request.prompt, /Task instructions:\nDo task/);
		assert.equal(requireActiveTeamExecutionContext().identifiers.attemptId, request.executionContext.attemptId);
		await request.onProgress({ kind: "assistant.delta", payload: { delta: "hel" } });
		await request.onProgress({ kind: "assistant.delta", payload: { delta: "lo" } });
		return { reply: "<think>private chain</think>\n<final>hello</final>", usage: { tokens: 42, costUsd: 0.25, costComplete: true } };
	};
	const service = new TeamRuntimeService({
		store,
		runTurn: runner,
		workerId: "runtime",
		validateAgentId: () => true,
		idlePollMs: 10_000,
		commandId: () => `runtime.${command++}`,
		onProgress(event) {
			progress.push({
				sequence: event.progressSeq,
				kind: event.kind,
				...(event.kind === "assistant.delta" && typeof event.payload.delta === "string" ? { delta: event.payload.delta } : {}),
				agentId: event.agentId,
			});
		},
	});
	await service.start();
	await service.waitForQuiescence();
	assert.equal((await store.getTask("task"))?.result, "hello");
	assert.equal((await store.getRun("run"))?.usage.tokens, 42);
	assert.equal((await store.getRun("run"))?.usage.costUsd, 0.25);
	assert.equal((await store.getRun("run"))?.usage.costComplete, true);
	assert.deepEqual(progress.map((event) => event.sequence), [1, 2]);
	assert.deepEqual(progress.filter((event) => event.kind === "assistant.delta").map((event) => event.delta), ["hel", "lo"]);
	assert.deepEqual(progress.map((event) => event.agentId), ["alice", "alice"]);
	await service.stop();
});

test("one coalesced pump enforces global concurrency across runs", async () => {
	const store = new InMemoryCollaborationStore();
	await addRun(store, { roomId: "one", runId: "run-one", tasks: [{ id: "one-a" }], concurrency: 1 });
	await addRun(store, { roomId: "two", runId: "run-two", tasks: [{ id: "two-a" }], concurrency: 1 });
	const pending: Array<ReturnType<typeof deferred<{ reply: string }>>> = [];
	let running = 0;
	let peak = 0;
	const service = new TeamRuntimeService({
		store,
		workerId: "runtime",
		validateAgentId: () => true,
		globalConcurrency: 1,
		idlePollMs: 10_000,
		runTurn: async () => {
			running += 1;
			peak = Math.max(peak, running);
			const gate = deferred<{ reply: string }>();
			pending.push(gate);
			const result = await gate.promise;
			running -= 1;
			return result;
		},
	});
	await Promise.all([service.start(), service.kick(), service.kick(), service.kick()]);
	await waitFor(() => pending.length === 1);
	assert.equal(service.listActiveAttempts().length, 1);
	pending[0]!.resolve({ reply: "first" });
	await waitFor(() => pending.length === 2);
	pending[1]!.resolve({ reply: "second" });
	await service.waitForQuiescence();
	assert.equal(peak, 1);
	assert.equal((await store.getRun("run-one"))?.status, "completed");
	assert.equal((await store.getRun("run-two"))?.status, "completed");
	await service.stop();
});

test("same room and agent are not overclaimed into the serialized session", async () => {
	const store = new InMemoryCollaborationStore();
	await addRun(store, {
		roomId: "room",
		runId: "run",
		tasks: [
			{ id: "a1", agentId: "alice" },
			{ id: "a2", agentId: "alice" },
			{ id: "z1", agentId: "bob" },
		],
		concurrency: 3,
	});
	let running = 0;
	let peak = 0;
	const firstStarted = deferred<void>();
	const releaseFirst = deferred<void>();
	const service = new TeamRuntimeService({
		store,
		workerId: "runtime",
		validateAgentId: () => true,
		globalConcurrency: 2,
		taskTimeoutMs: 40,
		leaseDurationMs: 500,
		leaseRenewIntervalMs: 100,
		idlePollMs: 10_000,
		runTurn: async ({ executionContext }) => {
			running += 1;
			peak = Math.max(peak, running);
			if (executionContext.taskId === "a1") {
				firstStarted.resolve();
				await releaseFirst.promise;
			}
			running -= 1;
			return { reply: "done" };
		},
	});
	await service.start();
	await firstStarted.promise;
	await waitFor(async () => (await store.getTask("z1"))?.status === "succeeded");
	assert.equal((await store.listAttempts("a1")).length, 1);
	assert.equal((await store.listAttempts("a2")).length, 0);
	assert.equal((await store.listAttempts("z1")).length, 1);
	assert.equal(service.listActiveAttempts().length, 1);
	releaseFirst.resolve();
	await service.waitForQuiescence();
	assert.equal(peak, 2);
	assert.deepEqual((await store.listTasks("run")).map((task) => task.status), ["succeeded", "succeeded", "succeeded"]);
	await service.stop();
});

test("an exact authority claim cannot redirect an assigned plan to a higher-priority unassigned task", async () => {
	const store = new InMemoryCollaborationStore();
	await addRun(store, {
		roomId: "room",
		runId: "run",
		tasks: [
			{ id: "a-main", agentId: "main" },
			{ id: "b-unassigned" },
			{ id: "c-alice", agentId: "alice" },
		],
		concurrency: 3,
	});
	const mainStarted = deferred<void>();
	const releaseMain = deferred<void>();
	const aliceStarted = deferred<void>();
	const starts: Array<{ taskId: string; agentId: string }> = [];
	const service = new TeamRuntimeService({
		store,
		workerId: "runtime",
		defaultAgentId: "main",
		validateAgentId: () => true,
		globalConcurrency: 2,
		leaseDurationMs: 1_000,
		leaseRenewIntervalMs: 100,
		idlePollMs: 10_000,
		runTurn: async ({ agentId, executionContext }) => {
			starts.push({ taskId: executionContext.taskId, agentId });
			if (executionContext.taskId === "a-main") {
				mainStarted.resolve();
				await releaseMain.promise;
			}
			if (executionContext.taskId === "c-alice") aliceStarted.resolve();
			return { reply: "done" };
		},
	});
	await service.start();
	await mainStarted.promise;
	await aliceStarted.promise;
	assert.deepEqual(starts.slice(0, 2), [
		{ taskId: "a-main", agentId: "main" },
		{ taskId: "c-alice", agentId: "alice" },
	]);
	assert.equal((await store.listAttempts("b-unassigned")).length, 0);
	assert.equal((await store.listAttempts("c-alice"))[0]?.agentId, "alice");
	releaseMain.resolve();
	await service.waitForQuiescence();
	assert.deepEqual(starts.at(-1), { taskId: "b-unassigned", agentId: "main" });
	assert.equal((await store.listAttempts("b-unassigned"))[0]?.agentId, "main");
	await service.stop();
});

test("runtime terminalizes legacy tasks whose fallback agent is not a room member", async () => {
	const store = new InMemoryCollaborationStore();
	await store.createRoom({
		commandId: "room",
		roomId: "room",
		title: "Room",
		createdBy: "owner",
		members: [{ agentId: "alice" }],
		now: 1,
	});
	await store.createRun({
		commandId: "run",
		runId: "run",
		roomId: "room",
		objective: "Legacy work",
		createdBy: "owner",
		now: 2,
	});
	await store.addTasks({
		commandId: "tasks",
		runId: "run",
		tasks: [{ id: "task", title: "Task", instructions: "Work" }],
		now: 3,
	});
	await store.startRun({ commandId: "start", runId: "run", now: 4 });
	let turns = 0;
	const service = new TeamRuntimeService({
		store,
		workerId: "runtime",
		defaultAgentId: "main",
		validateAgentId: () => true,
		idlePollMs: 10_000,
		runTurn: async () => {
			turns += 1;
			return { reply: "must not run" };
		},
	});
	await service.start();
	await service.waitForQuiescence();
	assert.equal(turns, 0);
	assert.equal((await store.getTask("task"))?.status, "failed");
	assert.match((await store.listAttempts("task"))[0]?.errorMessage ?? "", /not a member/);
	await service.stop();
});

test("one agent is not scheduled concurrently across different Team rooms", async () => {
	const store = new InMemoryCollaborationStore();
	await addRun(store, {
		roomId: "room-one",
		runId: "run-one",
		tasks: [{ id: "task-one", agentId: "alice" }],
		concurrency: 1,
	});
	await addRun(store, {
		roomId: "room-two",
		runId: "run-two",
		tasks: [{ id: "task-two", agentId: "alice" }],
		concurrency: 1,
	});
	const started: string[] = [];
	const firstStarted = deferred<void>();
	const releaseFirst = deferred<void>();
	let running = 0;
	let peak = 0;
	const service = new TeamRuntimeService({
		store,
		workerId: "runtime",
		validateAgentId: () => true,
		globalConcurrency: 2,
		idlePollMs: 10_000,
		runTurn: async ({ executionContext }) => {
			running += 1;
			peak = Math.max(peak, running);
			started.push(executionContext.taskId);
			if (started.length === 1) {
				firstStarted.resolve();
				await releaseFirst.promise;
			}
			running -= 1;
			return { reply: "done" };
		},
	});
	await service.start();
	await firstStarted.promise;
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(started.length, 1);
	assert.equal(service.listActiveAttempts().length, 1);
	releaseFirst.resolve();
	await service.waitForQuiescence();
	assert.equal(started.length, 2);
	assert.equal(peak, 1);
	assert.equal((await store.getRun("run-one"))?.status, "completed");
	assert.equal((await store.getRun("run-two"))?.status, "completed");
	await service.stop();
});

test("workspace-admission waiting pauses the active task timeout", async () => {
	const store = new InMemoryCollaborationStore();
	await addRun(store, { roomId: "room", runId: "run", tasks: [{ id: "task" }] });
	const admissionStarted = deferred<void>();
	const releaseAdmission = deferred<void>();
	const service = new TeamRuntimeService({
		store,
		workerId: "runtime",
		validateAgentId: () => true,
		taskTimeoutMs: 80,
		idlePollMs: 10_000,
		runTurn: async ({ onAdmissionWaitStart, onAdmissionWaitEnd }) => {
			onAdmissionWaitStart();
			admissionStarted.resolve();
			try {
				await releaseAdmission.promise;
			} finally {
				onAdmissionWaitEnd();
			}
			return { reply: "done after admission" };
		},
	});
	await service.start();
	await admissionStarted.promise;
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal((await store.getTask("task"))?.status, "running");
	assert.equal(service.listActiveAttempts()[0]?.paused, true);
	releaseAdmission.resolve();
	await service.waitForQuiescence();
	assert.equal((await store.getTask("task"))?.status, "succeeded");
	await service.stop();
});

test("actual task timeout aborts the turn and durably fails a non-retryable task", async () => {
	const store = new InMemoryCollaborationStore();
	await addRun(store, { roomId: "room", runId: "run", tasks: [{ id: "task" }] });
	let sawAbort = false;
	const service = new TeamRuntimeService({
		store,
		workerId: "runtime",
		validateAgentId: () => true,
		taskTimeoutMs: 20,
		leaseDurationMs: 1_000,
		leaseRenewIntervalMs: 100,
		idlePollMs: 10_000,
		runTurn: async ({ signal }) => {
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener("abort", () => {
					sawAbort = true;
					reject(signal.reason);
				}, { once: true });
			});
			return { reply: "unreachable" };
		},
	});
	await service.start();
	await service.waitForQuiescence();
	assert.equal(sawAbort, true);
	const attempt = (await store.listAttempts("task"))[0];
	assert.equal(attempt?.errorCode, "EXECUTION_TIMEOUT");
	assert.equal(attempt?.usage.costComplete, false);
	assert.equal((await store.getTask("task"))?.status, "failed");
	assert.equal((await store.getRun("run"))?.status, "failed");
	await service.stop();
});

test("timeout can settle a cooperative runner's usage without reclassifying the failure", async () => {
	const store = new InMemoryCollaborationStore();
	await addRun(store, { roomId: "room", runId: "run", tasks: [{ id: "task", retry: 2 }] });
	const taskSnapshot = await store.getTask("task");
	assert.ok(taskSnapshot);
	// Exercise the runtime's policy gate: EXECUTION_TIMEOUT is not allow-listed.
	const snapshot = await store.readSnapshot();
	const task = snapshot.tasks.find((candidate) => candidate.id === "task")!;
	task.retry.retryableCodes = ["RATE_LIMIT"];
	const seeded = new InMemoryCollaborationStore(snapshot);
	const service = new TeamRuntimeService({
		store: seeded,
		workerId: "runtime",
		validateAgentId: () => true,
		taskTimeoutMs: 20,
		leaseDurationMs: 500,
		leaseRenewIntervalMs: 100,
		idlePollMs: 10_000,
		runTurn: async ({ signal }) => {
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			return { reply: "partial", usage: { tokens: 7, costUsd: 0.07 } };
		},
	});
	await service.start();
	await service.waitForQuiescence();
	const attempts = await seeded.listAttempts("task");
	assert.equal(attempts.length, 1);
	assert.equal(attempts[0]?.errorCode, "EXECUTION_TIMEOUT");
	assert.equal(attempts[0]?.usage.tokens, 7);
	assert.equal((await seeded.getRun("run"))?.usage.tokens, 7);
	await service.stop();
});

test("unknown assigned agent fails the claimed attempt promptly instead of falling through or waiting for lease expiry", async () => {
	const store = new InMemoryCollaborationStore();
	await addRun(store, { roomId: "room", runId: "run", tasks: [{ id: "task", agentId: "ghost" }] });
	let runnerCalled = false;
	const service = new TeamRuntimeService({
		store,
		workerId: "runtime",
		validateAgentId: (agentId) => agentId !== "ghost",
		idlePollMs: 10_000,
		runTurn: async () => {
			runnerCalled = true;
			return { reply: "must not run" };
		},
	});
	await service.start();
	await service.waitForQuiescence();
	assert.equal(runnerCalled, false);
	assert.equal((await store.listAttempts("task"))[0]?.errorCode, "RUNTIME_PREFLIGHT_ERROR");
	assert.equal((await store.getTask("task"))?.status, "failed");
	await service.stop();
});

test("active attempts reject handoffs to agents removed from the runtime catalogue", async () => {
	const store = new InMemoryCollaborationStore();
	await addRun(store, {
		roomId: "room",
		runId: "run",
		tasks: [{ id: "task", agentId: "alice" }],
	});
	const service = new TeamRuntimeService({
		store,
		workerId: "runtime",
		validateAgentId: (agentId) => agentId === "alice",
		idlePollMs: 10_000,
		runTurn: async () => {
			await assert.rejects(
				requireActiveTeamExecutionContext().offerHandoff({ toAgentId: "bob" }),
				(error: unknown) =>
					error instanceof CollaborationConflictError && error.code === "UNKNOWN_AGENT",
			);
			return { reply: "Alice completed without an invalid handoff" };
		},
	});
	await service.start();
	await service.waitForQuiescence();
	assert.equal((await store.listHandoffs("run")).length, 0);
	assert.equal((await store.getTask("task"))?.status, "succeeded");
	await service.stop();
});

test("durable run cancellation aborts the active callback and cannot be overwritten by a late reply", async () => {
	const store = new InMemoryCollaborationStore();
	await addRun(store, { roomId: "room", runId: "run", tasks: [{ id: "task" }] });
	const started = deferred<void>();
	let aborted = false;
	const service = new TeamRuntimeService({
		store,
		workerId: "runtime",
		validateAgentId: () => true,
		idlePollMs: 10_000,
		runTurn: async ({ signal }) => {
			started.resolve();
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
				aborted = true;
				resolve();
			}, { once: true }));
			return { reply: "late reply" };
		},
	});
	await service.start();
	await started.promise;
	await service.cancelRun("run", "operator cancelled");
	await service.waitForQuiescence();
	assert.equal(aborted, true);
	assert.equal((await store.getRun("run"))?.status, "cancelled");
	assert.equal((await store.getTask("task"))?.status, "cancelled");
	assert.notEqual((await store.getTask("task"))?.result, "late reply");
	await service.stop();
});

test("approval waits pause the execution timeout and approved work resumes to completion", async () => {
	const store = new InMemoryCollaborationStore();
	await addRun(store, { roomId: "room", runId: "run", tasks: [{ id: "task", agentId: "alice" }] });
	const service = new TeamRuntimeService({
		store,
		workerId: "runtime",
		validateAgentId: () => true,
		taskTimeoutMs: 25,
		leaseDurationMs: 200,
		leaseRenewIntervalMs: 20,
		idlePollMs: 10_000,
		runTurn: async () => {
			const approval = await requireActiveTeamExecutionContext().requestApproval({
				kind: "deploy",
				prompt: "Approve deployment?",
				expiresInMs: 1_000,
			});
			assert.equal(approval.status, "approved");
			return { reply: "approved result" };
		},
	});
	await service.start();
	await waitFor(async () => (await store.listApprovals("run")).length === 1);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(service.listActiveAttempts()[0]?.paused, true);
	assert.equal((await store.getTask("task"))?.status, "waiting_approval");
	const approval = (await store.listApprovals("run"))[0]!;
	await store.resolveApproval({
		commandId: "approval.resolve",
		approvalId: approval.id,
		decision: "approved",
		now: Date.now(),
	});
	await service.kick();
	await service.waitForQuiescence();
	assert.equal((await store.getTask("task"))?.status, "succeeded");
	assert.equal((await store.getTask("task"))?.result, "approved result");
	await service.stop();
});

test("approval polling removes abort listeners after every timed poll", async () => {
	const store = new InMemoryCollaborationStore();
	await addRun(store, { roomId: "room", runId: "run", tasks: [{ id: "task", agentId: "alice" }] });
	let signal: AbortSignal | undefined;
	const service = new TeamRuntimeService({
		store,
		workerId: "runtime",
		validateAgentId: () => true,
		leaseDurationMs: 1_000,
		leaseRenewIntervalMs: 100,
		idlePollMs: 1,
		runTurn: async (request) => {
			signal = request.signal;
			const attempt = (await store.listAttempts("task"))[0]!;
			await store.requestApproval({
				commandId: "approval.request",
				approvalId: "approval",
				attemptId: attempt.id,
				leaseToken: attempt.lease.token,
				fence: attempt.lease.fence,
				kind: "deploy",
				prompt: "Proceed?",
				requestedBy: "alice",
				now: Date.now(),
			});
			return { reply: "approved result" };
		},
	});
	await service.start();
	await waitFor(async () => (await store.getTask("task"))?.status === "waiting_approval");
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.ok(signal);
	assert.ok(
		getEventListeners(signal, "abort").length <= 2,
		"timed polling must not retain one abort listener per interval",
	);
	await store.resolveApproval({
		commandId: "approval.resolve",
		approvalId: "approval",
		decision: "approved",
		now: Date.now(),
	});
	await service.kick();
	await service.waitForQuiescence();
	assert.equal((await store.getTask("task"))?.status, "succeeded");
	await service.stop();
});

test("accepted handoff fences the old callback and the pump resumes the task as the target agent", async () => {
	const store = new InMemoryCollaborationStore();
	await addRun(store, {
		roomId: "room",
		runId: "run",
		tasks: [{ id: "task", agentId: "alice", retry: 1 }],
		concurrency: 1,
	});
	const agents: string[] = [];
	let postHandoffSideEffect = false;
	const service = new TeamRuntimeService({
		store,
		workerId: "runtime",
		validateAgentId: () => true,
		taskTimeoutMs: 25,
		leaseDurationMs: 200,
		leaseRenewIntervalMs: 20,
		idlePollMs: 10_000,
		runTurn: async ({ agentId, signal }) => {
			agents.push(agentId);
			if (agentId === "alice") {
				const handoff = await requireActiveTeamExecutionContext().offerHandoff({
					toAgentId: "bob",
					reason: "Bob owns deployment",
					expiresInMs: 1_000,
				});
				assert.equal(handoff.status, "accepted");
				if (!signal.aborted) postHandoffSideEffect = true;
				assert.equal(signal.aborted, true, "ownership transfer retires the old workspace-capable turn");
				return { reply: "obsolete Alice reply", usage: { tokens: 10, costUsd: 0.1 } };
			}
			return { reply: "Bob completed the task", usage: { tokens: 20, costUsd: 0.2 } };
		},
	});
	await service.start();
	await waitFor(async () => (await store.listHandoffs("run")).length === 1);
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(service.listActiveAttempts()[0]?.paused, true);
	const offered = (await store.listHandoffs("run"))[0]!;
	await store.acceptHandoff({
		commandId: "handoff.accept",
		handoffId: offered.id,
		respondingAgentId: "bob",
		now: Date.now(),
	});
	await service.kick();
	await service.waitForQuiescence();
	assert.deepEqual(agents, ["alice", "bob"]);
	assert.equal((await store.getTask("task"))?.result, "Bob completed the task");
	assert.equal((await store.getRun("run"))?.status, "completed");
	assert.equal((await store.getRun("run"))?.usage.tokens, 30);
	assert.ok(Math.abs(((await store.getRun("run"))?.usage.costUsd ?? 0) - 0.3) < 1e-9);
	const attempts = await store.listAttempts("task");
	assert.deepEqual(attempts.map((attempt) => attempt.status), ["handed_off", "succeeded"]);
	assert.deepEqual(attempts.map((attempt) => attempt.usage.tokens), [10, 20]);
	assert.equal(postHandoffSideEffect, false);
	await service.stop();
});

test("a rejected approval aborts the old workspace-capable turn before it can continue", async () => {
	const store = new InMemoryCollaborationStore();
	await addRun(store, {
		roomId: "room",
		runId: "run",
		tasks: [{ id: "task", agentId: "alice" }],
		concurrency: 1,
	});
	let postDecisionSideEffect = false;
	const service = new TeamRuntimeService({
		store,
		workerId: "runtime",
		validateAgentId: () => true,
		leaseDurationMs: 1_000,
		leaseRenewIntervalMs: 100,
		idlePollMs: 10_000,
		runTurn: async ({ signal }) => {
			const approval = await requireActiveTeamExecutionContext().requestApproval({
				kind: "deploy",
				prompt: "Deploy?",
				expiresInMs: 1_000,
			});
			assert.equal(approval.status, "rejected");
			if (!signal.aborted) postDecisionSideEffect = true;
			assert.equal(signal.aborted, true, "rejection retires the workspace-capable turn");
			return { reply: "retired", usage: { tokens: 7, costUsd: 0.07 } };
		},
	});
	await service.start();
	await waitFor(async () => (await store.listApprovals("run")).length === 1);
	const approval = (await store.listApprovals("run"))[0]!;
	await store.resolveApproval({
		commandId: "approval.reject",
		approvalId: approval.id,
		decision: "rejected",
		now: Date.now(),
	});
	await service.kick();
	await service.waitForQuiescence();
	assert.equal(postDecisionSideEffect, false);
	assert.equal((await store.getTask("task"))?.status, "failed");
	assert.equal((await store.listAttempts("task"))[0]?.usage.tokens, 7);
	await service.stop();
});

test("lease renewal racing an accepted handoff still retires the old turn and records cooperative usage", async () => {
	const store = new InMemoryCollaborationStore();
	await addRun(store, {
		roomId: "room",
		runId: "run",
		tasks: [{ id: "task", agentId: "alice", retry: 1 }],
		concurrency: 2,
	});
	let aliceAborted = false;
	const service = new TeamRuntimeService({
		store,
		workerId: "runtime",
		validateAgentId: () => true,
		leaseDurationMs: 80,
		leaseRenewIntervalMs: 10,
		taskTimeoutMs: 1_000,
		idlePollMs: 10_000,
		runTurn: async ({ agentId, signal }) => {
			if (agentId === "alice") {
				signal.addEventListener("abort", () => { aliceAborted = true; }, { once: true });
				const handoff = await requireActiveTeamExecutionContext().offerHandoff({
					toAgentId: "bob",
					signal,
				});
				assert.equal(handoff.status, "accepted");
				await new Promise((resolve) => setTimeout(resolve, 25));
				return { reply: "retired", usage: { tokens: 3, costUsd: 0.03 } };
			}
			return { reply: "bob result", usage: { tokens: 5, costUsd: 0.05 } };
		},
	});
	await service.start();
	await waitFor(async () => (await store.listHandoffs("run")).length === 1);
	const offered = (await store.listHandoffs("run"))[0]!;
	await store.acceptHandoff({
		commandId: "handoff.accept.race",
		handoffId: offered.id,
		respondingAgentId: "bob",
		now: Date.now(),
	});
	await service.kick();
	await service.waitForQuiescence();
	assert.equal(aliceAborted, true);
	assert.equal((await store.getTask("task"))?.result, "bob result");
	assert.equal((await store.getRun("run"))?.usage.tokens, 8);
	await service.stop();
});

test("durable run cancellation aborts a terminal handoff callback that is still unwinding", async () => {
	const store = new InMemoryCollaborationStore();
	await addRun(store, {
		roomId: "room",
		runId: "run",
		tasks: [{ id: "task", agentId: "alice", retry: 1 }],
		concurrency: 1,
	});
	const handoffSettled = deferred<void>();
	const releaseCallback = deferred<void>();
	let aliceAborted = false;
	const service = new TeamRuntimeService({
		store,
		workerId: "runtime",
		validateAgentId: () => true,
		globalConcurrency: 1,
		leaseDurationMs: 200,
		leaseRenewIntervalMs: 20,
		taskTimeoutMs: 1_000,
		idlePollMs: 10_000,
		runTurn: async ({ signal }) => {
			await requireActiveTeamExecutionContext().offerHandoff({ toAgentId: "bob", signal });
			aliceAborted = signal.aborted;
			handoffSettled.resolve();
			await releaseCallback.promise;
			return { reply: "retired", usage: { tokens: 1, costUsd: 0.01 } };
		},
	});
	await service.start();
	await waitFor(async () => (await store.listHandoffs("run")).length === 1);
	const handoff = (await store.listHandoffs("run"))[0]!;
	await store.acceptHandoff({
		commandId: "handoff.accept.before-cancel",
		handoffId: handoff.id,
		respondingAgentId: "bob",
		now: Date.now(),
	});
	await handoffSettled.promise;
	await store.cancelRun({ commandId: "run.cancel.after-handoff", runId: "run", now: Date.now() });
	releaseCallback.resolve();
	await service.kick();
	await service.waitForQuiescence();
	assert.equal(aliceAborted, true);
	assert.equal((await store.getRun("run"))?.status, "cancelled");
	await service.stop();
});

test("startup reconciliation rejects orphan decisions from expired attempts", async () => {
	const store = new InMemoryCollaborationStore();
	await addRun(store, {
		roomId: "room",
		runId: "run",
		tasks: [{ id: "approval", agentId: "alice" }, { id: "handoff", agentId: "bob" }],
		concurrency: 2,
	});
	const first = (await store.claimReadyTask({
		commandId: "claim.first",
		now: 10,
		workerId: "old",
		leaseDurationMs: 5,
	})).value!;
	const second = (await store.claimReadyTask({
		commandId: "claim.second",
		now: 10,
		workerId: "old",
		leaseDurationMs: 5,
	})).value!;
	const approvalAttempt = first.taskId === "approval" ? first : second;
	const handoffAttempt = first.taskId === "handoff" ? first : second;
	await store.requestApproval({
		commandId: "approval.request",
		now: 11,
		attemptId: approvalAttempt.id,
		leaseToken: approvalAttempt.lease.token,
		fence: approvalAttempt.lease.fence,
		kind: "deploy",
		prompt: "Approve?",
		requestedBy: "alice",
	});
	await store.offerHandoff({
		commandId: "handoff.offer",
		now: 11,
		attemptId: handoffAttempt.id,
		leaseToken: handoffAttempt.lease.token,
		fence: handoffAttempt.lease.fence,
		fromAgentId: "bob",
		toAgentId: "alice",
	});
	const service = new TeamRuntimeService({
		store,
		workerId: "new",
		now: () => 20,
		validateAgentId: () => true,
		idlePollMs: 10_000,
		runTurn: async () => ({ reply: "unused" }),
	});
	await service.start();
	await service.waitForQuiescence();
	assert.equal((await store.listApprovals("run"))[0]?.status, "rejected");
	assert.equal((await store.listHandoffs("run"))[0]?.status, "rejected");
	await service.stop();
});

test("startup reconciliation fences an expired pre-restart attempt and executes its retry", async () => {
	const before = new InMemoryCollaborationStore();
	await addRun(before, { roomId: "room", runId: "run", tasks: [{ id: "task", retry: 2 }] });
	const old = await before.claimReadyTask({
		commandId: "old.claim",
		runId: "run",
		workerId: "old-runtime",
		leaseDurationMs: 5,
		now: 10,
	});
	assert.ok(old.value);
	const restarted = new InMemoryCollaborationStore(await before.readSnapshot());
	let now = 20;
	const service = new TeamRuntimeService({
		store: restarted,
		workerId: "new-runtime",
		validateAgentId: () => true,
		leaseDurationMs: 100,
		leaseRenewIntervalMs: 25,
		idlePollMs: 10_000,
		now: () => now++,
		runTurn: async () => ({ reply: "recovered" }),
	});
	await service.start();
	await service.waitForQuiescence();
	const attempts = await restarted.listAttempts("task");
	assert.equal(attempts[0]?.status, "timed_out");
	assert.equal(attempts[1]?.lease.fence, old.value.lease.fence + 1);
	assert.equal(attempts[1]?.status, "succeeded");
	await service.stop();
});

test("outbox retries with backoff without allowing a later roomSeq to leapfrog", async () => {
	const store = new InMemoryCollaborationStore();
	await addRun(store, { roomId: "room", runId: "run", tasks: [{ id: "task" }] });
	const attempts = new Map<number, number>();
	const delivered: number[] = [];
	const service = new TeamRuntimeService({
		store,
		workerId: "runtime",
		validateAgentId: () => true,
		idlePollMs: 5,
		outboxBackoffBaseMs: 5,
		outboxBackoffMaxMs: 5,
		outboxLeaseMs: 100,
		outboxBatchSize: 50,
		outboxPublisher: {
			async publish(event) {
				const count = (attempts.get(event.roomSeq) ?? 0) + 1;
				attempts.set(event.roomSeq, count);
				if (event.roomSeq === 1 && count === 1) throw new Error("temporary transport error");
				delivered.push(event.roomSeq);
			},
		},
		runTurn: async () => ({ reply: "done" }),
	});
	await service.start();
	await service.waitForQuiescence();
	await waitFor(async () => (await store.readSnapshot()).outbox.every((item) => item.status === "acked"), 2_000);
	assert.deepEqual(delivered, [...delivered].sort((a, b) => a - b));
	assert.equal(attempts.get(1), 2);
	await service.stop();
});

test("a stalled outbox publisher does not block startup or task claims", async () => {
	const store = new InMemoryCollaborationStore();
	await addRun(store, { roomId: "room", runId: "run", tasks: [{ id: "task", agentId: "alice" }] });
	const publishStarted = deferred<void>();
	const releasePublish = deferred<void>();
	const turnStarted = deferred<void>();
	const releaseTurn = deferred<void>();
	const service = new TeamRuntimeService({
		store,
		workerId: "runtime",
		validateAgentId: () => true,
		idlePollMs: 10_000,
		outboxPublisher: {
			async publish() {
				publishStarted.resolve();
				await releasePublish.promise;
			},
		},
		runTurn: async () => {
			turnStarted.resolve();
			await releaseTurn.promise;
			return { reply: "done" };
		},
	});
	const started = await Promise.race([
		service.start().then(() => true),
		new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_000)),
	]);
	assert.equal(started, true, "gateway startup must not await coordinator delivery");
	await Promise.all([publishStarted.promise, turnStarted.promise]);
	assert.equal((await store.listAttempts("task")).length, 1);
	releaseTurn.resolve();
	releasePublish.resolve();
	await service.waitForQuiescence();
	assert.equal((await store.getTask("task"))?.status, "succeeded");
	await service.stop();
});

test("runtime delegation yields, runs children at concurrency one, and resumes with child evidence", async () => {
	const store = new InMemoryCollaborationStore();
	await addRun(store, {
		roomId: "delegation-room",
		runId: "delegation-run",
		tasks: [{ id: "parent", agentId: "alice" }],
		concurrency: 1,
	});
	let parentTurns = 0;
	const observedPrompts: string[] = [];
	const service = new TeamRuntimeService({
		store,
		workerId: "runtime",
		globalConcurrency: 1,
		validateAgentId: (agentId) => agentId === "alice" || agentId === "bob",
		idlePollMs: 10_000,
		runTurn: async (request) => {
			observedPrompts.push(request.prompt);
			if (request.executionContext.taskId === "child") {
				return { reply: "specialist evidence", usage: { tokens: 3, costUsd: 0 } };
			}
			parentTurns += 1;
			if (parentTurns === 1) {
				await requireActiveTeamExecutionContext().delegateChildren({
					requestKey: "specialist-v1",
					delegationKind: "consultation",
					tasks: [{
						id: "child",
						title: "Consult specialist",
						instructions: "Return evidence",
						assignedAgentId: "bob",
					}],
				});
				return { reply: "stale source reply must not complete parent", usage: { tokens: 5, costUsd: 0 } };
			}
			assert.match(request.prompt, /Authoritative direct dependency taskIds: \["child"\]/);
			assert.match(request.prompt, /specialist evidence/);
			return { reply: "final parent result", usage: { tokens: 7, costUsd: 0 } };
		},
	});

	await service.start();
	await service.waitForQuiescence();
	assert.equal(parentTurns, 2);
	assert.equal((await store.getTask("parent"))?.result, "final parent result");
	assert.equal((await store.getRun("delegation-run"))?.status, "completed");
	assert.equal((await store.getRun("delegation-run"))?.usage.tokens, 15);
	const parentAttempts = await store.listAttempts("parent");
	assert.deepEqual(parentAttempts.map((attempt) => attempt.status), ["delegated", "succeeded"]);
	assert.equal(parentAttempts[0]?.usageRecorded, true);
	assert.equal(parentAttempts[1]?.lease.fence, (parentAttempts[0]?.lease.fence ?? 0) + 1);
	assert.equal(observedPrompts.length, 3);
	await service.stop();
});
