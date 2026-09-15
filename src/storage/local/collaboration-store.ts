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
	RoomId,
	RunId,
	RunSnapshot,
	TaskAttempt,
	TaskId,
	TeamApproval,
	TeamRun,
	TeamTask,
	ReconciliationReport,
} from "../../collaboration/types.js";
import {
	LocalCollaborationJournal,
	type CollaborationJournalEntry,
} from "./collaboration-journal.js";

const LOCAL_COLLABORATION_TX_VERSION = 1 as const;

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

interface CollectionDelta {
	upserts: unknown[];
	deletes: string[];
}

interface LocalCollaborationTransaction {
	schemaVersion: typeof LOCAL_COLLABORATION_TX_VERSION;
	operation: string;
	commandId: string;
	delta: Partial<Record<SnapshotCollection, CollectionDelta>>;
}

/**
 * Durable single-node implementation of Team Mode's semantic store.
 *
 * Domain transitions are delegated to the same in-memory state machine used by
 * tests and higher-level orchestration. The before/after delta, including the
 * command receipt, emitted events, and outbox rows, is then committed as one
 * hash-chained journal entry before the command resolves.
 */
export class LocalCollaborationStore implements CollaborationStore {
	private readonly journal: LocalCollaborationJournal<LocalCollaborationTransaction>;

	constructor(stateDir: string) {
		this.journal = new LocalCollaborationJournal<LocalCollaborationTransaction>(stateDir);
	}

	async init(): Promise<void> {
		await this.journal.init();
	}

	async close(): Promise<void> {
		await this.journal.close();
	}

	/** Best-effort wake hint; consumers resume with readEvents(afterRoomSeq). */
	subscribe(onChange: () => void): () => void {
		return this.journal.subscribe(onChange);
	}

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
		return (await this.readDelegate()).getRoom(roomId);
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
		return (await this.readDelegate()).getRun(runId);
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
		return this.mutate("renewAttemptLease", command, (store) => store.renewAttemptLease(command));
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
		return (await this.readDelegate()).readEvents(query);
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
		return (await this.readDelegate()).readSnapshot();
	}

	/** Migration hook used by `brigade store migrate`; normal commands never call it. */
	async importSnapshot(source: CollaborationStoreSnapshot): Promise<void> {
		await this.journal.transact((entries) => {
			const before = replayJournal(entries);
			const after = normalizeSnapshot(source);
			const delta = diffSnapshots(before, after);
			if (Object.keys(delta).length === 0) return { result: undefined };
			return {
				payload: {
					schemaVersion: LOCAL_COLLABORATION_TX_VERSION,
					operation: "importSnapshot",
					commandId: "migration",
					delta,
				},
				result: undefined,
			};
		});
	}

	private mutate<T>(
		operation: string,
		command: CommandMeta,
		invoke: (store: InMemoryCollaborationStore) => Promise<CommandResult<T>>,
	): Promise<CommandResult<T>> {
		return this.journal.transact(async (entries) => {
			const before = replayJournal(entries);
			const delegate = new InMemoryCollaborationStore(before);
			const result = await invoke(delegate);
			if (result.replayed) return { result };
			const after = await delegate.readSnapshot();
			const delta = diffSnapshots(before, after);
			return {
				payload: {
					schemaVersion: LOCAL_COLLABORATION_TX_VERSION,
					operation,
					commandId: command.commandId,
					delta,
				},
				result,
				txId: command.commandId,
				...(command.now !== undefined ? { writtenAt: command.now } : {}),
			};
		});
	}

	private async readDelegate(): Promise<InMemoryCollaborationStore> {
		const entries = await this.journal.readAll();
		return new InMemoryCollaborationStore(replayJournal(entries));
	}
}

function emptySnapshot(): CollaborationStoreSnapshot {
	return {
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
	};
}

function normalizeSnapshot(snapshot: CollaborationStoreSnapshot): CollaborationStoreSnapshot {
	return structuredClone({
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
	});
}

function replayJournal(
	entries: readonly CollaborationJournalEntry<LocalCollaborationTransaction>[],
): CollaborationStoreSnapshot {
	// Replay each collection in one mutable index. The journal is already a
	// freshly parsed, hash-validated immutable input and every public read is
	// cloned by InMemoryCollaborationStore, so cloning the entire accumulated
	// snapshot after every transaction added no isolation. It made replay
	// quadratic in journal history, though: a 975-entry journal cloned all prior
	// rooms, events, outbox items, and receipts 975 times for every gateway read.
	const collections = Object.fromEntries(
		SNAPSHOT_COLLECTIONS.map((collection) => [collection, new Map<string, unknown>()]),
	) as Record<SnapshotCollection, Map<string, unknown>>;
	for (const entry of entries) {
		const transaction = entry.payload;
		if (transaction.schemaVersion !== LOCAL_COLLABORATION_TX_VERSION) {
			throw new Error(
				`unsupported local collaboration transaction schema: ${String(transaction.schemaVersion)}`,
			);
		}
		for (const collection of SNAPSHOT_COLLECTIONS) {
			const change = transaction.delta[collection];
			if (!change) continue;
			const values = collections[collection];
			for (const id of change.deletes) values.delete(id);
			for (const value of change.upserts) values.set(recordId(collection, value), value);
		}
	}
	const snapshot = emptySnapshot();
	for (const collection of SNAPSHOT_COLLECTIONS) {
		assignCollection(snapshot, collection, [...collections[collection].values()]);
	}
	return snapshot;
}

function diffSnapshots(
	before: CollaborationStoreSnapshot,
	after: CollaborationStoreSnapshot,
): Partial<Record<SnapshotCollection, CollectionDelta>> {
	const delta: Partial<Record<SnapshotCollection, CollectionDelta>> = {};
	for (const collection of SNAPSHOT_COLLECTIONS) {
		const previous = new Map(
			(before[collection] as unknown[]).map((value) => [recordId(collection, value), value]),
		);
		const next = new Map(
			(after[collection] as unknown[]).map((value) => [recordId(collection, value), value]),
		);
		const upserts: unknown[] = [];
		const deletes: string[] = [];
		for (const [id, value] of next) {
			const old = previous.get(id);
			if (old === undefined || JSON.stringify(old) !== JSON.stringify(value)) upserts.push(value);
		}
		for (const id of previous.keys()) {
			if (!next.has(id)) deletes.push(id);
		}
		if (upserts.length > 0 || deletes.length > 0) delta[collection] = { upserts, deletes };
	}
	return delta;
}

function assignCollection(
	snapshot: CollaborationStoreSnapshot,
	collection: SnapshotCollection,
	values: unknown[],
): void {
	(snapshot as unknown as Record<SnapshotCollection, unknown[]>)[collection] = values;
}

function recordId(collection: SnapshotCollection, value: unknown): string {
	if (!value || typeof value !== "object") {
		throw new Error(`invalid ${collection} record in collaboration snapshot`);
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
		throw new Error(`invalid ${collection} record id in collaboration snapshot`);
	}
	return id;
}
