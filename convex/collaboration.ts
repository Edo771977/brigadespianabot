// convex/collaboration.ts — normalized Team Mode authority.
//
// The Node adapter evaluates one semantic command against the shared
// collaboration state machine, then submits only its per-record delta here.
// `commit` verifies the owner's OCC revision and applies domain rows, emitted
// events, outbox work, room sequence counters, and the idempotency receipt in
// one Convex transaction. A losing concurrent writer must reload and re-run
// the semantic decision before it can commit.

import { ConvexError, v } from "convex/values";

import { mutation, query } from "./_generated/server.js";
import type { MutationCtx } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";

type JsonRecord = Record<string, unknown>;

interface CollectionDelta {
	upserts: unknown[];
	deletes: string[];
}

type CollaborationDelta = Partial<
	Record<
		| "rooms"
		| "runs"
		| "tasks"
		| "attempts"
		| "handoffs"
		| "approvals"
			| "artifacts"
			| "messages"
		| "events"
		| "outbox"
		| "commandReceipts"
		| "roomSequences",
		CollectionDelta
	>
>;

function asRecord(value: unknown, collection: string): JsonRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ConvexError({
			code: "COLLABORATION_INVALID_DELTA",
			message: `${collection} upserts must contain objects`,
		});
	}
	return value as JsonRecord;
}

function stringField(record: JsonRecord, field: string, collection: string): string {
	const value = record[field];
	if (typeof value !== "string" || value.length === 0) {
		throw new ConvexError({
			code: "COLLABORATION_INVALID_DELTA",
			message: `${collection}.${field} must be a non-empty string`,
		});
	}
	return value;
}

function numberField(record: JsonRecord, field: string, collection: string): number {
	const value = record[field];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new ConvexError({
			code: "COLLABORATION_INVALID_DELTA",
			message: `${collection}.${field} must be finite`,
		});
	}
	return value;
}

function optionalString(record: JsonRecord, field: string): string | undefined {
	const value = record[field];
	return typeof value === "string" ? value : undefined;
}

function optionalNumber(record: JsonRecord, field: string): number | undefined {
	const value = record[field];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function deltaOf(delta: CollaborationDelta, collection: keyof CollaborationDelta): CollectionDelta {
	const value = delta[collection];
	if (value === undefined) return { upserts: [], deletes: [] };
	if (!value || !Array.isArray(value.upserts) || !Array.isArray(value.deletes)) {
		throw new ConvexError({
			code: "COLLABORATION_INVALID_DELTA",
			message: `${collection} delta is malformed`,
		});
	}
	if (value.deletes.some((id) => typeof id !== "string" || id.length === 0)) {
		throw new ConvexError({
			code: "COLLABORATION_INVALID_DELTA",
			message: `${collection} deletes must contain non-empty ids`,
		});
	}
	return value;
}

function records<T extends { record: unknown }>(rows: T[]): unknown[] {
	return rows.map((row) => row.record);
}

/** Point reads used by high-frequency gateway validation paths. */
export const getRoom = query({
	args: {
		ownerId: v.string(),
		roomId: v.string(),
	},
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("collaborationRooms")
			.withIndex("by_owner_room", (q) =>
				q.eq("ownerId", args.ownerId).eq("roomId", args.roomId),
			)
			.first();
		return row?.record ?? null;
	},
});

export const getRun = query({
	args: {
		ownerId: v.string(),
		runId: v.string(),
	},
	handler: async (ctx, args) => {
		const row = await ctx.db
			.query("collaborationRuns")
			.withIndex("by_owner_run", (q) =>
				q.eq("ownerId", args.ownerId).eq("runId", args.runId),
			)
			.first();
		return row?.record ?? null;
	},
});

