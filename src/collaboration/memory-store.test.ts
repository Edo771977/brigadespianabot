import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryCollaborationStore } from "./memory-store.js";
import { CollaborationBudgetError, CollaborationConflictError } from "./types.js";
import type { RunBudgets } from "./types.js";
import type { DelegateRunCommand, TaskDraft } from "./store.js";

async function startedStore(tasks: TaskDraft[], budgets: RunBudgets = {}): Promise<InMemoryCollaborationStore> {
	const store = new InMemoryCollaborationStore();
	const members = new Set(tasks.flatMap((task) => task.assignedAgentId ? [task.assignedAgentId] : []));
	// Handoff fixtures use bob as the successor to alice.
	members.add("bob");
	await store.createRoom({
		commandId: "room.create",
		roomId: "room",
		title: "Delivery",
		createdBy: "owner",
		members: [...members].map((agentId) => ({ agentId })),
		now: 1,
	});
	await store.createRun({
		commandId: "run.create",
		runId: "run",
		roomId: "room",
		objective: "Ship the result",
		createdBy: "owner",
		budgets,
		now: 2,
	});
	await store.addTasks({ commandId: "tasks.add", runId: "run", tasks, now: 3 });
	await store.startRun({ commandId: "run.start", runId: "run", now: 4 });
	return store;
}

async function claim(
	store: InMemoryCollaborationStore,
	commandId: string,
	now: number,
	agentId?: string,
) {
	const result = await store.claimReadyTask({
		commandId,
		runId: "run",
		workerId: "worker",
		leaseDurationMs: 100,
		...(agentId ? { agentId } : {}),
		now,
	});
	assert.ok(result.value, "expected a claimable task");
	return result.value;
}

async function succeed(store: InMemoryCollaborationStore, attempt: Awaited<ReturnType<typeof claim>>, commandId: string, now: number) {
	return store.completeAttempt({
		commandId,
		attemptId: attempt.id,
		leaseToken: attempt.lease.token,
		fence: attempt.lease.fence,
		result: `${attempt.taskId} done`,
		now,
	});
}

test("starting an empty run fails atomically instead of leaving an immortal running run", async () => {
	const store = new InMemoryCollaborationStore();
	await store.createRoom({
		commandId: "empty.room",
		roomId: "room",
		title: "Empty run guard",
		createdBy: "owner",
		now: 1,
	});
	await store.createRun({
		commandId: "empty.run",
		runId: "run",
		roomId: "room",
		objective: "Must have executable work",
		createdBy: "owner",
		now: 2,
	});
	const before = await store.readSnapshot();
	await assert.rejects(
		store.startRun({ commandId: "empty.start", runId: "run", now: 3 }),
		(error: unknown) => error instanceof CollaborationConflictError && error.code === "RUN_HAS_NO_TASKS",
	);
	assert.deepEqual(await store.readSnapshot(), before);
	assert.equal((await store.getRun("run"))?.status, "created");
});

test("review verdict gates fail closed in the durable authority", async () => {
	const store = await startedStore([{
		id: "final-review",
		title: "Final review",
		instructions: "Verify",
		resultGate: { kind: "review_verdict" },
	}]);
	const attempt = await claim(store, "review.claim", 5);
	const completion = await store.completeAttempt({
		commandId: "review.complete",
		attemptId: attempt.id,
		leaseToken: attempt.lease.token,
		fence: attempt.lease.fence,
		result: "REVIEW: FAIL\nThe deliverable is incomplete.",
		usage: { tokens: 12, costUsd: 0.02 },
		artifacts: [{
			id: "review-diagnostics",
			kind: "review-report",
			name: "Failed review diagnostics",
			uri: "artifact://review-diagnostics",
			metadata: { failingCheck: "integration" },
		}],
		now: 6,
	});

	assert.equal(completion.value.status, "failed");
	assert.equal(completion.value.errorCode, "RESULT_GATE_FAILED");
	assert.match(String(completion.value.result), /deliverable is incomplete/);
	assert.equal((await store.getTask("final-review"))?.status, "failed");
	assert.match(String((await store.getTask("final-review"))?.result), /deliverable is incomplete/);
	assert.equal((await store.getRun("run"))?.status, "failed");
	assert.equal((await store.getRun("run"))?.usage.tokens, 12);
	assert.deepEqual((await store.listArtifacts("run"))[0], {
		id: "review-diagnostics",
		runId: "run",
		taskId: "final-review",
		attemptId: attempt.id,
		kind: "review-report",
		name: "Failed review diagnostics",
		uri: "artifact://review-diagnostics",
		metadata: { failingCheck: "integration" },
		createdAt: 6,
	});
	assert.ok(completion.events.some((event) =>
		event.type === "artifact.created" && event.attemptId === attempt.id
	));
	await store.retryTask({ commandId: "review.retry", taskId: "final-review", now: 7 });
	assert.equal((await store.getTask("final-review"))?.status, "ready");
	assert.equal((await store.getTask("final-review"))?.result, undefined);
	assert.match(String((await store.listAttempts("final-review"))[0]?.result), /deliverable is incomplete/);
});

test("review verdict gates accept only an explicit pass verdict", async () => {
	const store = await startedStore([{
		id: "final-review",
		title: "Final review",
		instructions: "Verify",
		resultGate: { kind: "review_verdict" },
	}]);
	const attempt = await claim(store, "review-pass.claim", 5);
	const completion = await store.completeAttempt({
		commandId: "review-pass.complete",
		attemptId: attempt.id,
		leaseToken: attempt.lease.token,
		fence: attempt.lease.fence,
		result: "  REVIEW: PASS\nAll checks succeeded.",
		now: 6,
	});

	assert.equal(completion.value.status, "succeeded");
	assert.equal((await store.getRun("run"))?.status, "completed");
});

test("worker delegation yields its attempt and resumes only after children and source usage settle", async () => {
	const store = await startedStore([{
		id: "parent",
		title: "Parent",
		instructions: "Coordinate",
		assignedAgentId: "alice",
	}], { maxConcurrency: 1 });
	const source = await claim(store, "parent.claim", 5, "alice");
	const delegated = await store.delegateAttemptChildren({
		commandId: "parent.delegate",
		attemptId: source.id,
		leaseToken: source.lease.token,
		fence: source.lease.fence,
		requestKey: "research-v1",
		delegationKind: "consultation",
		tasks: [{
			id: "child",
			title: "Specialist answer",
			instructions: "Answer briefly",
			assignedAgentId: "bob",
		}],
		now: 6,
	});
	assert.equal(delegated.value.yieldedAttempt.status, "delegated");
	assert.equal(delegated.value.parentTask.status, "waiting_children");
	assert.equal(delegated.value.children[0]?.parentTaskId, "parent");
	assert.equal(delegated.value.children[0]?.delegatedByAttemptId, source.id);
	assert.equal(delegated.value.children[0]?.requestKey, "research-v1");
	assert.equal((await store.getRun("run"))?.usage.activeAttempts, 0);

	const child = (await store.claimReadyTask({
		commandId: "child.claim",
		runId: "run",
		taskId: "child",
		agentId: "bob",
		workerId: "worker",
		leaseDurationMs: 100,
		now: 7,
	})).value!;
	await store.completeAttempt({
		commandId: "child.complete",
		attemptId: child.id,
		leaseToken: child.lease.token,
		fence: child.lease.fence,
		result: "specialist result",
		now: 8,
	});
	assert.equal((await store.getTask("parent"))?.status, "waiting_children", "child settlement alone must not race source usage");
	await store.recordAttemptUsage({
		commandId: "parent.usage",
		attemptId: source.id,
		leaseToken: source.lease.token,
		fence: source.lease.fence,
		usage: { tokens: 13, costUsd: 0.01 },
		now: 9,
	});
	assert.equal((await store.getTask("parent"))?.status, "ready");
	const resumed = await claim(store, "parent.resume", 10, "alice");
	assert.equal(resumed.taskId, "parent");
	assert.equal(resumed.number, 2);
	assert.equal(resumed.lease.fence, source.lease.fence + 1);
	await assert.rejects(
		store.completeAttempt({
			commandId: "parent.stale",
			attemptId: source.id,
			leaseToken: source.lease.token,
			fence: source.lease.fence,
			result: "stale provider result",
			now: 11,
		}),
		(error: unknown) => error instanceof CollaborationConflictError && error.code === "STALE_ATTEMPT",
	);
});

