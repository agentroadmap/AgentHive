import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it, afterEach } from "node:test";
import type { ChildProcess } from "node:child_process";

import {
	assertResolvedRouteMetadata,
	buildSpawnProcessEnv,
	buildArgsBySpec,
	liveChildCount,
	renderClosingHint,
	terminateLiveChildren,
	trackLiveChild,
} from "../../src/core/orchestration/agent-spawner.ts";

// ─── Minimal ChildProcess mock ────────────────────────────────────────────────
// Uses EventEmitter so we can fire "close"/"error" programmatically without
// spawning real OS processes.

function makeMockChild(opts: { killed?: boolean; exitCode?: number | null } = {}): ChildProcess {
	const ee = new EventEmitter();
	const child = ee as unknown as ChildProcess;
	(child as any).pid = Math.floor(Math.random() * 90_000) + 10_000;
	(child as any).killed = opts.killed ?? false;
	(child as any).exitCode = opts.exitCode ?? null;
	(child as any).kill = (sig: NodeJS.Signals) => {
		(child as any).killed = true;
		(child as any).lastSignal = sig;
		return true;
	};
	return child;
}

// After each test, drain any leftover children so registry is clean
afterEach(async () => {
	if (liveChildCount() > 0) {
		await terminateLiveChildren({ graceMs: 0 });
	}
});

describe("live-child registry", () => {
	it("starts empty when no children have been spawned", () => {
		assert.equal(liveChildCount(), 0);
	});

	it("terminateLiveChildren is a no-op on empty registry", async () => {
		const result = await terminateLiveChildren({ graceMs: 0 });
		assert.deepEqual(result, { signalled: 0, killed: 0 });
	});

	it("trackLiveChild adds a child to the registry", () => {
		const child = makeMockChild();
		assert.equal(liveChildCount(), 0);
		trackLiveChild(child);
		assert.equal(liveChildCount(), 1);
		// Emit close so cleanup fires and registry shrinks back
		child.emit("close", 0);
		assert.equal(liveChildCount(), 0);
	});

	it("trackLiveChild auto-removes child on close event", () => {
		const child = makeMockChild();
		trackLiveChild(child);
		assert.equal(liveChildCount(), 1);
		child.emit("close", 0);
		assert.equal(liveChildCount(), 0);
	});

	it("trackLiveChild auto-removes child on error event", () => {
		const child = makeMockChild();
		trackLiveChild(child);
		assert.equal(liveChildCount(), 1);
		child.emit("error", new Error("spawn ENOENT"));
		assert.equal(liveChildCount(), 0);
	});

	it("registry handles multiple children independently", () => {
		const a = makeMockChild();
		const b = makeMockChild();
		const c = makeMockChild();
		trackLiveChild(a);
		trackLiveChild(b);
		trackLiveChild(c);
		assert.equal(liveChildCount(), 3);
		b.emit("close", 0);
		assert.equal(liveChildCount(), 2);
		a.emit("error", new Error("boom"));
		assert.equal(liveChildCount(), 1);
		c.emit("close", 0);
		assert.equal(liveChildCount(), 0);
	});

	it("terminateLiveChildren sends SIGTERM to all live children (graceMs=0)", async () => {
		const a = makeMockChild();
		const b = makeMockChild();
		trackLiveChild(a);
		trackLiveChild(b);
		// graceMs=0 skips the SIGKILL pass; children stay in registry
		// unless they emit close/error themselves
		const result = await terminateLiveChildren({ graceMs: 0 });
		assert.equal(result.signalled, 2, "both children should be SIGTERMed");
		assert.equal(result.killed, 0, "no SIGKILL with graceMs=0");
		// Manually emit close to restore registry for afterEach
		a.emit("close", 0);
		b.emit("close", 0);
	});

	it("terminateLiveChildren skips already-killed children", async () => {
		const alive = makeMockChild();
		const dead = makeMockChild({ killed: true });
		trackLiveChild(alive);
		trackLiveChild(dead);
		const result = await terminateLiveChildren({ graceMs: 0 });
		assert.equal(result.signalled, 1, "only the alive child is signalled");
		alive.emit("close", 0);
		dead.emit("close", 0);
	});

	it("terminateLiveChildren skips children with non-null exitCode", async () => {
		const alive = makeMockChild();
		const exited = makeMockChild({ exitCode: 1 });
		trackLiveChild(alive);
		trackLiveChild(exited);
		const result = await terminateLiveChildren({ graceMs: 0 });
		assert.equal(result.signalled, 1, "already-exited child is not re-signalled");
		alive.emit("close", 0);
		exited.emit("close", 0);
	});

	it("terminateLiveChildren returns {signalled:0,killed:0} when registry is empty", async () => {
		const result = await terminateLiveChildren({ graceMs: 0 });
		assert.deepEqual(result, { signalled: 0, killed: 0 });
	});
});