export const load = query({
	args: {
		ownerId: v.string(),
		commandId: v.optional(v.string()),
		includeEvents: v.optional(v.boolean()),
		includeOutbox: v.optional(v.boolean()),
		activeOutboxOnly: v.optional(v.boolean()),
		includeReceipts: v.optional(v.boolean()),
		outboxId: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const [
			state,
			rooms,
			runs,
			tasks,
			attempts,
			handoffs,
			approvals,
			artifacts,
			messages,
			roomSequences,
		] = await Promise.all([
			ctx.db
				.query("collaborationState")
				.withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
				.first(),
			ctx.db
				.query("collaborationRooms")
				.withIndex("by_owner_room", (q) => q.eq("ownerId", args.ownerId))
				.collect(),
			ctx.db
				.query("collaborationRuns")
				.withIndex("by_owner_run", (q) => q.eq("ownerId", args.ownerId))
				.collect(),
			ctx.db
				.query("collaborationTasks")
				.withIndex("by_owner_task", (q) => q.eq("ownerId", args.ownerId))
				.collect(),
			ctx.db
				.query("collaborationAttempts")
				.withIndex("by_owner_attempt", (q) => q.eq("ownerId", args.ownerId))
				.collect(),
			ctx.db
				.query("collaborationHandoffs")
				.withIndex("by_owner_handoff", (q) => q.eq("ownerId", args.ownerId))
				.collect(),
			ctx.db
				.query("collaborationApprovals")
				.withIndex("by_owner_approval", (q) => q.eq("ownerId", args.ownerId))
				.collect(),
			ctx.db
					.query("collaborationArtifacts")
				.withIndex("by_owner_artifact", (q) => q.eq("ownerId", args.ownerId))
					.collect(),
			ctx.db
					.query("collaborationMessages")
					.withIndex("by_owner_message", (q) => q.eq("ownerId", args.ownerId))
					.collect(),
			ctx.db
				.query("collaborationRoomSequences")
				.withIndex("by_owner_room", (q) => q.eq("ownerId", args.ownerId))
				.collect(),
		]);

		const commandReceipt = args.commandId
			? await ctx.db
					.query("collaborationCommandReceipts")
					.withIndex("by_owner_command", (q) =>
						q.eq("ownerId", args.ownerId).eq("commandId", args.commandId as string),
					)
					.first()
			: null;
		const receiptRows = args.includeReceipts
			? await ctx.db
					.query("collaborationCommandReceipts")
					.withIndex("by_owner_committed", (q) => q.eq("ownerId", args.ownerId))
					.collect()
			: commandReceipt
				? [commandReceipt]
				: [];

		let eventRows: Doc<"collaborationEvents">[];
		if (args.includeEvents) {
			eventRows = await ctx.db
				.query("collaborationEvents")
				.withIndex("by_owner_room_seq", (q) => q.eq("ownerId", args.ownerId))
				.collect();
		} else if (args.commandId && commandReceipt) {
			eventRows = await ctx.db
				.query("collaborationEvents")
				.withIndex("by_owner_command", (q) =>
					q.eq("ownerId", args.ownerId).eq("commandId", args.commandId as string),
				)
				.collect();
		} else {
			eventRows = [];
		}

		let outboxRows: Doc<"collaborationOutbox">[];
		if (args.includeOutbox && args.activeOutboxOnly) {
			const [pending, claimed] = await Promise.all([
				ctx.db
					.query("collaborationOutbox")
					.withIndex("by_owner_status_next", (q) =>
						q.eq("ownerId", args.ownerId).eq("status", "pending"),
					)
					.collect(),
				ctx.db
					.query("collaborationOutbox")
					.withIndex("by_owner_status_claim_expiry", (q) =>
						q.eq("ownerId", args.ownerId).eq("status", "claimed"),
					)
					.collect(),
			]);
			outboxRows = [...pending, ...claimed];
		} else if (args.includeOutbox) {
			outboxRows = await ctx.db
				.query("collaborationOutbox")
				.withIndex("by_owner_outbox", (q) => q.eq("ownerId", args.ownerId))
				.collect();
		} else if (args.outboxId) {
			const row = await ctx.db
				.query("collaborationOutbox")
				.withIndex("by_owner_outbox", (q) =>
					q.eq("ownerId", args.ownerId).eq("outboxId", args.outboxId as string),
				)
				.first();
			outboxRows = row ? [row] : [];
		} else {
			outboxRows = [];
		}

		return {
			revision: state?.revision ?? 0,
			snapshot: {
				rooms: records(rooms),
				runs: records(runs),
				tasks: records(tasks),
				attempts: records(attempts),
				handoffs: records(handoffs),
				approvals: records(approvals),
					artifacts: records(artifacts),
					messages: records(messages),
				events: records(eventRows),
				outbox: records(outboxRows),
				commandReceipts: records(receiptRows),
				roomSequences: roomSequences.map((row) => ({
					roomId: row.roomId,
					roomSeq: row.roomSeq,
				})),
			},
		};
	},
});