test("delegation request keys are semantic-idempotent and remain fence scoped", async () => {
	const store = await startedStore([{
		id: "parent",
		title: "Parent",
		instructions: "Coordinate",
		assignedAgentId: "alice",
	}]);
	const source = await claim(store, "delegate.claim", 5, "alice");
	const input = {
		attemptId: source.id,
		leaseToken: source.lease.token,
		fence: source.lease.fence,
		requestKey: "stable-key",
		tasks: [{ id: "child", title: "Child", instructions: "Work", assignedAgentId: "bob" }],
		now: 6,
	};
	const first = await store.delegateAttemptChildren({ commandId: "delegate.first", ...input });
	const retry = await store.delegateAttemptChildren({ commandId: "delegate.retry", ...input, now: 7 });
	assert.equal(first.value.deduplicated, false);
	assert.equal(retry.value.deduplicated, true);
	assert.equal((await store.listTasks("run")).filter((task) => task.parentTaskId === "parent").length, 1);
	await assert.rejects(
		store.delegateAttemptChildren({
			commandId: "delegate.conflict",
			...input,
			tasks: [{ id: "other", title: "Different", instructions: "Work", assignedAgentId: "bob" }],
			now: 8,
		}),
		(error: unknown) => error instanceof CollaborationConflictError && error.code === "DELEGATION_REQUEST_CONFLICT",
	);
	await assert.rejects(
		store.delegateAttemptChildren({ commandId: "delegate.stale-fence", ...input, fence: source.lease.fence + 1, now: 8 }),
		(error: unknown) => error instanceof CollaborationConflictError && error.code === "FENCE_MISMATCH",
	);
});

test("delegation rejects causal cycles and survives snapshot restart until unknown usage reconciliation", async () => {
	const store = await startedStore([{
		id: "parent",
		title: "Parent",
		instructions: "Coordinate",
		assignedAgentId: "alice",
	}]);
	const source = await claim(store, "restart.claim", 5, "alice");
	await assert.rejects(
		store.delegateAttemptChildren({
			commandId: "cycle",
			attemptId: source.id,
			leaseToken: source.lease.token,
			fence: source.lease.fence,
			requestKey: "cycle",
			tasks: [{ id: "cyclic-child", title: "Cycle", instructions: "Bad", assignedAgentId: "bob", dependencies: ["parent"] }],
			now: 6,
		}),
		(error: unknown) => error instanceof CollaborationConflictError && error.code === "DELEGATION_CYCLE",
	);
	await store.delegateAttemptChildren({
		commandId: "restart.delegate",
		attemptId: source.id,
		leaseToken: source.lease.token,
		fence: source.lease.fence,
		requestKey: "restart",
		tasks: [{ id: "child", title: "Child", instructions: "Work", assignedAgentId: "bob" }],
		now: 7,
	});
	const restarted = new InMemoryCollaborationStore(await store.readSnapshot());
	const child = (await restarted.claimReadyTask({
		commandId: "restart.child.claim",
		runId: "run",
		taskId: "child",
		agentId: "bob",
		workerId: "restarted",
		leaseDurationMs: 100,
		now: 8,
	})).value!;
	await restarted.failAttempt({
		commandId: "restart.child.fail",
		attemptId: child.id,
		leaseToken: child.lease.token,
		fence: child.lease.fence,
		errorCode: "SPECIALIST_FAILED",
		errorMessage: "specialist could not answer",
		retryable: false,
		now: 9,
	});
	assert.equal((await restarted.getTask("parent"))?.status, "waiting_children");
	await restarted.reconcile({ commandId: "restart.reconcile", now: 37_001 });
	assert.equal((await restarted.getAttempt(source.id))?.usage.costComplete, false);
	assert.equal((await restarted.getTask("parent"))?.status, "ready", "unknown usage settlement releases the durable child join");
});

test("nested delegation returns grandchild failure evidence through each durable parent join", async () => {
	const store = await startedStore([{
		id: "root",
		title: "Root",
		instructions: "Coordinate",
		assignedAgentId: "alice",
	}]);
	const rootSource = await claim(store, "nested.root.claim", 5, "alice");
	await store.delegateAttemptChildren({
		commandId: "nested.root.delegate",
		attemptId: rootSource.id,
		leaseToken: rootSource.lease.token,
		fence: rootSource.lease.fence,
		requestKey: "root-child",
		tasks: [{ id: "child", title: "Child", instructions: "Coordinate deeper", assignedAgentId: "bob" }],
		now: 6,
	});
	const childSource = (await store.claimReadyTask({
		commandId: "nested.child.claim",
		runId: "run",
		taskId: "child",
		agentId: "bob",
		workerId: "worker",
		leaseDurationMs: 100,
		now: 7,
	})).value!;
	await store.delegateAttemptChildren({
		commandId: "nested.child.delegate",
		attemptId: childSource.id,
		leaseToken: childSource.lease.token,
		fence: childSource.lease.fence,
		requestKey: "grandchild",
		delegationKind: "rework",
		tasks: [{ id: "grandchild", title: "Grandchild", instructions: "Try correction", assignedAgentId: "alice" }],
		now: 8,
	});
	assert.equal((await store.getTask("grandchild"))?.delegationDepth, 2);
	const grandchild = (await store.claimReadyTask({
		commandId: "nested.grandchild.claim",
		runId: "run",
		taskId: "grandchild",
		agentId: "alice",
		workerId: "worker",
		leaseDurationMs: 100,
		now: 9,
	})).value!;
	await store.failAttempt({
		commandId: "nested.grandchild.fail",
		attemptId: grandchild.id,
		leaseToken: grandchild.lease.token,
		fence: grandchild.lease.fence,
		errorCode: "NO_FIX",
		errorMessage: "correction did not work",
		retryable: false,
		now: 10,
	});
	await store.recordAttemptUsage({
		commandId: "nested.child.usage",
		attemptId: childSource.id,
		leaseToken: childSource.lease.token,
		fence: childSource.lease.fence,
		usage: { tokens: 2, costUsd: 0 },
		now: 11,
	});
	assert.equal((await store.getTask("child"))?.status, "ready");
	const childResumed = (await store.claimReadyTask({
		commandId: "nested.child.resume",
		runId: "run",
		taskId: "child",
		agentId: "bob",
		workerId: "worker",
		leaseDurationMs: 100,
		now: 12,
	})).value!;
	await store.completeAttempt({
		commandId: "nested.child.complete",
		attemptId: childResumed.id,
		leaseToken: childResumed.lease.token,
		fence: childResumed.lease.fence,
		result: "Child reports the failed correction",
		now: 13,
	});
	await store.recordAttemptUsage({
		commandId: "nested.root.usage",
		attemptId: rootSource.id,
		leaseToken: rootSource.lease.token,
		fence: rootSource.lease.fence,
		usage: { tokens: 3, costUsd: 0 },
		now: 14,
	});
	assert.equal((await store.getTask("root"))?.status, "ready");
	assert.equal((await store.getTask("grandchild"))?.failureReason, "correction did not work");
});

