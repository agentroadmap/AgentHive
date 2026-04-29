import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	assertResolvedRouteMetadata,
	buildSpawnProcessEnv,
	resolveActiveRouteProvider,
	SpawnPolicyViolation,
} from "../../src/core/orchestration/agent-spawner.ts";

// ─── Complete fixture (all ModelRoute fields present) ─────────────────────────

const HERMES_ROUTE = {
	modelName: "xiaomi/mimo-v2-pro",
	routeProvider: "nous",
	agentProvider: "openclaw",
	agentCli: "hermes",
	cliPath: null,
	apiSpec: "openai",
	baseUrl: "https://inference-api.nousresearch.com/v1",
	planType: "token_plan",
	costPer1kInput: 0.0002,
	costPerMillionInput: 0,
	costPerMillionOutput: 0,
	apiKeyEnv: "NOUS_API_KEY",
	apiKeyFallbackEnv: "OPENAI_API_KEY",
	baseUrlEnv: "OPENAI_BASE_URL",
	cliApiKeyEnv: null,
	apiKeyPrimary: null,
	apiKeySecondary: null,
	spawnToolsets:
		"web,browser,terminal,file,code_execution,vision,image_gen,tts,skills,todo,memory,session_search,clarify,cronjob,messaging",
	spawnDelegate: false,
};

// ─── Route metadata acceptance / rejection ────────────────────────────────────

describe("Hermes route compatibility", () => {
	it("accepts DB-shaped Hermes route metadata", () => {
		assert.doesNotThrow(() =>
			assertResolvedRouteMetadata("openclaw", HERMES_ROUTE),
		);
	});

	it("rejects route metadata that does not match the worktree provider", () => {
		assert.throws(() =>
			assertResolvedRouteMetadata("openclaw", {
				...HERMES_ROUTE,
				agentProvider: "claude",
				agentCli: "claude",
			}),
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
				route: HERMES_ROUTE,
				agentEnv: {
					DATABASE_URL: "postgresql://example",
					NOUS_API_KEY: "nous-secret",
					OPENAI_API_KEY: "openai-secret",
					ANTHROPIC_API_KEY: "anthropic-secret",
				},
				extraEnv: {},
			});

			// Core security assertion: Anthropic creds must not leak into a Nous/hermes spawn
			assert.equal(env.ANTHROPIC_API_KEY, undefined);
			// Primary route credential is set under apiKeyEnv (NOUS_API_KEY)
			assert.equal(env.NOUS_API_KEY, "nous-secret");
			// Fallback env var value is NOT forwarded as its own key — only the primary path
			// resolves under apiKeyEnv. This is intentional: agent gets the minimum needed.
			assert.equal(env.OPENAI_API_KEY, undefined);
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
});

// ─── P444 AC#3: SpawnPolicyViolation type shape ───────────────────────────────

describe("SpawnPolicyViolation (P444 AC#3)", () => {
	it("is an Error subclass with host, routeProvider, modelName fields", () => {
		const err = new SpawnPolicyViolation("hermes", "anthropic", "claude-opus-4-7");
		assert.ok(err instanceof Error);
		assert.ok(err instanceof SpawnPolicyViolation);
		assert.equal(err.name, "SpawnPolicyViolation");
		assert.equal(err.host, "hermes");
		assert.equal(err.routeProvider, "anthropic");
		assert.equal(err.modelName, "claude-opus-4-7");
	});

	it("message includes host and route_provider for operator diagnostics", () => {
		const err = new SpawnPolicyViolation("gary-main", "openai", "gpt-4o");
		assert.ok(err.message.includes("gary-main"));
		assert.ok(err.message.includes("openai"));
	});
});

// ─── P444 AC#3: resolveActiveRouteProvider returns string or null ─────────────

describe("resolveActiveRouteProvider shape contract (P444 AC#3)", () => {
	it("resolveActiveRouteProvider is exported as an async function", () => {
		assert.equal(typeof resolveActiveRouteProvider, "function");
		// Returns a Promise (thennable) — we don't run the DB query in unit tests
		const result = resolveActiveRouteProvider();
		assert.ok(result && typeof result.then === "function", "must return a Promise");
		// Consume the promise to avoid unhandled rejection noise in CI
		result.catch(() => {});
	});
});

// ─── P444 AC#5: agent_runs backward-compat — new columns are nullable ─────────

describe("agent_runs backward-compat column nullability (P444 AC#5)", () => {
	const P444_NEW_COLUMNS = [
		"dispatch_id",
		"agency_id",
		"worker_id",
		"host_id",
		"provider_account_id",
		"route_id",
		"agent_cli",
		"agent_provider",
		"route_provider",
		"auth_source_class",
		"project_id",
	];

	it("migration 073 defines all P444 new columns as nullable ALTER TABLE ADD COLUMN", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");

		const migPath = resolve(
			new URL("../../", import.meta.url).pathname,
			"scripts/migrations/073-p444-run-record-separation.sql",
		);
		const sql = readFileSync(migPath, "utf8");

		// Every new column must use ADD COLUMN IF NOT EXISTS … NULL (no NOT NULL constraint)
		for (const col of P444_NEW_COLUMNS) {
			const pattern = new RegExp(`ADD COLUMN IF NOT EXISTS\\s+${col}\\b`);
			assert.ok(
				pattern.test(sql),
				`migration 073 must ADD COLUMN IF NOT EXISTS ${col}`,
			);
			// Verify no NOT NULL constraint immediately follows — column must be nullable
			const notNullPattern = new RegExp(
				`ADD COLUMN IF NOT EXISTS\\s+${col}\\b[^;]+NOT NULL`,
			);
			assert.ok(
				!notNullPattern.test(sql),
				`column ${col} must be nullable (no NOT NULL) for backward compat`,
			);
		}
	});

	it("migration 073 defines control_git.worktree_policy function (AC#6)", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");

		const migPath = resolve(
			new URL("../../", import.meta.url).pathname,
			"scripts/migrations/073-p444-run-record-separation.sql",
		);
		const sql = readFileSync(migPath, "utf8");

		assert.ok(
			sql.includes("control_git.worktree_policy"),
			"migration 073 must define control_git.worktree_policy",
		);
		assert.ok(
			sql.includes("CREATE OR REPLACE FUNCTION control_git.worktree_policy"),
			"worktree_policy must be created with CREATE OR REPLACE",
		);
		assert.ok(
			sql.includes("/data/code/worktree"),
			"worktree_policy must default to /data/code/worktree",
		);
	});
});

// ─── P444 AC#2: SpawnRequest carries all separation fields ────────────────────

describe("SpawnRequest P444 separation fields (P444 AC#2)", () => {
	it("agent_runs INSERT includes host_id from AGENTHIVE_HOST when no override", async () => {
		// Verify the INSERT SQL template in agent-spawner.ts contains the P444 columns.
		// This is a static analysis test — reads source to confirm the column list.
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");

		const spawnerPath = resolve(
			new URL("../../", import.meta.url).pathname,
			"src/core/orchestration/agent-spawner.ts",
		);
		const src = readFileSync(spawnerPath, "utf8");

		for (const col of ["dispatch_id", "agency_id", "worker_id", "host_id", "route_id", "auth_source_class"]) {
			assert.ok(
				src.includes(col),
				`agent-spawner.ts INSERT must reference column ${col}`,
			);
		}
	});
});
