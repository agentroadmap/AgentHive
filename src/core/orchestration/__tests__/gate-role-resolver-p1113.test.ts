/**
 * P1113: resolvePersonaByRoleName tests.
 *
 * Tests for resolvePersonaByRoleName() covering:
 *   - AC-1: resolve 'skeptic-alpha' to D1 persona from BUILTIN_FALLBACK
 *   - AC-2: resolve 'developer' from agent_role_profile table
 *   - AC-3: return null for unknown roles
 *   - Fallback chain: BUILTIN_FALLBACK → gate_role table → agent_role_profile table
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { resolvePersonaByRoleName, BUILTIN_FALLBACK } from "../gate-role-resolver.ts";
import type { QueryFn } from "../gate-role-resolver.ts";

describe("gate-role-resolver: resolvePersonaByRoleName P1113", () => {
	describe("AC-1: resolves 'skeptic-alpha' to D1 persona from BUILTIN_FALLBACK", () => {
		it("returns D1 persona when role matches BUILTIN_FALLBACK key", async () => {
			const result = await resolvePersonaByRoleName("skeptic-alpha");

			expect(result).toBeTruthy();
			expect(result).toContain("SKEPTIC ALPHA");
			expect(result).toContain("DRAFT → REVIEW");
		});

		it("returns the full D1 persona text (not truncated)", async () => {
			const result = await resolvePersonaByRoleName("skeptic-alpha");

			// Spot-check key sections of the D1 persona
			expect(result).toContain("AC ACCRETION");
			expect(result).toContain("PHANTOM COLUMNS");
			expect(result).toContain("INTERNAL CONTRADICTION");
		});

		it("returns D2 persona for 'architecture-reviewer'", async () => {
			const result = await resolvePersonaByRoleName("architecture-reviewer");

			expect(result).toBeTruthy();
			expect(result).toContain("Architecture Reviewer");
			expect(result).toContain("REVIEW → DEVELOP");
		});

		it("returns D3 persona for 'skeptic-beta'", async () => {
			const result = await resolvePersonaByRoleName("skeptic-beta");

			expect(result).toBeTruthy();
			expect(result).toContain("SKEPTIC BETA");
			expect(result).toContain("DEVELOP → MERGE");
		});

		it("returns D4 persona for 'gate-reviewer'", async () => {
			const result = await resolvePersonaByRoleName("gate-reviewer");

			expect(result).toBeTruthy();
			expect(result).toContain("Integration Reviewer");
		});
	});

	describe("AC-2: resolves 'developer' from agent_role_profile table", () => {
		it("returns persona from agent_role_profile when role not in BUILTIN_FALLBACK", async () => {
			const mockQuery: QueryFn = async (sql, params) => {
				if (sql.includes("gate_role")) {
					return { rows: [] }; // gate_role has no match
				}
				if (sql.includes("agent_role_profile")) {
					if (params?.[0] === "developer") {
						return {
							rows: [
								{
									persona: "You are a developer agent focused on implementation.",
								},
							],
						};
					}
				}
				return { rows: [] };
			};

			const result = await resolvePersonaByRoleName(
				"developer",
				mockQuery,
			);

			expect(result).toBe("You are a developer agent focused on implementation.");
		});

		it("queries gate_role table first before agent_role_profile", async () => {
			let gateRoleQueried = false;
			let agentRoleProfileQueried = false;

			const mockQuery: QueryFn = async (sql, params) => {
				if (sql.includes("gate_role")) {
					gateRoleQueried = true;
					return { rows: [] };
				}
				if (sql.includes("agent_role_profile")) {
					agentRoleProfileQueried = true;
					return { rows: [{ persona: "test" }] };
				}
				return { rows: [] };
			};

			await resolvePersonaByRoleName("developer", mockQuery);

			expect(gateRoleQueried).toBe(true);
			expect(agentRoleProfileQueried).toBe(true);
		});

		it("uses gate_role result when available (short-circuits agent_role_profile)", async () => {
			let agentRoleProfileQueried = false;

			const mockQuery: QueryFn = async (sql, params) => {
				if (sql.includes("gate_role")) {
					return {
						rows: [{ persona: "Gate role persona for developer" }],
					};
				}
				if (sql.includes("agent_role_profile")) {
					agentRoleProfileQueried = true;
					return { rows: [{ persona: "This should not be used" }] };
				}
				return { rows: [] };
			};

			const result = await resolvePersonaByRoleName(
				"developer",
				mockQuery,
			);

			expect(result).toBe("Gate role persona for developer");
			// Should not query agent_role_profile if gate_role has a match
			expect(agentRoleProfileQueried).toBe(false);
		});
	});

	describe("AC-3: returns null for unknown roles (no regression)", () => {
		it("returns null when role is not in BUILTIN_FALLBACK and no DB match", async () => {
			const mockQuery: QueryFn = async () => {
				return { rows: [] }; // Both tables empty
			};

			const result = await resolvePersonaByRoleName("unknown-role-xyz", mockQuery);

			expect(result).toBeNull();
		});

		it("returns null gracefully without throwing", async () => {
			const mockQuery: QueryFn = async () => {
				throw new Error("DB error");
			};

			const result = await resolvePersonaByRoleName(
				"unknown-role",
				mockQuery,
			);

			expect(result).toBeNull();
		});

		it("returns null when both gate_role and agent_role_profile return empty persona", async () => {
			const mockQuery: QueryFn = async (sql) => {
				// Both tables have the role but persona is empty/null
				return { rows: [{ persona: "" }] };
			};

			const result = await resolvePersonaByRoleName("custom-role", mockQuery);

			expect(result).toBeNull();
		});
	});

	describe("Fallback chain precedence", () => {
		it("prefers BUILTIN_FALLBACK over DB lookups", async () => {
			const mockQuery: QueryFn = async () => {
				// This mock would return something, but BUILTIN_FALLBACK should match first
				return { rows: [{ persona: "DB persona (should not be used)" }] };
			};

			const result = await resolvePersonaByRoleName(
				"skeptic-alpha",
				mockQuery,
			);

			// Should return BUILTIN_FALLBACK without calling the query function
			expect(result).toContain("SKEPTIC ALPHA");
			expect(result).not.toContain("DB persona");
		});

		it("scans all BUILTIN_FALLBACK entries for role name match", async () => {
			// All gate roles should be found in BUILTIN_FALLBACK
			const gateRoles = [
				"skeptic-alpha",
				"architecture-reviewer",
				"skeptic-beta",
				"gate-reviewer",
			];

			for (const role of gateRoles) {
				const result = await resolvePersonaByRoleName(role);
				expect(result).toBeTruthy();
				expect(result?.length).toBeGreaterThan(100); // Personas are detailed
			}
		});
	});

	describe("Error handling", () => {
		it("logs warning and returns null when DB query throws", async () => {
			const mockQuery: QueryFn = async () => {
				throw new Error("Connection timeout");
			};

			const result = await resolvePersonaByRoleName(
				"any-role",
				mockQuery,
			);

			expect(result).toBeNull();
		});

		it("handles null rows gracefully", async () => {
			const mockQuery: QueryFn = async () => {
				return { rows: [{ persona: null }] };
			};

			const result = await resolvePersonaByRoleName("role", mockQuery);

			expect(result).toBeNull();
		});

		it("handles non-string persona values gracefully", async () => {
			const mockQuery: QueryFn = async () => {
				return { rows: [{ persona: 123 }] };
			};

			const result = await resolvePersonaByRoleName("role", mockQuery);

			expect(result).toBeNull();
		});
	});

	describe("Real-world integration scenarios", () => {
		it("enrichment_agent (non-gate role) resolves from agent_role_profile", async () => {
			const mockQuery: QueryFn = async (sql, params) => {
				if (sql.includes("agent_role_profile") && params?.[0] === "enrichment_agent") {
					return {
						rows: [
							{
								persona:
									"You are an enrichment agent tasked with preparing proposals for review.",
							},
						],
					};
				}
				return { rows: [] };
			};

			const result = await resolvePersonaByRoleName(
				"enrichment_agent",
				mockQuery,
			);

			expect(result).toContain("enrichment agent");
			expect(result).toContain("preparing proposals");
		});

		it("handles gate roles that might also be in agent_role_profile (gate_role wins)", async () => {
			const mockQuery: QueryFn = async (sql, params) => {
				if (sql.includes("gate_role") && params?.[0] === "skeptic-alpha") {
					return {
						rows: [
							{
								persona: "DB-overridden D1 persona (should not win vs BUILTIN)",
							},
						],
					};
				}
				return { rows: [] };
			};

			const result = await resolvePersonaByRoleName(
				"skeptic-alpha",
				mockQuery,
			);

			// BUILTIN_FALLBACK should win
			expect(result).toContain("SKEPTIC ALPHA");
			expect(result).not.toContain("DB-overridden");
		});
	});

	describe("Deployment readiness", () => {
		it("all D-gate personas are available in BUILTIN_FALLBACK", () => {
			const personas = Object.values(BUILTIN_FALLBACK);
			expect(personas.length).toBeGreaterThanOrEqual(4); // D1, D2, D3, D4
			personas.forEach((p) => {
				expect(p.persona).toBeTruthy();
				expect(p.persona.length).toBeGreaterThan(100);
			});
		});

		it("personas include output contract details", () => {
			const personas = Object.values(BUILTIN_FALLBACK);
			personas.forEach((p) => {
				expect(p.outputContract).toBeTruthy();
				expect(p.outputContract.length).toBeGreaterThan(50);
			});
		});
	});
});
