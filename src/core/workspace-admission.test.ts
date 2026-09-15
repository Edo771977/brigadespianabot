import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkspaceAdmissionController, canonicalWorkspacePath } from "./workspace-admission.js";

function deferred<T = void>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function nextTurn(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for admission state");
		await nextTurn();
	}
}

test("ordinary turns overlap until a queued Team writer blocks new admissions", async () => {
	const admission = new WorkspaceAdmissionController();
	const releaseFirst = deferred();
	const releaseSecond = deferred();
	const releaseTeam = deferred();
	const events: string[] = [];

	const first = admission.run({ workspaceDir: "/tmp/brigade-admission-a", mode: "ordinary" }, async () => {
		events.push("ordinary-1:start");
		await releaseFirst.promise;
		events.push("ordinary-1:end");
	});
	const second = admission.run({ workspaceDir: "/tmp/brigade-admission-a", mode: "ordinary" }, async () => {
		events.push("ordinary-2:start");
		await releaseSecond.promise;
		events.push("ordinary-2:end");
	});
	await waitFor(() => events.length === 2);
	assert.deepEqual(new Set(events), new Set(["ordinary-1:start", "ordinary-2:start"]));

	const team = admission.run({ workspaceDir: "/tmp/brigade-admission-a", mode: "team" }, async () => {
		events.push("team:start");
		await releaseTeam.promise;
		events.push("team:end");
	});
	const lateOrdinary = admission.run(
		{ workspaceDir: "/tmp/brigade-admission-a", mode: "ordinary" },
		async () => { events.push("ordinary-3:start"); },
	);
	await nextTurn();
	assert.equal(events.includes("team:start"), false);
	assert.equal(events.includes("ordinary-3:start"), false);

	releaseFirst.resolve();
	await nextTurn();
	assert.equal(events.includes("team:start"), false);
	releaseSecond.resolve();
	await waitFor(() => events.includes("team:start"));
	assert.equal(events.at(-1), "team:start");
	assert.equal(events.includes("ordinary-3:start"), false);
	releaseTeam.resolve();
	await Promise.all([first, second, team, lateOrdinary]);
	assert.ok(events.indexOf("ordinary-3:start") > events.indexOf("team:end"));
});

test("Team writers are exclusive while distinct workspaces remain parallel", async () => {
	const admission = new WorkspaceAdmissionController();
	const releaseFirst = deferred();
	const events: string[] = [];
	const first = admission.run({ workspaceDir: "/tmp/brigade-admission-b", mode: "team" }, async () => {
		events.push("team-1:start");
		await releaseFirst.promise;
		events.push("team-1:end");
	});
	const second = admission.run(
		{ workspaceDir: "/tmp/brigade-admission-b", mode: "team" },
		async () => { events.push("team-2:start"); },
	);
	const otherWorkspace = admission.run(
		{ workspaceDir: "/tmp/brigade-admission-c", mode: "team" },
		async () => { events.push("other:start"); },
	);
	await waitFor(() => events.length === 2);
	assert.deepEqual(new Set(events), new Set(["team-1:start", "other:start"]));
	releaseFirst.resolve();
	await Promise.all([first, second, otherWorkspace]);
	assert.ok(events.indexOf("team-2:start") > events.indexOf("team-1:end"));
});

test("asynchronous path resolution cannot reorder admission calls", async () => {
	const releaseFirstResolution = deferred();
	const releaseFirstOperation = deferred();
	const events: string[] = [];
	const admission = new WorkspaceAdmissionController(async (workspaceDir) => {
		if (workspaceDir === "first") await releaseFirstResolution.promise;
		return "/same/canonical/workspace";
	});
	const first = admission.run({ workspaceDir: "first", mode: "team" }, async () => {
		events.push("first:start");
		await releaseFirstOperation.promise;
		events.push("first:end");
	});
	const second = admission.run({ workspaceDir: "second", mode: "ordinary" }, async () => {
		events.push("second:start");
	});
	await nextTurn();
	assert.equal(events.length, 0);
	releaseFirstResolution.resolve();
	await waitFor(() => events.includes("first:start"));
	assert.equal(events.includes("second:start"), false);
	releaseFirstOperation.resolve();
	await Promise.all([first, second]);
	assert.deepEqual(events, ["first:start", "first:end", "second:start"]);
});

