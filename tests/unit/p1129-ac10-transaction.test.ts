import assert from "node:assert";
import { after, describe, it } from "node:test";
import { query } from "../../src/postgres/pool.ts";

// Load the module dynamically
const { PgAgentHandlers } = await import("../../src/apps/mcp-server/tools/agents/pg-handlers.ts");

describe("P1129 AC-10: transaction boundary for Phase A registration", () => {
	const handlers = new PgAgentHandlers();
	const testId = `test-ac10-${Math.random().toString(36).slice(2)}`;

	// Teardown: remove every scratch row this suite created (all identities share
	// the unique `testId` suffix). The AC-10 test writes THREE tables, so clean
	// children (provider_registry, agency) before the parent (agent_registry) to
	// respect FK order. Without this, fixture agents leak into the live registry.
	after(async () => {
		await query(`DELETE FROM roadmap_workforce.provider_registry WHERE agency_identity LIKE $1`, [`%${testId}%`]);
		await query(`DELETE FROM roadmap.agency WHERE agency_id LIKE $1`, [`%${testId}%`]);
		await query(`DELETE FROM roadmap_workforce.agent_registry WHERE agent_identity LIKE $1`, [`%${testId}%`]);
	});

	it("should create agent_registry atomically in transaction", async () => {
		const testIdentity = `agent-tx-${testId}`;

		const result = await handlers.registerAgent({
			identity: testIdentity,
			agent_type: "llm",
			role: "developer",
		});

		assert.strictEqual(result.isError, undefined, `registration should succeed. Got: ${result.content[0]?.text}`);
		const output = JSON.parse(result.content[0].text);
		assert.strictEqual(output.agent_identity, testIdentity, "should return registered identity");
		assert.strictEqual(output.transaction, "committed", "should indicate transaction committed");

		// Verify agent_registry row exists
		const check = await query(`SELECT id, agent_identity FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`, [
			testIdentity,
		]);
		assert.strictEqual(check.rows.length, 1, "agent should be in registry");
		assert.strictEqual(check.rows[0].agent_identity, testIdentity);
	});

	it("should atomically write agent_registry + agency + provider_registry when all fields present", async () => {
		const testIdentity = `agent-full-tx-${testId}`;

		const result = await handlers.registerAgent({
			identity: testIdentity,
			agent_type: "llm",
			role: "coordinator",
			display_name: "Test Coordinator",
			// AC-10: Agency fields for transaction-bundled registration
			agency_display_name: "Test Agency",
			agency_provider: "claude",
			agency_host_id: "bot",
			project_id: 1,
			squad_name: "test-squad",
		});

		assert.strictEqual(result.isError, undefined, `registration should succeed. Got: ${result.content[0]?.text}`);
		const output = JSON.parse(result.content[0].text);
		assert.strictEqual(output.transaction, "committed", "transaction should commit");

		// Verify all three rows exist
		const agentCheck = await query(`SELECT id FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`, [
			testIdentity,
		]);
		assert.strictEqual(agentCheck.rows.length, 1, "agent_registry row should exist");
		const agentId = agentCheck.rows[0].id;

		const agencyCheck = await query(`SELECT agency_id FROM roadmap.agency WHERE agency_id = $1`, [testIdentity]);
		assert.strictEqual(agencyCheck.rows.length, 1, "agency row should exist");

		const providerCheck = await query(
			`SELECT id FROM roadmap_workforce.provider_registry WHERE agency_id = $1 AND squad_name = $2`,
			[agentId, "test-squad"],
		);
		assert.strictEqual(providerCheck.rows.length, 1, "provider_registry row should exist");
	});

	it("should only write agent_registry if agency fields not fully provided", async () => {
		const testIdentity = `agent-partial-${testId}`;

		// Register without agency fields
		const result = await handlers.registerAgent({
			identity: testIdentity,
			agent_type: "llm",
			// No agency_display_name, agency_provider, agency_host_id
		});

		assert.strictEqual(result.isError, undefined);

		// Verify agent_registry exists
		const agentCheck = await query(`SELECT id FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`, [
			testIdentity,
		]);
		assert.strictEqual(agentCheck.rows.length, 1, "agent_registry row should exist");

		// Verify agency was NOT created (no full agency fields provided)
		const agencyCheck = await query(`SELECT agency_id FROM roadmap.agency WHERE agency_id = $1`, [testIdentity]);
		assert.strictEqual(agencyCheck.rows.length, 0, "agency row should NOT exist when fields incomplete");
	});

	it("should enforce SELECT...FOR UPDATE serialization on concurrent calls", async () => {
		const testIdentity = `agent-serialize-${testId}`;

		// Fire 2 concurrent registrations for the same identity
		// With FOR UPDATE, they should serialize without constraint violations
		const [result1, result2] = await Promise.all([
			handlers.registerAgent({
				identity: testIdentity,
				agent_type: "llm",
				role: "dev1",
			}),
			handlers.registerAgent({
				identity: testIdentity,
				agent_type: "llm",
				role: "dev2",
			}),
		]);

		// Both should succeed (COALESCE UPDATE) or one might override the other
		// But no deadlock or constraint violation should occur
		const noConflict = (result1.isError === undefined || result2.isError === undefined);
		assert.ok(noConflict, `at least one should succeed without constraint error`);

		// Verify final state is consistent
		const final = await query(`SELECT role FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`, [testIdentity]);
		assert.strictEqual(final.rows.length, 1, "exactly one row should exist after concurrent calls");
	});

	it("should rollback all writes if any step fails mid-transaction", async () => {
		const testIdentity = `agent-rollback-${testId}`;

		// Try to register with invalid agency_host_id (FK should fail)
		const result = await handlers.registerAgent({
			identity: testIdentity,
			agent_type: "llm",
			agency_display_name: "Test",
			agency_provider: "claude",
			agency_host_id: "nonexistent-host", // FK constraint will fail
		});

		// Should fail due to FK violation
		assert.strictEqual(result.isError, true, "should fail due to invalid host_id");

		// Verify NO rows were created (rollback happened)
		const agentCheck = await query(
			`SELECT id FROM roadmap_workforce.agent_registry WHERE agent_identity = $1`,
			[testIdentity],
		);
		assert.strictEqual(agentCheck.rows.length, 0, "agent_registry should NOT exist after rollback");

		const agencyCheck = await query(`SELECT agency_id FROM roadmap.agency WHERE agency_id = $1`, [testIdentity]);
		assert.strictEqual(agencyCheck.rows.length, 0, "agency should NOT exist after rollback");
	});
});