describe("Hermes route compatibility", () => {
	it("accepts DB-shaped Hermes route metadata", () => {
		assert.doesNotThrow(() =>
			assertResolvedRouteMetadata("openclaw", {
				modelName: "xiaomi/mimo-v2-pro",
				routeProvider: "nous",
				agentProvider: "openclaw",
				agentCli: "hermes",
				apiSpec: "openai",
				baseUrl: "https://inference-api.nousresearch.com/v1",
				planType: "token_plan",
				costPer1kInput: 0.0002,
				costPerMillionInput: 0,
				costPerMillionOutput: 0,
				apiKeyEnv: "NOUS_API_KEY",
				apiKeyFallbackEnv: "OPENAI_API_KEY",
				baseUrlEnv: "OPENAI_BASE_URL",
				spawnToolsets:
					"web,browser,terminal,file,code_execution,vision,image_gen,tts,skills,todo,memory,session_search,clarify,cronjob,messaging",
			} as any),
		);
	});

	it("rejects route metadata that does not match the worktree provider", () => {
		assert.throws(() =>
			assertResolvedRouteMetadata("openclaw", {
				modelName: "xiaomi/mimo-v2-pro",
				routeProvider: "nous",
				agentProvider: "claude",
				agentCli: "claude",
				apiSpec: "openai",
				baseUrl: "https://inference-api.nousresearch.com/v1",
				planType: "token_plan",
				costPer1kInput: 0.0002,
				costPerMillionInput: 0,
				costPerMillionOutput: 0,
				apiKeyEnv: "NOUS_API_KEY",
				apiKeyFallbackEnv: "OPENAI_API_KEY",
				baseUrlEnv: "OPENAI_BASE_URL",
				spawnToolsets:
					"web,browser,terminal,file,code_execution,vision,image_gen,tts,skills,todo,memory,session_search,clarify,cronjob,messaging",
			} as any),
		);
	});

	it("does not pass Anthropic credentials into Hermes workers", () => {
		const originalAnthropic = process.env.ANTHROPIC_API_KEY;
		const originalNous = process.env.NOUS_API_KEY;
		const originalOpenAI = process.env.OPENAI_API_KEY;
		process.env.ANTHROPIC_API_KEY = "anthropic-secret";
		process.env.NOUS_API_KEY = "nous-secret";
		process.env.OPENAI_API_KEY = "openai-secret";

		try {
			const env = buildSpawnProcessEnv({
				worktree: "openclaw-hermes",
				route: {
					modelName: "xiaomi/mimo-v2-pro",
					routeProvider: "nous",
					agentProvider: "openclaw",
					agentCli: "hermes",
					apiSpec: "openai",
					baseUrl: "https://inference-api.nousresearch.com/v1",
					planType: "token_plan",
					costPer1kInput: 0.0002,
					costPerMillionInput: 0,
					costPerMillionOutput: 0,
					apiKeyEnv: "NOUS_API_KEY",
					apiKeyFallbackEnv: "OPENAI_API_KEY",
					baseUrlEnv: "OPENAI_BASE_URL",
					spawnToolsets:
						"web,browser,terminal,file,code_execution,vision,image_gen,tts,skills,todo,memory,session_search,clarify,cronjob,messaging",
				} as any,
				agentEnv: {
					DATABASE_URL: "postgresql://example",
					NOUS_API_KEY: "nous-secret",
					OPENAI_API_KEY: "openai-secret",
					ANTHROPIC_API_KEY: "anthropic-secret",
				},
				extraEnv: {},
			});

			assert.equal(env.ANTHROPIC_API_KEY, undefined);
			assert.equal(env.OPENAI_API_KEY, "openai-secret");
			assert.equal(env.NOUS_API_KEY, "nous-secret");
			assert.equal(env.AGENT_PROVIDER, "openclaw");
		} finally {
			if (originalAnthropic === undefined) {
				delete process.env.ANTHROPIC_API_KEY;
			} else {
				process.env.ANTHROPIC_API_KEY = originalAnthropic;
			}
			if (originalNous === undefined) {
				delete process.env.NOUS_API_KEY;
			} else {
				process.env.NOUS_API_KEY = originalNous;
			}
			if (originalOpenAI === undefined) {
				delete process.env.OPENAI_API_KEY;
			} else {
				process.env.OPENAI_API_KEY = originalOpenAI;
			}
		}
	});

	it("P1967 AC-5: injects CLAUDE_CODE_OAUTH_TOKEN when route configured with api_key_env", () => {
		const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
		process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-fake-test-token-abc123xyz";

		try {
			const env = buildSpawnProcessEnv({
				worktree: "claude-worker",
				route: {
					modelName: "claude-sonnet-4-6",
					routeProvider: "anthropic",
					agentProvider: "claude",
					agentCli: "claude",
					apiSpec: "anthropic",
					baseUrl: "https://api.anthropic.com",
					planType: "token_plan",
					costPer1kInput: 0.00003,
					costPerMillionInput: 30,
					costPerMillionOutput: 120,
					apiKeyEnv: "CLAUDE_CODE_OAUTH_TOKEN", // P1967: Real injection path via route config
					cliApiKeyEnv: "CLAUDE_CODE_OAUTH_TOKEN",
					baseUrlEnv: "ANTHROPIC_BASE_URL",
				} as any,
				agentEnv: {
					DATABASE_URL: "postgresql://example",
				},
				extraEnv: {},
			});

			assert.equal(
				env.CLAUDE_CODE_OAUTH_TOKEN,
				"sk-fake-test-token-abc123xyz",
				"token must be injected from process.env via route config",
			);
			assert.equal(env.AGENT_PROVIDER, "claude");
		} finally {
			if (originalToken === undefined) {
				delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
			} else {
				process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
			}
		}
	});

	it("P1967 AC-1: absent CLAUDE_CODE_OAUTH_TOKEN keeps env identical to today (no regression)", () => {
		const originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
		delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

		try {
			const env = buildSpawnProcessEnv({
				worktree: "claude-worker",
				route: {
					modelName: "claude-sonnet-4-6",
					routeProvider: "anthropic",
					agentProvider: "claude",
					agentCli: "claude",
					apiSpec: "anthropic",
					baseUrl: "https://api.anthropic.com",
					planType: "token_plan",
					costPer1kInput: 0.00003,
					costPerMillionInput: 30,
					costPerMillionOutput: 120,
					apiKeyEnv: "CLAUDE_CODE_OAUTH_TOKEN",
					cliApiKeyEnv: "CLAUDE_CODE_OAUTH_TOKEN",
					baseUrlEnv: "ANTHROPIC_BASE_URL",
				} as any,
				agentEnv: {
					DATABASE_URL: "postgresql://example",
				},
				extraEnv: {},
			});

			// Token not in process.env, so it should NOT be in env
			assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined, "no-regression fallback: env must not contain absent token");
			assert.equal(env.AGENT_PROVIDER, "claude");
		} finally {
			if (originalToken !== undefined) {
				process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
			}
		}
	});
});