test("aborting a queued Team writer removes its writer-priority barrier", async () => {
	const admission = new WorkspaceAdmissionController();
	const releaseReader = deferred();
	const controller = new AbortController();
	const events: string[] = [];
	let waitsStarted = 0;
	let waitsEnded = 0;
	const reader = admission.run({ workspaceDir: "/tmp/brigade-admission-d", mode: "ordinary" }, async () => {
		events.push("reader:start");
		await releaseReader.promise;
	});
	await waitFor(() => events.includes("reader:start"));
	const team = admission.run({
		workspaceDir: "/tmp/brigade-admission-d",
		mode: "team",
		signal: controller.signal,
		onWaitStart: () => { waitsStarted += 1; },
		onWaitEnd: () => { waitsEnded += 1; },
	}, async () => { events.push("team:start"); });
	await waitFor(() => waitsStarted === 1);
	const lateReader = admission.run(
		{ workspaceDir: "/tmp/brigade-admission-d", mode: "ordinary" },
		async () => { events.push("late-reader:start"); },
	);
	await nextTurn();
	assert.equal(events.includes("late-reader:start"), false);
	const reason = new Error("cancel Team wait");
	controller.abort(reason);
	await assert.rejects(team, (error) => error === reason);
	await lateReader;
	assert.equal(events.includes("team:start"), false);
	assert.equal(events.includes("late-reader:start"), true);
	assert.equal(waitsStarted, 1);
	assert.equal(waitsEnded, 1);
	releaseReader.resolve();
	await reader;
});

test("an ordinary descendant inherits its admitted reader cohort without deadlocking", async () => {
	const admission = new WorkspaceAdmissionController();
	const teamStarted = deferred();
	const teamQueued = deferred();
	const releaseTeam = deferred();
	const events: string[] = [];
	let queuedTeam: Promise<void> | undefined;
	const reader = admission.run({ workspaceDir: "/tmp/brigade-admission-e", mode: "ordinary" }, async () => {
		events.push("reader:start");
		queuedTeam = admission.run({
			workspaceDir: "/tmp/brigade-admission-e",
			mode: "team",
			onWaitStart: () => teamQueued.resolve(),
		}, async () => {
			events.push("team:start");
			teamStarted.resolve();
			await releaseTeam.promise;
		});
		await teamQueued.promise;
		await admission.run({ workspaceDir: "/tmp/brigade-admission-e", mode: "ordinary" }, async () => {
			events.push("child-reader:start");
		});
		events.push("reader:end");
	});
	await reader;
	await teamStarted.promise;
	assert.deepEqual(events.slice(0, 4), ["reader:start", "child-reader:start", "reader:end", "team:start"]);
	releaseTeam.resolve();
	await queuedTeam;
});

test("canonical paths collapse symlink aliases, including a missing leaf", async (t) => {
	if (process.platform === "win32") return t.skip("directory symlink setup needs platform privileges");
	const base = await mkdtemp(path.join(os.tmpdir(), "brigade-admission-canonical-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const physical = path.join(base, "physical");
	const alias = path.join(base, "alias");
	await mkdir(physical);
	await symlink(physical, alias, "dir");
	assert.equal(
		await canonicalWorkspacePath(path.join(alias, "not-created-yet")),
		await canonicalWorkspacePath(path.join(physical, "not-created-yet")),
	);

	const admission = new WorkspaceAdmissionController();
	const releaseTeam = deferred();
	const events: string[] = [];
	const team = admission.run({ workspaceDir: alias, mode: "team" }, async () => {
		events.push("team:start");
		await releaseTeam.promise;
		events.push("team:end");
	});
	await waitFor(() => events.includes("team:start"));
	const ordinary = admission.run({ workspaceDir: physical, mode: "ordinary" }, async () => {
		events.push("ordinary:start");
	});
	await nextTurn();
	assert.equal(events.includes("ordinary:start"), false);
	releaseTeam.resolve();
	await Promise.all([team, ordinary]);
	assert.deepEqual(events, ["team:start", "team:end", "ordinary:start"]);
});