test("delegation enforces per-command, depth, run-child, and attempt-budget limits", async () => {
	const budgeted = await startedStore([{
		id: "parent",
		title: "Parent",
		instructions: "Coordinate",
		assignedAgentId: "alice",
	}], { maxAttempts: 2 });
	const budgetSource = await claim(budgeted, "limits.budget.claim", 5, "alice");
	await assert.rejects(
		budgeted.delegateAttemptChildren({
			commandId: "limits.budget.delegate",
			attemptId: budgetSource.id,
			leaseToken: budgetSource.lease.token,
			fence: budgetSource.lease.fence,
			requestKey: "over-budget",
			tasks: [{ title: "Child", instructions: "Work", assignedAgentId: "bob" }],
			now: 6,
		}),
		(error: unknown) => error instanceof CollaborationBudgetError && error.reason === "attempts",
	);
	await assert.rejects(
		budgeted.delegateAttemptChildren({
			commandId: "limits.command.delegate",
			attemptId: budgetSource.id,
			leaseToken: budgetSource.lease.token,
			fence: budgetSource.lease.fence,
			requestKey: "too-many-at-once",
			tasks: Array.from({ length: 5 }, (_, index) => ({
				id: `too-many-${index}`,
				title: "Child",
				instructions: "Work",
				assignedAgentId: "bob",
			})),
			now: 6,
		}),
		(error: unknown) => error instanceof CollaborationConflictError && error.code === "INVALID_ARGUMENT",
	);

	const countStore = await startedStore([{
		id: "count-root",
		title: "Root",
		instructions: "Coordinate",
		assignedAgentId: "alice",
	}]);
	const countRoot = await claim(countStore, "limits.count.root.claim", 5, "alice");
	await countStore.delegateAttemptChildren({
		commandId: "limits.count.root.delegate",
		attemptId: countRoot.id,
		leaseToken: countRoot.lease.token,
		fence: countRoot.lease.fence,
		requestKey: "top",
		tasks: Array.from({ length: 4 }, (_, index) => ({
			id: `top-${index}`,
			title: `Top ${index}`,
			instructions: "Coordinate",
			assignedAgentId: "bob",
		})),
		now: 6,
	});
	for (let top = 0; top < 4; top += 1) {
		const topAttempt = (await countStore.claimReadyTask({
			commandId: `limits.count.top.${top}.claim`,
			runId: "run",
			taskId: `top-${top}`,
			agentId: "bob",
			workerId: "worker",
			leaseDurationMs: 100,
			now: 7 + top * 2,
		})).value!;
		await countStore.delegateAttemptChildren({
			commandId: `limits.count.top.${top}.delegate`,
			attemptId: topAttempt.id,
			leaseToken: topAttempt.lease.token,
			fence: topAttempt.lease.fence,
			requestKey: `grandchildren-${top}`,
			tasks: Array.from({ length: 4 }, (_, index) => ({
				id: `grand-${top}-${index}`,
				title: `Grand ${top}-${index}`,
				instructions: "Investigate",
				assignedAgentId: "alice",
			})),
			now: 8 + top * 2,
		});
	}
	const greatSource = (await countStore.claimReadyTask({
		commandId: "limits.count.great.claim",
		runId: "run",
		taskId: "grand-0-0",
		agentId: "alice",
		workerId: "worker",
		leaseDurationMs: 100,
		now: 20,
	})).value!;
	await countStore.delegateAttemptChildren({
		commandId: "limits.count.great.delegate",
		attemptId: greatSource.id,
		leaseToken: greatSource.lease.token,
		fence: greatSource.lease.fence,
		requestKey: "great-four",
		tasks: Array.from({ length: 4 }, (_, index) => ({
			id: `great-${index}`,
			title: `Great ${index}`,
			instructions: "Investigate",
			assignedAgentId: "bob",
		})),
		now: 21,
	});
	const overCountSource = (await countStore.claimReadyTask({
		commandId: "limits.count.over.claim",
		runId: "run",
		taskId: "grand-0-1",
		agentId: "alice",
		workerId: "worker",
		leaseDurationMs: 100,
		now: 22,
	})).value!;
	await assert.rejects(
		countStore.delegateAttemptChildren({
			commandId: "limits.count.over.delegate",
			attemptId: overCountSource.id,
			leaseToken: overCountSource.lease.token,
			fence: overCountSource.lease.fence,
			requestKey: "twenty-five",
			tasks: [{ id: "over-count", title: "Too many", instructions: "Reject", assignedAgentId: "bob" }],
			now: 23,
		}),
		(error: unknown) => error instanceof CollaborationConflictError && error.code === "DELEGATION_LIMIT_EXCEEDED",
	);

	const depthStore = await startedStore([{
		id: "level-0",
		title: "Root",
		instructions: "Coordinate",
		assignedAgentId: "alice",
	}]);
	let currentTaskId = "level-0";
	let currentAgent = "alice";
	for (let depth = 1; depth <= 4; depth += 1) {
		const source = (await depthStore.claimReadyTask({
			commandId: `limits.depth.${depth}.claim`,
			runId: "run",
			taskId: currentTaskId,
			agentId: currentAgent,
			workerId: "worker",
			leaseDurationMs: 100,
			now: 10 + depth * 2,
		})).value!;
		const nextTaskId = `level-${depth}`;
		const nextAgent = currentAgent === "alice" ? "bob" : "alice";
		await depthStore.delegateAttemptChildren({
			commandId: `limits.depth.${depth}.delegate`,
			attemptId: source.id,
			leaseToken: source.lease.token,
			fence: source.lease.fence,
			requestKey: `depth-${depth}`,
			tasks: [{ id: nextTaskId, title: nextTaskId, instructions: "Go deeper", assignedAgentId: nextAgent }],
			now: 11 + depth * 2,
		});
		currentTaskId = nextTaskId;
		currentAgent = nextAgent;
	}
	const deepest = (await depthStore.claimReadyTask({
		commandId: "limits.depth.5.claim",
		runId: "run",
		taskId: "level-4",
		agentId: currentAgent,
		workerId: "worker",
		leaseDurationMs: 100,
		now: 20,
	})).value!;
	await assert.rejects(
		depthStore.delegateAttemptChildren({
			commandId: "limits.depth.5.delegate",
			attemptId: deepest.id,
			leaseToken: deepest.lease.token,
			fence: deepest.lease.fence,
			requestKey: "too-deep",
			tasks: [{ id: "level-5", title: "Too deep", instructions: "Reject", assignedAgentId: "bob" }],
			now: 21,
		}),
		(error: unknown) => error instanceof CollaborationConflictError && error.code === "DELEGATION_DEPTH_EXCEEDED",
	);
});

test("delegateRun atomically validates, creates, plans, and starts one idempotent run", async () => {
	const store = new InMemoryCollaborationStore();
	await store.createRoom({
		commandId: "room.delegate",
		roomId: "room",
		title: "Room",
		createdBy: "owner",
		members: [{ agentId: "maker" }, { agentId: "reviewer" }],
		now: 1,
	});
	const command: DelegateRunCommand = {
		commandId: "delegate",
		runId: "run",
		roomId: "room",
		objective: "Ship safely",
		createdBy: "owner",
		tasks: [
			{ id: "make", title: "Make", instructions: "Build", assignedAgentId: "maker" },
			{ id: "review", title: "Review", instructions: "Verify", assignedAgentId: "reviewer", dependencies: ["make"] },
		],
		now: 2,
	};
	const delegated = await store.delegateRun(command);
	assert.equal(delegated.value.run.status, "running");
	assert.equal(delegated.value.tasks.find((task) => task.id === "make")?.status, "ready");
	assert.equal(delegated.value.tasks.find((task) => task.id === "review")?.status, "blocked");
	assert.ok(delegated.events.length >= 4);
	assert.ok(delegated.events.every((event) => event.commandId === "delegate"));

	const replay = await store.delegateRun({ ...command, now: 99 });
	assert.equal(replay.replayed, true);
	assert.deepEqual(replay.value, delegated.value);
	assert.deepEqual(replay.events, delegated.events);
	await assert.rejects(
		store.delegateRun({ ...command, objective: "Different" }),
		(error: unknown) => error instanceof CollaborationConflictError && error.code === "IDEMPOTENCY_CONFLICT",
	);

	const second = new InMemoryCollaborationStore();
	await second.createRoom({ commandId: "room", roomId: "room", title: "Room", createdBy: "owner", now: 1 });
	const before = await second.readSnapshot();
	await assert.rejects(
		second.delegateRun({
			commandId: "bad",
			runId: "bad-run",
			roomId: "room",
			objective: "Bad DAG",
			createdBy: "owner",
			tasks: [{ id: "task", title: "Task", instructions: "Task", dependencies: ["missing"] }],
			now: 2,
		}),
		(error: unknown) => error instanceof CollaborationConflictError && error.code === "UNKNOWN_DEPENDENCY",
	);
	assert.deepEqual(await second.readSnapshot(), before, "an invalid delegation leaves no partial run, event, outbox row, or receipt");
});

test("delegateRun rejects an oversized durable command without changing authority state", async () => {
	const store = new InMemoryCollaborationStore();
	await store.createRoom({
		commandId: "oversized.room",
		roomId: "room",
		title: "Room",
		createdBy: "owner",
		now: 1,
	});
	const before = await store.readSnapshot();
	await assert.rejects(
		() => store.delegateRun({
			commandId: "oversized.delegate",
			runId: "oversized-run",
			roomId: "room",
			objective: "Too large to persist portably",
			createdBy: "owner",
			tasks: Array.from({ length: 6 }, (_, index) => ({
				id: `task-${index}`,
				title: `Large task ${index}`,
				// Each field stays below the gateway's 100,000-character limit;
				// their combined durable command exceeds the shared byte ceiling.
				instructions: "x".repeat(90_000),
			})),
			now: 2,
		}),
		(error: unknown) =>
			error instanceof CollaborationConflictError &&
			error.code === "INVALID_ARGUMENT" &&
			error.message.includes("atomic delegation command"),
	);
	assert.deepEqual(
		await store.readSnapshot(),
		before,
		"oversized delegation must not create a run, task, event, outbox item, or receipt",
	);
});