export const readEvents = query({
	args: {
		ownerId: v.string(),
		roomId: v.optional(v.string()),
		runId: v.optional(v.string()),
		afterRoomSeq: v.optional(v.number()),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const limit = Math.max(0, Math.min(args.limit ?? 500, 5_000));
		if (limit === 0) return [];
		const after = args.afterRoomSeq ?? 0;
		if (args.runId) {
			const indexed = ctx.db
				.query("collaborationEvents")
				.withIndex("by_owner_run_seq", (q) =>
					q.eq("ownerId", args.ownerId).eq("runId", args.runId as string).gt("roomSeq", after),
				);
			const filtered = args.roomId
				? indexed.filter((q) => q.eq(q.field("roomId"), args.roomId))
				: indexed;
			const events = await filtered.take(limit);
			return records(events).sort(compareEventRecords);
		}
		if (args.roomId) {
			let events = await ctx.db
				.query("collaborationEvents")
				.withIndex("by_owner_room_seq", (q) =>
					q.eq("ownerId", args.ownerId).eq("roomId", args.roomId as string).gt("roomSeq", after),
				)
				.take(limit);
			return records(events);
		}
		const events = await ctx.db
			.query("collaborationEvents")
			.withIndex("by_owner_room_seq", (q) => q.eq("ownerId", args.ownerId))
			.filter((q) => q.gt(q.field("roomSeq"), after))
			.take(limit);
		return records(events);
	},
});

function compareEventRecords(left: unknown, right: unknown): number {
	const a = asRecord(left, "events");
	const b = asRecord(right, "events");
	return String(a.roomId).localeCompare(String(b.roomId)) || Number(a.roomSeq) - Number(b.roomSeq);
}

export const commit = mutation({
	args: {
		ownerId: v.string(),
		expectedRevision: v.number(),
		operation: v.string(),
		commandId: v.string(),
		delta: v.any(),
		committedAt: v.number(),
	},
	handler: async (ctx, args) => {
		const state = await ctx.db
			.query("collaborationState")
			.withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
			.first();
		const actualRevision = state?.revision ?? 0;
		if (actualRevision !== args.expectedRevision) {
			throw new ConvexError({
				code: "COLLABORATION_OCC_CONFLICT",
				actualRevision,
			});
		}
		const delta = args.delta as CollaborationDelta;
		if (!delta || typeof delta !== "object") {
			throw new ConvexError({ code: "COLLABORATION_INVALID_DELTA" });
		}

		if (args.operation !== "importSnapshot") {
			const receipt = deltaOf(delta, "commandReceipts").upserts
				.map((value) => asRecord(value, "commandReceipts"))
				.find((value) => value.commandId === args.commandId);
			if (!receipt || receipt.operation !== args.operation) {
				throw new ConvexError({
					code: "COLLABORATION_RECEIPT_REQUIRED",
					commandId: args.commandId,
				});
			}
		}

		await applyRooms(ctx, args.ownerId, deltaOf(delta, "rooms"));
		await applyRuns(ctx, args.ownerId, deltaOf(delta, "runs"));
		await applyTasks(ctx, args.ownerId, deltaOf(delta, "tasks"));
		await applyAttempts(ctx, args.ownerId, deltaOf(delta, "attempts"));
		await applyHandoffs(ctx, args.ownerId, deltaOf(delta, "handoffs"));
		await applyApprovals(ctx, args.ownerId, deltaOf(delta, "approvals"));
		await applyArtifacts(ctx, args.ownerId, deltaOf(delta, "artifacts"));
		await applyMessages(ctx, args.ownerId, deltaOf(delta, "messages"));
		await applyEvents(ctx, args.ownerId, deltaOf(delta, "events"), args.commandId, args.operation);
		await applyOutbox(ctx, args.ownerId, deltaOf(delta, "outbox"));
		await applyReceipts(
			ctx,
			args.ownerId,
			deltaOf(delta, "commandReceipts"),
			args.operation === "importSnapshot",
		);
		await applyRoomSequences(
			ctx,
			args.ownerId,
			deltaOf(delta, "roomSequences"),
			args.operation === "importSnapshot",
		);

		const revision = actualRevision + 1;
		if (state) await ctx.db.patch(state._id, { revision, updatedAt: args.committedAt });
		else await ctx.db.insert("collaborationState", { ownerId: args.ownerId, revision, updatedAt: args.committedAt });
		return { revision };
	},
});

