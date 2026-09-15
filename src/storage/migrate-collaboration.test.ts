import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

import type { CollaborationStore, CollaborationStoreSnapshot } from "../collaboration/store.js";
import {
	collaborationSnapshotsEqual,
	migrationDomainsSucceeded,
	migrateCollaborationSnapshot,
} from "./migrate.js";
import { LocalCollaborationStore } from "./local/collaboration-store.js";

const roots: string[] = [];
const storeRoots = new WeakMap<LocalCollaborationStore, string>();

async function openStore(label: string): Promise<LocalCollaborationStore> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `brigade-migrate-${label}-`));
	roots.push(root);
	const store = new LocalCollaborationStore(root);
	await store.init();
	storeRoots.set(store, root);
	return store;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Team Mode store migration", () => {
	it("replaces target state exactly and is idempotent", async () => {
		const source = await openStore("source");
		const target = await openStore("target");
		await source.createRoom({
			commandId: "source-room-command",
			roomId: "source-room",
			title: "Source",
			createdBy: "owner",
			now: 1,
		});
		await target.createRoom({
			commandId: "target-room-command",
			roomId: "target-room",
			title: "Target",
			createdBy: "owner",
			now: 1,
		});

		const first = await migrateCollaborationSnapshot(source, target, {
			dryRun: false,
			verify: true,
		});
		assert.equal(first.copied, 5);
		assert.equal(first.verified, true);
		assert.deepEqual(
			(await target.listRooms()).map((room) => room.id).sort(),
			["source-room"],
		);

		const targetJournal = path.join(storeRoots.get(target) as string, "collaboration", "journal.jsonl");
		const beforeReplay = await fs.readFile(targetJournal, "utf8");
		const second = await migrateCollaborationSnapshot(source, target, {
			dryRun: false,
			verify: true,
		});
		assert.equal(second.verified, true);
		assert.equal(await fs.readFile(targetJournal, "utf8"), beforeReplay);
		await source.close();
		await target.close();
	});

	it("replaces conflicting target history with the authoritative source", async () => {
		const source = await openStore("conflict-source");
		const target = await openStore("conflict-target");
		await source.createRoom({
			commandId: "shared-command",
			roomId: "source-room",
			title: "Source",
			createdBy: "owner",
			now: 1,
		});
		await target.createRoom({
			commandId: "shared-command",
			roomId: "target-room",
			title: "Target",
			createdBy: "owner",
			now: 1,
		});

		const result = await migrateCollaborationSnapshot(source, target, {
			dryRun: false,
			verify: true,
		});
		assert.equal(result.verified, true);
		assert.deepEqual(await target.readSnapshot(), await source.readSnapshot());
		await source.close();
		await target.close();
	});

	it("requires exact room cursors and rejects target-only authority state", async () => {
		const source = {
			rooms: [],
			runs: [],
			tasks: [],
			attempts: [],
			handoffs: [],
			approvals: [],
			artifacts: [],
			events: [],
			outbox: [],
			commandReceipts: [],
			roomSequences: [{ roomId: "room", roomSeq: 4 }],
		};
		assert.equal(
			collaborationSnapshotsEqual(
				{ ...source, roomSequences: [{ roomId: "room", roomSeq: 5 }] },
				source,
			),
			false,
		);
		assert.equal(
			collaborationSnapshotsEqual(
				{ ...source, roomSequences: [{ roomId: "room", roomSeq: 3 }] },
				source,
			),
			false,
		);
		assert.equal(
			collaborationSnapshotsEqual(
				{
					...source,
					rooms: [
						{
							id: "target-only",
							title: "Stale",
							createdBy: "owner",
							status: "open",
							members: [],
							metadata: {},
							createdAt: 1,
							updatedAt: 1,
						},
					],
				},
				source,
			),
			false,
		);
	});

	it("does not authorize an authority flip after any domain error", () => {
		assert.equal(
			migrationDomainsSucceeded([
				{ domain: "collaboration", copied: 0, verified: false, skipped: true, error: "copy failed" },
			]),
			false,
		);
		assert.equal(
			migrationDomainsSucceeded([
				{ domain: "collaboration", copied: 5, verified: true, skipped: false },
			]),
			true,
		);
	});

	it("turns an exact-verification mismatch into a migration error", async () => {
		const empty: CollaborationStoreSnapshot = {
			rooms: [],
			runs: [],
			tasks: [],
			attempts: [],
			handoffs: [],
			approvals: [],
			artifacts: [],
			events: [],
			outbox: [],
			commandReceipts: [],
			roomSequences: [],
		};
		const source = { readSnapshot: async () => empty } as CollaborationStore;
		const target = {
			readSnapshot: async () => ({
				...empty,
				roomSequences: [{ roomId: "stale", roomSeq: 1 }],
			}),
			importSnapshot: async () => undefined,
		} as unknown as CollaborationStore;
		await assert.rejects(
			() => migrateCollaborationSnapshot(source, target, { dryRun: false, verify: true }),
			/collaboration snapshot verification failed/,
		);
	});
});
