/**
 * `team_task` — the narrow control surface available inside one leased Team
 * attempt.
 *
 * The runtime binds the authoritative store plus lease token/fence in an
 * AsyncLocalStorage capability. This tool receives only that safe capability:
 * model-visible input and output never contain the lease token or fence.
 *
 * Registration is additive and attempt-scoped (see registry.ts). A normal
 * assistant final reply is how the coordinator completes the attempt; there is
 * intentionally no `complete` action here.
 */

import { Type } from "typebox";

import type { AgentToolResult } from "@earendil-works/pi-agent-core";

import {
	requireActiveTeamExecutionContext,
	type ActiveTeamExecutionContext,
} from "../../collaboration/execution-context.js";
import {
	MAX_TEAM_RESULT_PAGE_CHARS,
	type TeamTaskResultPage,
} from "../../collaboration/task-result-page.js";
import { CollaborationDomainError } from "../../collaboration/types.js";
import {
	BrigadeToolInputError,
	jsonResult,
	readNumberParam,
	readStringParam,
} from "./common.js";
import type { BrigadeTool } from "./types.js";

const TeamTaskParams = Type.Object({
	action: Type.Union(
		[
			Type.Literal("status"),
			Type.Literal("read_messages"),
			Type.Literal("post_message"),
			Type.Literal("read_result"),
			Type.Literal("delegate"),
			Type.Literal("offer_handoff"),
			Type.Literal("request_approval"),
			Type.Literal("attach_artifact"),
		],
		{
			description:
				"status: inspect this attempt. read_messages/post_message: participate in the durable public room thread. read_result: page the exact result of a direct dependency or delegated child. delegate: yield to 1-4 durable child tasks and resume after they settle. offer_handoff: transfer ownership of this same task to another agent and wait for its response. " +
				"request_approval: pause and wait for an operator decision. attach_artifact: register an output produced by this attempt.",
		},
	),
	content: Type.Optional(
		Type.String({ description: "post_message: concise public room update.", minLength: 1, maxLength: 100_000 }),
	),
	mentions: Type.Optional(
		Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
			description: "post_message: room-member agent ids addressed by this message. Mentioning does not itself create work.",
			maxItems: 64,
		}),
	),
	replyToMessageId: Type.Optional(
		Type.String({ description: "post_message: message being replied to; creates or continues its thread.", minLength: 1, maxLength: 128 }),
	),
	threadRootMessageId: Type.Optional(
		Type.String({ description: "read_messages: return replies under this root message.", minLength: 1, maxLength: 128 }),
	),
	afterCreatedAt: Type.Optional(
		Type.Integer({ description: "read_messages: return messages newer than this timestamp.", minimum: 0 }),
	),
	attachments: Type.Optional(
		Type.Array(Type.Object({
			artifactId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
			name: Type.String({ minLength: 1, maxLength: 512 }),
			uri: Type.Optional(Type.String({ minLength: 1, maxLength: 8_000 })),
			mimeType: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
			bytes: Type.Optional(Type.Integer({ minimum: 0 })),
		}), { maxItems: 32 }),
	),
	taskId: Type.Optional(
		Type.String({
			description: "read_result: direct dependency task id from the execution envelope.",
			minLength: 1,
			maxLength: 128,
		}),
	),
	offset: Type.Optional(
		Type.Integer({ description: "read_result: zero-based character offset; defaults to 0.", minimum: 0 }),
	),
	limit: Type.Optional(
		Type.Integer({
			description: "read_result: maximum exact characters in this page; defaults to 8000.",
			minimum: 1,
			maximum: MAX_TEAM_RESULT_PAGE_CHARS,
		}),
	),
	requestKey: Type.Optional(
		Type.String({
			description: "delegate: stable idempotency key for this exact child-work request; reuse it when retrying the same call.",
			minLength: 1,
			maxLength: 128,
		}),
	),
	delegationKind: Type.Optional(
		Type.Union([Type.Literal("subtask"), Type.Literal("rework"), Type.Literal("consultation")], {
			description: "delegate: subtask for assigned work, rework for a correction, or consultation for a brief specialist answer.",
		}),
	),
	tasks: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
				title: Type.String({ minLength: 1, maxLength: 512 }),
				instructions: Type.String({ minLength: 1, maxLength: 100_000 }),
				assignedAgentId: Type.String({ minLength: 1, maxLength: 128 }),
				dependencies: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32 })),
				priority: Type.Optional(Type.Integer()),
				retry: Type.Optional(Type.Object({
					maxAttempts: Type.Integer({ minimum: 1, maximum: 100 }),
					backoffMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 86_400_000 })),
					retryableCodes: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32 })),
				})),
			}),
			{
				description: "delegate: 1-4 explicitly assigned child tasks committed atomically.",
				minItems: 1,
				maxItems: 4,
			},
		),
	),
	toAgentId: Type.Optional(
		Type.String({
			description: "offer_handoff: target Brigade agent id.",
			minLength: 1,
			maxLength: 128,
		}),
	),
	reason: Type.Optional(
		Type.String({ description: "offer_handoff: why the target agent should take over.", maxLength: 2_000 }),
	),
	expiresInMs: Type.Optional(
		Type.Integer({
			description: "handoff/approval: optional wait expiry in milliseconds; defaults to 5 minutes and cannot exceed 24 hours.",
			minimum: 1,
			maximum: 86_400_000,
		}),
	),
	kind: Type.Optional(
		Type.String({
			description: "request_approval or attach_artifact: short category such as deploy, purchase, report, or patch.",
			minLength: 1,
			maxLength: 128,
		}),
	),
	prompt: Type.Optional(
		Type.String({ description: "request_approval: the exact decision and relevant consequences.", minLength: 1, maxLength: 8_000 }),
	),
	name: Type.Optional(
		Type.String({ description: "attach_artifact: human-readable artifact name.", minLength: 1, maxLength: 512 }),
	),
	uri: Type.Optional(
		Type.String({ description: "attach_artifact: durable file, blob, or external URI.", minLength: 1, maxLength: 8_000 }),
	),
	mimeType: Type.Optional(
		Type.String({ description: "attach_artifact: MIME type when known.", minLength: 1, maxLength: 255 }),
	),
	bytes: Type.Optional(
		Type.Integer({ description: "attach_artifact: byte size when known.", minimum: 0 }),
	),
	sha256: Type.Optional(
		Type.String({ description: "attach_artifact: lowercase or uppercase SHA-256 hex digest when known.", pattern: "^[A-Fa-f0-9]{64}$" }),
	),
	metadata: Type.Optional(
		Type.Record(Type.String(), Type.Unknown(), {
			description: "attach_artifact: optional non-secret structured metadata.",
		}),
	),
});