test("a room has one active run and accepts the next run after terminal completion", async () => {
	const store = new InMemoryCollaborationStore();
	await store.createRoom({ commandId: "room", roomId: "room", title: "Room", createdBy: "main", now: 1 });
	await store.createRun({ commandId: "first", runId: "first", roomId: "room", objective: "First", createdBy: "main", now: 2 });
	await assert.rejects(
		store.createRun({ commandId: "second.blocked", runId: "second", roomId: "room", objective: "Second", createdBy: "main", now: 3 }),
		(error: unknown) => error instanceof CollaborationConflictError && error.code === "ROOM_ACTIVE_RUN_EXISTS",
	);
	await store.addTasks({ commandId: "first.tasks", runId: "first", tasks: [{ id: "task", title: "Work", instructions: "Work" }], now: 4 });
	await store.startRun({ commandId: "first.start", runId: "first", now: 5 });
	const attempt = (await store.claimReadyTask({ commandId: "first.claim", runId: "first", workerId: "worker", leaseDurationMs: 100, now: 6 })).value;
	assert.ok(attempt);
	await store.completeAttempt({ commandId: "first.complete", attemptId: attempt.id, leaseToken: attempt.lease.token, fence: attempt.lease.fence, result: "done", now: 7 });
	const second = await store.createRun({ commandId: "second.allowed", runId: "second", roomId: "room", objective: "Second", createdBy: "main", now: 8 });
	assert.equal(second.value.status, "created");
});

test("room coordinator identity is unambiguous and cannot outlive membership", async () => {
	const store = new InMemoryCollaborationStore();
	await assert.rejects(
		store.createRoom({
			commandId: "room.invalid-coordinator",
			roomId: "invalid",
			title: "Invalid",
			createdBy: "owner",
			members: [{ agentId: "reviewer" }],
			metadata: { coordinatorAgentId: "main" },
			now: 1,
		}),
		(error: unknown) =>
			error instanceof CollaborationConflictError && error.code === "ROOM_COORDINATOR_NOT_MEMBER",
	);
	await store.createRoom({
		commandId: "room.valid-coordinator",
		roomId: "room",
		title: "Room",
		createdBy: "owner",
		members: [{ agentId: "main", role: "coordinator" }, { agentId: "reviewer" }],
		metadata: { coordinatorAgentId: "main" },
		now: 2,
	});
	await assert.rejects(
		store.updateRoom({
			commandId: "room.remove-coordinator",
			roomId: "room",
			members: [{ agentId: "reviewer" }],
			now: 3,
		}),
		(error: unknown) =>
			error instanceof CollaborationConflictError && error.code === "ROOM_COORDINATOR_NOT_MEMBER",
	);
	assert.deepEqual((await store.getRoom("room"))?.members.map((member) => member.agentId), ["main", "reviewer"]);
});

test("all join unlocks only after every dependency succeeds", async () => {
	const store = await startedStore([
		{ id: "a", title: "A", instructions: "A" },
		{ id: "b", title: "B", instructions: "B" },
		{ id: "join", title: "Join", instructions: "Join", dependencies: ["a", "b"], join: { kind: "all" } },
	]);
	const a = await claim(store, "claim.a", 10);
	const b = await claim(store, "claim.b", 10);
	assert.equal((await store.getTask("join"))?.status, "blocked");
	await succeed(store, a, "complete.a", 11);
	assert.equal((await store.getTask("join"))?.status, "blocked");
	await succeed(store, b, "complete.b", 12);
	assert.equal((await store.getTask("join"))?.status, "ready");
	const joined = await claim(store, "claim.join", 13);
	assert.equal(joined.taskId, "join");
	await succeed(store, joined, "complete.join", 14);
	assert.equal((await store.getRun("run"))?.status, "completed");
});

test("any and quorum joins unlock atomically and cancel remaining branches when requested", async () => {
	const anyStore = await startedStore([
		{ id: "a", title: "A", instructions: "A" },
		{ id: "b", title: "B", instructions: "B" },
		{ id: "winner", title: "Winner", instructions: "Winner", dependencies: ["a", "b"], join: { kind: "any", cancelRemaining: true } },
	]);
	const a = await claim(anyStore, "any.claim.a", 10);
	const b = await claim(anyStore, "any.claim.b", 10);
	await succeed(anyStore, a, "any.complete.a", 11);
	assert.equal((await anyStore.getTask("winner"))?.status, "ready");
	assert.equal((await anyStore.getTask("b"))?.status, "cancelled");
	assert.equal((await anyStore.getAttempt(b.id))?.status, "cancelled");
	await assert.rejects(
		() => succeed(anyStore, b, "any.late.b", 12),
		(error: unknown) => error instanceof CollaborationConflictError && error.code === "STALE_ATTEMPT",
	);
	const anyWinner = await claim(anyStore, "any.claim.winner", 13);
	await succeed(anyStore, anyWinner, "any.complete.winner", 14);
	assert.equal((await anyStore.getTask("b"))?.cancelledByJoin, "winner");
	assert.equal((await anyStore.getRun("run"))?.status, "running", "success waits for cancelled provider usage");
	await anyStore.recordAttemptUsage({
		commandId: "any.usage.b",
		attemptId: b.id,
		leaseToken: b.lease.token,
		fence: b.lease.fence,
		usage: { tokens: 0, costUsd: 0 },
		now: 15,
	});
	assert.equal((await anyStore.getRun("run"))?.status, "completed");

	const quorumStore = await startedStore([
		{ id: "a", title: "A", instructions: "A" },
		{ id: "b", title: "B", instructions: "B" },
		{ id: "c", title: "C", instructions: "C" },
		{
			id: "quorum",
			title: "Quorum",
			instructions: "Quorum",
			dependencies: ["a", "b", "c"],
			join: { kind: "quorum", minimum: 2, cancelRemaining: true },
		},
	]);
	const qa = await claim(quorumStore, "q.claim.a", 10);
	const qb = await claim(quorumStore, "q.claim.b", 10);
	const qc = await claim(quorumStore, "q.claim.c", 10);
	await succeed(quorumStore, qa, "q.complete.a", 11);
	assert.equal((await quorumStore.getTask("quorum"))?.status, "blocked");
	await succeed(quorumStore, qb, "q.complete.b", 12);
	assert.equal((await quorumStore.getTask("quorum"))?.status, "ready");
	assert.equal((await quorumStore.getAttempt(qc.id))?.status, "cancelled");
	const quorum = await claim(quorumStore, "q.claim.quorum", 13);
	await succeed(quorumStore, quorum, "q.complete.quorum", 14);
	assert.equal((await quorumStore.getTask("c"))?.cancelledByJoin, "quorum");
	await quorumStore.recordAttemptUsage({
		commandId: "q.usage.c",
		attemptId: qc.id,
		leaseToken: qc.lease.token,
		fence: qc.lease.fence,
		usage: { tokens: 0, costUsd: 0 },
		now: 15,
	});
	assert.equal((await quorumStore.getRun("run"))?.status, "completed");
});

test("join cancellation preserves a live dependency that another blocked task still needs", async () => {
	const store = await startedStore([
		{ id: "a", title: "A", instructions: "A" },
		{ id: "b", title: "B", instructions: "B" },
		{
			id: "winner",
			title: "Winner",
			instructions: "Winner",
			dependencies: ["a", "b"],
			join: { kind: "any", cancelRemaining: true },
		},
		{ id: "consumer", title: "Consumer", instructions: "Consumer", dependencies: ["b"] },
	]);
	const a = await claim(store, "shared.claim.a", 10);
	const b = await claim(store, "shared.claim.b", 10);
	await succeed(store, a, "shared.complete.a", 11);
	assert.equal((await store.getTask("winner"))?.status, "ready");
	assert.equal((await store.getTask("b"))?.status, "running");
	assert.equal((await store.getAttempt(b.id))?.status, "running");
	await succeed(store, b, "shared.complete.b", 12);
	assert.equal((await store.getTask("consumer"))?.status, "ready");
});

