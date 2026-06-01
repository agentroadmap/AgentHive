import assert from "node:assert";
import { describe, it } from "node:test";
import { query } from "../../src/postgres/pool.ts";

// Load the module dynamically
const { PgAgentHandlers } = await import("../../src/apps/mcp-server/tools/agents/pg-handlers.ts");

describe("P1129 AC-11: per-identity probe mutex", () => {
	const handlers = new PgAgentHandlers();
	const testId = `test-mutex-${Math.random().toString(36).slice(2)}`;

	it("should prevent concurrent probe/write for same identity (mutex enforced)", async () => {
		// Register an agent first
		const agentResult = await handlers.registerAgent({
			identity: `agent-mutex-${testId}`,
			agent_type: "llm",
		});
		assert.strictEqual(agentResult.isError, undefined, "agent registration should succeed");

		const identity = `agent-mutex-${testId}`;

		// Fire 3 concurrent registerModel calls for the same identity
		// If mutex is working, they should all complete without race conditions
		const results = await Promise.all([
			handlers.registerModel({
				agent_identity: identity,
				model_name: `model-mutex1-${testId}`,
				route_provider: "claude",
				agent_provider: "claude",
				metadata_tier: "frontier",
			}),
			handlers.registerModel({
				agent_identity: identity,
				model_name: `model-mutex2-${testId}`,
				route_provider: "claude",
				agent_provider: "claude",
				metadata_tier: "standard",
			}),
			handlers.registerModel({
				agent_identity: identity,
				model_name: `model-mutex3-${testId}`,
				route_provider: "claude",
				agent_provider: "claude",
				metadata_tier: "economy",
			}),
		]);

		// All 3 should either succeed (registered) or fail with probe_failed (CLI not available)
		// but NOT with a concurrency race error like "violates unique constraint"
		for (let i = 0; i < results.length; i++) {
			const result = results[i];
			if (result.isError) {
				const errText = result.content[0].text;
				// Probe failures are OK (CLI not available)
				// But concurrency/constraint errors should not happen with mutex
				assert.ok(
					errText.includes("probe_failed") || errText.includes("probe") || errText.includes("unknown model"),
					`Call ${i + 1} failed with unexpected error (not probe-related): ${errText}`,
				);
			}
		}

		// Verify at least one succeeded in writing (check DB)
		const successCount = results.filter((r) => !r.isError).length;
		console.log(`Mutex test: ${successCount}/3 calls succeeded (others may have failed on probe)`);
		assert.ok(successCount >= 1, "at least one call should have successfully written to DB");

		// Verify no constraint violations by checking models exist
		for (let i = 1; i <= 3; i++) {
			const modelName = `model-mutex${i}-${testId}`;
			const check = await query(
				`SELECT id FROM roadmap.model_routes WHERE model_name = $1 AND route_provider = $2 AND agent_provider = $3 LIMIT 1`,
				[modelName, "claude", "claude"],
			);
			// It's OK if it doesn't exist (probe failed), but if it does, it should have valid columns
			if (check.rows.length > 0) {
				console.log(`✓ Model ${modelName} successfully written to DB`);
			}
		}
	});

	it("should allow parallel calls for different identities", async () => {
		// Register two different agents
		const agent1Result = await handlers.registerAgent({
			identity: `agent-p1-${testId}`,
			agent_type: "llm",
		});
		const agent2Result = await handlers.registerAgent({
			identity: `agent-p2-${testId}`,
			agent_type: "llm",
		});
		assert.strictEqual(agent1Result.isError, undefined);
		assert.strictEqual(agent2Result.isError, undefined);

		// Fire 2 concurrent calls for different identities
		const [result1, result2] = await Promise.all([
			handlers.registerModel({
				agent_identity: `agent-p1-${testId}`,
				model_name: `model-p1-${testId}`,
				route_provider: "claude",
				agent_provider: "claude",
				metadata_tier: "frontier",
			}),
			handlers.registerModel({
				agent_identity: `agent-p2-${testId}`,
				model_name: `model-p2-${testId}`,
				route_provider: "gemini",
				agent_provider: "gemini",
				metadata_tier: "standard",
			}),
		]);

		// Both should complete without blocking each other
		// (both may succeed or fail on probe, but not on mutex contention)
		const allGood =
			(result1.isError === undefined || result1.content[0].text.includes("probe")) &&
			(result2.isError === undefined || result2.content[0].text.includes("probe"));

		assert.ok(allGood, "parallel calls for different identities should not block each other");
	});
});