type TeamTaskAction = "status" | "read_messages" | "post_message" | "read_result" | "delegate" | "offer_handoff" | "request_approval" | "attach_artifact";

interface TeamTaskScope {
	roomId: string;
	runId: string;
	taskId: string;
	attemptId: string;
	agentId: string;
}

export interface TeamTaskToolResult {
	action: TeamTaskAction;
	ok: boolean;
	outcome: string;
	message: string;
	scope?: TeamTaskScope;
	status?: unknown;
	resultPage?: TeamTaskResultPage;
	delegation?: unknown;
	handoff?: unknown;
	approval?: unknown;
	artifact?: unknown;
	messages?: unknown[];
	roomMessage?: unknown;
	errorCode?: string;
}

export interface MakeTeamTaskToolOptions {
	/** Test seam. Production resolves the AsyncLocalStorage capability lazily. */
	context?: ActiveTeamExecutionContext;
}

const STALE_CODES = new Set([
	"ATTEMPT_SCOPE_MISMATCH",
	"FENCE_MISMATCH",
	"INVALID_RUN_STATE",
	"LEASE_EXPIRED",
	"NOT_FOUND",
	"STALE_ATTEMPT",
]);

function scopeOf(context: ActiveTeamExecutionContext): TeamTaskScope {
	const ids = context.identifiers;
	return {
		roomId: ids.roomId,
		runId: ids.runId,
		taskId: ids.taskId,
		attemptId: ids.attemptId,
		agentId: ids.agentId,
	};
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

function safeFailure(action: TeamTaskAction, error: unknown): TeamTaskToolResult {
	if (error instanceof CollaborationDomainError) {
		if (error.code === "NOT_TEAM_ATTEMPT") {
			return {
				action,
				ok: false,
				outcome: "not_active",
				errorCode: error.code,
				message: "team_task is available only while running a leased Team task attempt.",
			};
		}
		if (STALE_CODES.has(error.code)) {
			return {
				action,
				ok: false,
				outcome: "stale",
				errorCode: error.code,
				message: "This Team attempt is no longer active. Stop mutating it and return a concise final reply.",
			};
		}
		return {
			action,
			ok: false,
			outcome: "rejected",
			errorCode: error.code,
			message: error.message.slice(0, 1_000),
		};
	}
	const message = error instanceof Error ? error.message : String(error);
	if (/(?:lease|token|fence|secret|credential)/i.test(message)) {
		return {
			action,
			ok: false,
			outcome: "stale",
			message: "This Team attempt's authorization is no longer valid. Stop mutating it and return a concise final reply.",
		};
	}
	return {
		action,
		ok: false,
		outcome: "error",
		message: message.slice(0, 1_000),
	};
}

function requirePositiveInteger(
	args: Record<string, unknown>,
	key: string,
): number | undefined {
	const value = readNumberParam(args, key, { integer: true, strict: true });
	if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
		throw new BrigadeToolInputError(`${key} must be a positive integer`);
	}
	return value;
}

