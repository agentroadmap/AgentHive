/**
 * P1113: Role-based persona injection tests.
 *
 * Tests for buildTaskPrompt() AC-7 (P1113) covering:
 *   - AC-9: buildTaskPrompt signature accepts optional RoleProfile 4th param
 *   - AC-10: task_prompt from profile.promptTemplate is prepended
 *   - AC-12: Falls back gracefully when profile has null promptTemplate
 *   - Template variable resolution: {display_id}, {proposal_id}, {status}, {stage}
 */

import { describe, it, expect } from "bun:test";
import type { RoleProfile } from "../role-resolver.ts";
import type { ProposalDetail } from "../readiness-resolver.ts";
import {
	buildTaskPrompt,
	assessReadiness,
} from "../readiness-resolver.ts";

/**
 * Factory for test proposal details.
 */
function makeProposalDetail(overrides: Partial<ProposalDetail> = {}): ProposalDetail {
	return {
		id: 1234,
		displayId: "P1234",
		status: "DRAFT",
		maturity: "new",
		title: "Test Proposal",
		priority: "medium",
		summary: "A test proposal",
		design: "Test design",
		alternatives: null,
		drawbacks: null,
		dependency: null,
		unresolvedDependencies: 0,
		totalAcceptanceCriteria: 3,
		blockingAcceptanceCriteria: 0,
		passedAcceptanceCriteria: 0,
		latestDecision: null,
		...overrides,
	};
}

/**
 * Factory for test role profiles.
 */
function makeRoleProfile(overrides: Partial<RoleProfile> = {}): RoleProfile {
	return {
		id: 1,
		role: "test-role",
		requiredCapabilities: [],
		allowedRouteProviders: null,
		forbiddenRouteProviders: null,
		promptTemplate: null,
		priority: 10,
		source: "db",
		...overrides,
	};
}

