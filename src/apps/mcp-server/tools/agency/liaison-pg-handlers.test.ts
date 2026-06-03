/**
 * P917: Unit tests for liaison-pg-handlers.ts
 *
 * Mocks both the liaison-service and the postgres pool so no DB is needed.
 * Tests cover: success paths, not-found errors, idempotent leave, and list.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock liaison-service ──────────────────────────────────────────────────
vi.mock("../../../../infra/agency/liaison-service.js", () => ({
	liaisonRegister: vi.fn(),
	getAgencyStatus: vi.fn(),
	listDispatchableAgencies: vi.fn(),
}));

// ── Mock postgres pool ────────────────────────────────────────────────────
vi.mock("../../../../infra/postgres/pool.js", () => ({
	query: vi.fn(),
}));

import * as liaisonService from "../../../../infra/agency/liaison-service.js";
import * as pool from "../../../../infra/postgres/pool.js";
import {
	handleAgencyBootstrap,
	handleAgencyJoinProject,
	handleAgencyLeaveProject,
	handleAgencyLiaisonStatus,
} from "./liaison-pg-handlers.js";

const mockQuery = pool.query as ReturnType<typeof vi.fn>;
const mockRegister = liaisonService.liaisonRegister as ReturnType<typeof vi.fn>;
const mockGetStatus = liaisonService.getAgencyStatus as ReturnType<typeof vi.fn>;
const mockListDispatchable = liaisonService.listDispatchableAgencies as ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// agency_bootstrap
// ---------------------------------------------------------------------------
describe("handleAgencyBootstrap", () => {
	it("returns session_id on success", async () => {
		mockRegister.mockResolvedValue({
			session_id: "sess-123",
			agency_id: "claude/test-agent",
			status: "active",
		});

		const result = await handleAgencyBootstrap({
			agency_id: "claude/test-agent",
			display_name: "Test Agent",
			provider: "claude",
			host_id: "bot",
		});

		expect(result.isError).toBeFalsy();
		const payload = JSON.parse(result.content[0].text);
		expect(payload.session_id).toBe("sess-123");
		expect(payload.status).toBe("active");
	});

	it("returns error result on liaisonRegister failure", async () => {
		mockRegister.mockRejectedValue(new Error("DB unavailable"));

		const result = await handleAgencyBootstrap({
			agency_id: "claude/bad-agent",
			display_name: "Bad",
			provider: "claude",
			host_id: "bot",
		});

		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content[0].text);
		expect(payload.error).toBe("bootstrap_failed");
		expect(payload.message).toContain("DB unavailable");
	});
});

// ---------------------------------------------------------------------------
// agency_join_project
// ---------------------------------------------------------------------------
describe("handleAgencyJoinProject", () => {
	it("joins successfully when agency and project exist", async () => {
		// agency exists
		mockQuery
			.mockResolvedValueOnce({ rows: [{ agency_id: "claude/agent-a" }] })
			// project exists
			.mockResolvedValueOnce({ rows: [{ id: "42" }] })
			// fn_offer_provider_heartbeat (VOID)
			.mockResolvedValueOnce({ rows: [], rowCount: 0 });

		const result = await handleAgencyJoinProject({
			agency_id: "claude/agent-a",
			project_slug: "agenthive",
		});

		expect(result.isError).toBeFalsy();
		const payload = JSON.parse(result.content[0].text);
		expect(payload.joined).toBe(true);
		expect(payload.project_id).toBe("42");
	});

	it("returns agency_not_found when agency row missing", async () => {
		mockQuery.mockResolvedValueOnce({ rows: [] });

		const result = await handleAgencyJoinProject({
			agency_id: "claude/ghost",
			project_slug: "agenthive",
		});

		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content[0].text);
		expect(payload.error).toBe("agency_not_found");
	});

	it("returns project_not_found when project row missing", async () => {
		mockQuery
			.mockResolvedValueOnce({ rows: [{ agency_id: "claude/agent-a" }] })
			.mockResolvedValueOnce({ rows: [] });

		const result = await handleAgencyJoinProject({
			agency_id: "claude/agent-a",
			project_slug: "no-such-project",
		});

		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content[0].text);
		expect(payload.error).toBe("project_not_found");
	});
});

// ---------------------------------------------------------------------------
// agency_leave_project
// ---------------------------------------------------------------------------
describe("handleAgencyLeaveProject", () => {
	it("returns removed=true when a row was updated", async () => {
		mockQuery.mockResolvedValueOnce({
			rows: [{ agency_identity: "claude/agent-a" }],
			rowCount: 1,
		});

		const result = await handleAgencyLeaveProject({
			agency_id: "claude/agent-a",
			project_slug: "agenthive",
		});

		expect(result.isError).toBeFalsy();
		const payload = JSON.parse(result.content[0].text);
		expect(payload.removed).toBe(true);
	});

	it("returns removed=false when already paused (no-op)", async () => {
		mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

		const result = await handleAgencyLeaveProject({
			agency_id: "claude/agent-a",
			project_slug: "agenthive",
		});

		expect(result.isError).toBeFalsy();
		const payload = JSON.parse(result.content[0].text);
		expect(payload.removed).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// agency_liaison_status
// ---------------------------------------------------------------------------
describe("handleAgencyLiaisonStatus", () => {
	it("returns single agency status when agency_id provided", async () => {
		mockGetStatus.mockResolvedValue({
			agency_id: "claude/agent-a",
			display_name: "Agent A",
			status: "active",
			silence_seconds: 10,
			dispatchable: true,
		});

		const result = await handleAgencyLiaisonStatus({ agency_id: "claude/agent-a" });

		expect(result.isError).toBeFalsy();
		const payload = JSON.parse(result.content[0].text);
		expect(payload.dispatchable).toBe(true);
	});

	it("returns agency_not_found when getAgencyStatus returns null", async () => {
		mockGetStatus.mockResolvedValue(null);

		const result = await handleAgencyLiaisonStatus({ agency_id: "claude/ghost" });

		expect(result.isError).toBe(true);
		const payload = JSON.parse(result.content[0].text);
		expect(payload.error).toBe("agency_not_found");
	});

	it("returns dispatchable list when agency_id omitted", async () => {
		mockListDispatchable.mockResolvedValue([
			{ agency_id: "claude/a", display_name: "A", provider: "claude", status: "active" },
		]);

		const result = await handleAgencyLiaisonStatus({});

		expect(result.isError).toBeFalsy();
		const payload = JSON.parse(result.content[0].text);
		expect(Array.isArray(payload.dispatchable)).toBe(true);
		expect(payload.dispatchable).toHaveLength(1);
	});
});