test("leases use tokens and monotonic fences; reconciliation retries and rejects a stale completion", async () => {
	const store = await startedStore([
		{ id: "a", title: "A", instructions: "A", retry: { maxAttempts: 2, backoffMs: 5 } },
	]);
	const first = await claim(store, "claim.first", 10);
	await assert.rejects(
		() => store.renewAttemptLease({
			commandId: "renew.bad",
			attemptId: first.id,
			leaseToken: "wrong",
			fence: first.lease.fence,
			leaseDurationMs: 100,
			now: 20,
		}),
		(error: unknown) => error instanceof CollaborationConflictError && error.code === "FENCE_MISMATCH",
	);
	const reconciliation = await store.reconcile({ commandId: "reconcile", now: 111, retryDelayMs: 5 });
	assert.deepEqual(reconciliation.value.expiredAttempts, [first.id]);
	assert.equal((await store.getTask("a"))?.nextAttemptAt, 116);
	const second = await claim(store, "claim.second", 116);
	assert.equal(second.number, 2);
	assert.equal(second.lease.fence, first.lease.fence + 1);
	await assert.rejects(
		() => succeed(store, first, "complete.stale", 117),
		(error: unknown) => error instanceof CollaborationConflictError && error.code === "STALE_ATTEMPT",
	);
	await succeed(store, second, "complete.second", 118);
	assert.equal((await store.getRun("run"))?.status, "completed");
});

test("lease expiry obeys retryableCodes during reconciliation", async () => {
	const store = await startedStore([
		{
			id: "a",
			title: "A",
			instructions: "A",
			retry: { maxAttempts: 2, retryableCodes: ["RATE_LIMIT"] },
		},
	]);
	const attempt = await claim(store, "lease-policy.claim", 10);
	const reconciliation = await store.reconcile({ commandId: "lease-policy.reconcile", now: 111 });
	assert.deepEqual(reconciliation.value.expiredAttempts, [attempt.id]);
	assert.deepEqual(reconciliation.value.requeuedTasks, []);
	assert.deepEqual(reconciliation.value.failedTasks, ["a"]);
	assert.equal((await store.getAttempt(attempt.id))?.errorCode, "LEASE_EXPIRED");
	assert.equal((await store.getTask("a"))?.status, "failed");
	assert.equal((await store.getRun("run"))?.status, "failed");
});

test("approval resolved after lease expiry obeys retryableCodes", async () => {
	const store = await startedStore([
		{
			id: "a",
			title: "A",
			instructions: "A",
			retry: { maxAttempts: 2, retryableCodes: ["RATE_LIMIT"] },
		},
	]);
	const attempt = await claim(store, "approval-lease-policy.claim", 10);
	const approval = await store.requestApproval({
		commandId: "approval-lease-policy.request",
		attemptId: attempt.id,
		leaseToken: attempt.lease.token,
		fence: attempt.lease.fence,
		kind: "deploy",
		prompt: "Deploy?",
		requestedBy: "alice",
		now: 11,
	});
	await store.resolveApproval({
		commandId: "approval-lease-policy.resolve",
		approvalId: approval.value.id,
		decision: "approved",
		now: 111,
	});
	assert.equal((await store.getAttempt(attempt.id))?.status, "lost");
	assert.equal((await store.getAttempt(attempt.id))?.errorCode, "LEASE_EXPIRED");
	assert.equal((await store.getTask("a"))?.status, "failed");
	assert.equal((await store.getRun("run"))?.status, "failed");
});

test("token, time, attempt and concurrency budgets are enforced at atomic claim boundaries", async () => {
	const concurrencyStore = await startedStore(
		[
			{ id: "a", title: "A", instructions: "A" },
			{ id: "b", title: "B", instructions: "B" },
		],
		{ maxConcurrency: 1 },
	);
	const first = await claim(concurrencyStore, "budget.claim.first", 10);
	await assert.rejects(
		() => concurrencyStore.claimReadyTask({
			commandId: "budget.claim.blocked",
			runId: "run",
			workerId: "other",
			leaseDurationMs: 100,
			now: 10,
		}),
		(error: unknown) => error instanceof CollaborationBudgetError && error.reason === "concurrency",
	);
	await succeed(concurrencyStore, first, "budget.complete.first", 11);
	assert.ok((await concurrencyStore.claimReadyTask({
		commandId: "budget.claim.after",
		runId: "run",
		workerId: "other",
		leaseDurationMs: 100,
		now: 12,
	})).value);

	const tokenStore = await startedStore(
		[
			{ id: "a", title: "A", instructions: "A" },
			{ id: "b", title: "B", instructions: "B" },
		],
		{ maxTokens: 10 },
	);
	const tokenAttempt = await claim(tokenStore, "token.claim", 10);
	await tokenStore.completeAttempt({
		commandId: "token.complete",
		attemptId: tokenAttempt.id,
		leaseToken: tokenAttempt.lease.token,
		fence: tokenAttempt.lease.fence,
		usage: { tokens: 10 },
		now: 11,
	});
	assert.equal((await tokenStore.getRun("run"))?.status, "failed");
	assert.equal((await tokenStore.getTask("b"))?.status, "cancelled");

	const unknownCostStore = await startedStore(
		[
			{ id: "a", title: "A", instructions: "A" },
			{ id: "b", title: "B", instructions: "B" },
		],
		{ maxCostUsd: 5 },
	);
	const unknownCostAttempt = await claim(unknownCostStore, "cost.claim", 10);
	await unknownCostStore.completeAttempt({
		commandId: "cost.complete",
		attemptId: unknownCostAttempt.id,
		leaseToken: unknownCostAttempt.lease.token,
		fence: unknownCostAttempt.lease.fence,
		usage: { tokens: 10, costUsd: 0, costComplete: false },
		now: 11,
	});
	assert.equal((await unknownCostStore.getRun("run"))?.status, "failed");
	assert.equal((await unknownCostStore.getRun("run"))?.failureReason, "run budget exhausted: cost_unknown");
	assert.equal((await unknownCostStore.getTask("b"))?.status, "cancelled");

	const finalUnknownCostStore = await startedStore(
		[{ id: "a", title: "A", instructions: "A" }],
		{ maxCostUsd: 5 },
	);
	const finalUnknownCostAttempt = await claim(finalUnknownCostStore, "final.cost.claim", 10);
	await finalUnknownCostStore.completeAttempt({
		commandId: "final.cost.complete",
		attemptId: finalUnknownCostAttempt.id,
		leaseToken: finalUnknownCostAttempt.lease.token,
		fence: finalUnknownCostAttempt.lease.fence,
		usage: { tokens: 10, costUsd: 0, costComplete: false },
		now: 11,
	});
	assert.equal((await finalUnknownCostStore.getRun("run"))?.status, "failed");
	assert.equal(
		(await finalUnknownCostStore.getRun("run"))?.failureReason,
		"run budget exhausted: cost_unknown",
	);

	const finalTokenStore = await startedStore(
		[{ id: "a", title: "A", instructions: "A" }],
		{ maxTokens: 10 },
	);
	const finalTokenAttempt = await claim(finalTokenStore, "final.token.claim", 10);
	await finalTokenStore.completeAttempt({
		commandId: "final.token.complete",
		attemptId: finalTokenAttempt.id,
		leaseToken: finalTokenAttempt.lease.token,
		fence: finalTokenAttempt.lease.fence,
		usage: { tokens: 11 },
		now: 11,
	});
	assert.equal((await finalTokenStore.getRun("run"))?.status, "failed");

	const exactTokenStore = await startedStore(
		[{ id: "a", title: "A", instructions: "A" }],
		{ maxTokens: 10 },
	);
	const exactTokenAttempt = await claim(exactTokenStore, "exact.token.claim", 10);
	await exactTokenStore.completeAttempt({
		commandId: "exact.token.complete",
		attemptId: exactTokenAttempt.id,
		leaseToken: exactTokenAttempt.lease.token,
		fence: exactTokenAttempt.lease.fence,
		usage: { tokens: 10 },
		now: 11,
	});
	assert.equal((await exactTokenStore.getRun("run"))?.status, "completed");

	const durationStore = await startedStore([{ id: "a", title: "A", instructions: "A" }], { maxDurationMs: 10 });
	const duration = await durationStore.reconcile({ commandId: "duration.reconcile", now: 14 });
	assert.deepEqual(duration.value.failedRuns, ["run"]);
	assert.equal((await durationStore.getRun("run"))?.failureReason, "run budget exhausted: duration");
});

