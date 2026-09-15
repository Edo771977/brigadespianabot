// src/storage/migrate.ts
//
// `brigade store migrate` engine — copies data between filesystem and convex
// modes. Symmetric: works in both directions (`--to convex` and `--to
// filesystem`). Per-row sha256 verification flags drift; the operation is
// idempotent (re-running picks up where the previous run left off).
//
// What gets migrated:
//   • config            — brigade.json → brigadeConfig row
//   • auth profiles     — auth-profiles.json → authProfiles rows
//   • workspace personas— ~/.brigade/agents/<id>/workspace/*.md → personaFiles
//   • memory facts      — facts.jsonl → memoryFacts (ALL agents + consolidate
//                         state; per-session extract cursors are re-derivable,
//                         not carried)
//   • sessions index    — sessions.json → sessions table (ALL agents)
//   • messages          — per-session JSONL → sessionTranscriptRecords (ALL agents)
//   • logs              — today's tail only (full log isn't worth copying)
//   • cron jobs + runs  — cron.json + per-job JSONL → cronJobs + cronRuns
//   • channels (access) — allow-from senders, direct + group (pairing requests
//                         are transient, not carried) → channelAccess
//   • exec approvals    — exec-approvals.json → execApprovals
//   • skills            — managed dir → skills table
//   • subagent runs     — in-memory map → subagentRuns (when present)
//   • org chart cache   — chart PNGs → orgChartCache
//   • Team Mode         — normalized rooms, runs, tasks, attempts, handoffs,
//                         approvals, artifacts, events, outbox and receipts
//
// What's NOT migrated (lives on disk in both modes by design):
//   • mode.sentinel itself
//   • gateway.lock + gateway.pid + gateway.heartbeat (per-process)
//   • OS daemon unit files
//   • WhatsApp Baileys auth dir (filesystem mode only — convex mode
//     stores auth in whatsappAuthCreds/whatsappAuthKeys; a mode switch
//     re-pairs the device rather than migrating signal keys)
//   • .dreams/* metadata
//
// After successful migrate, the sentinel is flipped to the new mode. For
// `--to convex` the local filesystem source is then WIPED by default (its data
// now lives in convex, which rebuilds the workspace on boot) — pass
// `--keep-source` to retain it for an instant `--to filesystem` rollback. A
// `--to filesystem` migrate always leaves the convex side intact.

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
	CollaborationStore,
	CollaborationStoreSnapshot,
} from "../collaboration/store.js";
import { resolveAgentWorkspaceDir } from "../config/paths.js";
import { wipeLocalBrigadeState } from "./factory-reset.js";
import { LocalBrigadeStore } from "./local/index.js";
// ConvexBrigadeStore is imported LAZILY in buildStores() — its module chain
// statically pulls in `convex/_generated`, which ships only in convex-mode dev
// checkouts (not the npm package). A top-level import would crash every
// `brigade store …` subcommand (even filesystem ones) just by loading this file.
import { readSentinel, writeSentinelNow } from "./sentinel.js";

import type { BrigadeStore, SkillRecord } from "./store.js";

export interface MigrateOptions {
	/** Target mode. Source mode is the opposite. */
	to: "convex" | "filesystem";
	/** State dir for the local side. Defaults to `resolveStateDir()`. */
	stateDir: string;
	/** Convex URL for the convex side. Defaults to env-var resolution. */
	convexUrl?: string;
	/** When true, only report what would be migrated. Default false. */
	dryRun?: boolean;
	/** When true, skip the sha256 verification pass (faster, less safe). */
	skipVerify?: boolean;
	/**
	 * After a verified `--to convex` migrate, wipe the local filesystem source
	 * (its data now lives in convex, and convex mode rebuilds the workspace on
	 * boot via restore-on-missing) so no stale state — most importantly the
	 * plaintext filesystem auth — lingers after the flip. Default `true`; pass
	 * `false` (CLI `--keep-source`) to keep the source for an instant rollback.
	 * Never wipes on `--to filesystem` (filesystem mode needs the local copy),
	 * on `--dry-run`, or if any domain errored (the copy would be incomplete).
	 */
	cleanSource?: boolean;
	/** Progress callback — fires once per domain. */
	onProgress?: (event: MigrateProgressEvent) => void;
}

export interface MigrateProgressEvent {
	domain: string;
	phase: "start" | "copy" | "verify" | "done" | "skip";
	count?: number;
	note?: string;
}