function required(args: Record<string, unknown>, key: string): string {
	return readStringParam(args, key, { required: true });
}

function result(payload: TeamTaskToolResult): AgentToolResult<TeamTaskToolResult> {
	return jsonResult(payload) as AgentToolResult<TeamTaskToolResult>;
}

export function makeTeamTaskTool(
	options: MakeTeamTaskToolOptions = {},
): BrigadeTool<typeof TeamTaskParams, TeamTaskToolResult> {
	return {
		name: "team_task",
		label: "Team task",
		displaySummary: "coordinating the active Team task",
			description: [
			"Controls ONLY your currently leased Team task attempt; it is absent outside Team execution.",
				"Use status to check durable run/task/attempt state.",
				"Use read_messages for public room context and post_message for concise visible updates or replies. Mentions address room members but do not create work; use delegate for work and consultation.",
			"Use read_result to page the complete exact text of a DIRECT dependency when the execution envelope is truncated. Continue with nextOffset until complete; sha256 identifies one encoded result.",
			"Use delegate with a stable requestKey to atomically create 1-4 assigned child tasks. This attempt yields immediately; the parent resumes in a fresh attempt after every child settles and this turn's usage is recorded.",
			"offer_handoff transfers ownership of THIS SAME task to another agent and WAITS for acceptance or rejection; unlike delegate, accepted handoff does not return work to you.",
			"request_approval records a durable approval request and WAITS without stopping lease renewal. Continue only when approved; on rejection, cancellation, or expiry, stop and return a concise final explanation.",
			"attach_artifact records an output URI against this exact attempt. Never put credentials in metadata or URIs.",
			"Do not look for a completion action: your normal final assistant reply is captured by the Team coordinator as the task result.",
		].join(" "),
		parameters: TeamTaskParams,
		execute: async (
			_toolCallId,
			args,
			signal,
		): Promise<AgentToolResult<TeamTaskToolResult>> => {
			const action = args.action;
			try {
				if (signal?.aborted) {
					const error = new Error("Team task operation aborted");
					error.name = "AbortError";
					throw error;
				}
				const context = options.context ?? requireActiveTeamExecutionContext();
				const scope = scopeOf(context);
				switch (action) {
					case "status": {
						const status = await context.getStatus();
						return result({
							action,
							ok: true,
							outcome: status.attemptStatus,
							message: `Team task is ${status.taskStatus}; this attempt is ${status.attemptStatus}.`,
							scope,
							status: {
								runStatus: status.runStatus,
								taskStatus: status.taskStatus,
								attemptStatus: status.attemptStatus,
								...(status.assignedAgentId ? { assignedAgentId: status.assignedAgentId } : {}),
								leaseExpiresAt: status.leaseExpiresAt,
								updatedAt: status.updatedAt,
							},
						});
					}
					case "read_messages": {
						const threadRootMessageId = readStringParam(args, "threadRootMessageId");
						const afterCreatedAt = readNumberParam(args, "afterCreatedAt", { integer: true, strict: true });
						const limit = readNumberParam(args, "limit", { integer: true, strict: true }) ?? 50;
						if (afterCreatedAt !== undefined && (!Number.isSafeInteger(afterCreatedAt) || afterCreatedAt < 0)) {
							throw new BrigadeToolInputError("afterCreatedAt must be a non-negative safe integer");
						}
						if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
							throw new BrigadeToolInputError("limit must be between 1 and 100 for read_messages");
						}
						const messages = await context.readMessages({
							...(threadRootMessageId ? { threadRootMessageId } : {}),
							...(afterCreatedAt !== undefined ? { afterCreatedAt } : {}),
							limit,
						});
						return result({
							action,
							ok: true,
							outcome: "read",
							message: `Read ${messages.length} public room message${messages.length === 1 ? "" : "s"}.`,
							scope,
							messages,
						});
					}
					case "post_message": {
						const content = required(args, "content");
						const replyToMessageId = readStringParam(args, "replyToMessageId");
						const roomMessage = await context.postMessage({
							content,
							mentions: args.mentions ?? [],
							attachments: args.attachments ?? [],
							...(replyToMessageId ? { replyToMessageId } : {}),
						});
						return result({
							action,
							ok: true,
							outcome: "posted",
							message: replyToMessageId ? "Posted a durable thread reply." : "Posted a durable room update.",
							scope,
							roomMessage,
						});
					}
					case "read_result": {
						const taskId = required(args, "taskId");
						const offset = readNumberParam(args, "offset", { integer: true, strict: true });
						const limit = readNumberParam(args, "limit", { integer: true, strict: true });
						if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0)) {
							throw new BrigadeToolInputError("offset must be a non-negative safe integer");
						}
						if (
							limit !== undefined
							&& (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_TEAM_RESULT_PAGE_CHARS)
						) {
							throw new BrigadeToolInputError(
								`limit must be a positive safe integer no greater than ${MAX_TEAM_RESULT_PAGE_CHARS}`,
							);
						}
						const resultPage = await context.readTaskResult({
							taskId,
							...(offset !== undefined ? { offset } : {}),
							...(limit !== undefined ? { limit } : {}),
						});
						return result({
							action,
							ok: true,
							outcome: resultPage.complete ? "complete" : "more",
							message: resultPage.complete
								? `Read the complete result for dependency ${taskId}.`
								: `Read result characters ${resultPage.offset}-${resultPage.endOffset} for dependency ${taskId}; continue at offset ${resultPage.nextOffset}.`,
							scope,
							resultPage,
						});
					}
					case "delegate": {
						const requestKey = required(args, "requestKey");
						if (!Array.isArray(args.tasks) || args.tasks.length < 1 || args.tasks.length > 4) {
							throw new BrigadeToolInputError("tasks must contain 1-4 child tasks");
						}
						const delegationKind = args.delegationKind;
						const tasks = args.tasks.map((task, index) => {
							if (!task || typeof task !== "object") {
								throw new BrigadeToolInputError(`tasks[${index}] must be an object`);
							}
							const row = task as Record<string, unknown>;
							const title = required(row, "title");
							const instructions = required(row, "instructions");
							const assignedAgentId = required(row, "assignedAgentId");
							const id = readStringParam(row, "id");
							const priority = readNumberParam(row, "priority", { integer: true, strict: true });
							if (priority !== undefined && !Number.isSafeInteger(priority)) {
								throw new BrigadeToolInputError(`tasks[${index}].priority must be a safe integer`);
							}
							if (row.dependencies !== undefined && !Array.isArray(row.dependencies)) {
								throw new BrigadeToolInputError(`tasks[${index}].dependencies must be an array`);
							}
							let retry: { maxAttempts: number; backoffMs?: number; retryableCodes?: string[] } | undefined;
							if (row.retry !== undefined) {
								if (!row.retry || typeof row.retry !== "object" || Array.isArray(row.retry)) {
									throw new BrigadeToolInputError(`tasks[${index}].retry must be an object`);
								}
								const retryRow = row.retry as Record<string, unknown>;
								const maxAttempts = readNumberParam(retryRow, "maxAttempts", { integer: true, strict: true });
								if (maxAttempts === undefined || !Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
									throw new BrigadeToolInputError(`tasks[${index}].retry.maxAttempts must be a positive safe integer`);
								}
								const backoffMs = readNumberParam(retryRow, "backoffMs", { integer: true, strict: true });
								if (backoffMs !== undefined && (!Number.isSafeInteger(backoffMs) || backoffMs < 0)) {
									throw new BrigadeToolInputError(`tasks[${index}].retry.backoffMs must be a non-negative safe integer`);
								}
								if (retryRow.retryableCodes !== undefined && !Array.isArray(retryRow.retryableCodes)) {
									throw new BrigadeToolInputError(`tasks[${index}].retry.retryableCodes must be an array`);
								}
								const retryableCodes = Array.isArray(retryRow.retryableCodes)
									? retryRow.retryableCodes.map((value, codeIndex) => {
										if (typeof value !== "string" || !value.trim()) {
											throw new BrigadeToolInputError(`tasks[${index}].retry.retryableCodes[${codeIndex}] must be a non-empty string`);
										}
										return value;
									})
									: undefined;
								retry = {
									maxAttempts,
									...(backoffMs !== undefined ? { backoffMs } : {}),
									...(retryableCodes ? { retryableCodes } : {}),
								};
							}
							return {
								...(id ? { id } : {}),
								title,
								instructions,
								assignedAgentId,
								...(Array.isArray(row.dependencies)
									? { dependencies: row.dependencies.map((value, dependencyIndex) => {
										if (typeof value !== "string" || !value.trim()) {
											throw new BrigadeToolInputError(`tasks[${index}].dependencies[${dependencyIndex}] must be a non-empty string`);
										}
										return value;
									}) }
									: {}),
								...(priority !== undefined ? { priority } : {}),
								...(retry ? { retry } : {}),
							};
						});
						const delegation = await context.delegateChildren({
							requestKey,
							...(delegationKind ? { delegationKind } : {}),
							tasks,
						});
						return result({
							action,
							ok: true,
							outcome: delegation.deduplicated ? "already_delegated" : "delegated",
							message: "Child work is durable. This source attempt has yielded; stop work now. The parent task will resume in a fresh attempt after every child settles.",
							scope,
							delegation: {
								requestKey,
								delegationKind: delegationKind ?? "subtask",
								deduplicated: delegation.deduplicated,
								parentTaskId: delegation.parentTask.id,
								childTasks: delegation.children.map((child) => ({
									id: child.id,
									assignedAgentId: child.assignedAgentId,
									status: child.status,
								})),
							},
						});
					}
					case "offer_handoff": {
						const toAgentId = required(args, "toAgentId");
						const reason = readStringParam(args, "reason");
						const expiresInMs = requirePositiveInteger(args, "expiresInMs");
						const handoff = await context.offerHandoff({
							toAgentId,
							...(reason ? { reason } : {}),
							...(expiresInMs !== undefined ? { expiresInMs } : {}),
							...(signal ? { signal } : {}),
						});
						const accepted = handoff.status === "accepted";
						return result({
							action,
							ok: accepted,
							outcome: handoff.status,
							message: accepted
								? `Handoff accepted by ${handoff.toAgentId}. Stop work on this attempt and return a concise final confirmation.`
								: `Handoff ${handoff.status}. ${handoff.status === "rejected" ? "You may continue this attempt if it remains active." : "Check status before doing more work."}`,
							scope,
							handoff: {
								id: handoff.id,
								status: handoff.status,
								toAgentId: handoff.toAgentId,
								...(handoff.reason ? { reason: handoff.reason } : {}),
								...(handoff.resolvedAt !== undefined ? { resolvedAt: handoff.resolvedAt } : {}),
							},
						});
					}
					case "request_approval": {
						const kind = required(args, "kind");
						const prompt = required(args, "prompt");
						const expiresInMs = requirePositiveInteger(args, "expiresInMs");
						const approval = await context.requestApproval({
							kind,
							prompt,
							...(expiresInMs !== undefined ? { expiresInMs } : {}),
							...(signal ? { signal } : {}),
						});
						const approved = approval.status === "approved";
						return result({
							action,
							ok: approved,
							outcome: approval.status,
							message: approved
								? "Approval granted. Continue this attempt."
								: `Approval ${approval.status}. Stop this attempt and return a concise final explanation.`,
							scope,
							approval: {
								id: approval.id,
								status: approval.status,
								kind: approval.kind,
								...(approval.resolution ? { resolution: approval.resolution } : {}),
								...(approval.resolvedAt !== undefined ? { resolvedAt: approval.resolvedAt } : {}),
							},
						});
					}
					case "attach_artifact": {
						const kind = required(args, "kind");
						const name = required(args, "name");
						const uri = required(args, "uri");
						const mimeType = readStringParam(args, "mimeType");
						const sha256 = readStringParam(args, "sha256");
						const bytes = readNumberParam(args, "bytes", { integer: true, strict: true });
						if (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes < 0)) {
							throw new BrigadeToolInputError("bytes must be a non-negative integer");
						}
						const artifact = await context.attachArtifact({
							kind,
							name,
							uri,
							...(mimeType ? { mimeType } : {}),
							...(bytes !== undefined ? { bytes } : {}),
							...(sha256 ? { sha256 } : {}),
							...(args.metadata ? { metadata: args.metadata } : {}),
						});
						return result({
							action,
							ok: true,
							outcome: "attached",
							message: `Attached artifact ${artifact.name}. Your normal final reply still completes the Team task.`,
							scope,
							artifact: {
								id: artifact.id,
								kind: artifact.kind,
								name: artifact.name,
								uri: artifact.uri,
								...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
								...(artifact.bytes !== undefined ? { bytes: artifact.bytes } : {}),
								...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
							},
						});
					}
				}
			} catch (error) {
				if (isAbort(error, signal)) throw error;
				return result(safeFailure(action, error));
			}
		},
	};
}
