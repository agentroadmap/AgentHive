/**
 * P1365-AC2: sync Snapshot to Capacity tests
 *
 * Coverage:
 * - AC2: Bridge P1859 oauth-usage snapshot to P1365 capacity-tracker
 * - Tests the throttle curve computation
 * - Tests agency_capacity upsert
 * - Tests fallback to "*" model in queries
 *
 * Note: Live DB tests are env-gated (AGENTHIVE_LIVE_DB_TESTS=1)
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { query } from "../../../postgres/pool.ts";
import {
	reportAgentUsage,
	syncSnapshotToCapacity,
	getCredentialKey,
} from "../usage-probe.ts";

const LIVE_DB_ENABLED = process.env.AGENTHIVE_LIVE_DB_TESTS === "1";

if (!LIVE_DB_ENABLED) {
	describe("P1365-AC2: Sync Snapshot to Capacity (SKIPPED — AGENTHIVE_LIVE_DB_TESTS not set)", () => {
		it("skipped", () => {
			expect(true).toBe(true);
		});
	});
} else {
	describe("P1365-AC2: Sync Snapshot to Capacity", () => {
		const uniqueSuffix = Date.now();
		const testCredKey = `p1365-test:anthropic-${uniqueSuffix}`;
		const [osUser, provider] = testCredKey.split(":");

		afterAll(async () => {
			// Clean up test data
			try {
				// Remove snapshots
				await query(
					`DELETE FROM roadmap_workforce.agent_usage_snapshot WHERE credential_key = $1`,
					[testCredKey],
				);
				// Remove capacity rows — the suite's provider is unique per run, so
				// deleting by provider removes every row this suite created.
				await query(
					`DELETE FROM roadmap_workforce.agency_capacity WHERE provider = $1`,
					[provider],
				);
			} catch (err) {
				console.error("Cleanup failed:", err);
			}
		});

		describe("AC2: Bridge snapshot → capacity_tracker", () => {
			it("should sync snapshot with high headroom (>= 50%) to capacity table with action=none", async () => {
				// Report snapshot with 75% headroom
				const result = await reportAgentUsage(
					{
						provider,
						agent_identity: "test-agent",
						quota_remaining: 75, // 75% headroom
						quota_limit: 100,
						quota_reset_at: new Date(Date.now() + 3600000).toISOString(),
					},
					osUser,
				);
				expect(result.success).toBe(true);

				// Give async sync time to complete
				await new Promise((r) => setTimeout(r, 100));

				// Query capacity table — bridge writes one row per (provider, '*', agent_identity)
				const { rows } = await query(
					`SELECT throttle_action, p_skip, headroom_pct
         FROM roadmap_workforce.agency_capacity
         WHERE provider = $1 AND model = '*' AND agency_id = $2`,
					[provider, "test-agent"],
				);

				expect(rows.length).toBe(1);
				expect(rows[0].throttle_action).toBe("none");
				expect(parseFloat(rows[0].p_skip)).toBe(0);
				expect(parseFloat(rows[0].headroom_pct)).toBe(75);
			});

			it("should apply soft throttle for 25-50% headroom band", async () => {
				// Report snapshot with 40% headroom (in 25-50% band)
				// Curve: p_skip = (50 - 40) / 25 * 0.25 = 0.1
				const result = await reportAgentUsage(
					{
						provider,
						agent_identity: "test-agent-soft1",
						quota_remaining: 40,
						quota_limit: 100,
						quota_reset_at: new Date(Date.now() + 3600000).toISOString(),
					},
					osUser,
				);
				expect(result.success).toBe(true);

				await new Promise((r) => setTimeout(r, 100));

				const { rows } = await query(
					`SELECT throttle_action, p_skip, headroom_pct
         FROM roadmap_workforce.agency_capacity
         WHERE provider = $1 AND agency_id LIKE $2`,
					[provider, "%soft1"],
				);

				expect(rows.length).toBe(1);
				expect(rows[0].throttle_action).toBe("soft");
				expect(parseFloat(rows[0].p_skip)).toBeCloseTo(0.1, 2);
				expect(parseFloat(rows[0].headroom_pct)).toBe(40);
			});

			it("should apply soft throttle for 10-25% headroom band", async () => {
				// Report snapshot with 18% headroom (in 10-25% band)
				// Curve: p_skip = 0.25 + (25 - 18) / 15 * 0.45 = 0.25 + 0.21 = 0.46
				const result = await reportAgentUsage(
					{
						provider,
						agent_identity: "test-agent-soft2",
						quota_remaining: 18,
						quota_limit: 100,
						quota_reset_at: new Date(Date.now() + 3600000).toISOString(),
					},
					osUser,
				);
				expect(result.success).toBe(true);

				await new Promise((r) => setTimeout(r, 100));

				const { rows } = await query(
					`SELECT throttle_action, p_skip, headroom_pct
         FROM roadmap_workforce.agency_capacity
         WHERE provider = $1 AND agency_id LIKE $2`,
					[provider, "%soft2"],
				);

				expect(rows.length).toBe(1);
				expect(rows[0].throttle_action).toBe("soft");
				expect(parseFloat(rows[0].p_skip)).toBeCloseTo(0.46, 1);
				expect(parseFloat(rows[0].headroom_pct)).toBe(18);
			});

			it("should apply hard throttle for < 10% headroom", async () => {
				// Report snapshot with 5% headroom (< 10%)
				const result = await reportAgentUsage(
					{
						provider,
						agent_identity: "test-agent-hard",
						quota_remaining: 5,
						quota_limit: 100,
						quota_reset_at: new Date(Date.now() + 3600000).toISOString(),
					},
					osUser,
				);
				expect(result.success).toBe(true);

				await new Promise((r) => setTimeout(r, 100));

				const { rows } = await query(
					`SELECT throttle_action, p_skip, headroom_pct
         FROM roadmap_workforce.agency_capacity
         WHERE provider = $1 AND agency_id LIKE $2`,
					[provider, "%hard"],
				);

				expect(rows.length).toBe(1);
				expect(rows[0].throttle_action).toBe("hard");
				expect(parseFloat(rows[0].p_skip)).toBe(1);
				expect(parseFloat(rows[0].headroom_pct)).toBe(5);
			});

			it("should use wildcard model '*' for provider-level quota", async () => {
				const result = await reportAgentUsage(
					{
						provider,
						agent_identity: "test-agent-model",
						quota_remaining: 50,
						quota_limit: 100,
						quota_reset_at: new Date(Date.now() + 3600000).toISOString(),
					},
					osUser,
				);
				expect(result.success).toBe(true);

				await new Promise((r) => setTimeout(r, 100));

				// Verify model is "*"
				const { rows } = await query(
					`SELECT model
         FROM roadmap_workforce.agency_capacity
         WHERE provider = $1 AND agency_id LIKE $2`,
					[provider, "%model"],
				);

				expect(rows.length).toBe(1);
				expect(rows[0].model).toBe("*");
			});

			it("should handle null quota_remaining gracefully", async () => {
				// Report with null quota (stale snapshot)
				const result = await reportAgentUsage(
					{
						provider,
						agent_identity: "test-agent-null",
						quota_remaining: undefined, // null
						quota_limit: 100,
					},
					osUser,
				);
				// reportAgentUsage should succeed (it's the sync that fails gracefully)
				expect(result.success).toBe(true);

				await new Promise((r) => setTimeout(r, 100));

				// syncSnapshotToCapacity should have skipped (no valid snapshot)
				const { rows } = await query(
					`SELECT * FROM roadmap_workforce.agency_capacity
         WHERE agency_id LIKE $1`,
					["%null"],
				);

				// Should not have created a capacity row for null quota
				expect(rows.length).toBe(0);
			});

			it("syncSnapshotToCapacity skips when quota_limit is zero/invalid", async () => {
				await syncSnapshotToCapacity(
					{
						provider,
						agent_identity: "test-agent-zerolimit",
						quota_remaining: 50,
						quota_limit: 0,
					},
					osUser,
				);
				const { rows } = await query(
					`SELECT 1 FROM roadmap_workforce.agency_capacity WHERE agency_id = $1`,
					["test-agent-zerolimit"],
				);
				expect(rows.length).toBe(0);
			});
		});

		describe("AC4: Capacity-filter fallback to wildcard model", () => {
			it("capacity-filter should prefer exact model match over wildcard", async () => {
				// Create both exact and wildcard rows
				await query(
					`INSERT INTO roadmap_workforce.agency_capacity (
            provider, model, agency_id, headroom_pct, p_skip, throttle_action
          ) VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (provider, model, agency_id) DO UPDATE SET
            headroom_pct = EXCLUDED.headroom_pct`,
					[provider, "claude-3-opus", "test-filter-agency", 80, 0, "none"],
				);

				await query(
					`INSERT INTO roadmap_workforce.agency_capacity (
            provider, model, agency_id, headroom_pct, p_skip, throttle_action
          ) VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (provider, model, agency_id) DO UPDATE SET
            headroom_pct = EXCLUDED.headroom_pct`,
					[provider, "*", "test-filter-agency", 40, 0.25, "soft"],
				);

				// Query with fallback logic (from capacity-filter.ts)
				const { rows } = await query(
					`SELECT headroom_pct, model FROM roadmap_workforce.agency_capacity
           WHERE provider = $1 AND agency_id = $2 AND (model = $3 OR model = '*')
           ORDER BY CASE WHEN model = $3 THEN 0 ELSE 1 END
           LIMIT 1`,
					[provider, "test-filter-agency", "claude-3-opus"],
				);

				expect(rows.length).toBe(1);
				expect(rows[0].model).toBe("claude-3-opus"); // Should prefer exact match
				expect(parseFloat(rows[0].headroom_pct)).toBe(80);

				// Cleanup
				await query(
					`DELETE FROM roadmap_workforce.agency_capacity
           WHERE agency_id = $1`,
					["test-filter-agency"],
				);
			});

			it("capacity-filter should fall back to wildcard if no exact match", async () => {
				// Create only wildcard row
				await query(
					`INSERT INTO roadmap_workforce.agency_capacity (
            provider, model, agency_id, headroom_pct, p_skip, throttle_action
          ) VALUES ($1, $2, $3, $4, $5, $6)`,
					[provider, "*", "test-fallback-agency", 35, 0.4, "soft"],
				);

				// Query for different model → should fall back to wildcard
				const { rows } = await query(
					`SELECT headroom_pct, model FROM roadmap_workforce.agency_capacity
           WHERE provider = $1 AND agency_id = $2 AND (model = $3 OR model = '*')
           ORDER BY CASE WHEN model = $3 THEN 0 ELSE 1 END
           LIMIT 1`,
					[provider, "test-fallback-agency", "different-model"],
				);

				expect(rows.length).toBe(1);
				expect(rows[0].model).toBe("*");
				expect(parseFloat(rows[0].headroom_pct)).toBe(35);

				// Cleanup
				await query(
					`DELETE FROM roadmap_workforce.agency_capacity
           WHERE agency_id = $1`,
					["test-fallback-agency"],
				);
			});
		});
	});
}
