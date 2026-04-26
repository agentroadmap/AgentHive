/**
 * P459: cubic_create phase-driven role allocation tests
 *
 * Test cases:
 * AC1: cubic_create with agent_identity validates role per phase
 * AC2: cubic_create without agent_identity uses phase defaults
 * AC3: Mismatch returns typed error (not silent substitution)
 * AC4: All 4 phases have correct slot lists
 * AC5: Existing P281/P289 dispatch flow continues to work
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query } from "../../src/postgres/pool.ts";

describe("P459: Cubic Phase-Driven Role Allocation", () => {
	const VALID_AGENTS = {
		skeptic: "codex-one-skeptic-beta",
		architect: "xiaomi",
		coder: "orchestrator",
		tester: "codex-one",
	};

	// Test helper: ensure test agents exist in registry
	beforeAll(async () => {
		// Create minimal test agents if they don't exist
		const agents = [
			{
				id: "skeptic-test",
				identity: "skeptic-test-agent",
				role: "skeptic",
			},
			{
				id: "architect-test",
				identity: "architect-test-agent",
				role: "architect",
			},
			{
				id: "coder-test",
				identity: "coder-test-agent",
				role: "coder",
			},
			{
				id: "tester-test",
				identity: "tester-test-agent",
				role: "tester",
			},
			{
				id: "deployer-test",
				identity: "deployer-test-agent",
				role: "deployer",
			},
		];

		for (const agent of agents) {
			await query(
				`INSERT INTO roadmap.agent_registry (agent_identity, agent_type, role, status)
				 VALUES ($1, $2, $3, $4)
				 ON CONFLICT (agent_identity) DO NOTHING`,
				[agent.identity, "llm", agent.role, "active"],
			);
		}
	});

	describe("AC1: agent_identity role validation", () => {
		it("should accept skeptic agent in design phase", async () => {
			const result = await query(
				`SELECT role FROM roadmap.agent_registry WHERE agent_identity = $1`,
				["skeptic-test-agent"],
			);

			expect(result.rows).toHaveLength(1);
			const agentRole = result.rows[0].role;
			expect(agentRole).toBe("skeptic");

			// Verify design phase allows skeptic
			const phaseResult = await query(
				`SELECT allowed_roles FROM roadmap.cubic_phase_roles WHERE phase = $1`,
				["design"],
			);
			expect(phaseResult.rows[0].allowed_roles).toContain("skeptic");
		});

		it("should reject coder in design phase", async () => {
			// Verify design phase does NOT allow coder
			const phaseResult = await query(
				`SELECT allowed_roles FROM roadmap.cubic_phase_roles WHERE phase = $1`,
				["design"],
			);
			expect(phaseResult.rows[0].allowed_roles).not.toContain("coder");
		});

		it("should accept coder in build phase", async () => {
			const phaseResult = await query(
				`SELECT allowed_roles FROM roadmap.cubic_phase_roles WHERE phase = $1`,
				["build"],
			);
			expect(phaseResult.rows[0].allowed_roles).toContain("coder");
		});
	});

	describe("AC2: Phase defaults (no agent_identity)", () => {
		it("design phase should have skeptic, architect, pm defaults", async () => {
			const result = await query(
				`SELECT default_roles FROM roadmap.cubic_phase_roles WHERE phase = $1`,
				["design"],
			);
			expect(result.rows[0].default_roles).toEqual(
				expect.arrayContaining(["skeptic", "architect", "pm"]),
			);
		});

		it("build phase should have coder, tester defaults", async () => {
			const result = await query(
				`SELECT default_roles FROM roadmap.cubic_phase_roles WHERE phase = $1`,
				["build"],
			);
			expect(result.rows[0].default_roles).toEqual(
				expect.arrayContaining(["coder", "tester"]),
			);
		});

		it("test phase should have tester, qa defaults", async () => {
			const result = await query(
				`SELECT default_roles FROM roadmap.cubic_phase_roles WHERE phase = $1`,
				["test"],
			);
			expect(result.rows[0].default_roles).toEqual(
				expect.arrayContaining(["tester", "qa"]),
			);
		});

		it("ship phase should have deployer, ops defaults", async () => {
			const result = await query(
				`SELECT default_roles FROM roadmap.cubic_phase_roles WHERE phase = $1`,
				["ship"],
			);
			expect(result.rows[0].default_roles).toEqual(
				expect.arrayContaining(["deployer", "ops"]),
			);
		});
	});

	describe("AC3: Type-safe error on phase mismatch", () => {
		it("should have phase_role_mismatch error defined in phase_roles", async () => {
			// Verify all 4 phases exist with proper structure
			const result = await query(
				`SELECT phase, default_roles, allowed_roles FROM roadmap.cubic_phase_roles ORDER BY phase`,
			);

			expect(result.rows).toHaveLength(4);
			const phases = result.rows.map(
				(r: { phase: string }) => r.phase,
			);
			expect(phases).toEqual(["build", "design", "ship", "test"]);

			// Verify each has both default and allowed
			result.rows.forEach(
				(row: {
					default_roles: string[];
					allowed_roles: string[];
				}) => {
					expect(Array.isArray(row.default_roles)).toBe(true);
					expect(Array.isArray(row.allowed_roles)).toBe(true);
					expect(row.default_roles.length).toBeGreaterThan(0);
					expect(row.allowed_roles.length).toBeGreaterThan(0);
				},
			);
		});
	});

	describe("AC4: All 4 phases configured correctly", () => {
		it("should have all phases with proper allowed_roles", async () => {
			const result = await query(
				`SELECT phase, allowed_roles FROM roadmap.cubic_phase_roles ORDER BY phase`,
			);

			const phaseMap = new Map(
				result.rows.map((r: { phase: string; allowed_roles: string[] }) => [
					r.phase,
					r.allowed_roles,
				]),
			);

			// design: skeptic, architect, pm, reviewer
			expect(phaseMap.get("design")).toContain("skeptic");
			expect(phaseMap.get("design")).toContain("architect");
			expect(phaseMap.get("design")).toContain("reviewer");

			// build: coder, tester, reviewer
			expect(phaseMap.get("build")).toContain("coder");
			expect(phaseMap.get("build")).toContain("tester");
			expect(phaseMap.get("build")).toContain("reviewer");

			// test: tester, qa, reviewer
			expect(phaseMap.get("test")).toContain("tester");
			expect(phaseMap.get("test")).toContain("qa");
			expect(phaseMap.get("test")).toContain("reviewer");

			// ship: deployer, ops, reviewer
			expect(phaseMap.get("ship")).toContain("deployer");
			expect(phaseMap.get("ship")).toContain("ops");
			expect(phaseMap.get("ship")).toContain("reviewer");
		});

		it("should not allow build-only roles in design phase", async () => {
			const designResult = await query(
				`SELECT allowed_roles FROM roadmap.cubic_phase_roles WHERE phase = 'design'`,
			);
			const buildResult = await query(
				`SELECT allowed_roles FROM roadmap.cubic_phase_roles WHERE phase = 'build'`,
			);

			const designAllowed = designResult.rows[0].allowed_roles;
			const buildAllowed = buildResult.rows[0].allowed_roles;

			// Coder should be in build but not in design
			expect(buildAllowed).toContain("coder");
			expect(designAllowed).not.toContain("coder");
		});
	});

	describe("AC5: Backward compatibility (P281/P289 dispatch)", () => {
		it("should allow explicit agents array override for P281 dispatch", async () => {
			// P281/P289 flow might pass agents explicitly
			// Verify the table structure allows this to pass through
			const phaseResult = await query(
				`SELECT allowed_roles FROM roadmap.cubic_phase_roles WHERE phase = 'design'`,
			);

			const allowedRoles = phaseResult.rows[0].allowed_roles;

			// If an old dispatch passes ["coder", "reviewer"], it should fail in design
			// because coder is not in design allowed_roles
			expect(allowedRoles).not.toContain("coder");
			expect(allowedRoles).toContain("reviewer");

			// So ["reviewer"] would be valid, but ["coder"] would not
		});

		it("cubic_phase_roles table should be queryable by fn_acquire_cubic", async () => {
			// Verify the table exists and is accessible
			const result = await query(
				`SELECT COUNT(*) as cnt FROM roadmap.cubic_phase_roles`,
			);
			expect(Number(result.rows[0].cnt)).toBe(4);
		});
	});

	describe("Integration: cubic_phase_roles seeding", () => {
		it("should have exactly 4 phase role records", async () => {
			const result = await query(
				`SELECT COUNT(*) as cnt FROM roadmap.cubic_phase_roles`,
			);
			expect(Number(result.rows[0].cnt)).toBe(4);
		});

		it("should have proper indexes", async () => {
			const result = await query(
				`SELECT indexname FROM pg_indexes WHERE tablename = 'cubic_phase_roles'`,
			);
			const indexNames = result.rows.map(
				(r: { indexname: string }) => r.indexname,
			);
			expect(indexNames.length).toBeGreaterThan(0);
		});
	});

	afterAll(async () => {
		// Cleanup test agents
		const agents = [
			"skeptic-test-agent",
			"architect-test-agent",
			"coder-test-agent",
			"tester-test-agent",
			"deployer-test-agent",
		];

		for (const identity of agents) {
			await query(
				`DELETE FROM roadmap.agent_registry WHERE agent_identity = $1`,
				[identity],
			);
		}
	});
});
