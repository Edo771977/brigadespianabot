import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryCollaborationStore } from "./memory-store.js";
import { pageTeamTaskResult } from "./task-result-page.js";
import type { TaskDraft } from "./store.js";
import { CollaborationDomainError } from "./types.js";

const strictGate = { kind: "review_verdict", policy: "independent-v1" } as const;

async function emptyStore(): Promise<InMemoryCollaborationStore> {
	const store = new InMemoryCollaborationStore();
	await store.createRoom({
		commandId: "room",
		roomId: "room",
		title: "Review room",
		createdBy: "owner",
		members: ["maker", "specialist", "reviewer"].map((agentId) => ({ agentId })),
		now: 1,
	});
	return store;
}

async function delegate(tasks: TaskDraft[]): Promise<InMemoryCollaborationStore> {
	const store = await emptyStore();
	await store.delegateRun({
		commandId: "delegate",
		runId: "run",
		roomId: "room",
		objective: "Build and independently verify",
		createdBy: "owner",
		tasks,
		now: 2,
	});
	return store;
}

async function claim(store: InMemoryCollaborationStore, taskId: string, agentId: string, now: number) {
	const attempt = (await store.claimReadyTask({
		commandId: `claim.${taskId}.${now}`,
		runId: "run",
		taskId,
		agentId,
		workerId: "runtime",
		leaseDurationMs: 1_000,
		now,
	})).value;
	assert.ok(attempt);
	return attempt;
}

async function complete(store: InMemoryCollaborationStore, taskId: string, agentId: string, result: string, now: number) {
	const attempt = await claim(store, taskId, agentId, now);
	return store.completeAttempt({
		commandId: `complete.${taskId}.${now}`,
		attemptId: attempt.id,
		leaseToken: attempt.lease.token,
		fence: attempt.lease.fence,
		result,
		now: now + 1,
	});
}

function hasReviewPolicyError(pattern: RegExp): (error: unknown) => boolean {
	return (error) => error instanceof CollaborationDomainError
		&& error.code === "INVALID_REVIEW_POLICY"
		&& pattern.test(error.message);
}

test("independent-v1 validates explicit all-join reviewer topology atomically", async () => {
	const cases: Array<{ name: string; tasks: TaskDraft[]; error: RegExp }> = [
		{
			name: "missing reviewer assignment",
			tasks: [
				{ id: "make", title: "Make", instructions: "Build", assignedAgentId: "maker" },
				{ id: "review", title: "Review", instructions: "Verify", dependencies: ["make"], resultGate: strictGate },
			],
			error: /requires an explicit assignedAgentId/,
		},
		{
			name: "missing dependency",
			tasks: [{ id: "review", title: "Review", instructions: "Verify", assignedAgentId: "reviewer", resultGate: strictGate }],
			error: /requires at least one direct dependency/,
		},
		{
			name: "non-all join",
			tasks: [
				{ id: "make", title: "Make", instructions: "Build", assignedAgentId: "maker" },
				{ id: "review", title: "Review", instructions: "Verify", assignedAgentId: "reviewer", dependencies: ["make"], join: { kind: "any" }, resultGate: strictGate },
			],
			error: /requires an all join/,
		},
		{
			name: "unassigned contributor",
			tasks: [
				{ id: "make", title: "Make", instructions: "Build" },
				{ id: "review", title: "Review", instructions: "Verify", assignedAgentId: "reviewer", dependencies: ["make"], resultGate: strictGate },
			],
			error: /contributor make requires an explicit assignedAgentId/,
		},
		{
			name: "same direct contributor",
			tasks: [
				{ id: "make", title: "Make", instructions: "Build", assignedAgentId: "reviewer" },
				{ id: "review", title: "Review", instructions: "Verify", assignedAgentId: "reviewer", dependencies: ["make"], resultGate: strictGate },
			],
			error: /must differ from contributor make/,
		},
		{
			name: "same transitive contributor",
			tasks: [
				{ id: "research", title: "Research", instructions: "Research", assignedAgentId: "reviewer" },
				{ id: "make", title: "Make", instructions: "Build", assignedAgentId: "maker", dependencies: ["research"] },
				{ id: "review", title: "Review", instructions: "Verify", assignedAgentId: "reviewer", dependencies: ["make"], resultGate: strictGate },
			],
			error: /must differ from contributor research/,
		},
	];

	for (const fixture of cases) {
		const store = await emptyStore();
		const before = await store.readSnapshot();
		await assert.rejects(
			store.delegateRun({
				commandId: `invalid.${fixture.name}`,
				runId: "run",
				roomId: "room",
				objective: fixture.name,
				createdBy: "owner",
				tasks: fixture.tasks,
				now: 2,
			}),
			hasReviewPolicyError(fixture.error),
			fixture.name,
		);
		assert.deepEqual(await store.readSnapshot(), before, `${fixture.name} must not partially commit`);
	}
});

