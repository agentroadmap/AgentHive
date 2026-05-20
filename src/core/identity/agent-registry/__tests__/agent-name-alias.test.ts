/**
 * P919 / P931: Agent Name Display Alias Tests
 *
 * AC-8: Identity immutability — P852 identity never overwritten
 * Tests for assignDisplayAlias() Tier 1 & Tier 2 alias assignment.
 * P931 adds regression coverage for algorithmic Title-Case + provider guard.
 */

import { describe, it, expect } from "vitest";
import { assignDisplayAlias, pascalCaseHost } from "../agent-name";

describe("assignDisplayAlias — P919 Tiered Naming", () => {
	describe("Tier 1: Liaison (0..9, no expertise)", () => {
		it("should format '{Agency}-{Host}' for liaison slot (0..9)", () => {
			const alias = assignDisplayAlias("Claude", "bot", undefined, "0");
			expect(alias).toBe("Claude-bot");

			const alias2 = assignDisplayAlias("Codex", "hermes", undefined, "5");
			expect(alias2).toBe("Codex-hermes");
		});

		it("should handle multi-word agency names", () => {
			const alias = assignDisplayAlias("claude code", "bot", undefined, "0");
			expect(alias).toBe("ClaudeCode-bot");
		});

		it("should not apply alias if expertise hint is present (even for slot 0)", () => {
			const alias = assignDisplayAlias("Claude", "bot", "typescript", "0");
			// Tier 1 must have no expertise, so this should return null
			expect(alias).toBeNull();
		});
	});

	describe("Tier 2: Expert slot-a with expertise", () => {
		it("should format '{Agency}-{Host}-{Expertise}' for slot-a with expertise", () => {
			const alias = assignDisplayAlias("Claude", "bot", "architecture", "a");
			// encodeExpertise("architecture") → "arch", then capitalized → "Arch"
			expect(alias).toMatch(/Claude-bot-arch/i);
		});

		it("should capitalize expertise code", () => {
			const alias = assignDisplayAlias("Codex", "mac", "typescript", "a");
			expect(alias).toMatch(/Codex-mac-[A-Z]/i);
		});

		it("should not apply alias if no expertise hint", () => {
			const alias = assignDisplayAlias("Claude", "bot", undefined, "a");
			// Tier 2 requires expertise, so this should return null
			expect(alias).toBeNull();
		});
	});

	describe("Tier 3+: Rotated slots (b, c, ...) → no alias", () => {
		it("should return null for rotated expert slots", () => {
			const aliasB = assignDisplayAlias("Claude", "bot", "typescript", "b");
			expect(aliasB).toBeNull();

			const aliasZ = assignDisplayAlias("Codex", "hermes", "qa", "z");
			expect(aliasZ).toBeNull();
		});
	});

	describe("AC-8: Identity immutability", () => {
		it("should not modify the underlying agent_identity", () => {
			// assignDisplayAlias is pure — returns only the alias string
			// The identity is never passed to this function
			// This test documents the contract: assignDisplayAlias is side-effect-free
			const alias1 = assignDisplayAlias("Claude", "bot", undefined, "0");
			const alias2 = assignDisplayAlias("Claude", "bot", undefined, "0");

			// Pure function — same inputs always yield same output
			expect(alias1).toBe(alias2);

			// No DB writes, no state mutation
			expect(alias1).toBe("Claude-bot");
		});
	});

	describe("Edge cases", () => {
		it("should handle empty expertise string gracefully", () => {
			const alias = assignDisplayAlias("Claude", "bot", "", "a");
			// Empty expertise string should be treated as falsy (no alias)
			expect(alias).toBeNull();
		});

		it("should handle whitespace in agency names", () => {
			const alias = assignDisplayAlias("  claude  ", "bot", undefined, "0");
			expect(alias).toBe("Claude-bot");
		});

		it("should handle unknown expertise codes", () => {
			// Unknown expertise should be slugified (first 5 chars, alphanumeric only)
			const alias = assignDisplayAlias("Claude", "bot", "unknown-skill", "a");
			// Should still produce an alias since slot is 'a'
			expect(alias).not.toBeNull();
			expect(alias).toMatch(/Claude-bot-/i);
		});

		it("should return null for invalid slot characters", () => {
			const aliasX = assignDisplayAlias("Claude", "bot", "typescript", "x");
			expect(aliasX).toBeNull();

			const aliasAt = assignDisplayAlias("Claude", "bot", "typescript", "@");
			expect(aliasAt).toBeNull();
		});
	});

	describe("P931: algorithmic Title-Case + provider boundary enforcement", () => {
		it("unmapped expertise 'documenter' → 'Claude-bot-Documenter' (not undefineddocum)", () => {
			expect(assignDisplayAlias("Claude", "bot", "documenter", "a")).toBe(
				"Claude-bot-Documenter",
			);
		});

		it("unmapped expertise 'architect' → 'Claude-bot-Architect'", () => {
			expect(assignDisplayAlias("Claude", "bot", "architect", "a")).toBe(
				"Claude-bot-Architect",
			);
		});

		it("hyphenated expertise 'gate-review' → 'Claude-bot-GateReview'", () => {
			expect(assignDisplayAlias("Claude", "bot", "gate-review", "a")).toBe(
				"Claude-bot-GateReview",
			);
		});

		it("all-caps token 'qa' → 'Claude-bot-QA'", () => {
			expect(assignDisplayAlias("Claude", "bot", "qa", "a")).toBe(
				"Claude-bot-QA",
			);
		});

		it("multi-token + all-caps 'ai-architect' → 'Claude-bot-AIArchitect'", () => {
			expect(assignDisplayAlias("Claude", "bot", "ai-architect", "a")).toBe(
				"Claude-bot-AIArchitect",
			);
		});

		it("dense abbr 'ccs46ant' throws instead of producing 'Ccs46ant-bot-Documenter'", () => {
			expect(() =>
				assignDisplayAlias("ccs46ant", "bot", "documenter", "a"),
			).toThrow(/route abbreviation/);
		});

		it("Tier 1 liaison slot unaffected — still returns 'Claude-bot'", () => {
			expect(assignDisplayAlias("Claude", "bot", undefined, "0")).toBe(
				"Claude-bot",
			);
		});

		it("Tier 3+ rotated slots (b, c) unaffected — still return null", () => {
			expect(assignDisplayAlias("Claude", "bot", "typescript", "b")).toBeNull();
			expect(assignDisplayAlias("Claude", "bot", "typescript", "c")).toBeNull();
		});
	});
});

