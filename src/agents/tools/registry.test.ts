import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

import {
	runWithTeamExecutionContext,
	type ActiveTeamExecutionContext,
} from "../../collaboration/execution-context.js";
import { buildTeamChatSessionKey } from "../../collaboration/session-key.js";
import { __resetRenderVideoAvailabilityCache } from "./render-video/availability.js";
import { createBrigadeTools, listBrigadeToolNames } from "./registry.js";

// createBrigadeTools constructs a FileMemoryStore rooted at workspaceDir.
// Point it at a tempdir so the tools are real but isolated.
let tmpWorkspace: string;

// The Composio key, if exported in the dev/CI shell, would alter the composio
// tool's runtime state and could perturb the exact-count assertions below.
// These tests assert the baseline (no-Composio-key) surface, so neutralize it
// for the run.
const prevComposioKey = process.env.COMPOSIO_API_KEY;
delete process.env.COMPOSIO_API_KEY;

before(() => {
	tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-registry-"));
});

after(() => {
	if (prevComposioKey !== undefined) process.env.COMPOSIO_API_KEY = prevComposioKey;
});

after(() => {
	try {
		fs.rmSync(tmpWorkspace, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

describe("createBrigadeTools — Primitive #4 (memory) + agents_list + manage_agent + manage_skill", () => {
	it("returns the three memory tools + agents_list + manage_agent + manage_skill", () => {
		// Isolate from the user's real brigade.json so the `org` tool gate
		// can't surface when the dev has bootstrapped a cfg.org elsewhere.
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-registry-noorg-"));
		const prev = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = stateDir;
		// render_video is registered only when the HyperFrames engine resolves on
		// this host — force it OFF so the baseline count/name assertions are
		// deterministic regardless of whether a dev has `hyperframes` installed.
		const prevHf = process.env.BRIGADE_HYPERFRAMES_PATH;
		process.env.BRIGADE_HYPERFRAMES_PATH = path.join(stateDir, "no-such-hyperframes");
		__resetRenderVideoAvailabilityCache();
		let tools;
		try {
			tools = createBrigadeTools({
				workspaceDir: tmpWorkspace,
				agentId: "main",
				cwd: tmpWorkspace,
			});
		} finally {
			if (prev === undefined) delete process.env.BRIGADE_STATE_DIR;
			else process.env.BRIGADE_STATE_DIR = prev;
			if (prevHf === undefined) delete process.env.BRIGADE_HYPERFRAMES_PATH;
			else process.env.BRIGADE_HYPERFRAMES_PATH = prevHf;
			__resetRenderVideoAvailabilityCache();
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
		assert.equal(tools.length, 24);
		const names = tools.map((t) => t.name).sort();
		assert.deepEqual(names, [
			"agents_list",
			"analyze_media",
			"composio",
			"connect_channel",
			"edit_document",
			"find",
			"generate_image",
			"generate_music",
			"generate_speech",
			"generate_video",
			"make_document",
			"manage_access",
			"manage_agent",
			"manage_channel_access",
			"manage_memory",
			"manage_provider",
			"manage_skill",
			"message_action",
			"oauth_authorize",
			"read_memory",
			"recall_memory",
			"team",
			"transcribe_audio",
			"write_memory",
		]);
	});

	it("registers render_video only when the HyperFrames engine resolves", () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-registry-hf-"));
		const prevState = process.env.BRIGADE_STATE_DIR;
		const prevHf = process.env.BRIGADE_HYPERFRAMES_PATH;
		process.env.BRIGADE_STATE_DIR = stateDir;
		// Point the engine override at a real, resolvable executable (the running
		// node) so availability's PATH probe succeeds without a real install.
		process.env.BRIGADE_HYPERFRAMES_PATH = process.execPath;
		__resetRenderVideoAvailabilityCache();
		try {
			const names = createBrigadeTools({
				workspaceDir: tmpWorkspace,
				agentId: "main",
				cwd: tmpWorkspace,
			}).map((t) => t.name);
			assert.ok(names.includes("render_video"), "render_video present when engine resolves");
		} finally {
			if (prevState === undefined) delete process.env.BRIGADE_STATE_DIR;
			else process.env.BRIGADE_STATE_DIR = prevState;
			if (prevHf === undefined) delete process.env.BRIGADE_HYPERFRAMES_PATH;
			else process.env.BRIGADE_HYPERFRAMES_PATH = prevHf;
			__resetRenderVideoAvailabilityCache();
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("each tool has the required AgentTool shape", () => {
		const tools = createBrigadeTools({
			workspaceDir: tmpWorkspace,
			agentId: "main",
			cwd: tmpWorkspace,
		});
		for (const tool of tools) {
			assert.equal(typeof tool.name, "string");
			assert.equal(typeof tool.label, "string");
			assert.equal(typeof tool.description, "string");
			assert.ok(tool.parameters, "parameters schema present");
			assert.equal(typeof tool.execute, "function");
		}
	});

	it("includes the structured write_memory tool", () => {
		const tools = createBrigadeTools({
			workspaceDir: tmpWorkspace,
			agentId: "main",
			cwd: tmpWorkspace,
		});
		const names = tools.map((t) => t.name);
		assert.ok(names.includes("write_memory"), "write_memory tool present");
	});

	it("does not throw on common option shapes (Windows + POSIX paths)", () => {
		assert.doesNotThrow(() =>
			createBrigadeTools({
				workspaceDir: "C:\\Users\\me\\.brigade\\workspace",
				agentId: "main",
				cwd: "C:\\Users\\me",
			}),
		);
	});
});

describe("createBrigadeTools — Primitive #6 (sub-agents)", () => {
	it("does NOT register spawn_agent when subagentContext is omitted", () => {
		const tools = createBrigadeTools({
			workspaceDir: tmpWorkspace,
			agentId: "main",
			cwd: tmpWorkspace,
		});
		const names = tools.map((t) => t.name);
		assert.ok(!names.includes("spawn_agent"), "spawn_agent absent without context");
	});

	it("registers spawn_agent when subagentContext is provided at the top-level depth", () => {
		const tools = createBrigadeTools({
			workspaceDir: tmpWorkspace,
			agentId: "main",
			cwd: tmpWorkspace,
			subagentContext: {
				parentSessionKey: "agent:main:main",
				callerDepth: 0,
			},
		});
		const names = tools.map((t) => t.name);
		assert.ok(names.includes("spawn_agent"), "spawn_agent present for top-level turn");
		assert.ok(names.includes("spawn_agents"), "spawn_agents present for top-level turn");
	});

	it("drops BOTH spawn_agent + spawn_agents at leaf depth (callerDepth === maxDepth)", () => {
		const tools = createBrigadeTools({
			workspaceDir: tmpWorkspace,
			agentId: "main",
			cwd: tmpWorkspace,
			subagentContext: {
				parentSessionKey: "agent:main:main:subagent:abc",
				callerDepth: 1,
			},
			subagentMaxDepth: 1,
		});
		const names = tools.map((t) => t.name);
		assert.ok(!names.includes("spawn_agent"), "spawn_agent dropped at leaf");
		assert.ok(!names.includes("spawn_agents"), "spawn_agents dropped at leaf");
	});

	it("registers spawn_agent + spawn_agents at depth 1 when subagentMaxDepth allows depth 2", () => {
		const tools = createBrigadeTools({
			workspaceDir: tmpWorkspace,
			agentId: "main",
			cwd: tmpWorkspace,
			subagentContext: {
				parentSessionKey: "agent:main:main:subagent:abc",
				callerDepth: 1,
			},
			subagentMaxDepth: 2,
		});
		const names = tools.map((t) => t.name);
		assert.ok(
			names.includes("spawn_agent"),
			"spawn_agent present when child wouldn't be leaf",
		);
		assert.ok(
			names.includes("spawn_agents"),
			"spawn_agents present when child wouldn't be leaf",
		);
	});
});

describe("createBrigadeTools — Team Mode", () => {
	it("gives a Team coordinator one collaboration surface", () => {
		const sessionKey = buildTeamChatSessionKey("room", "main");
		const names = createBrigadeTools({
			workspaceDir: tmpWorkspace,
			agentId: "main",
			cwd: tmpWorkspace,
			senderIsOwner: true,
			sessionContext: { key: sessionKey, agentId: "main" },
			subagentContext: { parentSessionKey: sessionKey, callerDepth: 0 },
		}).map((tool) => tool.name);
		assert.ok(names.includes("team"));
		assert.ok(names.includes("agents_list"));
		assert.ok(!names.some((name) => name.startsWith("sessions_")));
		assert.ok(!names.includes("spawn_agent"));
		assert.ok(!names.includes("spawn_agents"));
	});

	it("mounts owner orchestration for a custom primary and isolates a leased worker by exact session", () => {
		const workerOptions = {
			workspaceDir: tmpWorkspace,
			agentId: "worker",
			cwd: tmpWorkspace,
		};
		const primary = createBrigadeTools({ ...workerOptions, agentId: "main" }).map((tool) => tool.name);
		assert.ok(primary.includes("team"));
		const customPrimary = createBrigadeTools({
			...workerOptions,
			agentId: "orchestrator",
			senderIsOwner: true,
		}).map((tool) => tool.name);
		assert.ok(customPrimary.includes("team"), "an owner-routed custom primary can orchestrate Team Mode");
		const outside = createBrigadeTools(workerOptions).map((tool) => tool.name);
		assert.ok(!outside.includes("team"));
		assert.ok(!outside.includes("team_task"));

		const fail = async (): Promise<never> => { throw new Error("not called"); };
		const active = {
			identifiers: {
				roomId: "room",
				runId: "run",
				taskId: "task",
				attemptId: "attempt",
				agentId: "worker",
				sessionKey: "agent:worker:team:room",
				runtimeRunId: "runtime",
			},
			getStatus: fail,
				readTaskResult: fail,
				delegateChildren: fail,
				postMessage: fail,
				readMessages: fail,
				offerHandoff: fail,
			requestApproval: fail,
			attachArtifact: fail,
		} satisfies ActiveTeamExecutionContext;
		const inside = runWithTeamExecutionContext(active, () =>
			createBrigadeTools({
				...workerOptions,
				senderIsOwner: false,
				sessionContext: { key: active.identifiers.sessionKey, agentId: "worker" },
			}).map((tool) => tool.name));
		assert.deepEqual(inside, ["find", "team_task"]);

		const inheritedChild = runWithTeamExecutionContext(active, () =>
			createBrigadeTools({
				...workerOptions,
				senderIsOwner: true,
				sessionContext: { key: `${active.identifiers.sessionKey}:subagent:child`, agentId: "worker" },
				subagentContext: {
					parentSessionKey: `${active.identifiers.sessionKey}:subagent:child`,
					callerDepth: 1,
				},
			}).map((tool) => tool.name));
		assert.deepEqual(
			inheritedChild,
			["find"],
			"an inherited Team context is not authority for child/session/admin/delegation tools",
		);
		const primaryInside = runWithTeamExecutionContext(active, () =>
			createBrigadeTools({
				...workerOptions,
				agentId: "main",
				senderIsOwner: true,
				sessionContext: { key: active.identifiers.sessionKey, agentId: "main" },
			}).map((tool) => tool.name));
		assert.ok(!primaryInside.includes("team"), "even primary is fence-scoped while executing a Team attempt");
		assert.ok(!primaryInside.includes("team_task"), "the lease belongs only to the routed worker agent");
	});
});

describe("Wave P1 — cron-triggered runs can spawn sub-agents", () => {
	it("a cron-style turn (subagentContext + non-leaf depth) gets both spawn tools", () => {
		// Cron's isolated executor calls runSingleTurn which always threads
		// subagentContext through. As long as the depth is below the cap,
		// the model running inside the cron job has BOTH spawn tools.
		const tools = createBrigadeTools({
			workspaceDir: tmpWorkspace,
			agentId: "main",
			cwd: tmpWorkspace,
			subagentContext: {
				parentSessionKey: "cron:nightly-research:run:abc-123",
				callerDepth: 0,
			},
			// Default subagentMaxDepth (3) — cron at depth 0 is well below.
		});
		const names = tools.map((t) => t.name);
		assert.ok(names.includes("spawn_agent"), "cron run can call spawn_agent");
		assert.ok(names.includes("spawn_agents"), "cron run can call spawn_agents (parallel fan-out)");
	});

	it("a cron-style turn at the depth cap drops both spawn tools (no infinite delegation)", () => {
		const tools = createBrigadeTools({
			workspaceDir: tmpWorkspace,
			agentId: "main",
			cwd: tmpWorkspace,
			subagentContext: {
				parentSessionKey: "cron:nightly:run:abc:subagent:x:subagent:y:subagent:z",
				callerDepth: 3,
			},
			subagentMaxDepth: 3,
		});
		const names = tools.map((t) => t.name);
		assert.ok(!names.includes("spawn_agent"));
		assert.ok(!names.includes("spawn_agents"));
	});
});

describe("createBrigadeTools — consolidated `org` tool gating", () => {
	// Each test in this block scopes a fresh state dir so brigade.json
	// can be written + torn down without polluting the suite's primary
	// tmpWorkspace. We avoid `beforeEach`/`afterEach` here to keep the
	// existing top-level tests untouched (additive only).
	function withCfg<T>(cfg: unknown, fn: (workspaceDir: string) => T): T {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-registry-org-"));
		fs.mkdirSync(path.join(stateDir, "agents"), { recursive: true });
		fs.writeFileSync(path.join(stateDir, "brigade.json"), JSON.stringify(cfg, null, 2));
		const prev = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = stateDir;
		try {
			return fn(stateDir);
		} finally {
			if (prev === undefined) delete process.env.BRIGADE_STATE_DIR;
			else process.env.BRIGADE_STATE_DIR = prev;
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
	}

	it("ADDITIVE PROOF: when cfg.org is absent, the `org` tool is NOT registered (legacy install unchanged)", () => {
		// Isolate via BRIGADE_STATE_DIR so the test can't be poisoned by
		// a real ~/.brigade/brigade.json that happens to contain cfg.org
		// (which a dev may have bootstrapped for chart-rendering work).
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "brigade-registry-additive-"));
		const prev = process.env.BRIGADE_STATE_DIR;
		process.env.BRIGADE_STATE_DIR = stateDir;
		let tools;
		try {
			tools = createBrigadeTools({
				workspaceDir: tmpWorkspace,
				agentId: "main",
				cwd: tmpWorkspace,
			});
		} finally {
			if (prev === undefined) delete process.env.BRIGADE_STATE_DIR;
			else process.env.BRIGADE_STATE_DIR = prev;
			fs.rmSync(stateDir, { recursive: true, force: true });
		}
		const names = tools.map((t) => t.name);
		assert.ok(!names.includes("org"), "legacy install must not surface the org tool");
		// Defensive: the old two-tool surface MUST also be gone (no shim).
		assert.ok(!names.includes("org_describe"), "legacy org_describe must not surface");
		assert.ok(!names.includes("delegate_to_department"), "legacy delegate_to_department must not surface");
	});

	it("when cfg.org is set, the `org` tool IS registered (single consolidated surface)", () => {
		withCfg(
			{
				agents: {
					defaults: { provider: "openrouter" },
					main: { org: { department: "exec", reportsTo: null, role: "Chief of Staff" } },
					logistics: { org: { department: "logistics", reportsTo: "main", role: "Head of Logistics" } },
				},
				org: { topOrder: "main", a2a: { mode: "derived" } },
				// session.agentToAgent omitted entirely — the consolidated
				// gate no longer cares; A2A-required actions (delegate)
				// refuse closed inside the action body instead.
			},
			() => {
				const tools = createBrigadeTools({
					workspaceDir: tmpWorkspace,
					agentId: "main",
					cwd: tmpWorkspace,
				});
				const names = tools.map((t) => t.name);
				assert.ok(names.includes("org"), "consolidated org tool surfaced when cfg.org is present");
				assert.ok(!names.includes("org_describe"), "old org_describe no longer surfaced");
				assert.ok(!names.includes("delegate_to_department"), "old delegate_to_department no longer surfaced");
			},
		);
	});

	it("keeps org delegation out of a Team coordinator chat", () => {
		withCfg(
			{
				agents: {
					defaults: { provider: "openrouter" },
					main: { org: { department: "exec", reportsTo: null, role: "Chief of Staff" } },
				},
				org: { topOrder: "main", a2a: { mode: "derived" } },
			},
			() => {
				const sessionKey = buildTeamChatSessionKey("room", "main");
				const names = createBrigadeTools({
					workspaceDir: tmpWorkspace,
					agentId: "main",
					cwd: tmpWorkspace,
					senderIsOwner: true,
					sessionContext: { key: sessionKey, agentId: "main" },
				}).map((tool) => tool.name);
				assert.ok(names.includes("team"));
				assert.ok(!names.includes("org"), "Team rooms expose one agent-coordination surface");
			},
		);
	});

	it("when cfg.org AND cfg.session.agentToAgent.enabled are both set, the `org` tool is still the single surface", () => {
		withCfg(
			{
				agents: {
					defaults: { provider: "openrouter" },
					main: { org: { department: "exec", reportsTo: null, role: "Chief of Staff" } },
					logistics: { org: { department: "logistics", reportsTo: "main", role: "Head of Logistics" } },
				},
				org: { topOrder: "main", a2a: { mode: "derived" } },
				session: { agentToAgent: { enabled: true, allow: ["*"] } },
			},
			() => {
				const tools = createBrigadeTools({
					workspaceDir: tmpWorkspace,
					agentId: "main",
					cwd: tmpWorkspace,
				});
				const names = tools.map((t) => t.name);
				assert.ok(names.includes("org"), "consolidated org tool surfaced");
				assert.ok(!names.includes("org_describe"), "old org_describe no longer surfaced");
				assert.ok(!names.includes("delegate_to_department"), "old delegate_to_department no longer surfaced");
			},
		);
	});
});

describe("listBrigadeToolNames", () => {
	it("returns the memory tool names", () => {
		assert.deepEqual(listBrigadeToolNames().sort(), ["read_memory", "recall_memory", "write_memory"]);
	});

	it("returns a fresh array on each call (callers may mutate)", () => {
		const a = listBrigadeToolNames();
		const b = listBrigadeToolNames();
		assert.notEqual(a, b, "different array instances");
		a.push("test-pollution");
		assert.deepEqual(
			listBrigadeToolNames().sort(),
			["read_memory", "recall_memory", "write_memory"],
			"subsequent calls unaffected",
		);
	});
});
