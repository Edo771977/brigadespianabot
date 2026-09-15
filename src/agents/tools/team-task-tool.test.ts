import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type {
	ActiveTeamExecutionContext,
	ActiveTeamExecutionStatus,
} from "../../collaboration/execution-context.js";
import { CollaborationConflictError } from "../../collaboration/types.js";
import type { Artifact, Handoff, RoomMessage, TeamApproval } from "../../collaboration/types.js";
import { makeTeamTaskTool, type TeamTaskToolResult } from "./team-task-tool.js";

const identifiers = {
	roomId: "room-1",
	runId: "run-1",
	taskId: "task-1",
	attemptId: "attempt-1",
	agentId: "researcher",
	sessionKey: "agent:researcher:team:room-1",
	runtimeRunId: "runtime-1",
};

const runningStatus: ActiveTeamExecutionStatus = {
	runStatus: "running",
	taskStatus: "running",
	attemptStatus: "running",
	assignedAgentId: "researcher",
	leaseExpiresAt: 50_000,
	updatedAt: 10,
};

function context(overrides: Partial<ActiveTeamExecutionContext> = {}): ActiveTeamExecutionContext {
	return {
		identifiers,
		getStatus: async () => runningStatus,
		readTaskResult: async (input) => ({
			taskId: input.taskId,
			runId: identifiers.runId,
			format: "text",
			content: "exact dependency result",
			offset: input.offset ?? 0,
			endOffset: 23,
			totalChars: 23,
			complete: true,
			sha256: "a".repeat(64),
		}),
			delegateChildren: async (input) => ({
			parentTask: { id: identifiers.taskId } as never,
			children: input.tasks.map((task, index) => ({
				id: task.id ?? `child-${index + 1}`,
				assignedAgentId: task.assignedAgentId,
				status: "ready",
			}) as never),
			yieldedAttempt: { id: identifiers.attemptId, status: "delegated" } as never,
				deduplicated: false,
			}),
			postMessage: async (input): Promise<RoomMessage> => ({
				id: "message-1",
				roomId: identifiers.roomId,
				authorId: identifiers.agentId,
				authorKind: "agent",
				source: "task",
				content: input.content,
				mentions: input.mentions ?? [],
				attachments: input.attachments ?? [],
				reactions: [],
				...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId, threadRootMessageId: input.replyToMessageId } : {}),
				createdAt: 10,
				updatedAt: 10,
			}),
			readMessages: async () => [],
			offerHandoff: async (input): Promise<Handoff> => ({
			id: "handoff-1",
			runId: identifiers.runId,
			taskId: identifiers.taskId,
			fromAttemptId: identifiers.attemptId,
			fromAgentId: identifiers.agentId,
			toAgentId: input.toAgentId,
			status: "accepted",
			createdAt: 10,
			updatedAt: 11,
			resolvedAt: 11,
		}),
		requestApproval: async (input): Promise<TeamApproval> => ({
			id: "approval-1",
			runId: identifiers.runId,
			taskId: identifiers.taskId,
			attemptId: identifiers.attemptId,
			kind: input.kind,
			prompt: input.prompt,
			status: "approved",
			requestedBy: identifiers.agentId,
			createdAt: 10,
			updatedAt: 11,
			resolvedAt: 11,
		}),
		attachArtifact: async (input): Promise<Artifact> => ({
			id: "artifact-1",
			runId: identifiers.runId,
			taskId: identifiers.taskId,
			attemptId: identifiers.attemptId,
			kind: input.kind,
			name: input.name,
			uri: input.uri,
			...(input.mimeType ? { mimeType: input.mimeType } : {}),
			...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
			...(input.sha256 ? { sha256: input.sha256 } : {}),
			metadata: input.metadata ?? {},
			createdAt: 10,
		}),
		...overrides,
	};
}

function details(value: Awaited<ReturnType<ReturnType<typeof makeTeamTaskTool>["execute"]>>): TeamTaskToolResult {
	return value.details as TeamTaskToolResult;
}