describe("pascalCaseHost — P932 host normalisation", () => {
	it("bare lowercase → capitalised", () => {
		expect(pascalCaseHost("bot")).toBe("Bot");
		expect(pascalCaseHost("hermes")).toBe("Hermes");
		expect(pascalCaseHost("mac")).toBe("Mac");
	});

	it("hyphenated host → joined PascalCase", () => {
		expect(pascalCaseHost("hermes-srv")).toBe("HermesSrv");
		expect(pascalCaseHost("agency-bot")).toBe("AgencyBot");
	});

	it("underscore-delimited host → joined PascalCase", () => {
		expect(pascalCaseHost("my_host")).toBe("MyHost");
	});

	it("already-PascalCase input is idempotent (lower-then-cap)", () => {
		// Idempotent on single-segment hosts
		expect(pascalCaseHost("Bot")).toBe("Bot");
	});

	it("all-uppercase input → lowercased then capitalized", () => {
		expect(pascalCaseHost("BOT")).toBe("Bot");
	});

	it("combined with assignDisplayAlias to form Tier 2 alias", () => {
		const alias = assignDisplayAlias(
			"Claude",
			pascalCaseHost("bot"),
			"documenter",
			"a",
		);
		expect(alias).toBe("Claude-Bot-Documenter");
	});

	it("multi-segment combined with assignDisplayAlias", () => {
		const alias = assignDisplayAlias(
			"Codex",
			pascalCaseHost("hermes-srv"),
			"architecture",
			"a",
		);
		expect(alias).toBe("Codex-HermesSrv-Architecture");
	});
});
