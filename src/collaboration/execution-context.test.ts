import assert from "node:assert/strict";
import test from "node:test";
import {
	createActiveTeamExecutionContext,
	getActiveTeamExecutionContext,
	runWithTeamExecutionContext,
} from "./execution-context.js";
import { InMemoryCollaborationStore } from "./memory-store.js";
import { CollaborationConflictError } from "./types.js";

async function fixture() {
	const store = new InMemoryCollaborationStore();
	await store.createRoom({
		commandId: "room",
		roomId: "room",
		title: "Room",
		createdBy: "owner",
		members: [{ agentId: "alice" }, { agentId: "bob" }],
		now: 1,
	});
	await store.createRun({ commandId: "run", runId: "run", roomId: "room", objective: "Work", createdBy: "owner", now: 2 });
	await store.addTasks({
		commandId: "task",
		runId: "run",
		tasks: [{ id: "task", title: "Task", instructions: "Work", assignedAgentId: "alice" }],
		now: 3,
	});
	await store.startRun({ commandId: "start", runId: "run", now: 4 });
	const attempt = (await store.claimReadyTask({
		commandId: "claim",
		runId: "run",
		workerId: "runtime",
		leaseDurationMs: 100,
		now: 5,
	})).value!;
	let command = 0;
	const context = createActiveTeamExecutionContext({
		store,
		identifiers: {
			roomId: "room",
			runId: "run",
			taskId: "task",
			attemptId: attempt.id,
			agentId: "alice",
			sessionKey: "agent:alice:team:cm9vbQ",
			runtimeRunId: "runtime-run",
		},
		leaseToken: attempt.lease.token,
		fence: attempt.lease.fence,
		validateAgentId: () => true,
		now: () => 10,
		commandId: () => `context.${command++}`,
	});
	return { store, attempt, context };
}

async function reviewFixture() {
	const store = new InMemoryCollaborationStore();
	await store.createRoom({
		commandId: "review.room",
		roomId: "review-room",
		title: "Review room",
		createdBy: "owner",
		members: [{ agentId: "maker" }, { agentId: "reviewer" }],
		now: 1,
	});
	await store.createRun({ commandId: "review.run", runId: "review-run", roomId: "review-room", objective: "Verify", createdBy: "owner", now: 2 });
	await store.addTasks({
		commandId: "review.tasks",
		runId: "review-run",
		tasks: [
			{ id: "source", title: "Source", instructions: "Produce", assignedAgentId: "maker" },
			{ id: "sibling", title: "Sibling", instructions: "Separate", assignedAgentId: "maker" },
			{ id: "review", title: "Review", instructions: "Verify", assignedAgentId: "reviewer", dependencies: ["source"] },
		],
		now: 3,
	});
	await store.startRun({ commandId: "review.start", runId: "review-run", now: 4 });
	const sourceAttempt = (await store.claimReadyTask({
		commandId: "review.claim.source",
		runId: "review-run",
		taskId: "source",
		workerId: "runtime",
		agentId: "maker",
		leaseDurationMs: 1_000,
		now: 5,
	})).value!;
	const sourceResult = `prefix-${"x".repeat(40_000)}-🦁-suffix`;
	await store.completeAttempt({
		commandId: "review.complete.source",
		attemptId: sourceAttempt.id,
		leaseToken: sourceAttempt.lease.token,
		fence: sourceAttempt.lease.fence,
		result: sourceResult,
		now: 6,
	});
	const reviewAttempt = (await store.claimReadyTask({
		commandId: "review.claim.reviewer",
		runId: "review-run",
		taskId: "review",
		workerId: "runtime",
		agentId: "reviewer",
		leaseDurationMs: 1_000,
		now: 7,
	})).value!;
	const context = createActiveTeamExecutionContext({
		store,
		identifiers: {
			roomId: "review-room",
			runId: "review-run",
			taskId: "review",
			attemptId: reviewAttempt.id,
			agentId: "reviewer",
			sessionKey: "agent:reviewer:team:review-room",
			runtimeRunId: "runtime-review",
		},
		leaseToken: reviewAttempt.lease.token,
		fence: reviewAttempt.lease.fence,
		validateAgentId: () => true,
		now: () => 10,
	});
	return { store, context, sourceResult };
}

