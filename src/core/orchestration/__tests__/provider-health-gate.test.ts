/**
 * P3795 AC-6: Integration tests for the provider health gate in offer-dispatch-handler.
 *
 * (a) HealthCache marks provider X as error → handleOfferDispatch called with
 *     an envelope pointing to provider X → no spawn occurs,
 *     fn_complete_work_offer called with 'failed'.
 *
 * (b) HealthCache marks provider X as ok → spawn proceeds normally.
 *
 * Uses vitest module mocking to inject controlled health gate responses
 * without a live DB or real provider.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { LiaisonMessage } from "../../../infra/agency/liaison-message-types.ts";
import type { SqlExec } from "../../../infra/agency/offer-dispatch-handler.ts";
import type { SpawnResult } from "../agent-spawner.ts";

// Mock the routing gate so we can inject health outcomes without a real cache.
vi.mock("../../../core/provider-health/routing-gate.ts", () => ({
	isProviderHealthyForDispatch: vi.fn(),
}));

// Mock liaison-message-service to avoid pre-existing duplicate-import parse error.
vi.mock("../../../infra/agency/liaison-message-service.ts", () => ({
	sendMessage: vi.fn().mockResolvedValue(undefined),
}));

// Mock the liaison-message-service dependency (messaging a2a-access-control).
vi.mock("../../../infra/messaging/a2a-access-control.js", () => ({
	agentNotifyChannel: vi.fn((id: string) => `msg_${id}`),
	checkA2AAccess: vi.fn().mockResolvedValue({ allowed: true }),
}));

import { isProviderHealthyForDispatch } from "../../provider-health/routing-gate.ts";
import { handleOfferDispatch } from "../../../infra/agency/offer-dispatch-handler.ts";

const mockGate = vi.mocked(isProviderHealthyForDispatch);

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

function makeEnvelope(override: Record<string, unknown> = {}): LiaisonMessage {
	return {
		message_id: "00000000-0000-0000-0000-p3795test0001",
		agency_id: "claude-bot-gary.a",
		sequence: 1n,
		direction: "orchestrator->liaison",
		kind: "offer_dispatch",
		correlation_id: "00000000-0000-0000-0000-p3795corr0001",
		payload: {
			offer_id: "00000000-0000-0000-0000-p3795offer001",
			role: "develop",
			required_capabilities: ["develop"],
			route_hint: "claude",
			dispatch_id: 79500,
			proposal_id: 3795,
			claim_token: "tok-p3795-test",
			lease_ttl_seconds: 60,
			...override,
		},
		signed_at: new Date().toISOString(),
		signature: "test-sig",
	};
}

function recordingExec(): { calls: Array<{ sql: string; params: unknown[] }>; exec: SqlExec } {
	const calls: Array<{ sql: string; params: unknown[] }> = [];
	const exec: SqlExec = async (sql, params) => {
		calls.push({ sql, params: params ?? [] });
		// Simulate preferred_provider lookup returning 'claude' so agencyProvider is set.
		if (sql.includes("preferred_provider") && sql.includes("agent_registry")) {
			return { rows: [{ preferred_provider: "claude" }] };
		}
		return { rows: [] };
	};
	return { calls, exec };
}

describe("P3795: provider health gate in offer-dispatch-handler", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("(a) unhealthy provider → no spawn, fn_complete_work_offer called with 'failed'", async () => {
		mockGate.mockResolvedValue({
			allowed: false,
			reason: "unhealthy",
			status: "error",
			checkedAt: Date.now() - 5_000,
		});

		const spawnCalls: unknown[] = [];
		const fakeSpawn = async (req: unknown): Promise<SpawnResult> => {
			spawnCalls.push(req);
			return { agentRunId: "should-not-run", worktree: "x", exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
		};

		const { calls, exec } = recordingExec();

		await handleOfferDispatch("claude-bot-gary.a", makeEnvelope(), {
			spawn: fakeSpawn as never,
			exec,
			logger: silentLogger,
			resolveWorktree: () => "test-worktree",
			renewalIntervalMs: 1_000_000,
		});

		// Wait for any fire-and-forget tails to flush
		await new Promise((r) => setTimeout(r, 100));

		expect(spawnCalls).toHaveLength(0);

		const completeCall = calls.find((c) => c.sql.includes("fn_complete_work_offer"));
		expect(completeCall).toBeDefined();
		// 2nd param is status='failed'
		expect(completeCall!.params).toContain("failed");

		const escalationCall = calls.find((c) =>
			c.sql.includes("escalation_log") && c.sql.includes("INSERT"),
		);
		expect(escalationCall).toBeDefined();
		expect(escalationCall!.params).toContain("PROVIDER_HEALTH_GATE");
	});

	it("(b) healthy provider → spawn proceeds (gate does not block)", async () => {
		mockGate.mockResolvedValue({
			allowed: true,
			reason: "healthy",
			status: "ok",
			checkedAt: Date.now(),
		});

		const spawnCalls: unknown[] = [];
		const fakeSpawn = async (req: unknown): Promise<SpawnResult> => {
			spawnCalls.push(req);
			return { agentRunId: "run-ok", worktree: "test-worktree", exitCode: 0, stdout: "ok", stderr: "", durationMs: 5 };
		};

		const { exec } = recordingExec();

		await handleOfferDispatch("claude-bot-gary.a", makeEnvelope(), {
			spawn: fakeSpawn as never,
			exec,
			logger: silentLogger,
			resolveWorktree: () => "test-worktree",
			renewalIntervalMs: 1_000_000,
		});

		await new Promise((r) => setTimeout(r, 100));

		expect(spawnCalls).toHaveLength(1);
	});
});