test("late usage from a join-cancelled attempt corrects a completed run that exceeded budget", async () => {
	const store = await startedStore(
		[
			{ id: "a", title: "A", instructions: "A" },
			{ id: "b", title: "B", instructions: "B" },
			{
				id: "winner",
				title: "Winner",
				instructions: "Winner",
				dependencies: ["a", "b"],
				join: { kind: "any", cancelRemaining: true },
			},
		],
		{ maxTokens: 10 },
	);
	const a = await claim(store, "late-budget.claim-a", 10);
	const b = await claim(store, "late-budget.claim-b", 10);
	await store.completeAttempt({
		commandId: "late-budget.complete-a",
		attemptId: a.id,
		leaseToken: a.lease.token,
		fence: a.lease.fence,
		usage: { tokens: 1 },
		now: 11,
	});
	assert.equal((await store.getAttempt(b.id))?.status, "cancelled");
	const winner = await claim(store, "late-budget.claim-winner", 12);
	await store.completeAttempt({
		commandId: "late-budget.complete-winner",
		attemptId: winner.id,
		leaseToken: winner.lease.token,
		fence: winner.lease.fence,
		usage: { tokens: 1 },
		now: 13,
	});
	assert.equal((await store.getRun("run"))?.status, "running");

	await store.recordAttemptUsage({
		commandId: "late-budget.record-cancelled",
		attemptId: b.id,
		leaseToken: b.lease.token,
		fence: b.lease.fence,
		usage: { tokens: 100 },
		now: 14,
	});
	const corrected = await store.getRun("run");
	assert.equal(corrected?.usage.tokens, 102);
	assert.equal(corrected?.status, "failed");
	assert.equal(corrected?.failureReason, "run budget exhausted: tokens");
	assert.equal(corrected?.finishedAt, 14, "terminal disposition is published only after usage settles");
	const events = await store.readEvents({ roomId: "room" });
	assert.deepEqual(events.slice(-2).map((event) => event.type), ["attempt.usage_recorded", "run.failed"]);
	assert.equal(events.some((event) => event.type === "run.completed"), false);
});

test("late usage that lands exactly on a token ceiling still completes the run", async () => {
	const store = await startedStore(
		[
			{ id: "a", title: "A", instructions: "A" },
			{ id: "b", title: "B", instructions: "B" },
			{
				id: "winner",
				title: "Winner",
				instructions: "Winner",
				dependencies: ["a", "b"],
				join: { kind: "any", cancelRemaining: true },
			},
		],
		{ maxTokens: 2 },
	);
	const a = await claim(store, "exact-late.claim-a", 10);
	const b = await claim(store, "exact-late.claim-b", 10);
	await store.completeAttempt({
		commandId: "exact-late.complete-a",
		attemptId: a.id,
		leaseToken: a.lease.token,
		fence: a.lease.fence,
		usage: { tokens: 1 },
		now: 11,
	});
	const winner = await claim(store, "exact-late.claim-winner", 12);
	await store.completeAttempt({
		commandId: "exact-late.complete-winner",
		attemptId: winner.id,
		leaseToken: winner.lease.token,
		fence: winner.lease.fence,
		usage: { tokens: 0 },
		now: 13,
	});
	assert.equal((await store.getRun("run"))?.status, "running");
	await store.recordAttemptUsage({
		commandId: "exact-late.record-cancelled",
		attemptId: b.id,
		leaseToken: b.lease.token,
		fence: b.lease.fence,
		usage: { tokens: 1 },
		now: 14,
	});
	const completed = await store.getRun("run");
	assert.equal(completed?.usage.tokens, 2);
	assert.equal(completed?.status, "completed");
	assert.equal(completed?.failureReason, undefined);
});

test("attempt ceilings block new claims without cancelling reserved final attempts", async () => {
	const pollingStore = await startedStore(
		[
			{ id: "a", title: "A", instructions: "A" },
			{ id: "b", title: "B", instructions: "B" },
		],
		{ maxAttempts: 1 },
	);
	const reserved = await claim(pollingStore, "attempt.claim.reserved", 10);
	const blockedClaim = await pollingStore.claimReadyTask({
		commandId: "attempt.claim.over-ceiling",
		runId: "run",
		workerId: "other-worker",
		leaseDurationMs: 100,
		now: 11,
	});
	assert.equal(blockedClaim.value, undefined);
	assert.equal((await pollingStore.getAttempt(reserved.id))?.status, "running");

	const completionStore = await startedStore(
		[{ id: "a", title: "A", instructions: "A" }],
		{ maxAttempts: 1 },
	);
	const finalAttempt = await claim(completionStore, "attempt.claim.final", 10);
	const restarted = new InMemoryCollaborationStore(await completionStore.readSnapshot());
	const reconciliation = await restarted.reconcile({ commandId: "attempt.reconcile", now: 20 });
	assert.deepEqual(reconciliation.value.failedRuns, []);
	assert.equal((await restarted.getRun("run"))?.status, "running");
	assert.equal((await restarted.getTask("a"))?.status, "running");
	assert.equal((await restarted.getAttempt(finalAttempt.id))?.status, "running");
	await succeed(restarted, finalAttempt, "attempt.complete.final", 21);
	assert.equal((await restarted.getRun("run"))?.status, "completed");
});

test("authority serializes tasks assigned to the same agent across runtime workers", async () => {
	const store = await startedStore([
		{ id: "a", title: "A", instructions: "A", assignedAgentId: "alice" },
		{ id: "b", title: "B", instructions: "B", assignedAgentId: "alice" },
	]);
	const first = await claim(store, "same-agent.first", 10, "alice");
	const blocked = await store.claimReadyTask({
		commandId: "same-agent.blocked",
		runId: "run",
		workerId: "other-runtime",
		agentId: "alice",
		leaseDurationMs: 100,
		now: 11,
	});
	assert.equal(blocked.value, undefined);
	await succeed(store, first, "same-agent.complete", 12);
	const second = await store.claimReadyTask({
		commandId: "same-agent.second",
		runId: "run",
		workerId: "other-runtime",
		agentId: "alice",
		leaseDurationMs: 100,
		now: 13,
	});
	assert.ok(second.value);
});

test("authority persists the resolved agent for unassigned-task exclusion", async () => {
	const store = new InMemoryCollaborationStore();
	await store.createRoom({ commandId: "room", roomId: "room", title: "Room", createdBy: "owner", members: [{ agentId: "alice" }], now: 1 });
	await store.createRun({ commandId: "run", runId: "run", roomId: "room", objective: "Work", createdBy: "owner", now: 2 });
	await store.addTasks({ commandId: "tasks", runId: "run", tasks: [
		{ id: "a", title: "A", instructions: "A" },
		{ id: "b", title: "B", instructions: "B" },
	], now: 3 });
	await store.startRun({ commandId: "start", runId: "run", now: 4 });
	const first = (await store.claimReadyTask({ commandId: "first", runId: "run", workerId: "runtime-a", agentId: "alice", leaseDurationMs: 100, now: 10 })).value;
	assert.equal(first?.agentId, "alice");
	const second = await store.claimReadyTask({ commandId: "second", runId: "run", workerId: "runtime-b", agentId: "alice", leaseDurationMs: 100, now: 11 });
	assert.equal(second.value, undefined);
});

test("manual retry reopens a failed run and its dependency-skipped descendants", async () => {
	const store = await startedStore([
		{ id: "a", title: "A", instructions: "A", retry: { maxAttempts: 1 } },
		{ id: "b", title: "B", instructions: "B", dependencies: ["a"] },
	]);
	const first = await claim(store, "manual-retry.claim", 10);
	await store.failAttempt({
		commandId: "manual-retry.fail",
		attemptId: first.id,
		leaseToken: first.lease.token,
		fence: first.lease.fence,
		errorCode: "INVALID_OUTPUT",
		errorMessage: "review failed",
		retryable: false,
		usage: { tokens: 1 },
		now: 11,
	});
	assert.equal((await store.getRun("run"))?.status, "failed");
	assert.equal((await store.getTask("b"))?.status, "skipped");
	await store.retryTask({ commandId: "manual-retry.retry", taskId: "a", now: 12 });
	assert.equal((await store.getRun("run"))?.status, "running");
	assert.equal((await store.getTask("a"))?.status, "ready");
	assert.equal((await store.getTask("b"))?.status, "blocked");
	assert.equal((await store.getTask("a"))?.retry.maxAttempts, 2, "manual retry grants one explicit attempt");
	const retried = await claim(store, "manual-retry.claim-again", 13);
	await succeed(store, retried, "manual-retry.complete", 14);
	const dependent = await claim(store, "manual-retry.claim-dependent", 15);
	await succeed(store, dependent, "manual-retry.complete-dependent", 16);
	assert.equal((await store.getRun("run"))?.status, "completed");
});