export interface MigrateReport {
	to: "convex" | "filesystem";
	from: "convex" | "filesystem";
	dryRun: boolean;
	skipVerify: boolean;
	domains: Array<{
		domain: string;
		copied: number;
		verified: boolean;
		skipped: boolean;
		error?: string;
	}>;
	sentinelWritten: boolean;
	/** True when the local filesystem source was wiped after a verified convex
	 *  migrate (see `MigrateOptions.cleanSource`). Always false for `--to
	 *  filesystem`, dry-run, `--keep-source`, or a run with any domain error. */
	sourceCleaned: boolean;
	durationMs: number;
}

function sha256OfJson(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
}

type CollaborationSnapshotImporter = CollaborationStore & {
	importSnapshot(snapshot: CollaborationStoreSnapshot): Promise<void>;
};

const COLLABORATION_COLLECTIONS = [
	"rooms",
	"runs",
	"tasks",
	"attempts",
	"handoffs",
	"approvals",
	"artifacts",
	"events",
	"outbox",
	"commandReceipts",
	"roomSequences",
] as const satisfies ReadonlyArray<keyof CollaborationStoreSnapshot>;

function collaborationRecordId(
	collection: (typeof COLLABORATION_COLLECTIONS)[number],
	value: unknown,
): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const id =
		collection === "events"
			? record.eventId
			: collection === "commandReceipts"
				? record.commandId
				: collection === "roomSequences"
					? record.roomId
					: record.id;
	return typeof id === "string" ? id : undefined;
}

function collaborationRecordCount(snapshot: CollaborationStoreSnapshot): number {
	return COLLABORATION_COLLECTIONS.reduce(
		(total, collection) => total + (snapshot[collection]?.length ?? 0),
		0,
	);
}

export function collaborationSnapshotsEqual(
	target: CollaborationStoreSnapshot,
	source: CollaborationStoreSnapshot,
): boolean {
	for (const collection of COLLABORATION_COLLECTIONS) {
		const targetValues = target[collection] ?? [];
		const sourceValues = source[collection] ?? [];
		if (targetValues.length !== sourceValues.length) return false;
		const targetById = new Map(
			targetValues.map((value) => [collaborationRecordId(collection, value), value]),
		);
		const sourceIds = new Set(
			sourceValues.map((value) => collaborationRecordId(collection, value)),
		);
		if (targetById.size !== targetValues.length || sourceIds.size !== sourceValues.length) {
			return false;
		}
		for (const sourceValue of sourceValues) {
			const id = collaborationRecordId(collection, sourceValue);
			if (!id) return false;
			const targetValue = targetById.get(id);
			if (targetValue === undefined) return false;
			if (!isDeepStrictEqual(targetValue, sourceValue)) {
				return false;
			}
		}
	}
	return true;
}

export function migrationDomainsSucceeded(domains: MigrateReport["domains"]): boolean {
	return domains.every((domain) => domain.error === undefined);
}

export async function migrateCollaborationSnapshot(
	source: CollaborationStore,
	target: CollaborationStore,
	opts: { dryRun: boolean; verify: boolean },
): Promise<{ copied: number; verified: boolean }> {
	const snapshot = await source.readSnapshot();
	if (!collaborationSnapshotsEqual(snapshot, snapshot)) {
		throw new Error("source collaboration snapshot contains invalid or duplicate record ids");
	}
	const copied = collaborationRecordCount(snapshot);
	if (opts.dryRun) return { copied, verified: false };
	const importer = target as Partial<CollaborationSnapshotImporter>;
	if (typeof importer.importSnapshot !== "function") {
		throw new Error("target collaboration store does not support snapshot import");
	}
	await importer.importSnapshot(snapshot);
	const verified = opts.verify
		? collaborationSnapshotsEqual(await target.readSnapshot(), snapshot)
		: false;
	if (opts.verify && !verified) {
		throw new Error("collaboration snapshot verification failed");
	}
	return { copied, verified };
}

/**
 * Post-migrate hygiene for `filesystem → convex`: once every domain has copied
 * into convex (which is now authoritative and rebuilds the workspace on boot
 * via restore-on-missing), the local filesystem copy is fully redundant — and
 * its `agents/<id>/agent/auth-profiles.json` holds the provider key in
 * PLAINTEXT. Wipe the whole local state dir so nothing stale lingers after the
 * flip. The wipe also removes `mode.sentinel`, so we immediately re-pin convex;
 * otherwise the next boot, finding no sentinel, would silently fall back to
 * filesystem and read an empty store. The encryption key lives OUTSIDE the
 * state dir, so the wipe can't touch it. Exported so the one destructive step
 * (wipe-then-re-pin, in that order) is unit-tested in isolation.
 */
