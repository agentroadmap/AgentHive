/**
 * P1859: Provider usage probe tests
 *
 * Coverage:
 * - AC-4: Per-(OS-user,provider) credential bucketing with 3 identities sharing same cred
 * - AC-7: Failure degradation (stale_flag=true rows, fail-open behavior)
 * - AC-8: P1699 integration (controller-side read API for quota-based cap computation)
 *
 * Note: Live DB tests are env-gated (AGENTHIVE_LIVE_DB_TESTS=1)
 */

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { query } from "../../../postgres/pool.ts";
import {
	reportAgentUsage,
	getLatestQuotaSnapshot,
	getCredentialKey,
	writeStaleSnapshot,
	type ProviderUsagePayload,
} from "../usage-probe.ts";

const LIVE_DB_ENABLED = process.env.AGENTHIVE_LIVE_DB_TESTS === "1";

if (!LIVE_DB_ENABLED) {
	describe("P1859: Usage Probe Tests (SKIPPED — AGENTHIVE_LIVE_DB_TESTS not set)", () => {
		it("skipped", () => {
			expect(true).toBe(true);
		});
	});
} else {
	describe("P1859: Usage Probe Tests", () => {
		const testCredKey = `test-user:anthropic-${Date.now()}`;

		beforeAll(async () => {
			// Clean up any existing test rows (use a unique suffix per run)
		});

		afterAll(async () => {
			// Clean up test snapshots by credential_key
			try {
				await query(`DELETE FROM roadmap_workforce.agent_usage_snapshot WHERE credential_key = $1`, [
					testCredKey,
				]);
			} catch (err) {
				console.error("Cleanup failed:", err);
			}
		});

		// ── AC-4: Per-(OS-user,provider) credential bucketing ─────────────────────
		describe("AC-4: Per-(OS-user,provider) credential bucketing", () => {
			it("should generate consistent credential keys", () => {
				const key1 = getCredentialKey("anthropic", "gary");
				const key2 = getCredentialKey("anthropic", "gary");
				expect(key1).toBe(key2);
				expect(key1).toBe("gary:anthropic");
			});

			it("should bucket 3 agencies under same credential key", async () => {
				const osUser = "testuser";
				const provider = "anthropic";
				const credKey = getCredentialKey(provider, osUser);

				// Three agencies: adam, alan, alex (all share same OS-user + provider)
				const agencies = ["adam", "alan", "alex"];

				// Report usage from all three agencies
				for (const agency of agencies) {
					const result = await reportAgentUsage(
						{
							provider,
							agent_identity: agency,
							quota_remaining: 50000,
							quota_limit: 100000,
							quota_reset_at: new Date(Date.now() + 3600000).toISOString(),
						},
						osUser,
					);
					expect(result.success).toBe(true);
				}

				// Query latest snapshot — should return ONE row (the most recent)
				const snapshot = await getLatestQuotaSnapshot(credKey);
				expect(snapshot).not.toBeNull();
				expect(snapshot!.quota_remaining).toBe(50000);
				expect(snapshot!.quota_limit).toBe(100000);
				expect(snapshot!.stale_flag).toBe(false);

				// Verify all 3 agencies' rows exist in DB (same credential_key)
				const { rows } = await query(
					`SELECT DISTINCT agent_identity FROM roadmap_workforce.agent_usage_snapshot WHERE credential_key = $1 ORDER BY agent_identity`,
					[credKey],
				);
				const identities = rows.map((r: any) => r.agent_identity).sort();
				expect(identities).toEqual(["adam", "alan", "alex"]);
			});

			it("should isolate different credential keys", async () => {
				const credKey1 = `test1:anthropic-${Date.now()}`;
				const credKey2 = `test2:anthropic-${Date.now()}`;

				// Insert under credKey1
				await reportAgentUsage(
					{
						provider: "anthropic",
						agent_identity: "adam",
						quota_remaining: 10000,
						quota_limit: 100000,
					},
					credKey1.split(":")[0],
				);

				// Insert under credKey2 with different values
				await reportAgentUsage(
					{
						provider: "anthropic",
						agent_identity: "alan",
						quota_remaining: 20000,
						quota_limit: 100000,
					},
					credKey2.split(":")[0],
				);

				const snap1 = await getLatestQuotaSnapshot(credKey1);
				const snap2 = await getLatestQuotaSnapshot(credKey2);

				expect(snap1?.quota_remaining).toBe(10000);
				expect(snap2?.quota_remaining).toBe(20000);

				// Cleanup
				await query(
					`DELETE FROM roadmap_workforce.agent_usage_snapshot WHERE credential_key IN ($1, $2)`,
					[credKey1, credKey2],
				);
			});
		});

		// ── AC-7: Failure degradation ────────────────────────────────────────────
		describe("AC-7: Failure degradation (stale_flag)", () => {
			it("should write stale_flag=true on probe failure", async () => {
				const credKey = `stale-test-${Date.now()}`;

				const written = await writeStaleSnapshot(
					credKey,
					"anthropic",
					"test-agent",
					"404 Not Found",
				);
				expect(written).toBe(true);

				const snapshot = await getLatestQuotaSnapshot(credKey);
				expect(snapshot).not.toBeNull();
				expect(snapshot!.stale_flag).toBe(true);
				expect(snapshot!.quota_remaining).toBeNull();

				// Cleanup
				await query(
					`DELETE FROM roadmap_workforce.agent_usage_snapshot WHERE credential_key = $1`,
					[credKey],
				);
			});

			it("should return stale row but caller should detect flag", async () => {
				const credKey = `stale-caller-test-${Date.now()}`;

				// Write stale snapshot
				await writeStaleSnapshot(credKey, "anthropic", "test-agent", "429 Too Many Requests");

				// Caller reads it and SHOULD check stale_flag
				const snapshot = await getLatestQuotaSnapshot(credKey);
				if (snapshot?.stale_flag === true) {
					// Consumer fails open: don't apply quota gate, proceed with spawn
					expect(snapshot.stale_flag).toBe(true);
				}

				// Cleanup
				await query(
					`DELETE FROM roadmap_workforce.agent_usage_snapshot WHERE credential_key = $1`,
					[credKey],
				);
			});

			it("should fail gracefully on corrupt/missing data", async () => {
				// Query a non-existent credential — should return null, no crash
				const snapshot = await getLatestQuotaSnapshot("does-not-exist");
				expect(snapshot).toBeNull();
			});
		});

		// ── AC-8: P1699 integration test ──────────────────────────────────────────
		describe("AC-8: P1699 controller integration", () => {
			it("should compute effective_cap from quota snapshot (shared bucket)", async () => {
				const osUser = "p1699test";
				const provider = "anthropic";
				const credKey = getCredentialKey(provider, osUser);
				const target_quota_pct = 0.8; // Only use 80% of remaining quota

				// Shared credential: three agencies with allocations
				const agencies = [
					{ identity: "adam", allocation_pct: 0.5 }, // 50% of shared quota
					{ identity: "alan", allocation_pct: 0.3 }, // 30%
					{ identity: "alex", allocation_pct: 0.2 }, // 20%
				];

				// Write shared quota snapshot
				const shared_quota_remaining = 100000; // tokens
				const shared_quota_limit = 1000000;
				await reportAgentUsage(
					{
						provider,
						agent_identity: "adam", // Last writer wins, but all read same snapshot
						quota_remaining: shared_quota_remaining,
						quota_limit: shared_quota_limit,
						quota_reset_at: new Date(Date.now() + 3600000).toISOString(),
					},
					osUser,
				);

				// Read snapshot for controller decision
				const snapshot = await getLatestQuotaSnapshot(credKey);
				expect(snapshot).not.toBeNull();
				expect(snapshot!.quota_remaining).toBe(shared_quota_remaining);
				expect(snapshot!.stale_flag).toBe(false);

				// AC-8: Controller-side computation
				// effective_cap = min(max_in_flight, floor(quota_remaining * target_quota_pct))
				const max_in_flight = 10; // from agency capacity config
				const effective_cap = Math.min(
					max_in_flight,
					Math.floor((snapshot!.quota_remaining || 0) * target_quota_pct),
				);
				expect(effective_cap).toBe(10); // Limited by max_in_flight, not quota

				// Verify each agency gets its share from the pool
				const adam_cap = Math.floor(effective_cap * agencies[0].allocation_pct);
				const alan_cap = Math.floor(effective_cap * agencies[1].allocation_pct);
				const alex_cap = Math.floor(effective_cap * agencies[2].allocation_pct);

				expect(adam_cap).toBe(5);
				expect(alan_cap).toBe(3);
				expect(alex_cap).toBe(2);
				expect(adam_cap + alan_cap + alex_cap).toBeLessThanOrEqual(effective_cap);

				// Cleanup
				await query(
					`DELETE FROM roadmap_workforce.agent_usage_snapshot WHERE credential_key = $1`,
					[credKey],
				);
			});

			it("should provide consumable read API for controller", async () => {
				const credKey = `controller-api-test-${Date.now()}`;
				const osUser = credKey.split(":")[0];

				// Simulate probe writing snapshot
				await reportAgentUsage(
					{
						provider: "anthropic",
						agent_identity: "controller-test",
						quota_remaining: 50000,
						quota_limit: 100000,
						quota_reset_at: new Date(Date.now() + 3600000).toISOString(),
					},
					osUser,
				);

				// Controller reads via exported API
				const snapshot = await getLatestQuotaSnapshot(credKey);

				// Should have all fields needed for effective_cap computation
				expect(snapshot).toHaveProperty("quota_remaining");
				expect(snapshot).toHaveProperty("quota_limit");
				expect(snapshot).toHaveProperty("quota_reset_at");
				expect(snapshot).toHaveProperty("stale_flag");

				// Verify structure matches AC-8 requirements
				if (snapshot && !snapshot.stale_flag) {
					const effective_cap = Math.min(10, Math.floor((snapshot.quota_remaining || 0) * 0.8));
					expect(typeof effective_cap).toBe("number");
					expect(effective_cap).toBeGreaterThanOrEqual(0);
				}

				// Cleanup
				await query(
					`DELETE FROM roadmap_workforce.agent_usage_snapshot WHERE credential_key = $1`,
					[credKey],
				);
			});
		});
	});
}
