import type { ConvexHttpClient } from "convex/browser";

import { api } from "../../../convex/_generated/api.js";
import { InMemoryCollaborationStore } from "../../collaboration/memory-store.js";
import type {
	AckOutboxCommand,
	AddArtifactCommand,
	AddTasksCommand,
	ArchiveRoomCommand,
	CancelRunCommand,
	CancelTaskCommand,
	ClaimOutboxCommand,
	ClaimReadyTaskCommand,
	CollaborationStore,
	CollaborationStoreSnapshot,
	CommandMeta,
	CommandResult,
	CompleteAttemptCommand,
	CreateRoomCommand,
	CreateRunCommand,
	DelegateAttemptChildrenCommand,
	DelegateAttemptChildrenResult,
	DelegateRunCommand,
	DelegateRunResult,
	EventQuery,
	EditRoomMessageCommand,
	FailAttemptCommand,
	DeleteRoomMessageCommand,
	MessageQuery,
	MessageSearchQuery,
	NackOutboxCommand,
	OfferHandoffCommand,
	PinRoomMessageCommand,
	PostRoomMessageCommand,
	ReactRoomMessageCommand,
	ReconcileCommand,
	RecordAttemptUsageCommand,
	RenewAttemptLeaseCommand,
	RequestApprovalCommand,
	ResolveApprovalCommand,
	RespondHandoffCommand,
	RetryTaskCommand,
	StartRunCommand,
	UpdateRoomCommand,
} from "../../collaboration/store.js";
import type {
	Artifact,
	AttemptId,
	CollaborationEvent,
	CollaborationOutboxItem,
	CollaborationRoom,
	Handoff,
	MessageId,
	RoomMessage,
	RoomMetrics,
	ReconciliationReport,
	RoomId,
	RunId,
	RunSnapshot,
	TaskAttempt,
	TaskId,
	TeamApproval,
	TeamRun,
	TeamTask,
} from "../../collaboration/types.js";
import { CollaborationConflictError } from "../../collaboration/types.js";

import { getReactiveConvexClient } from "./client.js";

const MAX_OCC_ATTEMPTS = 16;

const SNAPSHOT_COLLECTIONS = [
	"rooms",
	"runs",
	"tasks",
	"attempts",
	"handoffs",
	"approvals",
	"artifacts",
	"messages",
	"events",
	"outbox",
	"commandReceipts",
	"roomSequences",
] as const satisfies ReadonlyArray<keyof CollaborationStoreSnapshot>;

type SnapshotCollection = (typeof SNAPSHOT_COLLECTIONS)[number];

export interface CollaborationCollectionDelta {
	upserts: unknown[];
	deletes: string[];
}

export type CollaborationSnapshotDelta = Partial<
	Record<SnapshotCollection, CollaborationCollectionDelta>
>;

interface LoadedState {
	revision: number;
	snapshot: CollaborationStoreSnapshot;
}

interface Deps {
	client: ConvexHttpClient;
	ownerId: string;
}

/**
 * Convex Team Mode adapter.
 *
 * Convex commits are optimistic: the adapter reads one consistent normalized
 * snapshot, evaluates the shared semantic state machine, then commits the
 * resulting per-record delta only if the owner revision is unchanged. A
 * conflicting writer forces a reload and a fresh semantic decision.
 */
export class ConvexCollaborationStore implements CollaborationStore {
	constructor(private readonly deps: Deps) {}

	createRoom(command: CreateRoomCommand): Promise<CommandResult<CollaborationRoom>> {
		return this.mutate("createRoom", command, (store) => store.createRoom(command));
	}

	updateRoom(command: UpdateRoomCommand): Promise<CommandResult<CollaborationRoom>> {
		return this.mutate("updateRoom", command, (store) => store.updateRoom(command));
	}

	archiveRoom(command: ArchiveRoomCommand): Promise<CommandResult<CollaborationRoom>> {
		return this.mutate("archiveRoom", command, (store) => store.archiveRoom(command));
	}

	async listRooms(): Promise<CollaborationRoom[]> {
		return (await this.readDelegate()).listRooms();
	}

	async getRoom(roomId: RoomId): Promise<CollaborationRoom | undefined> {
		const room = await this.deps.client.query(api.collaboration.getRoom, {
			ownerId: this.deps.ownerId,
			roomId,
		}) as CollaborationRoom | null;
		return room ?? undefined;
	}

	createRun(command: CreateRunCommand): Promise<CommandResult<TeamRun>> {
		return this.mutate("createRun", command, (store) => store.createRun(command));
	}

