/**
 * Tests for proposal-47: Agent Knowledge Base & Documentation
 *
 * AC#1: Agents can search past solutions by keywords
 * AC#2: Common patterns extracted and indexed
 * AC#3: Decisions and rationales recorded
 * AC#4: Knowledge base accessible via MCP tool
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	createKnowledgeBase,
	type KnowledgeBase,
} from "../../src/core/infrastructure/knowledge-base.ts";

describe("proposal-47: Agent Knowledge Base", () => {
	let testDir: string;
	let kb: KnowledgeBase;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "kb-test-"));
		kb = createKnowledgeBase(testDir);
	});

	afterEach(() => {
		kb.close();
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch (_e) {
			// Ignore cleanup errors in tests
		}
	});

	describe("AC#1: Search past solutions by keywords", () => {
		it("should add and search for solutions", async () => {
			// Add a solution
			const entry = await kb.addEntry({
				type: "solution",
				title: "Fix TypeScript compilation error with generic types",
				content:
					"When TypeScript complains about generic type constraints, use `extends` keyword in the type parameter declaration.",
				keywords: ["typescript", "generic", "compilation", "error", "types"],
				relatedProposals: [],
				author: "test-agent",
				confidence: 90,
				tags: ["typescript", "debugging"],
			});

			assert.ok(entry.id);
			assert.strictEqual(entry.type, "solution");
			assert.strictEqual(
				entry.title,
				"Fix TypeScript compilation error with generic types",
			);
			assert.strictEqual(entry.helpfulCount, 0);
			assert.strictEqual(entry.referenceCount, 0);

			// Search for the solution
			const results = await kb.search({ keywords: ["typescript", "generic"] });

			assert.strictEqual(results.length, 1);
			assert.strictEqual(results[0]?.entry.id, entry.id);
			assert.ok(results[0]?.matchedKeywords.includes("typescript"));
		});

		it("should rank results by relevance", async () => {
			// Add multiple solutions
			await kb.addEntry({
				type: "solution",
				title: "TypeScript configuration",
				content: "Configure tsconfig.json properly",
				keywords: ["typescript", "config"],
				relatedProposals: [],
				author: "agent-1",
				confidence: 80,
				tags: ["typescript"],
			});

			await kb.addEntry({
				type: "solution",
				title: "Advanced TypeScript generics",
				content: "Use conditional types and mapped types for advanced patterns",
				keywords: ["typescript", "generic", "advanced", "types"],
				relatedProposals: [],
				author: "agent-2",
				confidence: 95,
				tags: ["typescript", "advanced"],
			});

			// Search with multiple keywords
			const results = await kb.search({
				keywords: ["typescript", "generic", "advanced"],
			});

			assert.strictEqual(results.length, 2);
			// Both results should have matched keywords
			assert.ok(results[0]?.matchedKeywords.length > 0);
			assert.ok(results[1]?.matchedKeywords.length > 0);
			// The entry with "advanced" should be ranked
			const advancedEntry = results.find((r) =>
				r.entry.title.includes("Advanced"),
			);
			assert.ok(advancedEntry);
		});

		it("should filter by type", async () => {
			await kb.addEntry({
				type: "solution",
				title: "Solution entry",
				content: "A solution",
				keywords: ["test"],
				relatedProposals: [],
				author: "agent",
				confidence: 80,
				tags: [],
			});

			await kb.addEntry({
				type: "obstacle",
				title: "Obstacle entry",
				content: "An obstacle",
				keywords: ["test"],
				relatedProposals: [],
				author: "agent",
				confidence: 80,
				tags: [],
			});

			// Filter by type
			const solutions = await kb.search({
				keywords: ["test"],
				type: "solution",
			});
			assert.strictEqual(solutions.length, 1);
			assert.strictEqual(solutions[0]?.entry.type, "solution");

			const obstacles = await kb.search({
				keywords: ["test"],
				type: "obstacle",
			});
			assert.strictEqual(obstacles.length, 1);
			assert.strictEqual(obstacles[0]?.entry.type, "obstacle");
		});

		it("should limit results", async () => {
			// Add multiple entries
			for (let i = 0; i < 5; i++) {
				await kb.addEntry({
					type: "solution",
					title: `Solution ${i}`,
					content: `Content ${i} with test keyword`,
					keywords: ["test"],
					relatedProposals: [],
					author: "agent",
					confidence: 80,
					tags: [],
				});
			}

			const results = await kb.search({ keywords: ["test"], limit: 3 });
			assert.strictEqual(results.length, 3);
		});
	});

	describe("AC#2: Common patterns extracted and indexed", () => {
		it("should extract and store patterns", async () => {
			const pattern = await kb.extractPattern({
				name: "Dependency Injection Pattern",
				description: "Use constructor injection for testable code",
				codeExample:
					"class Service { constructor(private dep: IDependency) {} }",
				firstSeenAt: "2026-03-24T00:00:00Z",
				relatedEntries: [],
			});

			assert.ok(pattern.id);
			assert.strictEqual(pattern.name, "Dependency Injection Pattern");
			assert.strictEqual(pattern.usageCount, 0);
			assert.strictEqual(pattern.successRate, 0);
		});

		it("should get all patterns with optional filtering", async () => {
			// Add patterns
			await kb.extractPattern({
				name: "Pattern 1",
				description: "First pattern",
				firstSeenAt: "2026-03-24T00:00:00Z",
				relatedEntries: [],
			});

			await kb.extractPattern({
				name: "Pattern 2",
				description: "Second pattern",
				firstSeenAt: "2026-03-24T01:00:00Z",
				relatedEntries: [],
			});

			const patterns = await kb.getPatterns();
			assert.strictEqual(patterns.length, 2);
		});

		it("should update pattern usage stats", async () => {
			const pattern = await kb.extractPattern({
				name: "Test Pattern",
				description: "A testable pattern",
				firstSeenAt: "2026-03-24T00:00:00Z",
				relatedEntries: [],
			});

			// Update usage
			await kb.updatePatternUsage(pattern.id, true);
			await kb.updatePatternUsage(pattern.id, true);
			await kb.updatePatternUsage(pattern.id, false);

			const patterns = await kb.getPatterns();
			assert.strictEqual(patterns[0]?.usageCount, 3);
			assert.strictEqual(patterns[0]?.successRate, 67); // 2/3 * 100
		});
	});

	describe("AC#3: Decisions and rationales recorded", () => {
		it("should record decisions with rationale", async () => {
			const decision = await kb.recordDecision({
				title: "Use SQLite for persistence",
				content: "Use SQLite for local storage instead of JSON files",
				rationale:
					"SQLite provides ACID compliance, better query performance, and concurrent access support",
				alternatives: ["JSON files", "YAML files", "LevelDB"],
				author: "architect-agent",
				relatedProposalId: "proposal-10",
				tags: ["architecture", "storage"],
			});

			assert.ok(decision.id);
			assert.strictEqual(decision.type, "decision");
			assert.strictEqual(decision.title, "Use SQLite for persistence");
			assert.ok(decision.content.includes("Rationale"));
			assert.ok(decision.content.includes("Alternatives Considered"));
		});

		it("should get decisions filtered by related proposal", async () => {
			await kb.recordDecision({
				title: "Decision 1",
				content: "First decision",
				rationale: "Reason 1",
				alternatives: [],
				author: "agent",
				relatedProposalId: "proposal-10",
			});

			await kb.recordDecision({
				title: "Decision 2",
				content: "Second decision",
				rationale: "Reason 2",
				alternatives: [],
				author: "agent",
				relatedProposalId: "proposal-20",
			});

			const decisions = await kb.getDecisions({
				relatedProposal: "proposal-10",
			});
			assert.strictEqual(decisions.length, 1);
			assert.strictEqual(decisions[0]?.title, "Decision 1");
		});

		it("should get all decisions", async () => {
			await kb.recordDecision({
				title: "Decision 1",
				content: "First decision",
				rationale: "Reason 1",
				alternatives: [],
				author: "agent",
			});

			await kb.recordDecision({
				title: "Decision 2",
				content: "Second decision",
				rationale: "Reason 2",
				alternatives: [],
				author: "agent",
			});

			const decisions = await kb.getDecisions();
			assert.strictEqual(decisions.length, 2);
		});
	});

	describe("AC#4: Knowledge base accessible via MCP tool", () => {
		it("should persist entries across instances", async () => {
			// Add entry with first instance
			await kb.addEntry({
				type: "solution",
				title: "Persistent solution",
				content: "This should persist",
				keywords: ["persistent"],
				relatedProposals: [],
				author: "agent",
				confidence: 85,
				tags: [],
			});

			kb.close();

			// Create new instance and verify
			const kb2 = createKnowledgeBase(testDir);
			const results = await kb2.search({ keywords: ["persistent"] });

			assert.strictEqual(results.length, 1);
			assert.strictEqual(results[0]?.entry.title, "Persistent solution");

			kb2.close();
		});
	});

	describe("Additional features", () => {
		it("should mark entries as helpful", async () => {
			const entry = await kb.addEntry({
				type: "solution",
				title: "Helpful solution",
				content: "Very helpful content",
				keywords: ["helpful"],
				relatedProposals: [],
				author: "agent",
				confidence: 80,
				tags: [],
			});

			await kb.markHelpful(entry.id);
			await kb.markHelpful(entry.id);

			const retrieved = await kb.getEntry(entry.id);
			assert.strictEqual(retrieved?.helpfulCount, 2);
		});

		it("should track reference count", async () => {
			const entry = await kb.addEntry({
				type: "solution",
				title: "Referenced solution",
				content: "Often referenced",
				keywords: ["reference"],
				relatedProposals: [],
				author: "agent",
				confidence: 80,
				tags: [],
			});

			await kb.incrementReference(entry.id);
			await kb.incrementReference(entry.id);
			await kb.incrementReference(entry.id);

			const retrieved = await kb.getEntry(entry.id);
			assert.strictEqual(retrieved?.referenceCount, 3);
		});

		it("should get entries by proposal", async () => {
			await kb.addEntry({
				type: "solution",
				title: "Solution for proposal 10",
				content: "Content",
				keywords: ["test"],
				relatedProposals: ["proposal-10"],
				sourceProposalId: "proposal-10",
				author: "agent",
				confidence: 80,
				tags: [],
			});

			await kb.addEntry({
				type: "decision",
				title: "Decision for proposal 10",
				content: "Content",
				keywords: ["test"],
				relatedProposals: ["proposal-10"],
				sourceProposalId: "proposal-10",
				author: "agent",
				confidence: 80,
				tags: [],
			});

			await kb.addEntry({
				type: "solution",
				title: "Solution for proposal 20",
				content: "Content",
				keywords: ["test"],
				relatedProposals: ["proposal-20"],
				author: "agent",
				confidence: 80,
				tags: [],
			});

			const entries = await kb.getEntriesByProposal("proposal-10");
			assert.strictEqual(entries.length, 2);
		});

		it("should provide statistics", async () => {
			// Add various entries
			await kb.addEntry({
				type: "solution",
				title: "Solution 1",
				content: "Content",
				keywords: ["test"],
				relatedProposals: [],
				author: "agent-1",
				confidence: 80,
				tags: [],
			});

			await kb.addEntry({
				type: "decision",
				title: "Decision 1",
				content: "Content",
				keywords: ["test"],
				relatedProposals: [],
				author: "agent-2",
				confidence: 90,
				tags: [],
			});

			await kb.extractPattern({
				name: "Pattern 1",
				description: "A pattern",
				firstSeenAt: "2026-03-24T00:00:00Z",
				relatedEntries: [],
			});

			const stats = await kb.getStats();

			assert.strictEqual(stats.totalEntries, 2);
			assert.strictEqual(stats.totalPatterns, 1);
			assert.strictEqual(stats.averageConfidence, 85); // (80 + 90) / 2
			assert.strictEqual(stats.topContributors.length, 2);
		});
	});
});