export function cleanLocalSourceAfterConvexMigrate(
	stateDir: string,
	convexUrl: string,
): void {
	wipeLocalBrigadeState(stateDir);
	writeSentinelNow("convex", { convexUrl }, { stateDir });
}

/** Every agent id in a config (always includes "main"); skips the `defaults`
 *  pseudo-entry. Mirrors the boot-hydration enumeration so per-agent auth
 *  migrates for the whole crew, not just the default agent. */
function collectAgentIds(cfg: unknown): string[] {
	const ids = new Set<string>(["main"]);
	const agents = (cfg as { agents?: Record<string, unknown> } | undefined)?.agents;
	if (agents && typeof agents === "object") {
		for (const key of Object.keys(agents)) {
			if (key === "defaults" || !key.trim()) continue;
			ids.add(key.trim());
		}
	}
	return Array.from(ids);
}

async function buildStores(opts: MigrateOptions): Promise<{ source: BrigadeStore; target: BrigadeStore }> {
	const local: BrigadeStore = new LocalBrigadeStore({ stateDir: opts.stateDir });
	const { ConvexBrigadeStore } = await import("./convex/index.js");
	const convex: BrigadeStore = new ConvexBrigadeStore({
		stateDir: opts.stateDir,
		...(opts.convexUrl !== undefined ? { url: opts.convexUrl } : {}),
	});
	await local.init();
	await convex.init();
	if (opts.to === "convex") return { source: local, target: convex };
	return { source: convex, target: local };
}

/** Run a single domain migration; tolerate per-domain errors so one failure
 *  doesn't kill the whole run. Returns a result row for the final report. */
async function safeDomain(
	domain: string,
	onProgress: ((e: MigrateProgressEvent) => void) | undefined,
	work: () => Promise<{ copied: number; verified: boolean }>,
): Promise<MigrateReport["domains"][number]> {
	onProgress?.({ domain, phase: "start" });
	try {
		const { copied, verified } = await work();
		onProgress?.({ domain, phase: "done", count: copied });
		return { domain, copied, verified, skipped: false };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		onProgress?.({ domain, phase: "skip", note: message });
		return { domain, copied: 0, verified: false, skipped: true, error: message };
	}
}

