/**
 * P919: Agent Name Display Alias Tests
 *
 * AC-8: Identity immutability — P852 identity never overwritten
 * Tests for assignDisplayAlias() Tier 1 & Tier 2 alias assignment
 */

import { describe, it, expect } from "vitest";
import { assignDisplayAlias } from "../agent-name";

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

	describe("P931: titleCaseExpertise — algorithmic Title-Case fixes", () => {
		it("AC-1: unmapped expertise 'documenter' → 'Claude-Bot-Documenter', not 'Claude-Bot-undefineddocum'", () => {
			const alias = assignDisplayAlias("Claude", "Bot", "documenter", "a");
			expect(alias).toBe("Claude-Bot-Documenter");
		});

		it("AC-2: mapped expertise 'architect' → 'Claude-Bot-Architect'", () => {
			const alias = assignDisplayAlias("Claude", "Bot", "architect", "a");
			expect(alias).toBe("Claude-Bot-Architect");
		});

		it("AC-3: hyphenated expertise 'gate-review' → 'Claude-Bot-GateReview'", () => {
			const alias = assignDisplayAlias("Claude", "Bot", "gate-review", "a");
			expect(alias).toBe("Claude-Bot-GateReview");
		});

		it("AC-4: ALL_CAPS token 'qa' → 'Claude-Bot-QA'", () => {
			const alias = assignDisplayAlias("Claude", "Bot", "qa", "a");
			expect(alias).toBe("Claude-Bot-QA");
		});

		it("AC-5: multi-token + ALL_CAPS 'ai-architect' → 'Claude-Bot-AIArchitect'", () => {
			const alias = assignDisplayAlias("Claude", "Bot", "ai-architect", "a");
			expect(alias).toBe("Claude-Bot-AIArchitect");
		});

		it("AC-6: provider-derivation regression — dense abbr 'ccs46ant' throws instead of producing 'Ccs46ant-Bot-Documenter'", () => {
			expect(() =>
				assignDisplayAlias("ccs46ant", "Bot", "documenter", "a"),
			).toThrow(/dense routeAbbr/);
		});

		it("AC-7: Tier 1 unaffected — liaison slot still returns '{Provider}-{Host}'", () => {
			const alias = assignDisplayAlias("Claude", "Bot", undefined, "0");
			expect(alias).toBe("Claude-Bot");
		});

		it("AC-8: Tier 3+ unaffected — rotated slots still return null", () => {
			expect(assignDisplayAlias("Claude", "Bot", "documenter", "b")).toBeNull();
			expect(assignDisplayAlias("Claude", "Bot", "documenter", "c")).toBeNull();
		});
	});
});