describe("P738 HF-B: closing hint forbids worker-side set_maturity", () => {
	const baseInput = {
		contextPackage: "## Proposal Context\n- Proposal: P999",
		task: "Implement AC-1 through AC-3.",
		proposalId: 999,
	};

	for (const stage of [
		"DRAFT",
		"REVIEW",
		"DEVELOP",
		"MERGE",
		"TRIAGE",
		"FIX",
	]) {
		it(`emits no 'set_maturity' instruction for stage=${stage}`, () => {
			const out = renderClosingHint({ ...baseInput, stage });
			assert.ok(
				!/\bset_maturity\b\s*\(?(action)?[^)]*?\)?\s*to\s+advance/i.test(out),
				`stage=${stage} briefing must not instruct worker to call set_maturity → mature`,
			);
			assert.ok(
				!out.includes(`maturity "mature"`),
				`stage=${stage} briefing must not contain literal 'maturity "mature"' instruction`,
			);
			assert.ok(
				out.includes("spawn_summary_emit"),
				`stage=${stage} briefing must point worker at spawn_summary_emit`,
			);
			assert.ok(
				/DO NOT call .?set_maturity.?/i.test(out),
				`stage=${stage} briefing must explicitly forbid set_maturity`,
			);
		});
	}

	it("emits no closing hint at all for terminal COMPLETE stage", () => {
		const out = renderClosingHint({ ...baseInput, stage: "COMPLETE" });
		assert.ok(!out.includes("## Completion"));
		assert.ok(!out.includes("set_maturity"));
		assert.ok(!out.includes("spawn_summary_emit"));
	});

	it("emits no closing hint at all for terminal DEPLOYED stage", () => {
		const out = renderClosingHint({ ...baseInput, stage: "DEPLOYED" });
		assert.ok(!out.includes("## Completion"));
		assert.ok(!out.includes("set_maturity"));
	});

	it("preserves contextPackage and task content verbatim", () => {
		const out = renderClosingHint({ ...baseInput, stage: "DEVELOP" });
		assert.ok(out.startsWith("## Proposal Context\n- Proposal: P999"));
		assert.ok(out.includes("## Task\nImplement AC-1 through AC-3."));
	});
});

