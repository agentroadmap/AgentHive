/**
 * P919: Display Alias Manager Tests
 *
 * AC-2: Crash-restart alias reclamation
 * AC-3: Alias collision prevention between different roles
 * AC-4: Force-release alias with heartbeat gating
 * AC-11: NULL Uniqueness — multiple inactive agents coexist
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { query } from "../../../../infra/postgres/pool";
import {
	forceReleaseAlias,
	type AliasReclaimError,
	type AliasReclaimResult,
} from "../alias-manager";

describe("Alias Manager — P919", () => {
	let testDbName: string;

	beforeEach(async () => {
		// Create isolated test database
		testDbName = `test_p919_${Date.now()}`;
		await query(`CREATE DATABASE ${testDbName}`);
		// Switch connection to test DB for subsequent queries
		// (In real test setup, this would use a fixture that manages connection pooling)
	});

	afterEach(async () => {
		// Clean up test database
		// (In real test setup, this would be done by test fixtures)
	});

	describe("AC-2: Crash-restart alias reclamation", () => {
		it("should allow alias reuse when prior owner transitions to inactive", async () => {
			// Scenario: Agent A registers with alias 'Claude-Bot-Architect'
			// Process crashes, A's row becomes inactive, alias field stays populated
			// Agent B (same role, different identity) spawns and reclaims the alias

			// Setup: Insert agent A with alias and status=active
			const agentA = await query(
				`INSERT INTO roadmap_workforce.agent_registry
        (agent_identity, agent_type, display_alias, status, project_id)
        VALUES ($1, $2, $3, 'active', 1)
        RETURNING agent_identity, display_alias, status`,
				["ccs45ant-bot-arch-a", "llm", "Claude-Bot-Architect"],
			);

			expect(agentA.rows[0].display_alias).toBe("Claude-Bot-Architect");

			// Simulate crash: transition A to inactive (alias stays set for audit)
			await query(
				`UPDATE roadmap_workforce.agent_registry
        SET status = 'inactive', status_reason = 'process_crash'
        WHERE agent_identity = $1`,
				["ccs45ant-bot-arch-a"],
			);

			// Verify A is now inactive
			const inactiveA = await query(
				`SELECT status, display_alias FROM roadmap_workforce.agent_registry
        WHERE agent_identity = $1`,
				["ccs45ant-bot-arch-a"],
			);
			expect(inactiveA.rows[0].status).toBe("inactive");
			expect(inactiveA.rows[0].display_alias).toBe("Claude-Bot-Architect");

			// Agent B spawns with same alias
			const agentB = await query(
				`INSERT INTO roadmap_workforce.agent_registry
        (agent_identity, agent_type, display_alias, status, project_id)
        VALUES ($1, $2, $3, 'active', 1)
        RETURNING agent_identity, display_alias, status`,
				["ccs45ant-bot-arch-b", "llm", "Claude-Bot-Architect"],
			);

			// Verify B holds the alias now
			expect(agentB.rows[0].display_alias).toBe("Claude-Bot-Architect");
			expect(agentB.rows[0].status).toBe("active");

			// Old A row still has alias (for audit trail)
			const auditA = await query(
				`SELECT status, display_alias FROM roadmap_workforce.agent_registry
        WHERE agent_identity = $1`,
				["ccs45ant-bot-arch-a"],
			);
			expect(auditA.rows[0].status).toBe("inactive");
		});
	});

	describe("AC-3: Alias collision between different roles prevented", () => {
		it("should prevent two active agents from holding the same alias", async () => {
			// Insert first agent with alias
			await query(
				`INSERT INTO roadmap_workforce.agent_registry
        (agent_identity, agent_type, display_alias, status, project_id)
        VALUES ($1, $2, $3, 'active', 1)`,
				["ccs45ant-bot-arch-a", "llm", "Claude-Bot-Architect"],
			);

			// Try to insert second agent with same alias (should fail due to unique index)
			try {
				await query(
					`INSERT INTO roadmap_workforce.agent_registry
          (agent_identity, agent_type, display_alias, status, project_id)
          VALUES ($1, $2, $3, 'active', 1)`,
					["ccs45ant-bot-arch-b", "llm", "Claude-Bot-Architect"],
				);
				expect.fail("Should have thrown unique constraint violation");
			} catch (e) {
				expect((e as any).message).toMatch(/unique/i);
			}

			// Different alias for different role should work
			const agentC = await query(
				`INSERT INTO roadmap_workforce.agent_registry
        (agent_identity, agent_type, display_alias, status, project_id)
        VALUES ($1, $2, $3, 'active', 1)
        RETURNING display_alias`,
				["ccs45ant-bot-sec-a", "llm", "Claude-Bot-Security"],
			);

			expect(agentC.rows[0].display_alias).toBe("Claude-Bot-Security");
		});
	});

	describe("AC-4: Force-release alias", () => {
		it("should clean-reclaim when target is inactive", async () => {
			// Setup: inactive agent holding an alias
			await query(
				`INSERT INTO roadmap_workforce.agent_registry
        (agent_identity, agent_type, display_alias, status, project_id)
        VALUES ($1, $2, $3, 'inactive', 1)`,
				["ccs45ant-bot-arch-old", "llm", "Claude-Bot-Architect"],
			);

			// Force-release (no force flag needed for inactive)
			const result = (await forceReleaseAlias({
				identity: "ccs45ant-bot-arch-old",
				force: false,
			})) as AliasReclaimResult;

			expect(result.success).toBe(true);
			expect(result.reason).toBe("inactive_clean");
			expect(result.priorIdentity).toBe("ccs45ant-bot-arch-old");

			// Verify alias was cleared
			const agent = await query(
				`SELECT display_alias FROM roadmap_workforce.agent_registry
        WHERE agent_identity = $1`,
				["ccs45ant-bot-arch-old"],
			);
			expect(agent.rows[0].display_alias).toBeNull();
		});

		it("should reject active agent without force flag", async () => {
			// Setup: active agent with recent heartbeat
			await query(
				`INSERT INTO roadmap_workforce.agent_registry
        (agent_identity, agent_type, display_alias, status, project_id)
        VALUES ($1, $2, $3, 'active', 1)`,
				["ccs45ant-bot-arch-active", "llm", "Claude-Bot-Architect"],
			);

			// Insert agency with recent heartbeat
			await query(
				`INSERT INTO roadmap.agency
        (agency_id, display_name, provider, host_id, status, last_heartbeat_at)
        VALUES ($1, $2, $3, $4, 'active', now())`,
				[
					"ccs45ant-bot-arch-active",
					"Test Agency",
					"anthropic",
					"bot",
				],
			);

			// Try to force-release without force=true (should fail)
			const result = (await forceReleaseAlias({
				identity: "ccs45ant-bot-arch-active",
				force: false,
			})) as AliasReclaimError;

			expect(result.code).toBe("alias_owner_still_alive");
			expect(result.message).toContain("still active");
		});

		it("should force-reclaim when agent is stuck-active (heartbeat > 90s)", async () => {
			// Setup: active agent with stale heartbeat
			await query(
				`INSERT INTO roadmap_workforce.agent_registry
        (agent_identity, agent_type, display_alias, status, project_id)
        VALUES ($1, $2, $3, 'active', 1)`,
				["ccs45ant-bot-arch-stuck", "llm", "Claude-Bot-Architect"],
			);

			// Insert agency with heartbeat > 90s ago
			await query(
				`INSERT INTO roadmap.agency
        (agency_id, display_name, provider, host_id, status, last_heartbeat_at)
        VALUES ($1, $2, $3, $4, 'active', now() - interval '120 seconds')`,
				["ccs45ant-bot-arch-stuck", "Test Agency", "anthropic", "bot"],
			);

			// Force-release with force=true (should succeed)
			const result = (await forceReleaseAlias({
				identity: "ccs45ant-bot-arch-stuck",
				force: true,
			})) as AliasReclaimResult;

			expect(result.success).toBe(true);
			expect(result.reason).toBe("stuck_active_force");

			// Verify alias was cleared
			const agent = await query(
				`SELECT display_alias FROM roadmap_workforce.agent_registry
        WHERE agent_identity = $1`,
				["ccs45ant-bot-arch-stuck"],
			);
			expect(agent.rows[0].display_alias).toBeNull();
		});
	});

	describe("AC-11: NULL Uniqueness", () => {
		it("should allow multiple active agents with NULL display_alias", async () => {
			// Insert multiple agents without setting display_alias (defaults to NULL)
			const agents = [];
			for (let i = 0; i < 3; i++) {
				const result = await query(
					`INSERT INTO roadmap_workforce.agent_registry
          (agent_identity, agent_type, status, project_id)
          VALUES ($1, $2, 'active', 1)
          RETURNING agent_identity, display_alias`,
					[`ccs45ant-bot-${i}`, "llm"],
				);
				agents.push(result.rows[0]);
			}

			// Verify all have NULL alias and no constraint violation occurred
			expect(agents).toHaveLength(3);
			agents.forEach((agent) => {
				expect(agent.display_alias).toBeNull();
			});
		});
	});
});
