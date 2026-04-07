import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	getOriginalClaimant,
	type ProofReference,
	type ProofRequirement,
	parseProofReferences,
	parseProofRequirements,
	parseReviewHistory,
	proofSatisfiesRequirement,
	type ReviewHistory,
	recordReview,
	serializeProofReferences,
	serializeReviewHistory,
	shouldEscalate,
	validateProof,
} from "../../src/core/proposal/acceptance.ts";

describe("Acceptance Module", () => {
	describe("proofSatisfiesRequirement", () => {
		test("matching type and non-empty value satisfies", () => {
			const proof: ProofReference = {
				type: "test-result",
				value: "All 25 tests passed",
			};
			const req: ProofRequirement = {
				description: "Tests pass",
				evidenceType: "test-result",
				verifier: "builder",
			};
			assert.equal(proofSatisfiesRequirement(proof, req), true);
		});

		test("wrong type does not satisfy", () => {
			const proof: ProofReference = { type: "commit", value: "abc123" };
			const req: ProofRequirement = {
				description: "Tests pass",
				evidenceType: "test-result",
				verifier: "builder",
			};
			assert.equal(proofSatisfiesRequirement(proof, req), false);
		});

		test("empty value does not satisfy", () => {
			const proof: ProofReference = { type: "test-result", value: "" };
			const req: ProofRequirement = {
				description: "Tests pass",
				evidenceType: "test-result",
				verifier: "builder",
			};
			assert.equal(proofSatisfiesRequirement(proof, req), false);
		});
	});

	describe("validateProof", () => {
		test("valid when all requirements met", () => {
			const requirements: ProofRequirement[] = [
				{
					description: "Tests pass",
					evidenceType: "test-result",
					verifier: "builder",
				},
				{
					description: "Build succeeds",
					evidenceType: "command-output",
					verifier: "builder",
				},
			];
			const references: ProofReference[] = [
				{ type: "test-result", value: "All 25 tests passed" },
				{ type: "command-output", value: "Build completed successfully" },
			];

			const result = validateProof(requirements, references);
			assert.equal(result.valid, true);
			assert.equal(result.missingRequirements.length, 0);
		});

		test("invalid when requirements missing", () => {
			const requirements: ProofRequirement[] = [
				{
					description: "Tests pass",
					evidenceType: "test-result",
					verifier: "builder",
				},
				{
					description: "Code reviewed",
					evidenceType: "validation-summary",
					verifier: "peer-tester",
				},
			];
			const references: ProofReference[] = [
				{ type: "test-result", value: "All tests passed" },
			];

			const result = validateProof(requirements, references);
			assert.equal(result.valid, false);
			assert.ok(result.missingRequirements.includes("Code reviewed"));
			assert.equal(result.peerAuditRequired, true);
		});

		test("peer audit satisfied when verified by different agent", () => {
			const requirements: ProofRequirement[] = [
				{
					description: "Code reviewed",
					evidenceType: "validation-summary",
					verifier: "peer-tester",
				},
			];
			const references: ProofReference[] = [
				{ type: "validation-summary", value: "LGTM", verifiedBy: "Opus" },
			];

			const result = validateProof(requirements, references, {
				auditAgent: "Gemini",
			});
			assert.equal(result.valid, true);
			assert.equal(result.peerAuditDone, true);
		});

		test("empty requirements always valid", () => {
			const result = validateProof([], []);
			assert.equal(result.valid, true);
		});
	});

	describe("recordReview", () => {
		test("pass moves to Complete", () => {
			const history: ReviewHistory = {
				proposalId: "proposal-9",
				entries: [],
				reviewCount: 0,
				isEscalated: false,
			};
			const result = recordReview(history, "Copilot", "pass", "Gemini");

			assert.equal(result.nextStatus, "Complete");
			assert.equal(result.shouldEscalate, false);
			assert.equal(history.reviewCount, 1);
			assert.equal(history.entries[0]?.result, "pass");
		});

		test("fail returns to claimant", () => {
			const history: ReviewHistory = {
				proposalId: "proposal-9",
				entries: [],
				reviewCount: 0,
				isEscalated: false,
			};
			const result = recordReview(history, "Copilot", "fail", "Gemini", [
				"Missing tests",
			]);

			assert.equal(result.nextStatus, "Active");
			assert.equal(result.shouldEscalate, false);
			assert.equal(history.entries[0]?.claimant, "Gemini");
			assert.deepEqual(history.entries[0]?.issues, ["Missing tests"]);
		});

		test("escalates after max attempts", () => {
			const history: ReviewHistory = {
				proposalId: "proposal-9",
				entries: [
					{
						timestamp: "2026-03-20T10:00:00Z",
						reviewer: "Copilot",
						result: "fail",
						claimant: "Gemini",
						reason: "Missing tests",
					},
					{
						timestamp: "2026-03-20T11:00:00Z",
						reviewer: "Opus",
						result: "fail",
						claimant: "Gemini",
						reason: "Still broken",
					},
				],
				reviewCount: 2,
				isEscalated: false,
			};

			const result = recordReview(history, "Copilot", "fail", "Gemini", [
				"Still failing",
			]);

			assert.equal(result.nextStatus, "Blocked");
			assert.equal(result.shouldEscalate, true);
			assert.equal(history.isEscalated, true);
			assert.equal(history.reviewCount, 3);
		});

		test("pass resets escalation tracking", () => {
			const history: ReviewHistory = {
				proposalId: "proposal-9",
				entries: [
					{
						timestamp: "2026-03-20T10:00:00Z",
						reviewer: "Copilot",
						result: "fail",
						claimant: "Gemini",
					},
				],
				reviewCount: 1,
				isEscalated: false,
			};

			const result = recordReview(history, "Opus", "pass", "Gemini");
			assert.equal(result.nextStatus, "Complete");
		});
	});

	describe("shouldEscalate", () => {
		test("returns false when under threshold", () => {
			const history: ReviewHistory = {
				proposalId: "proposal-9",
				entries: [
					{
						timestamp: "2026-03-20T10:00:00Z",
						reviewer: "Copilot",
						result: "fail",
						claimant: "Gemini",
					},
				],
				reviewCount: 1,
				isEscalated: false,
			};
			assert.equal(shouldEscalate(history), false);
		});

		test("returns true when at threshold with all fails", () => {
			const history: ReviewHistory = {
				proposalId: "proposal-9",
				entries: [
					{
						timestamp: "2026-03-20T10:00:00Z",
						reviewer: "A",
						result: "fail",
						claimant: "Gemini",
					},
					{
						timestamp: "2026-03-20T11:00:00Z",
						reviewer: "B",
						result: "fail",
						claimant: "Gemini",
					},
					{
						timestamp: "2026-03-20T12:00:00Z",
						reviewer: "C",
						result: "fail",
						claimant: "Gemini",
					},
				],
				reviewCount: 3,
				isEscalated: false,
			};
			assert.equal(shouldEscalate(history), true);
		});

		test("returns false if any pass exists", () => {
			const history: ReviewHistory = {
				proposalId: "proposal-9",
				entries: [
					{
						timestamp: "2026-03-20T10:00:00Z",
						reviewer: "A",
						result: "fail",
						claimant: "Gemini",
					},
					{
						timestamp: "2026-03-20T11:00:00Z",
						reviewer: "B",
						result: "pass",
						claimant: "Gemini",
					},
					{
						timestamp: "2026-03-20T12:00:00Z",
						reviewer: "C",
						result: "fail",
						claimant: "Gemini",
					},
				],
				reviewCount: 3,
				isEscalated: false,
			};
			assert.equal(shouldEscalate(history), false);
		});
	});

	describe("getOriginalClaimant", () => {
		test("returns claimant from first entry", () => {
			const history: ReviewHistory = {
				proposalId: "proposal-9",
				entries: [
					{
						timestamp: "2026-03-20T10:00:00Z",
						reviewer: "A",
						result: "fail",
						claimant: "Gemini",
					},
					{
						timestamp: "2026-03-20T11:00:00Z",
						reviewer: "B",
						result: "fail",
						claimant: "SomeoneElse",
					},
				],
				reviewCount: 2,
				isEscalated: false,
			};
			assert.equal(getOriginalClaimant(history), "Gemini");
		});

		test("returns null for empty history", () => {
			const history: ReviewHistory = {
				proposalId: "proposal-9",
				entries: [],
				reviewCount: 0,
				isEscalated: false,
			};
			assert.equal(getOriginalClaimant(history), null);
		});
	});

	describe("parseReviewHistory", () => {
		test("parses review entries from markdown", () => {
			const content = `
## Review History

- [pass] 2026-03-20T12:00:00Z by @Opus (claimant: @Gemini)
- [fail] 2026-03-20T13:00:00Z by @Copilot (claimant: @Gemini) — Missing tests
`;
			const history = parseReviewHistory(content, "proposal-9");
			assert.equal(history.entries.length, 2);
			assert.equal(history.entries[0]?.result, "pass");
			assert.equal(history.entries[1]?.result, "fail");
			assert.equal(history.entries[1]?.reason, "Missing tests");
		});

		test("returns empty history when no section", () => {
			const content = "## Description\n\nSome description";
			const history = parseReviewHistory(content, "proposal-9");
			assert.equal(history.entries.length, 0);
		});
	});

	describe("serializeReviewHistory", () => {
		test("serializes history to markdown", () => {
			const history: ReviewHistory = {
				proposalId: "proposal-9",
				entries: [
					{
						timestamp: "2026-03-20T10:00:00Z",
						reviewer: "Copilot",
						result: "fail",
						claimant: "Gemini",
						reason: "Missing tests",
					},
				],
				reviewCount: 1,
				isEscalated: false,
			};

			const markdown = serializeReviewHistory(history);
			assert.ok(markdown.includes("## Review History"));
			assert.ok(markdown.includes("[fail]"));
			assert.ok(markdown.includes("@Copilot"));
			assert.ok(markdown.includes("@Gemini"));
			assert.ok(markdown.includes("Missing tests"));
		});

		test("returns empty string for empty history", () => {
			const history: ReviewHistory = {
				proposalId: "proposal-9",
				entries: [],
				reviewCount: 0,
				isEscalated: false,
			};
			assert.equal(serializeReviewHistory(history), "");
		});
	});

	describe("parseProofReferences", () => {
		test("parses proof references from markdown", () => {
			const content = `
## Proof References

- [x] command-output: npm test passed
- [x] artifact: dist/bundle.js (verified by @Opus)
`;
			const refs = parseProofReferences(content);
			assert.equal(refs.length, 2);
			assert.equal(refs[0]?.type, "command-output");
			assert.equal(refs[1]?.verifiedBy, "@Opus");
		});
	});

	describe("serializeProofReferences", () => {
		test("serializes references to markdown", () => {
			const refs: ProofReference[] = [
				{ type: "test-result", value: "All tests passed" },
			];

			const markdown = serializeProofReferences(refs);
			assert.ok(markdown.includes("## Proof References"));
			assert.ok(markdown.includes("- [x] test-result: All tests passed"));
		});
	});

	describe("parseProofRequirements", () => {
		test("parses requirements from markdown", () => {
			const content = `
## Proof Requirements

- [ ] req: Tests must pass (evidence: test-result, verifier: builder)
`;
			const reqs = parseProofRequirements(content);
			assert.equal(reqs.length, 1);
			assert.equal(reqs[0]?.evidenceType, "test-result");
		});
	});

	describe("roundtrip", () => {
		test("review history parse/serialize preserves data", () => {
			const original: ReviewHistory = {
				proposalId: "proposal-9",
				entries: [
					{
						timestamp: "2026-03-20T10:00:00Z",
						reviewer: "Copilot",
						result: "fail",
						claimant: "Gemini",
						reason: "Missing tests",
					},
					{
						timestamp: "2026-03-20T11:00:00Z",
						reviewer: "Opus",
						result: "pass",
						claimant: "Gemini",
					},
				],
				reviewCount: 2,
				isEscalated: false,
			};

			const markdown = serializeReviewHistory(original);
			const parsed = parseReviewHistory(markdown, "proposal-9");

			assert.equal(parsed.entries.length, 2);
			assert.equal(parsed.entries[0]?.result, "fail");
			assert.equal(parsed.entries[1]?.result, "pass");
		});
	});
});