describe("buildArgsBySpec for agy", () => {
	it("routes agy route spec to buildAntigravityArgs with correct parameters", () => {
		const req = {
			task: "run lint check",
			worktree: "/data/code/worktree/antigravity",
		} as any;

		const route = {
			agentCli: "agy",
			cliPath: "/home/gary/.local/bin/agy",
			modelName: "Gemini 3.5 Flash (Medium)",
			routeProvider: "google",
		} as any;

		const spec = buildArgsBySpec(req, route);

		assert.ok(spec.argv[0].endsWith("/agy"), `bin path must end in /agy, got: ${spec.argv[0]}`);
		assert.ok(spec.argv.includes("--model"), "argv must include --model");
		assert.ok(spec.argv.includes("Gemini 3.5 Flash (Medium)"), "argv must include the exact model name");
		assert.ok(spec.argv.includes("run lint check"), "argv must include task");
		assert.ok(spec.argv.includes("/data/code/worktree/antigravity"), "argv must include worktree path");
	});
});

describe("assertResolvedRouteMetadata unknown-cli guard", () => {
	it("rejects unknown agent_cli values", () => {
		const route = {
			modelName: "custom-model",
			routeProvider: "google",
			agentProvider: "google",
			agentCli: "unknown-cli-name",
			cliPath: "/bin/custom",
			apiSpec: "google",
			baseUrl: "https://generativelanguage.googleapis.com",
		} as any;

		assert.throws(() => {
			assertResolvedRouteMetadata("google", route);
		}, /unknown agent_cli/);
	});

	it("rejects missing agent_cli values", () => {
		const route = {
			modelName: "custom-model",
			routeProvider: "google",
			agentProvider: "google",
			agentCli: "",
			cliPath: "/bin/custom",
			apiSpec: "google",
			baseUrl: "https://generativelanguage.googleapis.com",
		} as any;

		assert.throws(() => {
			assertResolvedRouteMetadata("google", route);
		}, /missing agent_cli/);
	});
});