test("AsyncLocalStorage exposes only the safe Team capability within the runner scope", async () => {
	const { context } = await fixture();
	assert.equal(getActiveTeamExecutionContext(), undefined);
	await runWithTeamExecutionContext(context, async () => {
		assert.equal(getActiveTeamExecutionContext(), context);
		await Promise.resolve();
		assert.equal(getActiveTeamExecutionContext(), context, "context survives async continuations");
		assert.equal("leaseToken" in context, false);
		assert.equal("fence" in context, false);
	});
	assert.equal(getActiveTeamExecutionContext(), undefined);
});

test("artifact attachment is bound to the active attempt fence and rejected after cancellation", async () => {
	const { store, context } = await fixture();
	const artifact = await context.attachArtifact({
		kind: "report",
		name: "Result",
		uri: "blob://result",
	});
	assert.equal(artifact.attemptId, context.identifiers.attemptId);
	await store.cancelRun({ commandId: "cancel", runId: "run", now: 11 });
	await assert.rejects(
		() => context.attachArtifact({ kind: "report", name: "Late", uri: "blob://late" }),
		(error: unknown) => error instanceof CollaborationConflictError && error.code === "STALE_ATTEMPT",
	);
});

test("result reads reconstruct a long direct dependency and deny every non-edge", async () => {
	const { store, context, sourceResult } = await reviewFixture();
	const first = await context.readTaskResult({ taskId: "source", offset: 0, limit: 32_000 });
	assert.equal(first.complete, false);
	assert.equal(first.nextOffset, 32_000);
	const second = await context.readTaskResult({ taskId: "source", offset: first.nextOffset, limit: 32_000 });
	assert.equal(second.complete, true);
	assert.equal(first.content + second.content, sourceResult);
	assert.equal(first.sha256, second.sha256);

	for (const taskId of ["sibling", "made-up-task"]) {
		await assert.rejects(
			() => context.readTaskResult({ taskId }),
			(error: unknown) => error instanceof CollaborationConflictError && error.code === "TASK_RESULT_NOT_VISIBLE",
		);
	}

	await store.cancelRun({ commandId: "review.cancel", runId: "review-run", now: 11 });
	await assert.rejects(
		() => context.readTaskResult({ taskId: "source" }),
		(error: unknown) => error instanceof CollaborationConflictError && error.code === "STALE_ATTEMPT",
	);
});

test("delegated child results return to a fresh fenced parent context", async () => {
	const { store, attempt, context } = await fixture();
	const delegated = await context.delegateChildren({
		requestKey: "specialist-v1",
		delegationKind: "consultation",
		tasks: [{ id: "child", title: "Specialist", instructions: "Investigate", assignedAgentId: "bob" }],
	});
	assert.equal(delegated.yieldedAttempt.status, "delegated");
	assert.equal(delegated.children[0]?.parentTaskId, "task");
	const childAttempt = (await store.claimReadyTask({
		commandId: "child.claim",
		runId: "run",
		taskId: "child",
		agentId: "bob",
		workerId: "runtime",
		leaseDurationMs: 100,
		now: 11,
	})).value!;
	const childResult = `specialist-${"z".repeat(40_000)}-done`;
	await store.completeAttempt({
		commandId: "child.complete",
		attemptId: childAttempt.id,
		leaseToken: childAttempt.lease.token,
		fence: childAttempt.lease.fence,
		result: childResult,
		now: 12,
	});
	await store.recordAttemptUsage({
		commandId: "parent.usage",
		attemptId: attempt.id,
		leaseToken: attempt.lease.token,
		fence: attempt.lease.fence,
		usage: { tokens: 1, costUsd: 0 },
		now: 13,
	});
	const resumed = (await store.claimReadyTask({
		commandId: "parent.resume",
		runId: "run",
		taskId: "task",
		agentId: "alice",
		workerId: "runtime",
		leaseDurationMs: 100,
		now: 14,
	})).value!;
	const resumedContext = createActiveTeamExecutionContext({
		store,
		identifiers: {
			...context.identifiers,
			attemptId: resumed.id,
			runtimeRunId: "runtime-resumed",
		},
		leaseToken: resumed.lease.token,
		fence: resumed.lease.fence,
		validateAgentId: () => true,
		now: () => 15,
	});
	const first = await resumedContext.readTaskResult({ taskId: "child", limit: 32_000 });
	const second = await resumedContext.readTaskResult({ taskId: "child", offset: first.nextOffset, limit: 32_000 });
	assert.equal(first.content + second.content, childResult);
	assert.equal(second.complete, true);
});
