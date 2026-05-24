/**
 * P1372: registerAgency MCP handler test suite.
 *
 * Validates that the new register_agency action correctly:
 * - Validates identity input and format
 * - Checks agent_registry prerequisites (existence, active status, agency type)
 * - Performs idempotent insertion into roadmap.agency
 * - Handles provider/host defaults and overrides
 * - Validates metadata object type
 * - Returns structured responses for created/noop/error cases
 * - Does NOT modify status/presence_state/last_heartbeat_at after insertion
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { query } from "../../../../../postgres/pool.ts";
import { PgAgentHandlers } from "../pg-handlers.ts";

const TEST_AGENCY_ID = "test-agency-p1372";
const TEST_AGENCY_ID_2 = "test-agency-p1372-2";
const ALT_AGENCY_ID = "alt-agency-p1372";

const handlers = new PgAgentHandlers();

/**
 * Helper: Clean up test data from agent_registry and roadmap.agency
 */
async function cleanupTest(agencyId?: string): Promise<void> {
	const ids = agencyId ? [agencyId] : [TEST_AGENCY_ID, TEST_AGENCY_ID_2, ALT_AGENCY_ID];
	for (const id of ids) {
		await query(
			`DELETE FROM roadmap.agency WHERE agency_id = $1`,
			[id],
		);
		await query(
			`DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
			[id],
		);
	}
}

/**
 * Helper: Seed an agent_registry row for testing
 */
async function seedAgencyRegistry(
	agencyId: string,
	status = "active",
	agentType = "agency",
	preferredProvider = "claude",
	hostAffinity = "bot",
): Promise<void> {
	await query(
		`INSERT INTO roadmap_workforce.agent_registry
		 (agent_identity, agent_type, status, preferred_provider, host_affinity)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT DO NOTHING`,
		[agencyId, agentType, status, preferredProvider, hostAffinity],
	);
}

/**
 * Helper: Fetch agency row from roadmap.agency
 */
async function getAgencyRow(agencyId: string): Promise<any> {
	const { rows } = await query<any>(
		`SELECT agency_id, provider, host_id, status, presence_state, metadata
		 FROM roadmap.agency WHERE agency_id = $1`,
		[agencyId],
	);
	return rows[0] || null;
}

describe("P1372: registerAgency handler", () => {
	beforeEach(async () => {
		await cleanupTest();
	});

	afterEach(async () => {
		await cleanupTest();
	});

	describe("AC-1: Input validation - identity resolution", () => {
		it("should reject missing identity", async () => {
			const result = await handlers.registerAgency({});
			expect(result.isError).toBe(true);
			const text =
				result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("agent_identity");
			expect(text).toContain("identity");
			expect(text).toContain("agency_id");
		});

		it("should reject blank identity", async () => {
			const result = await handlers.registerAgency({
				agent_identity: "   ",
			});
			expect(result.isError).toBe(true);
		});

		it("should accept canonical agent_identity", async () => {
			await seedAgencyRegistry(TEST_AGENCY_ID);
			const result = await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
			});
			expect(result.isError).not.toBe(true);
		});

		it("should accept alias 'identity'", async () => {
			await seedAgencyRegistry(TEST_AGENCY_ID);
			const result = await handlers.registerAgency({
				identity: TEST_AGENCY_ID,
			});
			expect(result.isError).not.toBe(true);
		});

		it("should accept alias 'agency_id'", async () => {
			await seedAgencyRegistry(TEST_AGENCY_ID);
			const result = await handlers.registerAgency({
				agency_id: TEST_AGENCY_ID,
			});
			expect(result.isError).not.toBe(true);
		});

		it("should trim whitespace from identity", async () => {
			await seedAgencyRegistry(TEST_AGENCY_ID);
			const result = await handlers.registerAgency({
				agent_identity: `  ${TEST_AGENCY_ID}  `,
			});
			expect(result.isError).not.toBe(true);
			const row = await getAgencyRow(TEST_AGENCY_ID);
			expect(row).not.toBeNull();
		});
	});

	describe("AC-2: Identity format validation", () => {
		it("should reject invalid characters in agency_id", async () => {
			const result = await handlers.registerAgency({
				agent_identity: "invalid@agency!",
			});
			expect(result.isError).toBe(true);
			const text =
				result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("Invalid");
			expect(text).toContain("format");
		});

		it("should reject agency_id longer than 64 chars", async () => {
			const longId = "a".repeat(65);
			const result = await handlers.registerAgency({
				agent_identity: longId,
			});
			expect(result.isError).toBe(true);
		});

		it("should accept valid characters: alphanumeric, dots, dashes, underscores", async () => {
			const validId = "test-agency_123.bot";
			await seedAgencyRegistry(validId);
			const result = await handlers.registerAgency({
				agent_identity: validId,
			});
			expect(result.isError).not.toBe(true);
		});
	});

	describe("AC-3: Metadata validation", () => {
		it("should accept metadata as object", async () => {
			await seedAgencyRegistry(TEST_AGENCY_ID);
			const result = await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
				metadata: { custom: "value" },
			});
			expect(result.isError).not.toBe(true);
			const row = await getAgencyRow(TEST_AGENCY_ID);
			expect(row.metadata).toMatchObject({ custom: "value" });
		});

		it("should reject metadata as array", async () => {
			await seedAgencyRegistry(TEST_AGENCY_ID);
			const result = await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
				metadata: ["item"] as any,
			});
			expect(result.isError).toBe(true);
			const text =
				result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("array");
		});

		it("should reject metadata as scalar", async () => {
			await seedAgencyRegistry(TEST_AGENCY_ID);
			const result = await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
				metadata: "string" as any,
			});
			expect(result.isError).toBe(true);
		});

		it("should merge metadata with registration context", async () => {
			await seedAgencyRegistry(TEST_AGENCY_ID);
			const result = await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
				metadata: { custom: "data" },
			});
			expect(result.isError).not.toBe(true);
			const row = await getAgencyRow(TEST_AGENCY_ID);
			expect(row.metadata).toHaveProperty("registered_via");
			expect(row.metadata.registered_via).toBe("mcp_agent.register_agency");
			expect(row.metadata).toHaveProperty("source_agent_registry");
			expect(row.metadata).toHaveProperty("custom");
		});
	});

	describe("AC-4: Prerequisite validation - agent_registry", () => {
		it("should reject missing agent_registry row", async () => {
			const result = await handlers.registerAgency({
				agent_identity: "nonexistent-agency",
			});
			expect(result.isError).toBe(true);
			const text =
				result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("agent_registry");
			expect(text).toContain("mcp_agent action='register'");
		});

		it("should reject non-active agency", async () => {
			await seedAgencyRegistry(TEST_AGENCY_ID, "inactive");
			const result = await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
			});
			expect(result.isError).toBe(true);
			const text =
				result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("status");
			expect(text).toContain("inactive");
		});

		it("should reject non-agency agent_type", async () => {
			await seedAgencyRegistry(TEST_AGENCY_ID, "active", "coordinator");
			const result = await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
			});
			expect(result.isError).toBe(true);
			const text =
				result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("agent_type");
			expect(text).toContain("coordinator");
		});
	});

	describe("AC-5: Provider defaults and validation", () => {
		it("should use args.provider when supplied", async () => {
			await seedAgencyRegistry(
				TEST_AGENCY_ID,
				"active",
				"agency",
				"claude",
			);
			const result = await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
				provider: "custom-provider",
			});
			expect(result.isError).not.toBe(true);
			const row = await getAgencyRow(TEST_AGENCY_ID);
			expect(row.provider).toBe("custom-provider");
		});

		it("should default to agent_registry.preferred_provider", async () => {
			await seedAgencyRegistry(
				TEST_AGENCY_ID,
				"active",
				"agency",
				"codex",
			);
			const result = await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
			});
			expect(result.isError).not.toBe(true);
			const row = await getAgencyRow(TEST_AGENCY_ID);
			expect(row.provider).toBe("codex");
		});

		it("should reject missing provider", async () => {
			// Seed with null preferred_provider
			await query(
				`INSERT INTO roadmap_workforce.agent_registry
				 (agent_identity, agent_type, status, preferred_provider, host_affinity)
				 VALUES ($1, $2, $3, NULL, $4)
				 ON CONFLICT DO NOTHING`,
				[TEST_AGENCY_ID, "agency", "active", "bot"],
			);
			const result = await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
			});
			expect(result.isError).toBe(true);
			const text =
				result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("provider");
			expect(text).toContain("cannot be determined");
		});
	});

	describe("AC-6: Host defaults and format validation", () => {
		it("should use args.host_id when supplied", async () => {
			await seedAgencyRegistry(TEST_AGENCY_ID);
			const result = await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
				host_id: "iMac",
			});
			expect(result.isError).not.toBe(true);
			const row = await getAgencyRow(TEST_AGENCY_ID);
			expect(row.host_id).toBe("iMac");
		});

		it("should default to agent_registry.host_affinity", async () => {
			await seedAgencyRegistry(
				TEST_AGENCY_ID,
				"active",
				"agency",
				"claude",
				"iMac",
			);
			const result = await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
			});
			expect(result.isError).not.toBe(true);
			const row = await getAgencyRow(TEST_AGENCY_ID);
			expect(row.host_id).toBe("iMac");
		});

		it("should default to 'bot' if host_affinity is null", async () => {
			await query(
				`INSERT INTO roadmap_workforce.agent_registry
				 (agent_identity, agent_type, status, preferred_provider, host_affinity)
				 VALUES ($1, $2, $3, $4, NULL)
				 ON CONFLICT DO NOTHING`,
				[TEST_AGENCY_ID, "agency", "active", "claude"],
			);
			const result = await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
			});
			expect(result.isError).not.toBe(true);
			const row = await getAgencyRow(TEST_AGENCY_ID);
			expect(row.host_id).toBe("bot");
		});

		it("should reject invalid host_id format", async () => {
			await seedAgencyRegistry(TEST_AGENCY_ID);
			const result = await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
				host_id: "invalid@host!",
			});
			expect(result.isError).toBe(true);
			const text =
				result.content[0]?.type === "text" ? result.content[0].text : "";
			expect(text).toContain("Invalid");
			expect(text).toContain("host_id");
		});
	});

	describe("AC-7: Happy path - new agency INSERT", () => {
		it("should insert new agency and return created action", async () => {
			await seedAgencyRegistry(TEST_AGENCY_ID);
			const result = await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
				display_name: "Test Agency Display",
				provider: "claude",
				host_id: "bot",
			});

			expect(result.isError).not.toBe(true);
			const text =
				result.content[0]?.type === "text" ? result.content[0].text : "";
			const payload = JSON.parse(text);
			expect(payload.action).toBe("created");
			expect(payload.agency_id).toBe(TEST_AGENCY_ID);
			expect(payload.provider).toBe("claude");
			expect(payload.host_id).toBe("bot");

			const row = await getAgencyRow(TEST_AGENCY_ID);
			expect(row).not.toBeNull();
			expect(row.agency_id).toBe(TEST_AGENCY_ID);
			expect(row.provider).toBe("claude");
			expect(row.host_id).toBe("bot");
			expect(row.status).toBe("active");
			expect(row.presence_state).toBe("offline");
		});

		it("should use defaults when not supplied", async () => {
			await seedAgencyRegistry(
				TEST_AGENCY_ID,
				"active",
				"agency",
				"gemini",
				"iMac",
			);
			const result = await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
			});

			expect(result.isError).not.toBe(true);
			const row = await getAgencyRow(TEST_AGENCY_ID);
			expect(row.provider).toBe("gemini");
			expect(row.host_id).toBe("iMac");
		});

		it("should default display_name to agent_identity", async () => {
			await seedAgencyRegistry(TEST_AGENCY_ID);
			const result = await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
			});

			expect(result.isError).not.toBe(true);
			const row = await getAgencyRow(TEST_AGENCY_ID);
			expect(row.agency_id).toBe(TEST_AGENCY_ID);
		});
	});

	describe("AC-8: Idempotency - duplicate call returns noop", () => {
		it("should return noop on second call with same identity", async () => {
			await seedAgencyRegistry(TEST_AGENCY_ID);

			// First call
			const result1 = await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
				provider: "claude",
				host_id: "bot",
			});
			expect(result1.isError).not.toBe(true);

			// Second call
			const result2 = await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
				provider: "claude",
				host_id: "bot",
			});
			expect(result2.isError).not.toBe(true);
			const text =
				result2.content[0]?.type === "text" ? result2.content[0].text : "";
			const payload = JSON.parse(text);
			expect(payload.action).toBe("noop");
			expect(payload.reason).toBe("already_exists");
			expect(payload.agency_id).toBe(TEST_AGENCY_ID);
		});

		it("should surface mismatch in noop response if provider differs", async () => {
			await seedAgencyRegistry(TEST_AGENCY_ID);

			// First call with provider=claude
			await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
				provider: "claude",
			});

			// Second call with provider=codex
			const result2 = await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
				provider: "codex",
			});

			expect(result2.isError).not.toBe(true);
			const text =
				result2.content[0]?.type === "text" ? result2.content[0].text : "";
			const payload = JSON.parse(text);
			expect(payload.action).toBe("noop");
			expect(payload.mismatches).toBeDefined();
			expect(payload.note).toContain("never modified");
		});

		it("should surface mismatch in noop response if host_id differs", async () => {
			await seedAgencyRegistry(TEST_AGENCY_ID);

			// First call
			await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
				host_id: "bot",
			});

			// Second call with different host
			const result2 = await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
				host_id: "custom-host",
			});

			const text =
				result2.content[0]?.type === "text" ? result2.content[0].text : "";
			const payload = JSON.parse(text);
			expect(payload.mismatches).toBeDefined();
		});
	});

	describe("AC-9: Status/presence_state immutability", () => {
		it("should not overwrite status set by fn_pulse", async () => {
			await seedAgencyRegistry(TEST_AGENCY_ID);

			// Insert via registerAgency
			await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
				provider: "claude",
			});

			// Manually update status to simulate fn_pulse operation
			await query(
				`UPDATE roadmap.agency SET status = $1 WHERE agency_id = $2`,
				["paused", TEST_AGENCY_ID],
			);

			// Verify status persists
			let row = await getAgencyRow(TEST_AGENCY_ID);
			expect(row.status).toBe("paused");

			// Call registerAgency again (idempotent noop)
			await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
				provider: "claude",
			});

			// Status should still be 'paused', not reset to 'active'
			row = await getAgencyRow(TEST_AGENCY_ID);
			expect(row.status).toBe("paused");
		});

		it("should not overwrite presence_state set by fn_pulse", async () => {
			await seedAgencyRegistry(TEST_AGENCY_ID);

			// Insert via registerAgency
			await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
				provider: "claude",
			});

			// Manually update presence_state
			await query(
				`UPDATE roadmap.agency SET presence_state = $1 WHERE agency_id = $2`,
				["online", TEST_AGENCY_ID],
			);

			// Verify it persists
			let row = await getAgencyRow(TEST_AGENCY_ID);
			expect(row.presence_state).toBe("online");

			// Call registerAgency again
			await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
			});

			// Should still be online
			row = await getAgencyRow(TEST_AGENCY_ID);
			expect(row.presence_state).toBe("online");
		});
	});

	describe("AC-10: No UPDATE semantics", () => {
		it("should not update display_name on second call", async () => {
			await seedAgencyRegistry(TEST_AGENCY_ID);

			// First call with display_name
			const result1 = await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
				display_name: "Original Name",
			});
			expect(result1.isError).not.toBe(true);

			// Manually query to verify display_name was stored (it's in roadmap.agency table)
			const { rows: rows1 } = await query<{
				display_name: string;
			}>(
				`SELECT display_name FROM roadmap.agency WHERE agency_id = $1`,
				[TEST_AGENCY_ID],
			);
			expect(rows1[0]?.display_name).toBe("Original Name");

			// Second call with different display_name
			const result2 = await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
				display_name: "Updated Name",
			});
			expect(result2.isError).not.toBe(true);

			// Should NOT update - display_name should still be original
			const { rows: rows2 } = await query<{ display_name: string }>(
				`SELECT display_name FROM roadmap.agency WHERE agency_id = $1`,
				[TEST_AGENCY_ID],
			);
			expect(rows2[0]?.display_name).toBe("Original Name");
		});
	});

	describe("AC-11: Multiple agencies", () => {
		it("should handle registration of multiple distinct agencies", async () => {
			await seedAgencyRegistry(TEST_AGENCY_ID);
			await seedAgencyRegistry(TEST_AGENCY_ID_2);

			const result1 = await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID,
				provider: "claude",
			});
			expect(result1.isError).not.toBe(true);

			const result2 = await handlers.registerAgency({
				agent_identity: TEST_AGENCY_ID_2,
				provider: "gemini",
			});
			expect(result2.isError).not.toBe(true);

			const row1 = await getAgencyRow(TEST_AGENCY_ID);
			const row2 = await getAgencyRow(TEST_AGENCY_ID_2);

			expect(row1.provider).toBe("claude");
			expect(row2.provider).toBe("gemini");
		});
	});
});