test("manual retry cannot reopen an old run beside a newer active room run", async () => {
	const store = await startedStore([{ id: "a", title: "A", instructions: "A", retry: { maxAttempts: 1 } }]);
	const attempt = await claim(store, "retry-conflict.claim", 10);
	await store.failAttempt({
		commandId: "retry-conflict.fail",
		attemptId: attempt.id,
		leaseToken: attempt.lease.token,
		fence: attempt.lease.fence,
		errorMessage: "failed",
		retryable: false,
		usage: { tokens: 0 },
		now: 11,
	});
	await store.createRun({ commandId: "newer", runId: "newer", roomId: "room", objective: "Newer", createdBy: "owner", now: 12 });
	await assert.rejects(
		store.retryTask({ commandId: "retry-conflict.retry", taskId: "a", now: 13 }),
		(error: unknown) => error instanceof CollaborationConflictError && error.code === "ROOM_ACTIVE_RUN_EXISTS",
	);
	assert.equal((await store.getRun("run"))?.status, "failed");
});

test("operator decisions always expire and handoff acceptance is source-lease fenced", async () => {
	const handoffStore = await startedStore([
		{ id: "a", title: "A", instructions: "A", assignedAgentId: "alice" },
	]);
	const handoffAttempt = await claim(handoffStore, "bounded.handoff.claim", 10, "alice");
	const handoff = await handoffStore.offerHandoff({
		commandId: "bounded.handoff.offer",
		attemptId: handoffAttempt.id,
		leaseToken: handoffAttempt.lease.token,
		fence: handoffAttempt.lease.fence,
		fromAgentId: "alice",
		toAgentId: "bob",
		now: 11,
	});
	assert.equal(handoff.value.expiresAt, 300_011);
	await assert.rejects(
		handoffStore.acceptHandoff({
			commandId: "bounded.handoff.accept-late",
			handoffId: handoff.value.id,
			respondingAgentId: "bob",
			now: 111,
		}),
		(error: unknown) => error instanceof CollaborationConflictError && error.code === "LEASE_EXPIRED",
	);

	const approvalStore = await startedStore([{ id: "a", title: "A", instructions: "A" }]);
	const approvalAttempt = await claim(approvalStore, "bounded.approval.claim", 20);
	const approval = await approvalStore.requestApproval({
		commandId: "bounded.approval.request",
		attemptId: approvalAttempt.id,
		leaseToken: approvalAttempt.lease.token,
		fence: approvalAttempt.lease.fence,
		kind: "deploy",
		prompt: "Deploy?",
		requestedBy: "alice",
		now: 21,
	});
	assert.equal(approval.value.expiresAt, 300_021);
	const shortApproval = await approvalStore.resolveApproval({
		commandId: "bounded.approval.reject-default",
		approvalId: approval.value.id,
		decision: "rejected",
		now: 22,
	});
	assert.equal(shortApproval.value.status, "rejected");

	const expiryStore = await startedStore([{ id: "a", title: "A", instructions: "A" }]);
	const expiryAttempt = await claim(expiryStore, "expiry.claim", 20);
	const expiring = await expiryStore.requestApproval({
		commandId: "expiry.request",
		attemptId: expiryAttempt.id,
		leaseToken: expiryAttempt.lease.token,
		fence: expiryAttempt.lease.fence,
		kind: "deploy",
		prompt: "Deploy?",
		requestedBy: "alice",
		expiresAt: 30,
		now: 21,
	});
	await assert.rejects(
		expiryStore.resolveApproval({ commandId: "expiry.toctou", approvalId: expiring.value.id, decision: "approved", now: 31 }),
		(error: unknown) => error instanceof CollaborationConflictError && error.code === "APPROVAL_EXPIRED",
	);
});

test("unknown usage settlement does not double-release run concurrency", async () => {
	const store = await startedStore(
		["a", "b", "c", "d"].map((id) => ({ id, title: id.toUpperCase(), instructions: id })),
		{ maxConcurrency: 2 },
	);
	const a = (await store.claimReadyTask({ commandId: "accounting.a", runId: "run", workerId: "one", leaseDurationMs: 10, now: 10 })).value!;
	const b = (await store.claimReadyTask({ commandId: "accounting.b", runId: "run", workerId: "two", leaseDurationMs: 100, now: 10 })).value!;
	await store.cancelTask({ commandId: "accounting.cancel-a", taskId: a.taskId, now: 11 });
	assert.equal((await store.getRun("run"))?.usage.activeAttempts, 1);
	await store.reconcile({ commandId: "accounting.reconcile", now: 21 });
	assert.equal((await store.getRun("run"))?.usage.activeAttempts, 1);
	const c = await store.claimReadyTask({ commandId: "accounting.c", runId: "run", workerId: "three", leaseDurationMs: 100, now: 22 });
	assert.ok(c.value);
	await assert.rejects(
		store.claimReadyTask({ commandId: "accounting.d", runId: "run", workerId: "four", leaseDurationMs: 100, now: 23 }),
		(error: unknown) => error instanceof CollaborationBudgetError && error.reason === "concurrency",
	);
	assert.equal((await store.getAttempt(b.id))?.status, "running");
});

test("reconciliation settles abandoned terminal usage as unknown after its durable grace", async () => {
	const store = await startedStore([
		{ id: "a", title: "A", instructions: "A" },
		{ id: "b", title: "B", instructions: "B", dependencies: ["a"], join: { kind: "any", cancelRemaining: true } },
	]);
	const a = await claim(store, "unknown-usage.claim-a", 10);
	await store.cancelTask({ commandId: "unknown-usage.cancel-a", taskId: "a", now: 11 });
	assert.equal((await store.getRun("run"))?.status, "running", "terminal publication waits for usage settlement");
	assert.equal((await store.getAttempt(a.id))?.usageRecorded, undefined);
	await store.reconcile({ commandId: "unknown-usage.reconcile", now: 30_012 });
	assert.equal((await store.getAttempt(a.id))?.usageRecorded, true);
	assert.equal((await store.getRun("run"))?.usage.costComplete, false);
	assert.equal((await store.getRun("run"))?.status, "failed");
});

test("assigned agents and handoff targets must remain room members", async () => {
	const store = new InMemoryCollaborationStore();
	await store.createRoom({
		commandId: "membership.room",
		roomId: "room",
		title: "Room",
		createdBy: "owner",
		members: [{ agentId: "alice" }],
		now: 1,
	});
	await store.createRun({
		commandId: "membership.run",
		runId: "run",
		roomId: "room",
		objective: "Work",
		createdBy: "owner",
		now: 2,
	});
	await assert.rejects(
		store.addTasks({
			commandId: "membership.bad-task",
			runId: "run",
			tasks: [{ id: "bad", title: "Bad", instructions: "Bad", assignedAgentId: "bob" }],
			now: 3,
		}),
		(error: unknown) => error instanceof CollaborationConflictError && error.code === "AGENT_NOT_IN_ROOM",
	);
	await store.addTasks({
		commandId: "membership.task",
		runId: "run",
		tasks: [{ id: "task", title: "Task", instructions: "Work", assignedAgentId: "alice" }],
		now: 4,
	});
	await assert.rejects(
		store.updateRoom({
			commandId: "membership.remove-active",
			roomId: "room",
			members: [],
			now: 5,
		}),
		(error: unknown) => error instanceof CollaborationConflictError && error.code === "ROOM_MEMBER_IN_USE",
	);
	await store.startRun({ commandId: "membership.start", runId: "run", now: 6 });
	const attempt = await claim(store, "membership.claim", 7, "alice");
	await assert.rejects(
		store.offerHandoff({
			commandId: "membership.bad-handoff",
			attemptId: attempt.id,
			leaseToken: attempt.lease.token,
			fence: attempt.lease.fence,
			fromAgentId: "alice",
			toAgentId: "bob",
			now: 8,
		}),
		(error: unknown) => error instanceof CollaborationConflictError && error.code === "AGENT_NOT_IN_ROOM",
	);
	assert.equal((await store.listHandoffs("run")).length, 0);
});

