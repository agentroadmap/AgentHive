import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";

import {
	buildSpawnProcessEnv,
} from "../../src/core/orchestration/agent-spawner.ts";

// Minimal ModelRoute stub — only the fields required by buildSpawnProcessEnv.
const stubRoute = {
	modelName: "xiaomi/mimo-v2-pro",
	routeProvider: "nous",
	agentProvider: "openclaw",
	agentCli: "hermes",
	apiSpec: "openai" as const,
	baseUrl: "https://inference-api.nousresearch.com/v1",
	planType: "token_plan",
	costPer1kInput: 0.0002,
	costPerMillionInput: 0.2,
	costPerMillionOutput: 0.6,
	apiKeyEnv: "NOUS_API_KEY",
	apiKeyFallbackEnv: "OPENAI_API_KEY",
	baseUrlEnv: "OPENAI_BASE_URL",
	cliApiKeyEnv: null,
	apiKeyPrimary: null,
	apiKeySecondary: null,
	spawnToolsets: null,
	spawnDelegate: false,
	routeId: null,
};

describe("AGENTHIVE_TRACE_ID propagation", () => {
	const savedEnv: Record<string, string | undefined> = {};

	before(() => {
		savedEnv.NOUS_API_KEY = process.env.NOUS_API_KEY;
		savedEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
		process.env.NOUS_API_KEY = "nous-test-key";
		process.env.OPENAI_API_KEY = "openai-test-key";
	});

	after(() => {
		for (const [k, v] of Object.entries(savedEnv)) {
			if (v === undefined) {
				delete process.env[k];
			} else {
				process.env[k] = v;
			}
		}
	});

	it("includes AGENTHIVE_TRACE_ID when traceId is provided", () => {
		const traceId = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
		const env = buildSpawnProcessEnv({
			worktree: "openclaw-hermes",
			route: stubRoute,
			agentEnv: { DATABASE_URL: "postgresql://test" },
			extraEnv: {},
			traceId,
		});

		assert.equal(env.AGENTHIVE_TRACE_ID, traceId);
	});

	it("omits AGENTHIVE_TRACE_ID when no traceId is given", () => {
		const env = buildSpawnProcessEnv({
			worktree: "openclaw-hermes",
			route: stubRoute,
			agentEnv: { DATABASE_URL: "postgresql://test" },
			extraEnv: {},
		});

		assert.equal(env.AGENTHIVE_TRACE_ID, undefined);
	});

	it("passes traceId through to child process env alongside AGENT_PROVIDER", () => {
		const traceId = "deadbeef-0000-0000-0000-000000000001";
		const env = buildSpawnProcessEnv({
			worktree: "openclaw-hermes",
			route: stubRoute,
			agentEnv: { DATABASE_URL: "postgresql://test" },
			extraEnv: {},
			traceId,
		});

		assert.equal(env.AGENT_PROVIDER, "openclaw");
		assert.equal(env.AGENTHIVE_TRACE_ID, traceId);
	});

	it("extraEnv traceId override takes precedence over param", () => {
		// extraEnv is merged last, so if caller explicitly sets AGENTHIVE_TRACE_ID
		// in extraEnv it wins — this is intentional escape-hatch behaviour.
		const env = buildSpawnProcessEnv({
			worktree: "openclaw-hermes",
			route: stubRoute,
			agentEnv: { DATABASE_URL: "postgresql://test" },
			extraEnv: { AGENTHIVE_TRACE_ID: "override-id" },
			traceId: "original-id",
		});

		assert.equal(env.AGENTHIVE_TRACE_ID, "override-id");
	});
});