async function applyRooms(ctx: MutationCtx, ownerId: string, delta: CollectionDelta): Promise<void> {
	for (const roomId of delta.deletes) {
		const row = await ctx.db.query("collaborationRooms").withIndex("by_owner_room", (q) => q.eq("ownerId", ownerId).eq("roomId", roomId)).first();
		if (row) await ctx.db.delete(row._id);
	}
	for (const value of delta.upserts) {
		const record = asRecord(value, "rooms");
		const roomId = stringField(record, "id", "rooms");
		const row = await ctx.db.query("collaborationRooms").withIndex("by_owner_room", (q) => q.eq("ownerId", ownerId).eq("roomId", roomId)).first();
		const document = { ownerId, roomId, status: stringField(record, "status", "rooms"), updatedAt: numberField(record, "updatedAt", "rooms"), record };
		if (row) await ctx.db.replace(row._id, document);
		else await ctx.db.insert("collaborationRooms", document);
	}
}

async function applyRuns(ctx: MutationCtx, ownerId: string, delta: CollectionDelta): Promise<void> {
	for (const runId of delta.deletes) {
		const row = await ctx.db.query("collaborationRuns").withIndex("by_owner_run", (q) => q.eq("ownerId", ownerId).eq("runId", runId)).first();
		if (row) await ctx.db.delete(row._id);
	}
	for (const value of delta.upserts) {
		const record = asRecord(value, "runs");
		const runId = stringField(record, "id", "runs");
		const row = await ctx.db.query("collaborationRuns").withIndex("by_owner_run", (q) => q.eq("ownerId", ownerId).eq("runId", runId)).first();
		const document = { ownerId, runId, roomId: stringField(record, "roomId", "runs"), status: stringField(record, "status", "runs"), createdAt: numberField(record, "createdAt", "runs"), updatedAt: numberField(record, "updatedAt", "runs"), record };
		if (row) await ctx.db.replace(row._id, document);
		else await ctx.db.insert("collaborationRuns", document);
	}
}

async function applyTasks(ctx: MutationCtx, ownerId: string, delta: CollectionDelta): Promise<void> {
	for (const taskId of delta.deletes) {
		const row = await ctx.db.query("collaborationTasks").withIndex("by_owner_task", (q) => q.eq("ownerId", ownerId).eq("taskId", taskId)).first();
		if (row) await ctx.db.delete(row._id);
	}
	for (const value of delta.upserts) {
		const record = asRecord(value, "tasks");
		const taskId = stringField(record, "id", "tasks");
		const row = await ctx.db.query("collaborationTasks").withIndex("by_owner_task", (q) => q.eq("ownerId", ownerId).eq("taskId", taskId)).first();
		const document = { ownerId, taskId, runId: stringField(record, "runId", "tasks"), status: stringField(record, "status", "tasks"), priority: numberField(record, "priority", "tasks"), ...(optionalNumber(record, "nextAttemptAt") !== undefined ? { nextAttemptAt: optionalNumber(record, "nextAttemptAt") } : {}), createdAt: numberField(record, "createdAt", "tasks"), updatedAt: numberField(record, "updatedAt", "tasks"), record };
		if (row) await ctx.db.replace(row._id, document);
		else await ctx.db.insert("collaborationTasks", document);
	}
}