test("run start defensively rejects an invalid hydrated independent review graph", async () => {
	const store = await emptyStore();
	await store.createRun({ commandId: "run", runId: "run", roomId: "room", objective: "Verify", createdBy: "owner", now: 2 });
	await store.addTasks({
		commandId: "tasks",
		runId: "run",
		tasks: [
			{ id: "make", title: "Make", instructions: "Build", assignedAgentId: "maker" },
			{ id: "review", title: "Review", instructions: "Verify", assignedAgentId: "reviewer", dependencies: ["make"], resultGate: strictGate },
		],
		now: 3,
	});
	const snapshot = await store.readSnapshot();
	const review = snapshot.tasks.find((task) => task.id === "review");
	assert.ok(review);
	review.assignedAgentId = "maker";
	const recovered = new InMemoryCollaborationStore(snapshot);
	await assert.rejects(
		recovered.startRun({ commandId: "start", runId: "run", now: 4 }),
		hasReviewPolicyError(/must differ from contributor make/),
	);
	assert.equal((await recovered.getRun("run"))?.status, "created");
});

test("independent-v1 requires exact direct-result digest evidence", async () => {
	const store = await delegate([
		{ id: "make", title: "Make", instructions: "Build", assignedAgentId: "maker" },
		{ id: "review", title: "Review", instructions: "Verify", assignedAgentId: "reviewer", dependencies: ["make"], resultGate: strictGate },
	]);
	await complete(store, "make", "maker", "durable deliverable", 3);
	const source = await store.getTask("make");
	assert.ok(source);
	const evidence = JSON.stringify({ make: pageTeamTaskResult(source).sha256 });
	const attempt = await claim(store, "review", "reviewer", 5);
	const failed = await store.completeAttempt({
		commandId: "review.bad-evidence",
		attemptId: attempt.id,
		leaseToken: attempt.lease.token,
		fence: attempt.lease.fence,
		result: `REVIEW: PASS\nEVIDENCE: {"make":"${"0".repeat(64)}"}`,
		now: 6,
	});
	assert.equal(failed.value.status, "failed");
	assert.equal(failed.value.errorCode, "RESULT_GATE_FAILED");
	assert.match(failed.value.errorMessage ?? "", /exact dependency evidence line/);

	await store.retryTask({ commandId: "review.retry", taskId: "review", now: 7 });
	const retried = await claim(store, "review", "reviewer", 8);
	const passed = await store.completeAttempt({
		commandId: "review.good-evidence",
		attemptId: retried.id,
		leaseToken: retried.lease.token,
		fence: retried.lease.fence,
		result: `REVIEW: PASS\nEVIDENCE: ${evidence}\nAll checks passed.`,
		now: 9,
	});
	assert.equal(passed.value.status, "succeeded");
	assert.equal((await store.getRun("run"))?.status, "completed");
});