	delegateRun(command: DelegateRunCommand): Promise<CommandResult<DelegateRunResult>> {
		return this.mutate("delegateRun", command, (store) => store.delegateRun(command));
	}

	startRun(command: StartRunCommand): Promise<CommandResult<TeamRun>> {
		return this.mutate("startRun", command, (store) => store.startRun(command));
	}

	async listRuns(roomId?: RoomId): Promise<TeamRun[]> {
		return (await this.readDelegate()).listRuns(roomId);
	}

	async getRun(runId: RunId): Promise<TeamRun | undefined> {
		const run = await this.deps.client.query(api.collaboration.getRun, {
			ownerId: this.deps.ownerId,
			runId,
		}) as TeamRun | null;
		return run ?? undefined;
	}

	async readRunSnapshot(runId: RunId): Promise<RunSnapshot | undefined> {
		return (await this.readDelegate()).readRunSnapshot(runId);
	}

	addTasks(command: AddTasksCommand): Promise<CommandResult<TeamTask[]>> {
		return this.mutate("addTasks", command, (store) => store.addTasks(command));
	}

	async listTasks(runId: RunId): Promise<TeamTask[]> {
		return (await this.readDelegate()).listTasks(runId);
	}

	async getTask(taskId: TaskId): Promise<TeamTask | undefined> {
		return (await this.readDelegate()).getTask(taskId);
	}

	claimReadyTask(command: ClaimReadyTaskCommand): Promise<CommandResult<TaskAttempt | undefined>> {
		return this.mutate("claimReadyTask", command, (store) => store.claimReadyTask(command));
	}

	renewAttemptLease(command: RenewAttemptLeaseCommand): Promise<CommandResult<TaskAttempt>> {
		return this.mutate("renewAttemptLease", command, (store) =>
			store.renewAttemptLease(command),
		);
	}

	completeAttempt(command: CompleteAttemptCommand): Promise<CommandResult<TaskAttempt>> {
		return this.mutate("completeAttempt", command, (store) => store.completeAttempt(command));
	}

	failAttempt(command: FailAttemptCommand): Promise<CommandResult<TaskAttempt>> {
		return this.mutate("failAttempt", command, (store) => store.failAttempt(command));
	}

	delegateAttemptChildren(command: DelegateAttemptChildrenCommand): Promise<CommandResult<DelegateAttemptChildrenResult>> {
		return this.mutate("delegateAttemptChildren", command, (store) => store.delegateAttemptChildren(command));
	}

	recordAttemptUsage(command: RecordAttemptUsageCommand): Promise<CommandResult<TaskAttempt>> {
		return this.mutate("recordAttemptUsage", command, (store) => store.recordAttemptUsage(command));
	}

	cancelTask(command: CancelTaskCommand): Promise<CommandResult<TeamTask>> {
		return this.mutate("cancelTask", command, (store) => store.cancelTask(command));
	}

	retryTask(command: RetryTaskCommand): Promise<CommandResult<TeamTask>> {
		return this.mutate("retryTask", command, (store) => store.retryTask(command));
	}

	cancelRun(command: CancelRunCommand): Promise<CommandResult<TeamRun>> {
		return this.mutate("cancelRun", command, (store) => store.cancelRun(command));
	}

	async getAttempt(attemptId: AttemptId): Promise<TaskAttempt | undefined> {
		return (await this.readDelegate()).getAttempt(attemptId);
	}

	async listAttempts(taskId: TaskId): Promise<TaskAttempt[]> {
		return (await this.readDelegate()).listAttempts(taskId);
	}

	offerHandoff(command: OfferHandoffCommand): Promise<CommandResult<Handoff>> {
		return this.mutate("offerHandoff", command, (store) => store.offerHandoff(command));
	}

	acceptHandoff(command: RespondHandoffCommand): Promise<CommandResult<Handoff>> {
		return this.mutate("acceptHandoff", command, (store) => store.acceptHandoff(command));
	}

	rejectHandoff(command: RespondHandoffCommand): Promise<CommandResult<Handoff>> {
		return this.mutate("rejectHandoff", command, (store) => store.rejectHandoff(command));
	}

	async listHandoffs(runId: RunId): Promise<Handoff[]> {
		return (await this.readDelegate()).listHandoffs(runId);
	}

	requestApproval(command: RequestApprovalCommand): Promise<CommandResult<TeamApproval>> {
		return this.mutate("requestApproval", command, (store) => store.requestApproval(command));
	}

	resolveApproval(command: ResolveApprovalCommand): Promise<CommandResult<TeamApproval>> {
		return this.mutate("resolveApproval", command, (store) => store.resolveApproval(command));
	}