async function applyAttempts(ctx: MutationCtx, ownerId: string, delta: CollectionDelta): Promise<void> {
	for (const attemptId of delta.deletes) {
		const row = await ctx.db.query("collaborationAttempts").withIndex("by_owner_attempt", (q) => q.eq("ownerId", ownerId).eq("attemptId", attemptId)).first();
		if (row) await ctx.db.delete(row._id);
	}
	for (const value of delta.upserts) {
		const record = asRecord(value, "attempts");
		const lease = asRecord(record.lease, "attempts.lease");
		const attemptId = stringField(record, "id", "attempts");
		const row = await ctx.db.query("collaborationAttempts").withIndex("by_owner_attempt", (q) => q.eq("ownerId", ownerId).eq("attemptId", attemptId)).first();
		const document = { ownerId, attemptId, runId: stringField(record, "runId", "attempts"), taskId: stringField(record, "taskId", "attempts"), status: stringField(record, "status", "attempts"), number: numberField(record, "number", "attempts"), leaseOwnerId: stringField(lease, "ownerId", "attempts.lease"), leaseFence: numberField(lease, "fence", "attempts.lease"), leaseExpiresAt: numberField(lease, "expiresAt", "attempts.lease"), startedAt: numberField(record, "startedAt", "attempts"), updatedAt: numberField(record, "updatedAt", "attempts"), record };
		if (row) await ctx.db.replace(row._id, document);
		else await ctx.db.insert("collaborationAttempts", document);
	}
}

async function applyHandoffs(ctx: MutationCtx, ownerId: string, delta: CollectionDelta): Promise<void> {
	for (const handoffId of delta.deletes) {
		const row = await ctx.db.query("collaborationHandoffs").withIndex("by_owner_handoff", (q) => q.eq("ownerId", ownerId).eq("handoffId", handoffId)).first();
		if (row) await ctx.db.delete(row._id);
	}
	for (const value of delta.upserts) {
		const record = asRecord(value, "handoffs");
		const handoffId = stringField(record, "id", "handoffs");
		const row = await ctx.db.query("collaborationHandoffs").withIndex("by_owner_handoff", (q) => q.eq("ownerId", ownerId).eq("handoffId", handoffId)).first();
		const expiresAt = optionalNumber(record, "expiresAt");
		const document = { ownerId, handoffId, runId: stringField(record, "runId", "handoffs"), taskId: stringField(record, "taskId", "handoffs"), status: stringField(record, "status", "handoffs"), ...(expiresAt !== undefined ? { expiresAt } : {}), createdAt: numberField(record, "createdAt", "handoffs"), updatedAt: numberField(record, "updatedAt", "handoffs"), record };
		if (row) await ctx.db.replace(row._id, document);
		else await ctx.db.insert("collaborationHandoffs", document);
	}
}

async function applyApprovals(ctx: MutationCtx, ownerId: string, delta: CollectionDelta): Promise<void> {
	for (const approvalId of delta.deletes) {
		const row = await ctx.db.query("collaborationApprovals").withIndex("by_owner_approval", (q) => q.eq("ownerId", ownerId).eq("approvalId", approvalId)).first();
		if (row) await ctx.db.delete(row._id);
	}
	for (const value of delta.upserts) {
		const record = asRecord(value, "approvals");
		const approvalId = stringField(record, "id", "approvals");
		const row = await ctx.db.query("collaborationApprovals").withIndex("by_owner_approval", (q) => q.eq("ownerId", ownerId).eq("approvalId", approvalId)).first();
		const expiresAt = optionalNumber(record, "expiresAt");
		const document = { ownerId, approvalId, runId: stringField(record, "runId", "approvals"), taskId: stringField(record, "taskId", "approvals"), status: stringField(record, "status", "approvals"), ...(expiresAt !== undefined ? { expiresAt } : {}), createdAt: numberField(record, "createdAt", "approvals"), updatedAt: numberField(record, "updatedAt", "approvals"), record };
		if (row) await ctx.db.replace(row._id, document);
		else await ctx.db.insert("collaborationApprovals", document);
	}
}

async function applyArtifacts(ctx: MutationCtx, ownerId: string, delta: CollectionDelta): Promise<void> {
	for (const artifactId of delta.deletes) {
		const row = await ctx.db.query("collaborationArtifacts").withIndex("by_owner_artifact", (q) => q.eq("ownerId", ownerId).eq("artifactId", artifactId)).first();
		if (row) await ctx.db.delete(row._id);
	}
	for (const value of delta.upserts) {
		const record = asRecord(value, "artifacts");
		const artifactId = stringField(record, "id", "artifacts");
		const row = await ctx.db.query("collaborationArtifacts").withIndex("by_owner_artifact", (q) => q.eq("ownerId", ownerId).eq("artifactId", artifactId)).first();
		const taskId = optionalString(record, "taskId");
		const attemptId = optionalString(record, "attemptId");
		const document = { ownerId, artifactId, runId: stringField(record, "runId", "artifacts"), ...(taskId !== undefined ? { taskId } : {}), ...(attemptId !== undefined ? { attemptId } : {}), kind: stringField(record, "kind", "artifacts"), createdAt: numberField(record, "createdAt", "artifacts"), record };
		if (row) await ctx.db.replace(row._id, document);
		else await ctx.db.insert("collaborationArtifacts", document);
	}
}