test("handoff transfers ownership, approval pauses/resumes, and artifacts commit with the result", async () => {
	const store = await startedStore([
		{ id: "a", title: "A", instructions: "A", assignedAgentId: "alice", retry: { maxAttempts: 1 } },
	]);
	const alice = await claim(store, "handoff.claim.alice", 10, "alice");
	const offered = await store.offerHandoff({
		commandId: "handoff.offer",
		attemptId: alice.id,
		leaseToken: alice.lease.token,
		fence: alice.lease.fence,
		fromAgentId: "alice",
		toAgentId: "bob",
		expiresAt: 50,
		now: 11,
	});
	await store.acceptHandoff({
		commandId: "handoff.accept",
		handoffId: offered.value.id,
		respondingAgentId: "bob",
		now: 12,
	});
	assert.equal((await store.getAttempt(alice.id))?.status, "handed_off");
	assert.equal((await store.getTask("a"))?.assignedAgentId, "bob");
	const bob = await claim(store, "handoff.claim.bob", 13, "bob");
	assert.equal(bob.number, 2, "accepted handoff creates a successor even when retry maxAttempts is one");
	const approval = await store.requestApproval({
		commandId: "approval.request",
		attemptId: bob.id,
		leaseToken: bob.lease.token,
		fence: bob.lease.fence,
		kind: "exec",
		prompt: "Deploy?",
		requestedBy: "bob",
		expiresAt: 80,
		now: 14,
	});
	assert.equal((await store.getTask("a"))?.status, "waiting_approval");
	await store.resolveApproval({
		commandId: "approval.resolve",
		approvalId: approval.value.id,
		decision: "approved",
		now: 15,
	});
	assert.equal((await store.getTask("a"))?.status, "running");
	await store.completeAttempt({
		commandId: "handoff.complete",
		attemptId: bob.id,
		leaseToken: bob.lease.token,
		fence: bob.lease.fence,
		result: "deployed",
		artifacts: [{ id: "artifact", kind: "report", name: "Result", uri: "blob://result", metadata: {} }],
		now: 16,
	});
	assert.equal((await store.getRun("run"))?.status, "running", "handoff source usage must settle first");
	await store.recordAttemptUsage({
		commandId: "handoff.source.usage",
		attemptId: alice.id,
		leaseToken: alice.lease.token,
		fence: alice.lease.fence,
		usage: { tokens: 0, costUsd: 0 },
		now: 17,
	});
	assert.equal((await store.listArtifacts("run"))[0]?.id, "artifact");
	assert.equal((await store.getRun("run"))?.status, "completed");
});

test("task cancellation resolves pending handoffs and approvals", async () => {
	const store = await startedStore([
		{ id: "a", title: "A", instructions: "A", assignedAgentId: "alice" },
	]);
	const attempt = await claim(store, "cancel.claim", 10, "alice");
	const handoff = await store.offerHandoff({
		commandId: "cancel.handoff",
		attemptId: attempt.id,
		leaseToken: attempt.lease.token,
		fence: attempt.lease.fence,
		fromAgentId: "alice",
		toAgentId: "bob",
		now: 11,
	});
	const approval = await store.requestApproval({
		commandId: "cancel.approval",
		attemptId: attempt.id,
		leaseToken: attempt.lease.token,
		fence: attempt.lease.fence,
		kind: "exec",
		prompt: "Proceed?",
		requestedBy: "alice",
		now: 12,
	});
	await store.cancelRun({ commandId: "cancel.run", runId: "run", reason: "stopped", now: 13 });
	assert.equal((await store.listHandoffs("run")).find(({ id }) => id === handoff.value.id)?.status, "cancelled");
	assert.equal((await store.listApprovals("run")).find(({ id }) => id === approval.value.id)?.status, "cancelled");
	const events = await store.readEvents({ roomId: "room" });
	assert.ok(events.some(({ type }) => type === "handoff.cancelled"));
	assert.ok(events.some(({ type }) => type === "approval.cancelled"));
});

test("a command is atomic and idempotent across snapshot hydration", async () => {
	const store = await startedStore([{
		id: "a",
		title: "A",
		instructions: "A",
		resultGate: { kind: "review_verdict" },
	}]);
	const attempt = await claim(store, "atomic.claim", 10);
	await store.addArtifact({
		commandId: "atomic.artifact",
		artifactId: "duplicate",
		runId: "run",
		kind: "seed",
		name: "Existing",
		uri: "blob://existing",
		now: 11,
	});
	const before = await store.readSnapshot();
	await assert.rejects(() => store.completeAttempt({
		commandId: "atomic.complete",
		attemptId: attempt.id,
		leaseToken: attempt.lease.token,
		fence: attempt.lease.fence,
		result: "REVIEW: FAIL\nDiagnostics are attached.",
		usage: { tokens: 99 },
		artifacts: [{ id: "duplicate", kind: "result", name: "Duplicate", uri: "blob://duplicate", metadata: {} }],
		now: 12,
	}));
	const after = await store.readSnapshot();
	assert.deepEqual(after, before, "failed semantic command rolls back state, events, outbox and receipt");
	await store.cancelRun({
		commandId: "atomic.cancel-first",
		runId: "run",
		reason: "finish first run before creating another room run",
		now: 13,
	});

	const created = await store.createRun({
		commandId: "idempotent.run",
		runId: "run-two",
		roomId: "room",
		objective: "Second",
		createdBy: "owner",
		now: 20,
	});
	const replayed = await store.createRun({
		commandId: "idempotent.run",
		runId: "run-two",
		roomId: "room",
		objective: "Second",
		createdBy: "owner",
		now: 21,
	});
	assert.equal(replayed.replayed, true);
	assert.deepEqual(replayed.value, created.value);
	const hydrated = new InMemoryCollaborationStore(await store.readSnapshot());
	const replayAfterRestart = await hydrated.createRun({
		commandId: "idempotent.run",
		runId: "run-two",
		roomId: "room",
		objective: "Second",
		createdBy: "owner",
		now: 22,
	});
	assert.equal(replayAfterRestart.replayed, true);
	await assert.rejects(
		() => hydrated.createRun({
			commandId: "idempotent.run",
			runId: "run-three",
			roomId: "room",
			objective: "Changed",
			createdBy: "owner",
			now: 20,
		}),
		(error: unknown) => error instanceof CollaborationConflictError && error.code === "IDEMPOTENCY_CONFLICT",
	);
});

test("events are strictly room-ordered and the outbox uses independent fenced delivery leases", async () => {
	const store = await startedStore([{ id: "a", title: "A", instructions: "A" }]);
	await store.cancelRun({
		commandId: "events.cancel-first",
		runId: "run",
		reason: "make room for a second run",
		now: 9,
	});
	await store.createRun({
		commandId: "events.second-run",
		runId: "second",
		roomId: "room",
		objective: "Second",
		createdBy: "owner",
		now: 10,
	});
	const events = await store.readEvents({ roomId: "room" });
	assert.deepEqual(events.map((event) => event.roomSeq), events.map((_event, index) => index + 1));
	assert.ok(events.some((event) => event.runId === "run"));
	assert.ok(events.some((event) => event.runId === "second"));

	const claimed = await store.claimOutbox({
		commandId: "outbox.claim",
		workerId: "publisher",
		leaseDurationMs: 50,
		limit: 2,
		now: 20,
	});
	assert.equal(claimed.value.length, 1, "only the earliest unacked room event is claimable");
	const item = claimed.value[0]!;
	await assert.rejects(
		() => store.ackOutbox({
			commandId: "outbox.bad-ack",
			outboxId: item.id,
			claimToken: item.claimToken!,
			fence: item.claimFence + 1,
			now: 21,
		}),
		(error: unknown) => error instanceof CollaborationConflictError && error.code === "OUTBOX_FENCE_MISMATCH",
	);
	await store.ackOutbox({
		commandId: "outbox.ack",
		outboxId: item.id,
		claimToken: item.claimToken!,
		fence: item.claimFence,
		now: 21,
	});
	assert.equal((await store.readSnapshot()).outbox.find((row) => row.id === item.id)?.status, "acked");
	const next = await store.claimOutbox({
		commandId: "outbox.claim.next",
		workerId: "publisher",
		leaseDurationMs: 50,
		limit: 2,
		now: 22,
	});
	assert.equal(next.value[0]?.event.roomSeq, item.event.roomSeq + 1);
});