	async listApprovals(runId: RunId): Promise<TeamApproval[]> {
		return (await this.readDelegate()).listApprovals(runId);
	}

	addArtifact(command: AddArtifactCommand): Promise<CommandResult<Artifact>> {
		return this.mutate("addArtifact", command, (store) => store.addArtifact(command));
	}

	async listArtifacts(runId: RunId): Promise<Artifact[]> {
		return (await this.readDelegate()).listArtifacts(runId);
	}

	postMessage(command: PostRoomMessageCommand): Promise<CommandResult<RoomMessage>> {
		return this.mutate("postMessage", command, (store) => store.postMessage(command));
	}

	editMessage(command: EditRoomMessageCommand): Promise<CommandResult<RoomMessage>> {
		return this.mutate("editMessage", command, (store) => store.editMessage(command));
	}

	deleteMessage(command: DeleteRoomMessageCommand): Promise<CommandResult<RoomMessage>> {
		return this.mutate("deleteMessage", command, (store) => store.deleteMessage(command));
	}

	reactMessage(command: ReactRoomMessageCommand): Promise<CommandResult<RoomMessage>> {
		return this.mutate("reactMessage", command, (store) => store.reactMessage(command));
	}

	pinMessage(command: PinRoomMessageCommand): Promise<CommandResult<RoomMessage>> {
		return this.mutate("pinMessage", command, (store) => store.pinMessage(command));
	}

	async getMessage(messageId: MessageId): Promise<RoomMessage | undefined> {
		return (await this.readDelegate()).getMessage(messageId);
	}

	async listMessages(query: MessageQuery): Promise<RoomMessage[]> {
		return (await this.readDelegate()).listMessages(query);
	}

	async searchMessages(query: MessageSearchQuery): Promise<RoomMessage[]> {
		return (await this.readDelegate()).searchMessages(query);
	}

	async getRoomMetrics(roomId: RoomId): Promise<RoomMetrics> {
		return (await this.readDelegate()).getRoomMetrics(roomId);
	}

	async readEvents(query: EventQuery): Promise<CollaborationEvent[]> {
		return (await this.deps.client.query(api.collaboration.readEvents, {
			ownerId: this.deps.ownerId,
			...(query.roomId !== undefined ? { roomId: query.roomId } : {}),
			...(query.runId !== undefined ? { runId: query.runId } : {}),
			...(query.afterRoomSeq !== undefined ? { afterRoomSeq: query.afterRoomSeq } : {}),
			...(query.limit !== undefined ? { limit: query.limit } : {}),
		})) as CollaborationEvent[];
	}

	claimOutbox(command: ClaimOutboxCommand): Promise<CommandResult<CollaborationOutboxItem[]>> {
		return this.mutate("claimOutbox", command, (store) => store.claimOutbox(command));
	}

	ackOutbox(command: AckOutboxCommand): Promise<CommandResult<CollaborationOutboxItem>> {
		return this.mutate("ackOutbox", command, (store) => store.ackOutbox(command));
	}

	nackOutbox(command: NackOutboxCommand): Promise<CommandResult<CollaborationOutboxItem>> {
		return this.mutate("nackOutbox", command, (store) => store.nackOutbox(command));
	}

	reconcile(command: ReconcileCommand): Promise<CommandResult<ReconciliationReport>> {
		return this.mutate("reconcile", command, (store) => store.reconcile(command));
	}

	async readSnapshot(): Promise<CollaborationStoreSnapshot> {
		return (
			await this.load({ includeEvents: true, includeOutbox: true, includeReceipts: true })
		).snapshot;
	}

	/** Best-effort wake hint; callers resume with readEvents(afterRoomSeq). */
	subscribe(onChange: () => void): () => void {
		const reactive = getReactiveConvexClient();
		const unsubscribe = reactive.onUpdate(
			api.collaboration.load,
			{ ownerId: this.deps.ownerId },
			() => {
				try {
					onChange();
				} catch {
					// One subscriber must not break the live query.
				}
			},
		);
		return () => {
			try {
				unsubscribe();
			} catch {
				// Idempotent.
			}
		};
	}

	/** Migration hook used by `brigade store migrate`; normal commands never call it. */
	async importSnapshot(snapshot: CollaborationStoreSnapshot): Promise<void> {
		const source = normalizeSnapshot(toPlainJson(snapshot) as CollaborationStoreSnapshot);
		let conflictAttempts = 0;
		while (true) {
			const loaded = await this.load({
				includeEvents: true,
				includeOutbox: true,
				includeReceipts: true,
			});
			const delta = diffCollaborationSnapshots(loaded.snapshot, source);
			if (Object.keys(delta).length === 0) return;
			const batch = takeDeltaBatch(delta, 64);
			try {
				await this.commit(loaded.revision, "importSnapshot", "migration", batch, Date.now());
				conflictAttempts = 0;
			} catch (error) {
				if (!isOccConflict(error) || conflictAttempts === MAX_OCC_ATTEMPTS - 1) throw error;
				await occBackoff(conflictAttempts);
				conflictAttempts += 1;
			}
		}
	}