async function applyMessages(ctx: MutationCtx, ownerId: string, delta: CollectionDelta): Promise<void> {
	for (const messageId of delta.deletes) {
		const row = await ctx.db.query("collaborationMessages").withIndex("by_owner_message", (q) => q.eq("ownerId", ownerId).eq("messageId", messageId)).first();
		if (row) await ctx.db.delete(row._id);
	}
	for (const value of delta.upserts) {
		const record = asRecord(value, "messages");
		const messageId = stringField(record, "id", "messages");
		const row = await ctx.db.query("collaborationMessages").withIndex("by_owner_message", (q) => q.eq("ownerId", ownerId).eq("messageId", messageId)).first();
		const threadRootMessageId = optionalString(record, "threadRootMessageId");
		const runId = optionalString(record, "runId");
		const taskId = optionalString(record, "taskId");
		const pinnedAt = optionalNumber(record, "pinnedAt");
		const document = {
			ownerId,
			messageId,
			roomId: stringField(record, "roomId", "messages"),
			authorId: stringField(record, "authorId", "messages"),
			...(threadRootMessageId !== undefined ? { threadRootMessageId } : {}),
			...(runId !== undefined ? { runId } : {}),
			...(taskId !== undefined ? { taskId } : {}),
			...(pinnedAt !== undefined ? { pinnedAt } : {}),
			createdAt: numberField(record, "createdAt", "messages"),
			updatedAt: numberField(record, "updatedAt", "messages"),
			record,
		};
		if (row) await ctx.db.replace(row._id, document);
		else await ctx.db.insert("collaborationMessages", document);
	}
}

async function applyEvents(ctx: MutationCtx, ownerId: string, delta: CollectionDelta, commandId: string, operation: string): Promise<void> {
	for (const eventId of delta.deletes) {
		const row = await ctx.db.query("collaborationEvents").withIndex("by_owner_event", (q) => q.eq("ownerId", ownerId).eq("eventId", eventId)).first();
		if (row) await ctx.db.delete(row._id);
	}
	for (const value of delta.upserts) {
		const record = asRecord(value, "events");
		const eventId = stringField(record, "eventId", "events");
		const eventCommandId = stringField(record, "commandId", "events");
		if (operation !== "importSnapshot" && eventCommandId !== commandId) {
			throw new ConvexError({ code: "COLLABORATION_EVENT_COMMAND_MISMATCH", eventId });
		}
		const roomId = stringField(record, "roomId", "events");
		const roomSeq = numberField(record, "roomSeq", "events");
		const collision = await ctx.db.query("collaborationEvents").withIndex("by_owner_room_seq", (q) => q.eq("ownerId", ownerId).eq("roomId", roomId).eq("roomSeq", roomSeq)).first();
		if (collision && collision.eventId !== eventId) {
			throw new ConvexError({ code: "COLLABORATION_ROOM_SEQUENCE_CONFLICT", roomId, roomSeq });
		}
		const row = await ctx.db.query("collaborationEvents").withIndex("by_owner_event", (q) => q.eq("ownerId", ownerId).eq("eventId", eventId)).first();
		const runId = optionalString(record, "runId");
		const taskId = optionalString(record, "taskId");
		const attemptId = optionalString(record, "attemptId");
		const document = { ownerId, eventId, roomId, ...(runId !== undefined ? { runId } : {}), ...(taskId !== undefined ? { taskId } : {}), ...(attemptId !== undefined ? { attemptId } : {}), roomSeq, type: stringField(record, "type", "events"), commandId: eventCommandId, createdAt: numberField(record, "createdAt", "events"), record };
		if (row) await ctx.db.replace(row._id, document);
		else await ctx.db.insert("collaborationEvents", document);
		await advanceRoomSequence(ctx, ownerId, roomId, roomSeq);
	}
}

