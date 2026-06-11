/**
 * P1370 AC-6: Unit tests for liaison-context hydration.
 * Covers happy path, null fields, paused roles, peer filtering, and privacy guard.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
	hydrateLiaisonContext,
	clearContextCache,
	type LiaisonContext,
} from "../liaison-context.ts";
import { query } from "../../postgres/pool.ts";

// Mock the query function
vi.mock("../../postgres/pool.ts", () => ({
	query: vi.fn(),
}));

const mockQuery = query as ReturnType<typeof vi.fn>;

describe("liaison-context", () => {
	beforeEach(() => {
		clearContextCache();
		mockQuery.mockReset();
	});

	afterEach(() => {
		clearContextCache();
	});

	describe("AC-5: hydrateLiaisonContext()", () => {
		it("AC-6a: happy path with all sub-objects populated", async () => {
			// Mock v_liaison_context query (self-record)
			mockQuery.mockResolvedValueOnce({
				rows: [
					{
						agency_identity: "claude/agency-bot",
						agency_style: "orchestrator",
						llm_variant: "claude-opus-4",
						provider: "anthropic",
						host_id: "bot",
						project_id: 1,
						presence_state: "online",
						last_heartbeat_at: "2026-06-10T12:00:00Z",
						provider_cooldown_until: null,
						requests_remaining: 100,
						tokens_remaining: 50000,
						capacity_reset_at: "2026-06-11T00:00:00Z",
						throttle_action: "none",
						capacity_last_sampled_at: "2026-06-10T11:59:00Z",
						spent_today_usd: 15.75,
						spent_week_usd: 120.0,
						cumulative_usd: 2500.0,
						daily_cap_usd: 500.0,
						capabilities: ["building", "reviewing", "gating"],
						max_concurrent_claims: 3,
						active_claim_count: 1,
					},
				],
			});

			// Mock fetchPeers query
			mockQuery.mockResolvedValueOnce({
				rows: [
					{
						identity: "codex/agency-bot",
						agency_style: "executor",
						llm_variant: "codex-v1",
						online: true,
						headroom_pct: 75,
						active_claim_count: 2,
						capabilities: ["building"],
					},
				],
			});

			// Mock fetchPausedRoles query
			mockQuery.mockResolvedValueOnce({
				rows: [
					{
						proposal_id: 123,
						role: "architect",
						expires_at: "2026-06-11T00:00:00Z",
					},
				],
			});

			const result = await hydrateLiaisonContext("claude/agency-bot", 1);

			expect(result).not.toBeNull();
			expect(result!.agency_identity).toBe("claude/agency-bot");
			expect(result!.capacity.requests_remaining).toBe(100);
			expect(result!.spending.spent_today_usd).toBe(15.75);
			expect(result!.peers).toHaveLength(1);
			expect(result!.paused_proposal_roles).toHaveLength(1);
			expect(result!.last_hydrated_at).toBeGreaterThan(0);
		});

		it("AC-6b: null capacity when no agency_capacity row exists", async () => {
			mockQuery.mockResolvedValueOnce({
				rows: [
					{
						agency_identity: "claude/agency-bot",
						agency_style: "orchestrator",
						llm_variant: "claude-opus-4",
						provider: "anthropic",
						host_id: "bot",
						project_id: 1,
						presence_state: "online",
						last_heartbeat_at: "2026-06-10T12:00:00Z",
						provider_cooldown_until: null,
						requests_remaining: null, // NULL when no agency_capacity row
						tokens_remaining: null,
						capacity_reset_at: null,
						throttle_action: null,
						capacity_last_sampled_at: null,
						spent_today_usd: 0,
						spent_week_usd: 0,
						cumulative_usd: 0,
						daily_cap_usd: null,
						capabilities: [],
						max_concurrent_claims: 3,
						active_claim_count: 0,
					},
				],
			});

			mockQuery.mockResolvedValueOnce({ rows: [] }); // No peers
			mockQuery.mockResolvedValueOnce({ rows: [] }); // No paused roles

			const result = await hydrateLiaisonContext("claude/agency-bot", 1);

			expect(result!.capacity.requests_remaining).toBeNull();
			expect(result!.capacity.tokens_remaining).toBeNull();
			expect(result!.capacity.reset_at).toBeNull();
			expect(result!.capacity.throttle_action).toBe("unknown");
		});

		it("AC-6c: null daily_cap_usd when agent_budget_ledger is empty", async () => {
			mockQuery.mockResolvedValueOnce({
				rows: [
					{
						agency_identity: "claude/agency-bot",
						agency_style: "orchestrator",
						llm_variant: null,
						provider: "anthropic",
						host_id: "bot",
						project_id: 1,
						presence_state: "online",
						last_heartbeat_at: "2026-06-10T12:00:00Z",
						provider_cooldown_until: null,
						requests_remaining: 100,
						tokens_remaining: 50000,
						capacity_reset_at: "2026-06-11T00:00:00Z",
						throttle_action: "none",
						capacity_last_sampled_at: "2026-06-10T11:59:00Z",
						spent_today_usd: 0,
						spent_week_usd: 0,
						cumulative_usd: 0,
						daily_cap_usd: null, // NULL when no budget ledger entry
						capabilities: [],
						max_concurrent_claims: 3,
						active_claim_count: 0,
					},
				],
			});

			mockQuery.mockResolvedValueOnce({ rows: [] });
			mockQuery.mockResolvedValueOnce({ rows: [] });

			const result = await hydrateLiaisonContext("claude/agency-bot", 1);

			expect(result!.spending.daily_cap_usd).toBeNull();
			expect(result!.spending.spent_today_usd).toBe(0);
		});

		it("AC-6d: paused_proposal_roles populated correctly with expiry filter", async () => {
			mockQuery.mockResolvedValueOnce({
				rows: [
					{
						agency_identity: "claude/agency-bot",
						agency_style: "orchestrator",
						llm_variant: null,
						provider: "anthropic",
						host_id: "bot",
						project_id: 1,
						presence_state: "online",
						last_heartbeat_at: "2026-06-10T12:00:00Z",
						provider_cooldown_until: null,
						requests_remaining: 100,
						tokens_remaining: 50000,
						capacity_reset_at: "2026-06-11T00:00:00Z",
						throttle_action: "none",
						capacity_last_sampled_at: "2026-06-10T11:59:00Z",
						spent_today_usd: 0,
						spent_week_usd: 0,
						cumulative_usd: 0,
						daily_cap_usd: null,
						capabilities: [],
						max_concurrent_claims: 3,
						active_claim_count: 0,
					},
				],
			});

			mockQuery.mockResolvedValueOnce({ rows: [] }); // No peers

			// Mock paused roles with one active (expires_at > now) and implicit null-expires
			mockQuery.mockResolvedValueOnce({
				rows: [
					{
						proposal_id: 123,
						role: "architect",
						expires_at: "2026-06-11T12:00:00Z", // Future
					},
					{
						proposal_id: 456,
						role: "reviewer",
						expires_at: null, // Never expires
					},
				],
			});

			const result = await hydrateLiaisonContext("claude/agency-bot", 1);

			expect(result!.paused_proposal_roles).toHaveLength(2);
			expect(result!.paused_proposal_roles[0].proposal_id).toBe(123);
			expect(result!.paused_proposal_roles[1].expires_at).toBeNull();
		});

		it("AC-6e: peers query excludes self and filters by project_id", async () => {
			mockQuery.mockResolvedValueOnce({
				rows: [
					{
						agency_identity: "claude/agency-bot",
						agency_style: "orchestrator",
						llm_variant: null,
						provider: "anthropic",
						host_id: "bot",
						project_id: 1,
						presence_state: "online",
						last_heartbeat_at: "2026-06-10T12:00:00Z",
						provider_cooldown_until: null,
						requests_remaining: 100,
						tokens_remaining: 50000,
						capacity_reset_at: "2026-06-11T00:00:00Z",
						throttle_action: "none",
						capacity_last_sampled_at: "2026-06-10T11:59:00Z",
						spent_today_usd: 0,
						spent_week_usd: 0,
						cumulative_usd: 0,
						daily_cap_usd: null,
						capabilities: [],
						max_concurrent_claims: 3,
						active_claim_count: 0,
					},
				],
			});

			// Peers query should exclude "claude/agency-bot" and filter to project_id=1
			mockQuery.mockResolvedValueOnce({
				rows: [
					{
						identity: "codex/agency-bot",
						agency_style: "executor",
						llm_variant: null,
						online: true,
						headroom_pct: 50,
						active_claim_count: 1,
						capabilities: ["building"],
					},
				],
			});

			mockQuery.mockResolvedValueOnce({ rows: [] });

			const result = await hydrateLiaisonContext("claude/agency-bot", 1);

			expect(result!.peers).toHaveLength(1);
			expect(result!.peers[0].identity).toBe("codex/agency-bot");

			// Verify the peers query was called with correct params
			expect(mockQuery).toHaveBeenNthCalledWith(2, expect.stringContaining("WHERE ar.project_id = $1 AND ar.agent_identity <> $2"), [1, "claude/agency-bot"]);
		});

		it("AC-6f: peers projection contains NO spending/credential columns", async () => {
			mockQuery.mockResolvedValueOnce({
				rows: [
					{
						agency_identity: "claude/agency-bot",
						agency_style: "orchestrator",
						llm_variant: null,
						provider: "anthropic",
						host_id: "bot",
						project_id: 1,
						presence_state: "online",
						last_heartbeat_at: "2026-06-10T12:00:00Z",
						provider_cooldown_until: null,
						requests_remaining: 100,
						tokens_remaining: 50000,
						capacity_reset_at: "2026-06-11T00:00:00Z",
						throttle_action: "none",
						capacity_last_sampled_at: "2026-06-10T11:59:00Z",
						spent_today_usd: 0,
						spent_week_usd: 0,
						cumulative_usd: 0,
						daily_cap_usd: null,
						capabilities: [],
						max_concurrent_claims: 3,
						active_claim_count: 0,
					},
				],
			});

			mockQuery.mockResolvedValueOnce({
				rows: [
					{
						identity: "codex/agency-bot",
						agency_style: "executor",
						llm_variant: null,
						online: true,
						headroom_pct: 50,
						active_claim_count: 1,
						capabilities: ["building"],
					},
				],
			});

			mockQuery.mockResolvedValueOnce({ rows: [] });

			const result = await hydrateLiaisonContext("claude/agency-bot", 1);

			const peer = result!.peers[0];
			const peerKeys = Object.keys(peer);

			// AC-6f: Verify no spending/credential columns present
			expect(peerKeys).not.toContain("cost_usd");
			expect(peerKeys).not.toContain("daily_cap_usd");
			expect(peerKeys).not.toContain("cumulative_usd");
			expect(peerKeys).not.toContain("spent_today_usd");
			expect(peerKeys).not.toContain("spent_week_usd");

			// Verify safe columns are present
			expect(peerKeys).toContain("identity");
			expect(peerKeys).toContain("agency_style");
			expect(peerKeys).toContain("online");
			expect(peerKeys).toContain("headroom_pct");
			expect(peerKeys).toContain("active_claim_count");
			expect(peerKeys).toContain("capabilities");
		});

		it("returns null when no agency found in v_liaison_context", async () => {
			mockQuery.mockResolvedValueOnce({ rows: [] }); // Empty result

			const result = await hydrateLiaisonContext("nonexistent/agency", 1);

			expect(result).toBeNull();
		});

		it("returns null and logs on query error", async () => {
			mockQuery.mockRejectedValueOnce(new Error("DB connection failed"));

			const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			const result = await hydrateLiaisonContext("claude/agency-bot", 1);

			expect(result).toBeNull();
			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining("[liaison-context] hydrate failed"),
				"DB connection failed",
			);

			consoleErrorSpy.mockRestore();
		});
	});
});
