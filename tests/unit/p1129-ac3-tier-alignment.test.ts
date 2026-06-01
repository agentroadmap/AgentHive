import assert from "node:assert";
import { describe, it } from "node:test";
import { query } from "../../src/postgres/pool.ts";

// Load the module dynamically to ensure we get the source version
const { PgAgentHandlers } = await import("../../src/apps/mcp-server/tools/agents/pg-handlers.ts");

describe("P1129 AC-3: tier enum alignment between tables", () => {
	const handlers = new PgAgentHandlers();
	const testId = `test-ac3-${Math.random().toString(36).slice(2)}`;

	it("should map metadata_tier frontier→frontier for model_routes", async () => {
		// First register an agent to use as identity
		const agentResult = await handlers.registerAgent({
			identity: `agent-${testId}`,
			agent_type: "llm",
		});
		assert.strictEqual(agentResult.isError, undefined, "agent registration should succeed");

		// Register model with metadata_tier=frontier
		const result = await handlers.registerModel({
			agent_identity: `agent-${testId}`,
			model_name: `model-frontier-${testId}`,
			route_provider: "claude",
			agent_provider: "claude",
			metadata_tier: "frontier",
		});
		assert.strictEqual(result.isError, undefined, `registerModel should succeed. Got: ${result.content[0]?.text}`);

		// Verify both tables have correct tiers
		const metadata = await query(
			`SELECT tier FROM roadmap.model_metadata WHERE model_name = $1 AND provider = $2`,
			[`model-frontier-${testId}`, "claude"],
		);
		assert.strictEqual(metadata.rows[0]?.tier, "frontier", "model_metadata should have tier=frontier");

		const routes = await query(
			`SELECT tier FROM roadmap.model_routes WHERE model_name = $1 AND route_provider = $2 AND agent_provider = $3`,
			[`model-frontier-${testId}`, "claude", "claude"],
		);
		assert.strictEqual(routes.rows[0]?.tier, "frontier", "model_routes should have tier=frontier");
	});

	it("should map metadata_tier standard→mid for model_routes", async () => {
		const agentResult = await handlers.registerAgent({
			identity: `agent-std-${testId}`,
			agent_type: "llm",
		});
		assert.strictEqual(agentResult.isError, undefined, "agent registration should succeed");

		const result = await handlers.registerModel({
			agent_identity: `agent-std-${testId}`,
			model_name: `model-standard-${testId}`,
			route_provider: "google",
			agent_provider: "google",
			metadata_tier: "standard",
		});
		assert.strictEqual(result.isError, undefined, `registerModel should succeed. Got: ${result.content[0]?.text}`);

		const metadata = await query(
			`SELECT tier FROM roadmap.model_metadata WHERE model_name = $1 AND provider = $2`,
			[`model-standard-${testId}`, "google"],
		);
		assert.strictEqual(metadata.rows[0]?.tier, "standard", "model_metadata should have tier=standard");

		const routes = await query(
			`SELECT tier FROM roadmap.model_routes WHERE model_name = $1 AND route_provider = $2 AND agent_provider = $3`,
			[`model-standard-${testId}`, "google", "google"],
		);
		assert.strictEqual(routes.rows[0]?.tier, "mid", "model_routes should have tier=mid (mapped from standard)");
	});

	it("should map metadata_tier economy→lower for model_routes", async () => {
		const agentResult = await handlers.registerAgent({
			identity: `agent-econ-${testId}`,
			agent_type: "llm",
		});
		assert.strictEqual(agentResult.isError, undefined, "agent registration should succeed");

		const result = await handlers.registerModel({
			agent_identity: `agent-econ-${testId}`,
			model_name: `model-economy-${testId}`,
			route_provider: "gemini",
			agent_provider: "gemini",
			metadata_tier: "economy",
		});
		assert.strictEqual(result.isError, undefined, `registerModel should succeed. Got: ${result.content[0]?.text}`);

		const metadata = await query(
			`SELECT tier FROM roadmap.model_metadata WHERE model_name = $1 AND provider = $2`,
			[`model-economy-${testId}`, "gemini"],
		);
		assert.strictEqual(metadata.rows[0]?.tier, "economy", "model_metadata should have tier=economy");

		const routes = await query(
			`SELECT tier FROM roadmap.model_routes WHERE model_name = $1 AND route_provider = $2 AND agent_provider = $3`,
			[`model-economy-${testId}`, "gemini", "gemini"],
		);
		assert.strictEqual(routes.rows[0]?.tier, "lower", "model_routes should have tier=lower (mapped from economy)");
	});

	it("should allow explicit route_tier override when provided", async () => {
		const agentResult = await handlers.registerAgent({
			identity: `agent-override-${testId}`,
			agent_type: "llm",
		});
		assert.strictEqual(agentResult.isError, undefined, "agent registration should succeed");

		// Register with metadata_tier=standard but route_tier=tool (override)
		const result = await handlers.registerModel({
			agent_identity: `agent-override-${testId}`,
			model_name: `model-override-${testId}`,
			route_provider: "openai",
			agent_provider: "openai",
			metadata_tier: "standard",
			route_tier: "tool",
		});
		assert.strictEqual(result.isError, undefined, `registerModel should succeed. Got: ${result.content[0]?.text}`);

		const routes = await query(
			`SELECT tier FROM roadmap.model_routes WHERE model_name = $1 AND route_provider = $2 AND agent_provider = $3`,
			[`model-override-${testId}`, "openai", "openai"],
		);
		assert.strictEqual(routes.rows[0]?.tier, "tool", "model_routes should use explicit route_tier=tool (not mid from mapping)");
	});

	it("should reject invalid metadata_tier values", async () => {
		const agentResult = await handlers.registerAgent({
			identity: `agent-invalid-${testId}`,
			agent_type: "llm",
		});
		assert.strictEqual(agentResult.isError, undefined, "agent registration should succeed");

		const result = await handlers.registerModel({
			agent_identity: `agent-invalid-${testId}`,
			model_name: `model-invalid-${testId}`,
			route_provider: "claude",
			agent_provider: "claude",
			metadata_tier: "garbage" as string,
		});
		assert.strictEqual(result.isError, true, "should reject invalid metadata_tier");
		assert.ok(result.content[0]?.text.includes("Invalid metadata_tier"), "error should mention invalid tier");
	});
});
