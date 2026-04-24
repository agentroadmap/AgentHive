import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	assertResolvedRouteMetadata,
	buildSpawnProcessEnv,
} from "../../src/core/orchestration/agent-spawner.ts";

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
			}),
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
				},
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
});