	private async mutate<T>(
		operation: string,
		command: CommandMeta,
		invoke: (store: InMemoryCollaborationStore) => Promise<CommandResult<T>>,
	): Promise<CommandResult<T>> {
		for (let attempt = 0; attempt < MAX_OCC_ATTEMPTS; attempt += 1) {
			const loaded = await this.loadForCommand(operation, command);
			const delegate = new InMemoryCollaborationStore(loaded.snapshot);
			const result = await invoke(delegate);
			if (result.replayed) return result;
			const after = normalizeSnapshot(
				toPlainJson(await delegate.readSnapshot()) as CollaborationStoreSnapshot,
			);
			const delta = diffCollaborationSnapshots(loaded.snapshot, after);
			const receipt = after.commandReceipts.find((value) => value.commandId === command.commandId);
			try {
				await this.commit(
					loaded.revision,
					operation,
					command.commandId,
					delta,
					receipt?.committedAt ?? command.now ?? Date.now(),
				);
				return result;
			} catch (error) {
				if (!isOccConflict(error) || attempt === MAX_OCC_ATTEMPTS - 1) throw error;
				await occBackoff(attempt);
			}
		}
		throw new Error("unreachable collaboration OCC retry state");
	}

	private async loadForCommand(operation: string, command: CommandMeta): Promise<LoadedState> {
		const outboxId =
			operation === "ackOutbox" || operation === "nackOutbox"
				? (command as AckOutboxCommand | NackOutboxCommand).outboxId
				: undefined;
		return this.load({
			commandId: command.commandId,
			...(operation === "claimOutbox"
				? { includeOutbox: true, activeOutboxOnly: true }
				: {}),
			...(outboxId !== undefined ? { outboxId } : {}),
		});
	}

	private async readDelegate(): Promise<InMemoryCollaborationStore> {
		return new InMemoryCollaborationStore((await this.load({})).snapshot);
	}

	private async load(options: {
		commandId?: string;
		includeEvents?: boolean;
		includeOutbox?: boolean;
		activeOutboxOnly?: boolean;
		includeReceipts?: boolean;
		outboxId?: string;
	}): Promise<LoadedState> {
		const loaded = (await this.deps.client.query(api.collaboration.load, {
			ownerId: this.deps.ownerId,
			...options,
		})) as LoadedState;
		return {
			revision: loaded.revision,
			snapshot: normalizeSnapshot(loaded.snapshot),
		};
	}

	private async commit(
		expectedRevision: number,
		operation: string,
		commandId: string,
		delta: CollaborationSnapshotDelta,
		committedAt: number,
	): Promise<void> {
		await this.deps.client.mutation(api.collaboration.commit, {
			ownerId: this.deps.ownerId,
			expectedRevision,
			operation,
			commandId,
			delta,
			committedAt,
		});
	}
}

function normalizeSnapshot(snapshot: CollaborationStoreSnapshot): CollaborationStoreSnapshot {
	return {
		rooms: snapshot.rooms ?? [],
		runs: snapshot.runs ?? [],
		tasks: snapshot.tasks ?? [],
		attempts: snapshot.attempts ?? [],
		handoffs: snapshot.handoffs ?? [],
		approvals: snapshot.approvals ?? [],
		artifacts: snapshot.artifacts ?? [],
		messages: snapshot.messages ?? [],
		events: snapshot.events ?? [],
		outbox: snapshot.outbox ?? [],
		commandReceipts: snapshot.commandReceipts ?? [],
		roomSequences: snapshot.roomSequences ?? [],
	};
}

export function emptyCollaborationSnapshot(): CollaborationStoreSnapshot {
	return normalizeSnapshot({
		rooms: [],
		runs: [],
		tasks: [],
		attempts: [],
		handoffs: [],
		approvals: [],
		artifacts: [],
		messages: [],
		events: [],
		outbox: [],
		commandReceipts: [],
		roomSequences: [],
	});
}

