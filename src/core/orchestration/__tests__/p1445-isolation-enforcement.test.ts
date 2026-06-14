/**
 * P1445 enforcement tests (headless, no live DB required).
 *
 * Covers:
 *   AC-1 — assertNotRepoRoot refuses spawn in the shared repo root
 *   AC-3 — env worktree fallback is gated off by default
 *   AC-6 — worker/spawn source contains zero `systemctl restart`
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
	assertNotRepoRoot,
	isWorktreeCwd,
	RepoRootSpawnRefused,
} from "../worktree-guard.ts";
import {
	isEnvWorktreeFallbackEnabled,
	resolveExecutorWorktreeFallback,
} from "../executor-worktree-fallback.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
// __tests__ → orchestration → core → src → repo root
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");

// ───────────────────────── AC-1: repo-root spawn guard ─────────────────────────

test("AC-1: assertNotRepoRoot throws when cwd IS the repo root", () => {
	assert.throws(
		() => assertNotRepoRoot("/data/code/AgentHive", "/data/code/AgentHive"),
		RepoRootSpawnRefused,
	);
});

test("AC-1: trailing slash / unnormalised paths still match the repo root", () => {
	assert.throws(
		() => assertNotRepoRoot("/data/code/AgentHive/", "/data/code/AgentHive"),
		RepoRootSpawnRefused,
	);
	assert.throws(
		() =>
			assertNotRepoRoot(
				"/data/code/worktree/../AgentHive",
				"/data/code/AgentHive",
			),
		RepoRootSpawnRefused,
	);
});

test("AC-1: a real worktree cwd is allowed (no throw)", () => {
	assert.doesNotThrow(() =>
		assertNotRepoRoot("/data/code/worktree/codex-one", "/data/code/AgentHive"),
	);
	// A nested worktree under the repo root (e.g. .claude/worktrees/<id>) is fine —
	// only the root ITSELF is forbidden.
	assert.doesNotThrow(() =>
		assertNotRepoRoot(
			"/data/code/AgentHive/.claude/worktrees/abc",
			"/data/code/AgentHive",
		),
	);
});

test("AC-1: error message names the offending root and points to CONVENTIONS §7a", () => {
	try {
		assertNotRepoRoot("/data/code/AgentHive", "/data/code/AgentHive");
		assert.fail("expected throw");
	} catch (err) {
		assert.ok(err instanceof RepoRootSpawnRefused);
		assert.match(err.message, /P1445/);
		assert.match(err.message, /repo root/i);
		assert.match(err.message, /worktree/i);
	}
});

test("AC-1: isWorktreeCwd is the boolean inverse of the guard", () => {
	assert.equal(isWorktreeCwd("/data/code/AgentHive", "/data/code/AgentHive"), false);
	assert.equal(
		isWorktreeCwd("/data/code/worktree/codex-one", "/data/code/AgentHive"),
		true,
	);
});

// ───────────────────────── AC-3: gated env fallback ─────────────────────────

test("AC-3: env worktree fallback is OFF by default (gate closed)", () => {
	const env = { AGENTHIVE_DEFAULT_EXECUTOR_WORKTREE: "codex-one" };
	assert.equal(resolveExecutorWorktreeFallback(env), undefined);
	assert.equal(isEnvWorktreeFallbackEnabled(env), false);
});

test("AC-3: env fallback honoured only with explicit opt-in flag", () => {
	const env = {
		AGENTHIVE_DEFAULT_EXECUTOR_WORKTREE: "codex-one",
		AGENTHIVE_ALLOW_ENV_WORKTREE_FALLBACK: "1",
	};
	assert.equal(resolveExecutorWorktreeFallback(env), "codex-one");
	assert.equal(isEnvWorktreeFallbackEnabled(env), true);
});

test("AC-3: opt-in flag with empty env var yields undefined (no shared default)", () => {
	assert.equal(
		resolveExecutorWorktreeFallback({
			AGENTHIVE_ALLOW_ENV_WORKTREE_FALLBACK: "1",
			AGENTHIVE_DEFAULT_EXECUTOR_WORKTREE: "   ",
		}),
		undefined,
	);
});

// ───────────────────────── AC-6: no restart authority in worker code ─────────────────────────

const WORKER_SOURCES = [
	"src/core/orchestration/agent-spawner.ts",
	"src/infra/agency/offer-dispatch-handler.ts",
	"src/infra/agency/liaison-agent.ts",
	"src/core/orchestration/orchestrator.ts",
	"src/core/orchestration/legacy-dispatch.ts",
];

test("AC-6: worker/spawn source initiates zero service restarts", () => {
	const offenders = [];
	for (const rel of WORKER_SOURCES) {
		const body = readFileSync(resolve(REPO_ROOT, rel), "utf8");
		// Match an actual restart invocation, not the substring in a comment about
		// NOT restarting. We look for `systemctl ... restart` or `restart <unit>`.
		if (/systemctl\s+(?:[\w@.\-]+\s+)*restart/i.test(body)) {
			offenders.push(rel);
		}
	}
	assert.deepEqual(
		offenders,
		[],
		`worker code must never restart live services (P1445 AC-6); offenders: ${offenders.join(", ")}`,
	);
});
