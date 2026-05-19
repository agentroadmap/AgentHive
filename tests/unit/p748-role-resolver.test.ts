import { describe, it, expect, mock } from "bun:test";
import {
	getRolesForQueue,
	getRolesFor,
	type RoleProfile,
	type QueueKey,
} from "../../src/core/orchestration/role-resolver.ts";

describe("P748: Agent Role Resolver", () => {
	describe("getRolesForQueue", () => {
		it("returns DB rows when query returns data", async () => {
			const mockQueryFn = mock(async () => ({
				rows: [
					{
						id: 1,
						role: "architect",
						required_capabilities: ["design", "system-design"],
						allowed_route_providers: null,
						forbidden_route_providers: null,
						prompt_template: null,
						priority: 10,
					},
					{
						id: 2,
						role: "researcher",
						required_capabilities: ["research"],
						allowed_route_providers: null,
						forbidden_route_providers: null,
						prompt_template: null,
						priority: 20,
					},
				],
			}));

			const profiles = await getRolesForQueue(
				{
					workflowTemplateId: 14,
					stage: "DRAFT",
					maturity: "new",
					projectId: null,
				},
				mockQueryFn as any,
			);

			expect(profiles).toHaveLength(2);
			expect(profiles[0].role).toBe("architect");
			expect(profiles[1].role).toBe("researcher");
			expect(profiles[0].source).toBe("db");
			expect(profiles[1].source).toBe("db");
		});

		it("falls back to BUILTIN_FALLBACK when DB returns empty", async () => {
			const mockQueryFn = mock(async () => ({
				rows: [],
			}));

			const profiles = await getRolesForQueue(
				{
					workflowTemplateId: 14,
					stage: "DRAFT",
					maturity: "new",
					projectId: null,
				},
				mockQueryFn as any,
			);

			expect(profiles.length).toBeGreaterThan(0);
			expect(profiles[0].source).toBe("builtin-fallback");
		});

		it("falls back to BUILTIN_FALLBACK when DB throws", async () => {
			const mockQueryFn = mock(async () => {
				throw new Error("DB connection failed");
			});

			const profiles = await getRolesForQueue(
				{
					workflowTemplateId: 14,
					stage: "DRAFT",
					maturity: "new",
					projectId: null,
				},
				mockQueryFn as any,
			);

			expect(profiles.length).toBeGreaterThan(0);
			expect(profiles[0].source).toBe("builtin-fallback");
		});

		it("returns profiles ordered by priority ASC", async () => {
			const mockQueryFn = mock(async () => ({
				rows: [
					{
						id: 1,
						role: "skeptic-alpha",
						required_capabilities: ["review"],
						allowed_route_providers: null,
						forbidden_route_providers: null,
						prompt_template: null,
						priority: 10,
					},
					{
						id: 2,
						role: "reviewer-d2",
						required_capabilities: ["review"],
						allowed_route_providers: null,
						forbidden_route_providers: null,
						prompt_template: null,
						priority: 20,
					},
					{
						id: 3,
						role: "architect",
						required_capabilities: ["design"],
						allowed_route_providers: null,
						forbidden_route_providers: null,
						prompt_template: null,
						priority: 30,
					},
				],
			}));

			const profiles = await getRolesForQueue(
				{
					workflowTemplateId: 14,
					stage: "REVIEW",
					maturity: "mature",
					projectId: null,
				},
				mockQueryFn as any,
			);

			expect(profiles[0].role).toBe("skeptic-alpha");
			expect(profiles[1].role).toBe("reviewer-d2");
			expect(profiles[2].role).toBe("architect");
		});

		it("prefers project-scoped rows over global rows for same role", async () => {
			const mockQueryFn = mock(async () => ({
				rows: [
					{
						id: 100,
						role: "architect",
						required_capabilities: ["design", "system-design", "project-specific"],
						allowed_route_providers: ["project-ai"],
						forbidden_route_providers: null,
						prompt_template: { project: true },
						priority: 5, // lower priority = higher precedence
					},
					{
						id: 101,
						role: "researcher",
						required_capabilities: ["research"],
						allowed_route_providers: null,
						forbidden_route_providers: null,
						prompt_template: null,
						priority: 15,
					},
				],
			}));

			const profiles = await getRolesForQueue(
				{
					workflowTemplateId: 14,
					stage: "DRAFT",
					maturity: "new",
					projectId: 42,
				},
				mockQueryFn as any,
			);

			expect(profiles[0].role).toBe("architect");
			expect(profiles[0].requiredCapabilities).toContain("project-specific");
			expect(profiles[0].allowedRouteProviders).toContain("project-ai");
		});

		it("respects custom required_capabilities from DB", async () => {
			const mockQueryFn = mock(async () => ({
				rows: [
					{
						id: 1,
						role: "developer",
						required_capabilities: ["code", "testing", "custom-skill"],
						allowed_route_providers: null,
						forbidden_route_providers: null,
						prompt_template: null,
						priority: 10,
					},
				],
			}));

			const profiles = await getRolesForQueue(
				{
					workflowTemplateId: 14,
					stage: "DEVELOP",
					maturity: "new",
					projectId: null,
				},
				mockQueryFn as any,
			);

			expect(profiles[0].requiredCapabilities).toEqual([
				"code",
				"testing",
				"custom-skill",
			]);
		});
	});

	describe("getRolesFor alias", () => {
		it("returns same results as getRolesForQueue with converted params", async () => {
			const mockQueryFn = mock(async () => ({
				rows: [
					{
						id: 1,
						role: "architect",
						required_capabilities: ["design"],
						allowed_route_providers: null,
						forbidden_route_providers: null,
						prompt_template: null,
						priority: 10,
					},
				],
			}));

			const aliasResults = await getRolesFor(
				14,
				"DRAFT",
				"new",
				null,
				mockQueryFn as any,
			);

			const queueKeyResults = await getRolesForQueue(
				{
					workflowTemplateId: 14,
					stage: "DRAFT",
					maturity: "new",
					projectId: null,
				},
				mockQueryFn as any,
			);

			expect(aliasResults).toEqual(queueKeyResults);
		});

		it("accepts positional parameters without key object", async () => {
			const mockQueryFn = mock(async () => ({
				rows: [
					{
						id: 1,
						role: "developer",
						required_capabilities: ["code"],
						allowed_route_providers: null,
						forbidden_route_providers: null,
						prompt_template: null,
						priority: 10,
					},
				],
			}));

			const profiles = await getRolesFor(
				37, // Hotfix template
				"DEVELOP",
				"active",
				100, // project ID
				mockQueryFn as any,
			);

			expect(profiles[0].role).toBe("developer");
		});
	});

	describe("MERGE/mature gate reviewer", () => {
		it("returns reviewer-d4 as first role for MERGE/mature", async () => {
			const mockQueryFn = mock(async () => ({
				rows: [
					{
						id: 1,
						role: "reviewer-d4",
						required_capabilities: ["review", "gating"],
						allowed_route_providers: null,
						forbidden_route_providers: null,
						prompt_template: null,
						priority: 10,
					},
					{
						id: 2,
						role: "qa",
						required_capabilities: ["testing"],
						allowed_route_providers: null,
						forbidden_route_providers: null,
						prompt_template: null,
						priority: 20,
					},
					{
						id: 3,
						role: "maintainer",
						required_capabilities: ["devops"],
						allowed_route_providers: null,
						forbidden_route_providers: null,
						prompt_template: null,
						priority: 30,
					},
					{
						id: 4,
						role: "gate-agent",
						required_capabilities: ["gating"],
						allowed_route_providers: null,
						forbidden_route_providers: null,
						prompt_template: null,
						priority: 40,
					},
				],
			}));

			const profiles = await getRolesForQueue(
				{
					workflowTemplateId: 14,
					stage: "MERGE",
					maturity: "mature",
					projectId: null,
				},
				mockQueryFn as any,
			);

			expect(profiles[0].role).toBe("reviewer-d4");
		});
	});

	describe("Hotfix workflow (template_id=37)", () => {
		it("resolves roles for Hotfix DRAFT", async () => {
			const mockQueryFn = mock(async () => ({
				rows: [
					{
						id: 1,
						role: "researcher",
						required_capabilities: ["research"],
						allowed_route_providers: null,
						forbidden_route_providers: null,
						prompt_template: null,
						priority: 10,
					},
					{
						id: 2,
						role: "architect",
						required_capabilities: ["design"],
						allowed_route_providers: null,
						forbidden_route_providers: null,
						prompt_template: null,
						priority: 20,
					},
				],
			}));

			const profiles = await getRolesForQueue(
				{
					workflowTemplateId: 37,
					stage: "DRAFT",
					maturity: "new",
					projectId: null,
				},
				mockQueryFn as any,
			);

			expect(profiles).toHaveLength(2);
			expect(profiles[0].role).toBe("researcher");
			expect(profiles[1].role).toBe("architect");
		});

		it("resolves roles for Hotfix DEVELOP", async () => {
			const mockQueryFn = mock(async () => ({
				rows: [
					{
						id: 1,
						role: "developer",
						required_capabilities: ["code"],
						allowed_route_providers: null,
						forbidden_route_providers: null,
						prompt_template: null,
						priority: 10,
					},
					{
						id: 2,
						role: "engineer",
						required_capabilities: ["code", "devops"],
						allowed_route_providers: null,
						forbidden_route_providers: null,
						prompt_template: null,
						priority: 20,
					},
				],
			}));

			const profiles = await getRolesForQueue(
				{
					workflowTemplateId: 37,
					stage: "DEVELOP",
					maturity: "active",
					projectId: null,
				},
				mockQueryFn as any,
			);

			expect(profiles).toHaveLength(2);
			expect(profiles[0].role).toBe("developer");
			expect(profiles[1].role).toBe("engineer");
		});
	});
});