async function applyOutbox(ctx: MutationCtx, ownerId: string, delta: CollectionDelta): Promise<void> {
	for (const outboxId of delta.deletes) {
		const row = await ctx.db.query("collaborationOutbox").withIndex("by_owner_outbox", (q) => q.eq("ownerId", ownerId).eq("outboxId", outboxId)).first();
		if (row) await ctx.db.delete(row._id);
	}
	for (const value of delta.upserts) {
		const record = asRecord(value, "outbox");
		const outboxId = stringField(record, "id", "outbox");
		const row = await ctx.db.query("collaborationOutbox").withIndex("by_owner_outbox", (q) => q.eq("ownerId", ownerId).eq("outboxId", outboxId)).first();
		const claimExpiresAt = optionalNumber(record, "claimExpiresAt");
		const document = { ownerId, outboxId, status: stringField(record, "status", "outbox"), nextAttemptAt: numberField(record, "nextAttemptAt", "outbox"), ...(claimExpiresAt !== undefined ? { claimExpiresAt } : {}), createdAt: numberField(record, "createdAt", "outbox"), updatedAt: numberField(record, "updatedAt", "outbox"), record };
		if (row) await ctx.db.replace(row._id, document);
		else await ctx.db.insert("collaborationOutbox", document);
	}
}

async function applyReceipts(
	ctx: MutationCtx,
	ownerId: string,
	delta: CollectionDelta,
	allowReplacement: boolean,
): Promise<void> {
	for (const commandId of delta.deletes) {
		const row = await ctx.db.query("collaborationCommandReceipts").withIndex("by_owner_command", (q) => q.eq("ownerId", ownerId).eq("commandId", commandId)).first();
		if (row) await ctx.db.delete(row._id);
	}
	for (const value of delta.upserts) {
		const record = asRecord(value, "commandReceipts");
		const commandId = stringField(record, "commandId", "commandReceipts");
		const operation = stringField(record, "operation", "commandReceipts");
		const fingerprint = stringField(record, "fingerprint", "commandReceipts");
		const row = await ctx.db.query("collaborationCommandReceipts").withIndex("by_owner_command", (q) => q.eq("ownerId", ownerId).eq("commandId", commandId)).first();
		if (!allowReplacement && row && (row.operation !== operation || row.fingerprint !== fingerprint)) {
			throw new ConvexError({ code: "COLLABORATION_IDEMPOTENCY_CONFLICT", commandId });
		}
		const document = { ownerId, commandId, operation, fingerprint, committedAt: numberField(record, "committedAt", "commandReceipts"), record };
		if (row) await ctx.db.replace(row._id, document);
		else await ctx.db.insert("collaborationCommandReceipts", document);
	}
}

async function applyRoomSequences(
	ctx: MutationCtx,
	ownerId: string,
	delta: CollectionDelta,
	replaceExactly: boolean,
): Promise<void> {
	for (const roomId of delta.deletes) {
		const row = await ctx.db.query("collaborationRoomSequences").withIndex("by_owner_room", (q) => q.eq("ownerId", ownerId).eq("roomId", roomId)).first();
		if (row) await ctx.db.delete(row._id);
	}
	for (const value of delta.upserts) {
		const record = asRecord(value, "roomSequences");
		const roomId = stringField(record, "roomId", "roomSequences");
		const roomSeq = numberField(record, "roomSeq", "roomSequences");
		if (!replaceExactly) {
			await advanceRoomSequence(ctx, ownerId, roomId, roomSeq);
			continue;
		}
		const row = await ctx.db
			.query("collaborationRoomSequences")
			.withIndex("by_owner_room", (q) => q.eq("ownerId", ownerId).eq("roomId", roomId))
			.first();
		if (row) await ctx.db.patch(row._id, { roomSeq });
		else await ctx.db.insert("collaborationRoomSequences", { ownerId, roomId, roomSeq });
	}
}

async function advanceRoomSequence(ctx: MutationCtx, ownerId: string, roomId: string, roomSeq: number): Promise<void> {
	const row = await ctx.db.query("collaborationRoomSequences").withIndex("by_owner_room", (q) => q.eq("ownerId", ownerId).eq("roomId", roomId)).first();
	if (row) {
		if (roomSeq > row.roomSeq) await ctx.db.patch(row._id, { roomSeq });
	} else {
		await ctx.db.insert("collaborationRoomSequences", { ownerId, roomId, roomSeq });
	}
}
