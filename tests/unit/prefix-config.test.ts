import assert from "node:assert";
import { describe, test } from "node:test";
import { EntityType, type RoadmapConfig } from "../../src/types/index.ts";
import {
	buildFilenameIdRegex,
	buildGlobPattern,
	buildIdRegex,
	DEFAULT_PREFIX_CONFIG,
	extractAnyPrefix,
	extractIdBody,
	extractIdNumbers,
	generateNextId,
	generateNextSubproposalId,
	getDefaultPrefixConfig,
	getPrefixForType,
	hasPrefix,
	idsEqual,
	mergePrefixConfig,
	normalizeId,
} from "../../src/utils/prefix-config.ts";
import { expect } from "../support/test-utils.ts";

describe("prefix-config", () => {
	describe("getDefaultPrefixConfig", () => {
		test("returns default proposal prefix", () => {
			const config = getDefaultPrefixConfig();
			assert.strictEqual(config.proposal, "proposal");
		});

		test("returns a new object each time", () => {
			const config1 = getDefaultPrefixConfig();
			const config2 = getDefaultPrefixConfig();
			assert.notStrictEqual(config1, config2);
			assert.deepStrictEqual(config1, config2);
		});
	});

	describe("mergePrefixConfig", () => {
		test("returns defaults when no config provided", () => {
			const config = mergePrefixConfig();
			assert.deepStrictEqual(config, DEFAULT_PREFIX_CONFIG);
		});

		test("returns defaults when empty object provided", () => {
			const config = mergePrefixConfig({});
			assert.deepStrictEqual(config, DEFAULT_PREFIX_CONFIG);
		});

		test("merges partial config with defaults", () => {
			const config = mergePrefixConfig({ proposal: "JIRA" });
			assert.strictEqual(config.proposal, "JIRA");
		});

		test("uses custom proposal value when provided", () => {
			const config = mergePrefixConfig({ proposal: "issue" });
			assert.strictEqual(config.proposal, "issue");
		});
	});

	describe("normalizeId", () => {
		test("adds uppercase prefix to numeric ID", () => {
			expect(normalizeId("123", "proposal")).toBe("proposal-123");
			expect(normalizeId("456", "draft")).toBe("draft-456");
		});

		test("normalizes existing prefix to uppercase", () => {
			expect(normalizeId("proposal-123", "proposal")).toBe("proposal-123");
			expect(normalizeId("draft-456", "draft")).toBe("draft-456");
		});

		test("normalizes mixed case to uppercase", () => {
			expect(normalizeId("proposal-123", "proposal")).toBe("proposal-123");
			expect(normalizeId("Proposal-456", "proposal")).toBe("proposal-456");
		});

		test("works with custom prefixes (uppercase output)", () => {
			expect(normalizeId("789", "JIRA")).toBe("JIRA-789");
			expect(normalizeId("JIRA-789", "JIRA")).toBe("JIRA-789");
			expect(normalizeId("jira-789", "JIRA")).toBe("JIRA-789");
			expect(normalizeId("789", "jira")).toBe("JIRA-789");
		});

		test("handles hierarchical IDs", () => {
			expect(normalizeId("5.2.1", "proposal")).toBe("proposal-5.2.1");
			expect(normalizeId("proposal-5.2.1", "proposal")).toBe("proposal-5.2.1");
		});

		test("trims whitespace", () => {
			expect(normalizeId("  123  ", "proposal")).toBe("proposal-123");
			expect(normalizeId("  proposal-123  ", "proposal")).toBe("proposal-123");
		});
	});

	describe("extractIdBody", () => {
		test("extracts body from prefixed ID", () => {
			expect(extractIdBody("proposal-123", "proposal")).toBe("123");
			expect(extractIdBody("draft-456", "draft")).toBe("456");
		});

		test("handles hierarchical IDs", () => {
			expect(extractIdBody("proposal-5.2.1", "proposal")).toBe("5.2.1");
		});

		test("returns original if no prefix match", () => {
			expect(extractIdBody("123", "proposal")).toBe("123");
			expect(extractIdBody("draft-123", "proposal")).toBe("draft-123");
		});

		test("is case-insensitive for prefix", () => {
			expect(extractIdBody("proposal-123", "proposal")).toBe("123");
			expect(extractIdBody("Proposal-123", "proposal")).toBe("123");
		});

		test("works with custom prefixes", () => {
			expect(extractIdBody("JIRA-789", "JIRA")).toBe("789");
			expect(extractIdBody("issue-42", "issue")).toBe("42");
		});
	});

	describe("extractIdNumbers", () => {
		test("extracts single number", () => {
			expect(extractIdNumbers("proposal-123", "proposal")).toEqual([123]);
		});

		test("extracts hierarchical numbers", () => {
			expect(extractIdNumbers("proposal-5.2.1", "proposal")).toEqual([5, 2, 1]);
			expect(extractIdNumbers("proposal-10.20.30", "proposal")).toEqual([
				10, 20, 30,
			]);
		});

		test("handles non-numeric body", () => {
			expect(extractIdNumbers("proposal-abc", "proposal")).toEqual([0]);
		});

		test("handles mixed numeric/non-numeric", () => {
			// Each segment is parsed independently
			expect(extractIdNumbers("proposal-5.abc.3", "proposal")).toEqual([
				5, 0, 3,
			]);
		});

		test("works with custom prefixes", () => {
			expect(extractIdNumbers("JIRA-456", "JIRA")).toEqual([456]);
		});
	});

	describe("buildGlobPattern", () => {
		test("builds correct glob pattern", () => {
			expect(buildGlobPattern("proposal")).toBe("proposal-*.md");
			expect(buildGlobPattern("draft")).toBe("draft-*.md");
			expect(buildGlobPattern("JIRA")).toBe("JIRA-*.md");
		});
	});

	describe("buildIdRegex", () => {
		test("matches simple IDs", () => {
			const regex = buildIdRegex("proposal");
			expect("proposal-123".match(regex)).toBeTruthy();
			expect("proposal-123".match(regex)?.[1]).toBe("123");
		});

		test("matches hierarchical IDs", () => {
			const regex = buildIdRegex("proposal");
			expect("proposal-5.2.1".match(regex)?.[1]).toBe("5.2.1");
		});

		test("is case-insensitive", () => {
			const regex = buildIdRegex("proposal");
			expect("proposal-123".match(regex)).toBeTruthy();
			expect("Proposal-456".match(regex)).toBeTruthy();
		});

		test("does not match wrong prefix", () => {
			const regex = buildIdRegex("proposal");
			expect("draft-123".match(regex)).toBeFalsy();
		});

		test("works with custom prefixes", () => {
			const regex = buildIdRegex("JIRA");
			expect("JIRA-789".match(regex)?.[1]).toBe("789");
			expect("jira-789".match(regex)?.[1]).toBe("789");
		});

		test("only matches at start of string", () => {
			const regex = buildIdRegex("proposal");
			expect("prefix-proposal-123".match(regex)).toBeFalsy();
		});
	});

	describe("buildFilenameIdRegex", () => {
		test("extracts ID from filename", () => {
			const regex = buildFilenameIdRegex("proposal");
			const match = "proposal-123 - Some Title.md".match(regex);
			assert.strictEqual(match?.[1], "123");
		});

		test("handles hierarchical IDs in filenames", () => {
			const regex = buildFilenameIdRegex("proposal");
			const match = "proposal-5.2 - Subproposal Title.md".match(regex);
			assert.strictEqual(match?.[1], "5.2");
		});
	});

	describe("hasPrefix", () => {
		test("returns true for matching prefix", () => {
			expect(hasPrefix("proposal-123", "proposal")).toBe(true);
			expect(hasPrefix("draft-456", "draft")).toBe(true);
		});

		test("is case-insensitive", () => {
			expect(hasPrefix("proposal-123", "proposal")).toBe(true);
			expect(hasPrefix("Proposal-456", "proposal")).toBe(true);
		});

		test("returns false for non-matching prefix", () => {
			expect(hasPrefix("draft-123", "proposal")).toBe(false);
			expect(hasPrefix("123", "proposal")).toBe(false);
		});

		test("trims whitespace", () => {
			expect(hasPrefix("  proposal-123  ", "proposal")).toBe(true);
		});
	});

	describe("idsEqual", () => {
		test("returns true for identical IDs", () => {
			expect(idsEqual("proposal-123", "proposal-123", "proposal")).toBe(true);
		});

		test("is case-insensitive for prefix", () => {
			expect(idsEqual("proposal-123", "proposal-123", "proposal")).toBe(true);
			expect(idsEqual("proposal-123", "proposal-123", "proposal")).toBe(true);
		});

		test("returns false for different IDs", () => {
			expect(idsEqual("proposal-123", "proposal-456", "proposal")).toBe(false);
		});

		test("handles IDs without prefix", () => {
			expect(idsEqual("123", "proposal-123", "proposal")).toBe(true);
		});
	});

	describe("generateNextId", () => {
		test("generates next ID in sequence (uppercase)", () => {
			expect(
				generateNextId(["proposal-1", "proposal-2", "proposal-3"], "proposal"),
			).toBe("proposal-4");
		});

		test("handles gaps in sequence", () => {
			expect(
				generateNextId(["proposal-1", "proposal-5", "proposal-10"], "proposal"),
			).toBe("proposal-11");
		});

		test("returns proposal-1 for empty list", () => {
			expect(generateNextId([], "proposal")).toBe("proposal-1");
		});

		test("ignores subproposals when finding max", () => {
			expect(
				generateNextId(
					["proposal-1", "proposal-1.1", "proposal-1.2", "proposal-2"],
					"proposal",
				),
			).toBe("proposal-3");
		});

		test("handles zero padding", () => {
			expect(
				generateNextId(["proposal-001", "proposal-002"], "proposal", 3),
			).toBe("proposal-003");
		});

		test("works with custom prefixes (uppercase)", () => {
			expect(generateNextId(["JIRA-100", "JIRA-101"], "JIRA")).toBe("JIRA-102");
		});

		test("ignores IDs with wrong prefix", () => {
			expect(
				generateNextId(["proposal-5", "draft-10", "proposal-3"], "proposal"),
			).toBe("proposal-6");
		});
	});

	describe("generateNextSubproposalId", () => {
		test("generates next subproposal ID (uppercase)", () => {
			expect(
				generateNextSubproposalId(
					["proposal-5", "proposal-5.1", "proposal-5.2"],
					"proposal-5",
					"proposal",
				),
			).toBe("proposal-5.3");
		});

		test("returns .1 for first subproposal", () => {
			expect(
				generateNextSubproposalId(["proposal-5"], "proposal-5", "proposal"),
			).toBe("proposal-5.1");
		});

		test("handles gaps in subproposal sequence", () => {
			expect(
				generateNextSubproposalId(
					["proposal-5", "proposal-5.1", "proposal-5.5"],
					"proposal-5",
					"proposal",
				),
			).toBe("proposal-5.6");
		});

		test("handles zero padding", () => {
			expect(
				generateNextSubproposalId(
					["proposal-5", "proposal-5.01"],
					"proposal-5",
					"proposal",
					2,
				),
			).toBe("proposal-5.02");
		});

		test("works with custom prefixes", () => {
			expect(
				generateNextSubproposalId(
					["JIRA-100", "JIRA-100.1"],
					"JIRA-100",
					"JIRA",
				),
			).toBe("JIRA-100.2");
		});

		test("handles unnormalized parent ID", () => {
			expect(
				generateNextSubproposalId(
					["proposal-5", "proposal-5.1"],
					"5",
					"proposal",
				),
			).toBe("proposal-5.2");
		});
	});

	describe("getPrefixForType", () => {
		test("returns default proposal prefix without config", () => {
			expect(getPrefixForType(EntityType.Proposal)).toBe("proposal");
		});

		test("returns configured proposal prefix", () => {
			const config = { prefixes: { proposal: "JIRA" } } as RoadmapConfig;
			expect(getPrefixForType(EntityType.Proposal, config)).toBe("JIRA");
		});

		test("returns default proposal prefix when config has no prefixes", () => {
			const config = {} as RoadmapConfig;
			expect(getPrefixForType(EntityType.Proposal, config)).toBe("proposal");
		});

		test("returns hardcoded draft prefix (not configurable)", () => {
			expect(getPrefixForType(EntityType.Draft)).toBe("draft");
		});

		test("draft prefix is always hardcoded regardless of config", () => {
			const config = { prefixes: { proposal: "JIRA" } } as RoadmapConfig;
			// Draft prefix is hardcoded, not part of config
			expect(getPrefixForType(EntityType.Draft, config)).toBe("draft");
		});

		test("returns doc prefix for Document type", () => {
			expect(getPrefixForType(EntityType.Document)).toBe("doc");
		});

		test("returns decision prefix for Decision type", () => {
			expect(getPrefixForType(EntityType.Decision)).toBe("decision");
		});
	});

	describe("extractAnyPrefix", () => {
		test("extracts proposal prefix", () => {
			expect(extractAnyPrefix("proposal-123")).toBe("proposal");
		});

		test("extracts uppercase prefix", () => {
			expect(extractAnyPrefix("proposal-123")).toBe("proposal");
		});

		test("extracts custom prefix", () => {
			expect(extractAnyPrefix("JIRA-456")).toBe("jira");
		});

		test("extracts draft prefix", () => {
			expect(extractAnyPrefix("draft-1")).toBe("draft");
		});

		test("returns null for plain number", () => {
			expect(extractAnyPrefix("123")).toBe(null);
		});

		test("returns null for empty string", () => {
			expect(extractAnyPrefix("")).toBe(null);
		});

		test("returns null for null/undefined", () => {
			expect(extractAnyPrefix(null as unknown as string)).toBe(null);
			expect(extractAnyPrefix(undefined as unknown as string)).toBe(null);
		});

		test("handles subproposal IDs", () => {
			expect(extractAnyPrefix("proposal-5.2.1")).toBe("proposal");
		});

		test("handles word IDs", () => {
			expect(extractAnyPrefix("bug-fix-login")).toBe("bug");
		});
	});
});