test("independent-v1 rejects contributor/reviewer handoffs and delegated overlap", async () => {
	const producerHandoff = await delegate([
		{ id: "make", title: "Make", instructions: "Build", assignedAgentId: "maker" },
		{ id: "review", title: "Review", instructions: "Verify", assignedAgentId: "reviewer", dependencies: ["make"], resultGate: strictGate },
	]);
	const maker = await claim(producerHandoff, "make", "maker", 3);
	const offer = (await producerHandoff.offerHandoff({
		commandId: "offer.to-reviewer",
		attemptId: maker.id,
		leaseToken: maker.lease.token,
		fence: maker.lease.fence,
		fromAgentId: "maker",
		toAgentId: "reviewer",
		now: 4,
	})).value;
	await assert.rejects(
		producerHandoff.acceptHandoff({ commandId: "accept.to-reviewer", handoffId: offer.id, respondingAgentId: "reviewer", now: 5 }),
		hasReviewPolicyError(/must differ from contributor make/),
	);
	assert.equal((await producerHandoff.getAttempt(maker.id))?.status, "running");
	assert.equal((await producerHandoff.listHandoffs("run"))[0]?.status, "offered");

	const delegatedOverlap = await delegate([
		{ id: "make", title: "Make", instructions: "Build", assignedAgentId: "maker" },
		{ id: "review", title: "Review", instructions: "Verify", assignedAgentId: "reviewer", dependencies: ["make"], resultGate: strictGate },
	]);
	const delegatingMaker = await claim(delegatedOverlap, "make", "maker", 3);
	await assert.rejects(
		delegatedOverlap.delegateAttemptChildren({
			commandId: "delegate.to-reviewer",
			attemptId: delegatingMaker.id,
			leaseToken: delegatingMaker.lease.token,
			fence: delegatingMaker.lease.fence,
			requestKey: "reviewer-child",
			tasks: [{ id: "child", title: "Child", instructions: "Contribute", assignedAgentId: "reviewer" }],
			now: 6,
		}),
		hasReviewPolicyError(/must differ from contributor child/),
	);
	assert.equal(await delegatedOverlap.getTask("child"), undefined);
	assert.equal((await delegatedOverlap.getAttempt(delegatingMaker.id))?.status, "running");

	const reviewerHandoff = await delegate([
		{ id: "make", title: "Make", instructions: "Build", assignedAgentId: "maker" },
		{ id: "review", title: "Review", instructions: "Verify", assignedAgentId: "reviewer", dependencies: ["make"], resultGate: strictGate },
	]);
	await complete(reviewerHandoff, "make", "maker", "done", 3);
	const reviewer = await claim(reviewerHandoff, "review", "reviewer", 5);
	const reverseOffer = (await reviewerHandoff.offerHandoff({
		commandId: "offer.to-maker",
		attemptId: reviewer.id,
		leaseToken: reviewer.lease.token,
		fence: reviewer.lease.fence,
		fromAgentId: "reviewer",
		toAgentId: "maker",
		now: 6,
	})).value;
	await assert.rejects(
		reviewerHandoff.acceptHandoff({ commandId: "accept.to-maker", handoffId: reverseOffer.id, respondingAgentId: "maker", now: 7 }),
		hasReviewPolicyError(/must differ from contributor make/),
	);

	const unrelatedHandoff = await delegate([
		{ id: "make", title: "Make", instructions: "Build", assignedAgentId: "maker" },
		{ id: "review", title: "Review", instructions: "Verify", assignedAgentId: "reviewer", dependencies: ["make"], resultGate: strictGate },
	]);
	await complete(unrelatedHandoff, "make", "maker", "done", 3);
	const originalReviewer = await claim(unrelatedHandoff, "review", "reviewer", 5);
	const safeOffer = (await unrelatedHandoff.offerHandoff({
		commandId: "offer.to-specialist",
		attemptId: originalReviewer.id,
		leaseToken: originalReviewer.lease.token,
		fence: originalReviewer.lease.fence,
		fromAgentId: "reviewer",
		toAgentId: "specialist",
		now: 6,
	})).value;
	const accepted = await unrelatedHandoff.acceptHandoff({
		commandId: "accept.to-specialist",
		handoffId: safeOffer.id,
		respondingAgentId: "specialist",
		now: 7,
	});
	assert.equal(accepted.value.status, "accepted");
	assert.equal((await unrelatedHandoff.getTask("review"))?.assignedAgentId, "specialist");
});

test("independent-v1 completion fails closed when hydrated attempt identity violates independence", async () => {
	const original = await delegate([
		{ id: "make", title: "Make", instructions: "Build", assignedAgentId: "maker" },
		{ id: "review", title: "Review", instructions: "Verify", assignedAgentId: "reviewer", dependencies: ["make"], resultGate: strictGate },
	]);
	await complete(original, "make", "maker", "done", 3);
	const snapshot = await original.readSnapshot();
	const producerAttempt = snapshot.attempts.find((attempt) => attempt.taskId === "make");
	assert.ok(producerAttempt);
	producerAttempt.agentId = "reviewer";
	const recovered = new InMemoryCollaborationStore(snapshot);
	const source = await recovered.getTask("make");
	assert.ok(source);
	const reviewer = await claim(recovered, "review", "reviewer", 5);
	const completion = await recovered.completeAttempt({
		commandId: "review.recovered.complete",
		attemptId: reviewer.id,
		leaseToken: reviewer.lease.token,
		fence: reviewer.lease.fence,
		result: `REVIEW: PASS\nEVIDENCE: ${JSON.stringify({ make: pageTeamTaskResult(source).sha256 })}`,
		now: 6,
	});
	assert.equal(completion.value.status, "failed");
	assert.equal(completion.value.errorCode, "RESULT_GATE_FAILED");
	assert.match(completion.value.errorMessage ?? "", /already contributed through attempt/);
});