describe("readiness-resolver: buildTaskPrompt P1113 integration", () => {
	describe("AC-9: signature accepts optional RoleProfile", () => {
		it("buildTaskPrompt(detail, mode, reasons) works without profile", () => {
			const detail = makeProposalDetail({ status: "DRAFT" });
			const result = buildTaskPrompt(detail, "prep", []);
			expect(result).toContain("You are the preparation agent");
		});

		it("buildTaskPrompt(detail, mode, reasons, null) works with explicit null", () => {
			const detail = makeProposalDetail({ status: "DRAFT" });
			const result = buildTaskPrompt(detail, "prep", [], null);
			expect(result).toContain("You are the preparation agent");
		});

		it("buildTaskPrompt(detail, mode, reasons, undefined) works with undefined", () => {
			const detail = makeProposalDetail({ status: "DRAFT" });
			const result = buildTaskPrompt(detail, "prep", [], undefined);
			expect(result).toContain("You are the preparation agent");
		});

		it("buildTaskPrompt(detail, mode, reasons, profile) works with profile", () => {
			const detail = makeProposalDetail({ status: "DRAFT" });
			const profile = makeRoleProfile({
				promptTemplate: { task_prompt: "Test task prompt" },
			});
			const result = buildTaskPrompt(detail, "prep", [], profile);
			expect(result).toContain("Test task prompt");
		});
	});

	describe("AC-10: task_prompt from profile is prepended", () => {
		it("prepends role-specific task_prompt to generic prompt", () => {
			const detail = makeProposalDetail({
				displayId: "P1234",
				id: 1234,
				status: "DRAFT",
			});
			const profile = makeRoleProfile({
				promptTemplate: {
					task_prompt: "You are the enrichment agent for {display_id}.",
				},
			});

			const result = buildTaskPrompt(detail, "prep", [], profile);

			// Role-specific prompt should appear first
			expect(result.indexOf("You are the enrichment agent")).toBeLessThan(
				result.indexOf("You are the preparation agent"),
			);
			// Should be separated by blank line
			expect(result).toContain("You are the enrichment agent for P1234.\n\nYou are the preparation agent");
		});

		it("resolves template variable {display_id}", () => {
			const detail = makeProposalDetail({ displayId: "P9999" });
			const profile = makeRoleProfile({
				promptTemplate: {
					task_prompt: "Working on {display_id}",
				},
			});

			const result = buildTaskPrompt(detail, "prep", [], profile);
			expect(result).toContain("Working on P9999");
			expect(result).not.toContain("{display_id}");
		});

		it("resolves template variable {proposal_id}", () => {
			const detail = makeProposalDetail({ id: 5678 });
			const profile = makeRoleProfile({
				promptTemplate: {
					task_prompt: "Proposal ID is {proposal_id}",
				},
			});

			const result = buildTaskPrompt(detail, "prep", [], profile);
			expect(result).toContain("Proposal ID is 5678");
			expect(result).not.toContain("{proposal_id}");
		});

		it("resolves template variable {status}", () => {
			const detail = makeProposalDetail({ status: "DEVELOP" });
			const profile = makeRoleProfile({
				promptTemplate: {
					task_prompt: "Current status is {status}",
				},
			});

			const result = buildTaskPrompt(detail, "prep", [], profile);
			expect(result).toContain("Current status is DEVELOP");
			expect(result).not.toContain("{status}");
		});

		it("resolves template variable {stage}", () => {
			const detail = makeProposalDetail({ status: "review" });
			const profile = makeRoleProfile({
				promptTemplate: {
					task_prompt: "Stage: {stage}",
				},
			});

			const result = buildTaskPrompt(detail, "prep", [], profile);
			expect(result).toContain("Stage: REVIEW");
			expect(result).not.toContain("{stage}");
		});

		it("resolves multiple template variables in one prompt", () => {
			const detail = makeProposalDetail({
				displayId: "P555",
				id: 555,
				status: "MERGE",
			});
			const profile = makeRoleProfile({
				promptTemplate: {
					task_prompt:
						"Check {display_id} (id {proposal_id}) status={status} stage={stage}",
				},
			});

			const result = buildTaskPrompt(detail, "gate", [], profile);
			expect(result).toContain("Check P555 (id 555) status=MERGE stage=MERGE");
		});
	});

	describe("AC-12: fallback when profile has null promptTemplate", () => {
		it("falls back to generic prompt when profile.promptTemplate is null", () => {
			const detail = makeProposalDetail({ status: "DRAFT" });
			const profile = makeRoleProfile({ promptTemplate: null });

			const result = buildTaskPrompt(detail, "prep", [], profile);

			// Should produce the same output as without the profile
			const withoutProfile = buildTaskPrompt(detail, "prep", []);
			expect(result).toBe(withoutProfile);
		});

		it("falls back when promptTemplate.task_prompt is empty string", () => {
			const detail = makeProposalDetail({ status: "DRAFT" });
			const profile = makeRoleProfile({
				promptTemplate: { task_prompt: "" },
			});

			const result = buildTaskPrompt(detail, "prep", [], profile);
			const withoutProfile = buildTaskPrompt(detail, "prep", []);
			expect(result).toBe(withoutProfile);
		});

		it("falls back when promptTemplate.task_prompt is not a string", () => {
			const detail = makeProposalDetail({ status: "DRAFT" });
			const profile = makeRoleProfile({
				promptTemplate: { task_prompt: 123 },
			});

			const result = buildTaskPrompt(detail, "prep", [], profile);
			const withoutProfile = buildTaskPrompt(detail, "prep", []);
			expect(result).toBe(withoutProfile);
		});
	});

	describe("AC-4 [FALLBACK]: builtin-fallback profile gracefully handled", () => {
		it("handles builtin-fallback profile with null promptTemplate", () => {
			const detail = makeProposalDetail({ status: "DRAFT" });
			const profile = makeRoleProfile({
				source: "builtin-fallback",
				promptTemplate: null,
			});

			const result = buildTaskPrompt(detail, "prep", [], profile);
			expect(result).toContain("You are the preparation agent");
		});
	});

	describe("Gate mode with profile", () => {
		it("prepends profile prompt in gate mode", () => {
			const detail = makeProposalDetail({
				status: "DRAFT",
				blockingAcceptanceCriteria: 0,
				design: "Complete design",
				summary: "Complete summary",
			});
			const profile = makeRoleProfile({
				promptTemplate: {
					task_prompt:
						"Gate review for {display_id}: check all AC are met.",
				},
			});

			const result = buildTaskPrompt(detail, "gate", [], profile);

			expect(result).toContain("Gate review for P1234: check all AC are met.");
			expect(result).toContain("Decide whether the proposal is ready");
		});
	});

	describe("Prep mode with missing items", () => {
		it("includes blocking items in generic prompt alongside profile prompt", () => {
			const detail = makeProposalDetail({
				status: "DRAFT",
				blockingAcceptanceCriteria: 2,
			});
			const profile = makeRoleProfile({
				promptTemplate: {
					task_prompt: "Enrichment task for {display_id}:",
				},
			});

			const result = buildTaskPrompt(detail, "prep", ["design", "AC"], profile);

			expect(result).toContain("Enrichment task for P1234:");
			expect(result).toContain("Prepare the proposal by addressing: design, AC");
		});
	});

	describe("Backward compatibility: no profile", () => {
		it("produces same output as before P1113 when profile is omitted", () => {
			const detail = makeProposalDetail({ status: "DRAFT" });

			const resultWithoutProfile = buildTaskPrompt(detail, "prep", ["design"]);
			const resultWithNullProfile = buildTaskPrompt(detail, "prep", ["design"], null);

			expect(resultWithoutProfile).toBe(resultWithNullProfile);
		});

		it("gate mode produces correct output without profile", () => {
			const detail = makeProposalDetail({
				status: "DEVELOP",
				blockingAcceptanceCriteria: 0,
			});

			const result = buildTaskPrompt(detail, "gate", []);

			expect(result).toContain("You are the gate agent");
			expect(result).toContain("P1234");
			expect(result).toContain("Ready to gate");
		});
	});
});
