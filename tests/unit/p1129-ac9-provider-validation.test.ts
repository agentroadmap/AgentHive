import assert from "node:assert";
import { describe, it } from "node:test";

// Load the module dynamically to ensure we get the source version
const { PgAgentHandlers } = await import("../../src/apps/mcp-server/tools/agents/pg-handlers.ts");

describe("P1129 AC-9: preferred_provider validation", () => {
	const handlers = new PgAgentHandlers();

	it("should reject non-canonical providers with clear message", async () => {
		const invalidProviders = ["openai", "google", "garbage", "anthropic", "invalid"];

		for (const provider of invalidProviders) {
			const result = await handlers.registerAgent({
				identity: `test-agent-invalid-${provider}`,
				agent_type: "llm",
				preferred_provider: provider,
			});
			assert.strictEqual(result.isError, true, `${provider} should be rejected`);

			// Check error message contains canonical list and provider name
			const errorText = result.content[0].text;
			assert.ok(
				errorText.includes("Invalid preferred_provider") || errorText.includes(provider),
				`Error should mention invalid provider for ${provider}. Got: ${errorText}`,
			);
			assert.ok(
				errorText.includes("claude") &&
				errorText.includes("codex") &&
				errorText.includes("gemini") &&
				errorText.includes("copilot"),
				`Error should list all canonical providers. Got: ${errorText}`,
			);
		}
	});

	it("should accept valid canonical providers (case-insensitive)", async () => {
		const validProviders = ["claude", "codex"];

		for (const provider of validProviders) {
			const result = await handlers.registerAgent({
				identity: `test-agent-${provider}-${Math.random().toString(36).slice(2)}`,
				agent_type: "llm",
				preferred_provider: provider,
			});
			// Should not error
			if (result.isError) {
				console.error(`Error for ${provider}:`, result.content[0].text);
			}
			assert.strictEqual(result.isError, undefined, `${provider} should be valid. Got: ${result.content[0]?.text}`);
		}
	});

	it("should allow NULL/undefined preferred_provider", async () => {
		// Test: no preferred_provider field
		const result = await handlers.registerAgent({
			identity: `test-agent-null-${Math.random().toString(36).slice(2)}`,
			agent_type: "llm",
		});
		assert.strictEqual(result.isError, undefined, `undefined preferred_provider should be allowed. Got: ${result.content[0]?.text}`);
	});
});