describe("team_task", () => {
	it("has no completion action and reports a model-safe status", async () => {
		const tool = makeTeamTaskTool({ context: context() });
		assert.equal(tool.name, "team_task");
		assert.doesNotMatch(JSON.stringify(tool.parameters), /complete_attempt/);
		assert.match(tool.description, /normal final assistant reply/i);

		const response = await tool.execute("call-1", { action: "status" });
		const payload = details(response);
		assert.equal(payload.ok, true);
		assert.equal(payload.outcome, "running");
		assert.deepEqual(payload.scope, {
			roomId: "room-1",
			runId: "run-1",
			taskId: "task-1",
			attemptId: "attempt-1",
			agentId: "researcher",
		});
		const rendered = JSON.stringify(response);
		assert.doesNotMatch(rendered, /leaseToken|fence|runtimeRunId/);
	});

	it("offers and waits for a handoff using the tool abort signal", async () => {
		const controller = new AbortController();
		let seenSignal: AbortSignal | undefined;
		const tool = makeTeamTaskTool({
			context: context({
				offerHandoff: async (input) => {
					seenSignal = input.signal;
					return {
						id: "handoff-1",
						runId: "run-1",
						taskId: "task-1",
						fromAttemptId: "attempt-1",
						fromAgentId: "researcher",
						toAgentId: input.toAgentId,
						status: "accepted",
						createdAt: 10,
						updatedAt: 11,
						resolvedAt: 11,
					};
				},
			}),
		});
		const response = await tool.execute(
			"call-2",
			{ action: "offer_handoff", toAgentId: "writer", reason: "needs prose", expiresInMs: 5_000 },
			controller.signal,
		);
		assert.equal(seenSignal, controller.signal);
		const payload = details(response);
		assert.equal(payload.ok, true);
		assert.equal(payload.outcome, "accepted");
		assert.match(payload.message, /stop work/i);
	});

	it("pages an exact direct-dependency result without exposing its lease capability", async () => {
		let input: { taskId: string; offset?: number; limit?: number } | undefined;
		const tool = makeTeamTaskTool({
			context: context({
				readTaskResult: async (value) => {
					input = value;
					return {
						taskId: value.taskId,
						runId: "run-1",
						format: "text",
						content: "second page",
						offset: value.offset ?? 0,
						endOffset: 21,
						totalChars: 30,
						complete: false,
						nextOffset: 21,
						sha256: "b".repeat(64),
					};
				},
			}),
		});
		const response = await tool.execute("read-call", {
			action: "read_result",
			taskId: "dependency",
			offset: 10,
			limit: 11,
		});
		const payload = details(response);
		assert.equal(payload.ok, true);
		assert.equal(payload.outcome, "more");
		assert.deepEqual(input, { taskId: "dependency", offset: 10, limit: 11 });
		assert.equal(payload.resultPage?.content, "second page");
		assert.equal(payload.resultPage?.nextOffset, 21);
		assert.doesNotMatch(JSON.stringify(response), /leaseToken|fence|runtimeRunId/);
	});

	it("delegates explicit child work with a stable request key", async () => {
		let received: Parameters<ActiveTeamExecutionContext["delegateChildren"]>[0] | undefined;
		const tool = makeTeamTaskTool({
			context: context({
				delegateChildren: async (input) => {
					received = input;
					return {
						parentTask: { id: "task-1" } as never,
						children: [{ id: "child-1", assignedAgentId: "writer", status: "ready" } as never],
						yieldedAttempt: { id: "attempt-1", status: "delegated" } as never,
						deduplicated: false,
					};
				},
			}),
		});
		const response = await tool.execute("delegate-call", {
			action: "delegate",
			requestKey: "write-v1",
			delegationKind: "subtask",
			tasks: [{ title: "Write", instructions: "Draft the answer", assignedAgentId: "writer" }],
		});
		const payload = details(response);
		assert.equal(payload.ok, true);
		assert.equal(payload.outcome, "delegated");
		assert.equal(received?.requestKey, "write-v1");
		assert.equal(received?.tasks[0]?.assignedAgentId, "writer");
		assert.match(payload.message, /fresh attempt/i);
		assert.doesNotMatch(JSON.stringify(response), /leaseToken|fence|runtimeRunId/);
	});

	it("returns approval rejection as a clean terminal outcome", async () => {
		const tool = makeTeamTaskTool({
			context: context({
				requestApproval: async (input) => ({
					id: "approval-1",
					runId: "run-1",
					taskId: "task-1",
					attemptId: "attempt-1",
					kind: input.kind,
					prompt: input.prompt,
					status: "rejected",
					requestedBy: "researcher",
					resolution: "Do not deploy",
					createdAt: 10,
					updatedAt: 11,
					resolvedAt: 11,
				}),
			}),
		});
		const response = await tool.execute("call-3", {
			action: "request_approval",
			kind: "deploy",
			prompt: "Deploy the candidate?",
		});
		const payload = details(response);
		assert.equal(payload.ok, false);
		assert.equal(payload.outcome, "rejected");
		assert.match(payload.message, /stop this attempt/i);
	});

	it("maps stale authority to a safe result without leaking credentials", async () => {
		const tool = makeTeamTaskTool({
			context: context({
				getStatus: async () => {
					throw new CollaborationConflictError("FENCE_MISMATCH", "lease token abc-secret no longer owns fence 9");
				},
			}),
		});
		const response = await tool.execute("call-4", { action: "status" });
		const payload = details(response);
		assert.equal(payload.ok, false);
		assert.equal(payload.outcome, "stale");
		assert.doesNotMatch(JSON.stringify(response), /abc-secret|fence 9/);
	});

	it("honors cancellation while waiting", async () => {
		const controller = new AbortController();
		const tool = makeTeamTaskTool({
			context: context({
				requestApproval: async (input) => new Promise((_resolve, reject) => {
					input.signal?.addEventListener("abort", () => {
						const error = new Error("approval wait aborted");
						error.name = "AbortError";
						reject(error);
					}, { once: true });
				}),
			}),
		});
		const pending = tool.execute(
			"call-5",
			{ action: "request_approval", kind: "deploy", prompt: "Proceed?" },
			controller.signal,
		);
		controller.abort();
		await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError");
	});

	it("fails clearly when invoked outside a Team attempt", async () => {
		const response = await makeTeamTaskTool().execute("call-6", { action: "status" });
		const payload = details(response);
		assert.equal(payload.ok, false);
		assert.equal(payload.outcome, "not_active");
		assert.equal(payload.errorCode, "NOT_TEAM_ATTEMPT");
	});
});