export function diffCollaborationSnapshots(
	before: CollaborationStoreSnapshot,
	after: CollaborationStoreSnapshot,
): CollaborationSnapshotDelta {
	const delta: CollaborationSnapshotDelta = {};
	for (const collection of SNAPSHOT_COLLECTIONS) {
		const previous = new Map(
			(before[collection] ?? []).map((value) => [recordId(collection, value), value]),
		);
		const next = new Map(
			(after[collection] ?? []).map((value) => [recordId(collection, value), value]),
		);
		const upserts: unknown[] = [];
		const deletes: string[] = [];
		for (const [id, value] of next) {
			const old = previous.get(id);
			if (old === undefined || JSON.stringify(old) !== JSON.stringify(value)) upserts.push(value);
		}
		for (const id of previous.keys()) if (!next.has(id)) deletes.push(id);
		if (upserts.length > 0 || deletes.length > 0) delta[collection] = { upserts, deletes };
	}
	return delta;
}

export function applyCollaborationDelta(
	snapshot: CollaborationStoreSnapshot,
	delta: CollaborationSnapshotDelta,
): CollaborationStoreSnapshot {
	const next = structuredClone(normalizeSnapshot(snapshot));
	for (const collection of SNAPSHOT_COLLECTIONS) {
		const change = delta[collection];
		if (!change) continue;
		const values = (next[collection] ?? []) as unknown[];
		const byId = new Map(values.map((value) => [recordId(collection, value), value]));
		for (const id of change.deletes) byId.delete(id);
		for (const value of change.upserts) byId.set(recordId(collection, value), value);
		(next as unknown as Record<SnapshotCollection, unknown[]>)[collection] = [...byId.values()];
	}
	return next;
}

function takeDeltaBatch(
	delta: CollaborationSnapshotDelta,
	limit: number,
): CollaborationSnapshotDelta {
	const batch: CollaborationSnapshotDelta = {};
	let remaining = limit;
	for (const collection of SNAPSHOT_COLLECTIONS) {
		if (remaining === 0) break;
		const change = delta[collection];
		if (!change) continue;
		const deletes = change.deletes.slice(0, remaining);
		remaining -= deletes.length;
		const upserts = change.upserts.slice(0, remaining);
		remaining -= upserts.length;
		if (upserts.length > 0 || deletes.length > 0) batch[collection] = { upserts, deletes };
	}
	return batch;
}

function recordId(collection: SnapshotCollection, value: unknown): string {
	if (!value || typeof value !== "object") {
		throw new CollaborationConflictError(
			"INVALID_SNAPSHOT",
			`invalid ${collection} record in collaboration snapshot`,
		);
	}
	const record = value as Record<string, unknown>;
	const id =
		collection === "events"
			? record.eventId
			: collection === "commandReceipts"
				? record.commandId
				: collection === "roomSequences"
					? record.roomId
					: record.id;
	if (typeof id !== "string" || id.length === 0) {
		throw new CollaborationConflictError(
			"INVALID_SNAPSHOT",
			`invalid ${collection} record id in collaboration snapshot`,
		);
	}
	return id;
}

function toPlainJson(value: unknown, seen = new Set<object>()): unknown {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new CollaborationConflictError(
				"INVALID_ARGUMENT",
				"collaboration values must contain finite numbers",
			);
		}
		return value;
	}
	if (value === undefined) return undefined;
	if (typeof value !== "object") {
		throw new CollaborationConflictError(
			"INVALID_ARGUMENT",
			"collaboration values must be plain JSON values",
		);
	}
	if (seen.has(value)) {
		throw new CollaborationConflictError(
			"INVALID_ARGUMENT",
			"collaboration values must not contain cycles",
		);
	}
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map((item, index) => {
				if (!(index in value) || item === undefined) {
					throw new CollaborationConflictError(
						"INVALID_ARGUMENT",
						"collaboration arrays must not contain missing values",
					);
				}
				return toPlainJson(item, seen);
			});
		}
		const prototype = Object.getPrototypeOf(value) as unknown;
		if (prototype !== Object.prototype && prototype !== null) {
			throw new CollaborationConflictError(
				"INVALID_ARGUMENT",
				"collaboration values must be plain JSON values",
			);
		}
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			const item = (value as Record<string, unknown>)[key];
			if (item !== undefined) out[key] = toPlainJson(item, seen);
		}
		return out;
	} finally {
		seen.delete(value);
	}
}

function isOccConflict(error: unknown): boolean {
	const data = (error as { data?: unknown } | undefined)?.data;
	if (
		data &&
		typeof data === "object" &&
		(data as { code?: unknown }).code === "COLLABORATION_OCC_CONFLICT"
	) {
		return true;
	}
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("COLLABORATION_OCC_CONFLICT");
}

async function occBackoff(attempt: number): Promise<void> {
	const delayMs = Math.min(25, 1 + attempt * 2 + Math.floor(Math.random() * 4));
	await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