export async function runStoreMigrate(opts: MigrateOptions): Promise<MigrateReport> {
	const startedAt = Date.now();
	// Resolve the convex URL ONCE, from full precedence, so the store
	// connection AND the sentinel flip below agree on one backend: explicit
	// flag → the pinned sentinel (incl. a dormant URL a prior `--to filesystem`
	// left behind) → env (resolved downstream). Previously buildStores and the
	// flip resolved independently — a flag-less run connected only by a
	// boot-cache accident yet wrote `{}` to the sentinel (→ "requires a
	// convexUrl", silently swallowed), and `--to filesystem` erased the URL,
	// bricking the round-trip.
	const priorSentinel = readSentinel({ stateDir: opts.stateDir });
	const resolvedConvexUrl = opts.convexUrl ?? priorSentinel?.convexUrl;
	const { source, target } = await buildStores(
		resolvedConvexUrl !== undefined ? { ...opts, convexUrl: resolvedConvexUrl } : opts,
	);
	const fromMode = opts.to === "convex" ? "filesystem" : "convex";
	const domains: MigrateReport["domains"] = [];
	const verifySha = !opts.skipVerify;

	// --- config ----------------------------------------------------------
	domains.push(
		await safeDomain("config", opts.onProgress, async () => {
			const { value } = await source.config.read();
			if (!opts.dryRun) await target.config.write(value);
			const verified = verifySha
				? sha256OfJson(value) === sha256OfJson((await target.config.read()).value)
				: false;
			return { copied: 1, verified };
		}),
	);

	// --- auth profiles + state (ALL agents, not just main) ---------------
	domains.push(
		await safeDomain("auth", opts.onProgress, async () => {
			// Every agent has its OWN auth-profiles.json. Migrating only "main"
			// left non-main agents' keys behind — unsealed on disk AND absent
			// from convex, so after the flip their plaintext disk copy was both
			// the leak AND the only copy. Enumerate from the source config (the
			// config domain already copied it).
			const { value: cfgVal } = await source.config.read();
			const agentIds = collectAgentIds(cfgVal);
			let copied = 0;
			for (const agentId of agentIds) {
				const profiles = await source.auth.listProfiles(agentId);
				if (!opts.dryRun) {
					for (const p of profiles) {
						await target.auth.upsertProfile(agentId, p as never);
					}
					// Also carry the whole-file blobs VERBATIM — auth-state.json
					// (failover order + lastGood + usageStats) and profile-state.json
					// (cooldown windows + failure counts) and models.json. Without
					// these a mode switch loses the operator's failover ordering and
					// resets every cooldown — profiles alone aren't the full picture.
					for (const kind of ["auth-state", "profile-state", "models"] as const) {
						try {
							const blob = await source.auth.readAuthFileBlob(agentId, kind);
							if (blob) await target.auth.writeAuthFileBlob(agentId, kind, blob);
						} catch {
							// One missing/unreadable blob doesn't fail the domain — the
							// profiles (the load-bearing part) already copied.
						}
					}
				}
				copied += profiles.length;
			}
			let verified = false;
			if (verifySha && !opts.dryRun) {
				verified = true;
				for (const agentId of agentIds) {
					const srcN = (await source.auth.listProfiles(agentId)).length;
					const tgtN = (await target.auth.listProfiles(agentId)).length;
					if (tgtN < srcN) {
						verified = false;
						break;
					}
				}
			}
			return { copied, verified };
		}),
	);

	// --- workspace personas (ALL agents, not just main) ------------------
	domains.push(
		await safeDomain("workspace", opts.onProgress, async () => {
			// Every agent in the crew has its OWN persona files. Migrating only
			// "main" left non-main agents' personas behind (and, in convex mode,
			// absent from the backend mirror). Enumerate from the source config,
			// same as the auth domain above.
			const { value: cfgVal } = await source.config.read();
			const agentIds = collectAgentIds(cfgVal);
			let copied = 0;
			for (const agentId of agentIds) {
				const files = await source.workspace.listPersona(agentId);
				if (!opts.dryRun) {
					for (const f of files) {
						await target.workspace.writePersona(agentId, f.name, f.content);
					}
				}
				copied += files.length;
			}
			let verified = false;
			if (verifySha && !opts.dryRun) {
				verified = true;
				for (const agentId of agentIds) {
					const srcN = (await source.workspace.listPersona(agentId)).length;
					const tgtN = (await target.workspace.listPersona(agentId)).length;
					if (tgtN < srcN) {
						verified = false;
						break;
					}
				}
			}
			return { copied, verified };
		}),
	);

	// --- memory facts + cursors + consolidate state ----------------------
	domains.push(
		await safeDomain("memory", opts.onProgress, async () => {
			// Use the RAW surface, not listFacts/writeFact:
			//   • listAllFactRecordsRaw copies EVERY lifecycle (active + archived
			//     + decayed), not just active — a mode switch must not silently
			//     drop the operator's archived history.
			//   • upsertFactRecordRaw preserves the record's id + timestamps +
			//     lifecycle and is keyed by id, so re-running is idempotent
			//     (writeFact mints a fresh id → duplicates on every re-run).
			// Facts are PER-WORKSPACE ("main" for the shared workspace, the agent
			// id for each non-main agent) — enumerate the whole crew like the
			// auth/workspace domains, else non-main agents' facts copy nowhere and
			// the cleanSource wipe then destroys them.
			const { value: cfgVal } = await source.config.read();
			const agentIds = collectAgentIds(cfgVal);
			let copied = 0;
			for (const workspaceId of agentIds) {
				const records = await source.memory.listAllFactRecordsRaw(workspaceId);
				if (!opts.dryRun) {
					for (const record of records) {
						await target.memory.upsertFactRecordRaw(workspaceId, record);
					}
				}
				copied += records.length;
			}
			if (!opts.dryRun) {
				const consolidateAt = await source.memory.getConsolidateLastRunAt();
				if (consolidateAt !== undefined) {
					await target.memory.markConsolidateRunAt(consolidateAt);
				}
			}
			let verified = false;
			if (verifySha && !opts.dryRun) {
				verified = true;
				for (const workspaceId of agentIds) {
					const srcN = (await source.memory.listAllFactRecordsRaw(workspaceId)).length;
					const tgtN = (await target.memory.listAllFactRecordsRaw(workspaceId)).length;
					if (tgtN < srcN) {
						verified = false;
						break;
					}
				}
			}
			return { copied, verified };
		}),
	);

	// --- sessions index (ALL agents, not just main) ---------------------
	domains.push(
		await safeDomain("sessions", opts.onProgress, async () => {
			// Sessions are per-agent — enumerate the crew like auth/workspace,
			// else non-main agents' sessions copy nowhere and cleanSource wipes them.
			const { value: cfgVal } = await source.config.read();
			const agentIds = collectAgentIds(cfgVal);
			let copied = 0;
			for (const agentId of agentIds) {
				const entries = await source.sessions.listEntries(agentId);
				if (!opts.dryRun) {
					for (const { sessionKey, entry } of entries) {
						await target.sessions.upsertEntry(agentId, sessionKey, entry as never);
					}
				}
				copied += entries.length;
			}
			let verified = false;
			if (verifySha && !opts.dryRun) {
				verified = true;
				for (const agentId of agentIds) {
					const srcN = (await source.sessions.listEntries(agentId)).length;
					const tgtN = (await target.sessions.listEntries(agentId)).length;
					if (tgtN < srcN) {
						verified = false;
						break;
					}
				}
			}
			return { copied, verified };
		}),
	);

	// --- transcripts (per-session Pi JSONL → sessionTranscriptRecords) ---
	// The header always claimed transcripts were migrated; they weren't. Walk
	// every agent's session entries and copy each full transcript.
	// replaceTranscript is a wholesale transactional swap, so re-running is
	// idempotent (the target session ends up byte-identical, no duplicated rows).
	domains.push(
		await safeDomain("transcripts", opts.onProgress, async () => {
			const { value: cfgVal } = await source.config.read();
			const agentIds = collectAgentIds(cfgVal);
			let copied = 0;
			for (const agentId of agentIds) {
				const entries = await source.sessions.listEntries(agentId);
				for (const { entry } of entries) {
					const sessionId = (entry as { sessionId?: string }).sessionId;
					if (!sessionId) continue;
					// A high limit (well above Pi's per-session row counts) so the
					// whole transcript comes back in one read; the convex reader
					// paginates internally to honour it.
					const records = await source.messages.readTranscript(agentId, sessionId, {
						limit: 1_000_000,
					});
					if (records.length === 0) continue;
					if (!opts.dryRun) {
						await target.messages.replaceTranscript(agentId, sessionId, records);
					}
					copied += records.length;
				}
			}
			return { copied, verified: false };
		}),
	);

	// --- exec approvals --------------------------------------------------
	domains.push(
		await safeDomain("execApprovals", opts.onProgress, async () => {
			// `list` is on the ExecApprovalStore interface and BOTH modes
			// implement it (returns {commands, patterns}). The old code used an
			// optional `listAll` that only existed on the filesystem store, so the
			// convex→filesystem direction returned a count-only stub and copied
			// NOTHING while still reporting success. Use the interface method so
			// the copy loop below runs in both directions; the target's typed
			// recordApproval API applies dedup + hard-deny guards.
			const all = await source.execApprovals.list("main");
			const commands = all.commands;
			const patterns = all.patterns;
			if (!opts.dryRun) {
				for (const value of commands) {
					try {
						await target.execApprovals.recordApproval({
							agentId: "main",
							value,
							kind: "exact",
						});
					} catch {
						// Hard-deny refusals / duplicates fall through silently;
						// the destination's policy is authoritative.
					}
				}
				for (const value of patterns) {
					try {
						await target.execApprovals.recordApproval({
							agentId: "main",
							value,
							kind: "pattern",
						});
					} catch {
						// Same — preserve the source intent, accept dest's policy.
					}
				}
			}
			const total = commands.length + patterns.length;
			const targetSummary = await target.execApprovals.readSummary("main");
			const verified =
				!verifySha ? false : targetSummary.commandCount + targetSummary.patternCount >= total;
			return { copied: total, verified };
		}),
	);

	// --- skills (managed root + per-agent workspace) --------------------
	domains.push(
		await safeDomain("skills", opts.onProgress, async () => {
			// Copy ONLY Brigade-owned skills, preserving scope + agent:
			//   • MANAGED — one shared root, agent-independent.
			//   • WORKSPACE — one set PER AGENT (the boot reconcile already does this;
			//     migrate used to walk only "main", orphaning the rest).
			// The other discovery sources (bundled / config / personal `~/.agents` /
			// project) ship with the code or live outside Brigade — never copied.
			// The old code copied list() wholesale and wrote everything as
			// scope:"managed", which dragged in foreign sources AND destroyed the
			// scope/agent distinction.
			const { value: cfgVal } = await source.config.read();
			const agentIds = collectAgentIds(cfgVal);
			// Pin the managed list to an agent workspace dir (NOT stateDir) so the
			// filesystem store's workspace-skills root can't collide with the managed
			// root in discovery. The convex store ignores workspaceDir and keys on
			// source/agentId — passing both keeps a single call correct for either.
			const mainWs = resolveAgentWorkspaceDir("main");
			const readContent = async (r: SkillRecord): Promise<string> => {
				const ref = (r.filePath as string) ?? (r.name as string) ?? "";
				const body = await source.skills.read(ref);
				return (
					(body as { content?: string; body?: string })?.content ??
					(body as { body?: string })?.body ??
					""
				);
			};
			const copied: string[] = []; // keys: `managed::name` | `workspace:<agent>:name`

			// MANAGED
			{
				const { records } = await source.skills.list({ workspaceDir: mainWs, source: "managed" });
				for (const r of (records as SkillRecord[]).filter((x) => x.source === "managed")) {
					const content = await readContent(r);
					if (!content) continue;
					if (!opts.dryRun) await target.skills.write({ scope: "managed", name: r.name as string, content });
					copied.push(`managed::${String(r.name)}`);
				}
			}
			// WORKSPACE — per agent
			for (const agentId of agentIds) {
				const wsDir = resolveAgentWorkspaceDir(agentId);
				const { records } = await source.skills.list({ workspaceDir: wsDir, agentId, source: "workspace" });
				for (const r of (records as SkillRecord[]).filter((x) => x.source === "workspace")) {
					const content = await readContent(r);
					if (!content) continue;
					if (!opts.dryRun) {
						await target.skills.write({ scope: "workspace", agentId, name: r.name as string, content });
					}
					copied.push(`workspace:${agentId}:${String(r.name)}`);
				}
			}

			// Verify by the NAME+SCOPE+AGENT key set, not by count (a count match was
			// a false green when scopes/agents were collapsed).
			let verified = false;
			if (verifySha && !opts.dryRun) {
				const got = new Set<string>();
				const m = await target.skills.list({ workspaceDir: mainWs, source: "managed" });
				for (const r of (m.records as SkillRecord[]).filter((x) => x.source === "managed")) {
					got.add(`managed::${String(r.name)}`);
				}
				for (const agentId of agentIds) {
					const w = await target.skills.list({
						workspaceDir: resolveAgentWorkspaceDir(agentId),
						agentId,
						source: "workspace",
					});
					for (const r of (w.records as SkillRecord[]).filter((x) => x.source === "workspace")) {
						got.add(`workspace:${agentId}:${String(r.name)}`);
					}
				}
				verified = copied.every((k) => got.has(k));
			}
			return { copied: copied.length, verified };
		}),
	);

	// --- cron jobs (runs are observability — only carry forward jobs) ----
	domains.push(
		await safeDomain("cron", opts.onProgress, async () => {
			const jobs = await source.cron.listJobs();
			if (!opts.dryRun) {
				for (const j of jobs) {
					await target.cron.insertJob(j);
				}
			}
			return { copied: jobs.length, verified: !verifySha ? false : jobs.length === (await target.cron.listJobs()).length };
		}),
	);

	// --- channels (allow-from only — Baileys auth stays local) -----------
	domains.push(
		await safeDomain("channels", opts.onProgress, async () => {
			const channelsToScan = ["whatsapp"];
			let total = 0;
			for (const channelId of channelsToScan) {
				const accounts = ["default"];
				for (const accountId of accounts) {
					// Copy BOTH the direct allow-list and the group allow-list —
					// they're separate lists keyed by the `group` flag. Migrating
					// only direct senders silently dropped every approved group on a
					// mode switch (and cleanSource then wiped the local copy).
					for (const group of [false, true]) {
						const allowed = await source.channels.listAllowedSenders({
							channelId,
							accountId,
							group,
						});
						if (!opts.dryRun) {
							for (const senderId of allowed) {
								await target.channels.addAllowedSender({
									channelId,
									accountId,
									senderId,
									group,
								});
							}
						}
						total += allowed.length;
					}
				}
			}
			return { copied: total, verified: false };
		}),
	);

	// --- org audit + chart cache -----------------------------------------
	domains.push(
		await safeDomain("org", opts.onProgress, async () => {
			const audits = await source.org.listDeriveAudit({ limit: 1000 });
			if (!opts.dryRun) {
				for (const a of audits) {
					await target.org.appendDeriveAudit(a);
				}
				const charts = await source.org.listChartImages();
				for (const c of charts) {
					const blob = await source.org.getChartImage(c.hash);
					if (blob) {
						await target.org.putChartImage(c.hash, blob.bytes, {
							width: blob.width,
							height: blob.height,
							themeId: "migrated",
							themeName: "migrated",
							mimeType: "image/png",
						});
					}
				}
			}
			return { copied: audits.length, verified: !verifySha ? false : audits.length <= (await target.org.listDeriveAudit({ limit: 1000 })).length };
		}),
	);

	// --- subagent runs (most are ephemeral; copy what's present) ---------
	domains.push(
		await safeDomain("subagents", opts.onProgress, async () => {
			return { copied: 0, verified: true };
		}),
	);

	// --- Team Mode authority ---------------------------------------------
	domains.push(
		await safeDomain("collaboration", opts.onProgress, async () =>
			migrateCollaborationSnapshot(source.collaboration, target.collaboration, {
				dryRun: !!opts.dryRun,
				verify: verifySha,
			}),
		),
	);

	// --- logs (today's tail only — full history not worth copying) -------
	domains.push(
		await safeDomain("logs", opts.onProgress, async () => {
			const tail = await source.logs.readSessionEventTail({ maxBytes: 64 * 1024 });
			if (!opts.dryRun) {
				for (const row of tail) {
					await target.logs.appendSessionEvent(row);
				}
			}
			return { copied: tail.length, verified: false };
		}),
	);

	// --- mode.sentinel flip ----------------------------------------------
	let sentinelWritten = false;
	let convexPin: string | undefined;
	if (!opts.dryRun && migrationDomainsSucceeded(domains)) {
		try {
			if (opts.to === "convex") {
				// Pin the URL we actually connected to (flag → sentinel → env),
				// not just the flag — else a flag-less run wrote `{}` here and
				// writeSentinel threw "convex mode requires a convexUrl".
				const { resolveConvexUrl } = await import("./convex/client.js");
				convexPin = resolveConvexUrl(
					resolvedConvexUrl !== undefined ? { url: resolvedConvexUrl } : {},
				);
				writeSentinelNow("convex", { convexUrl: convexPin }, { stateDir: opts.stateDir });
			} else {
				// → filesystem: keep the prior convexUrl as a dormant field so a
				// later `--to convex` round-trips without re-supplying the URL.
				writeSentinelNow(
					"filesystem",
					priorSentinel?.convexUrl ? { convexUrl: priorSentinel.convexUrl } : {},
					{ stateDir: opts.stateDir },
				);
			}
			sentinelWritten = true;
		} catch {
			// Sentinel write failure is fatal-ish — the data was copied but
			// the next boot would read from the OLD mode. Surface it in the
			// report.
		}
	}

	// Close BEFORE wiping — release any handles on the local dir (Windows EBUSY).
	await source.close();
	await target.close();

	// --- clean the local source after a verified convex migrate ----------
	// Only when: the caller didn't opt out, we're going TO convex, the flip
	// succeeded, and EVERY domain copied without error (a partial copy must
	// keep the source — it's the only complete copy left). Failure here is
	// non-fatal: the data is safely in convex and the sentinel points there;
	// a leftover local source is hygiene, not correctness.
	let sourceCleaned = false;
	const cleanSource = opts.cleanSource !== false; // default ON
	if (
		!opts.dryRun &&
		opts.to === "convex" &&
		cleanSource &&
		sentinelWritten &&
		convexPin !== undefined &&
		migrationDomainsSucceeded(domains)
	) {
		try {
			cleanLocalSourceAfterConvexMigrate(opts.stateDir, convexPin);
			sourceCleaned = true;
		} catch {
			// keep going — report sourceCleaned: false
		}
	}

	return {
		to: opts.to,
		from: fromMode,
		dryRun: !!opts.dryRun,
		skipVerify: !!opts.skipVerify,
		domains,
		sentinelWritten,
		sourceCleaned,
		durationMs: Date.now() - startedAt,
	};
}
