/**
 * Tests for proposal-40: Skill Registry & Auto-Discovery
 * - Agents register skills via MCP skill_register tool
 * - Agent profiles list all registered skills
 * - Other agents can query and filter by skill
 * - Skills persist across sessions in SQLite
 * - Skill match scoring ranks agents by capability fit
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type {
	AgentProfile,
	Skill,
} from "../../src/core/identity/skill-registry.ts";
import { SkillRegistry } from "../../src/core/identity/skill-registry.ts";

const TEST_BASE = join(import.meta.dirname, "../../tmp/test-skill-registry");

describe("proposal-40: Skill Registry & Auto-Discovery", () => {
	let testDir: string;
	let registry: SkillRegistry;
	let testCounter = 0;

	beforeEach(() => {
		testCounter++;
		testDir = join(TEST_BASE, `test-${Date.now()}-${testCounter}`);
		mkdirSync(testDir, { recursive: true });
		registry = new SkillRegistry(testDir);
	});

	afterEach(() => {
		registry.close();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	const createTestAgent = (
		id: string,
		skills: Partial<Skill>[] = [],
	): AgentProfile => ({
		agentId: id,
		name: `Agent ${id}`,
		available: true,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		skills: skills.map((s, i) => ({
			id: s.id || `skill-${i}`,
			name: s.name || `Skill ${i}`,
			category: s.category || "language",
			level: s.level || "intermediate",
			...s,
		})),
		tools: ["cli", "mcp"],
	});

	describe("AC#1: Agents can register skills", () => {
		it("registers a new agent with skills", () => {
			const profile = createTestAgent("agent-1", [
				{
					id: "typescript",
					name: "TypeScript",
					category: "language",
					level: "expert",
				},
				{
					id: "react",
					name: "React",
					category: "framework",
					level: "advanced",
				},
			]);

			registry.registerAgent(profile);

			const result = registry.getAgentProfile("agent-1");
			assert.ok(result);
			assert.equal(result.agentId, "agent-1");
			assert.equal(result.skills.length, 2);
		});

		it("updates existing agent registration", () => {
			const profile1 = createTestAgent("agent-1", [
				{
					id: "typescript",
					name: "TypeScript",
					category: "language",
					level: "beginner",
				},
			]);
			registry.registerAgent(profile1);

			const profile2 = createTestAgent("agent-1", [
				{
					id: "typescript",
					name: "TypeScript",
					category: "language",
					level: "expert",
				},
				{ id: "vue", name: "Vue", category: "framework", level: "advanced" },
			]);
			registry.registerAgent(profile2);

			const result = registry.getAgentProfile("agent-1");
			assert.equal(result?.skills.length, 2);
			assert.equal(
				result?.skills.find((s) => s.id === "typescript")?.level,
				"expert",
			);
		});

		it("registers agent with tools", () => {
			const profile = createTestAgent("agent-1");
			profile.tools = ["cli", "mcp", "browser"];

			registry.registerAgent(profile);

			const result = registry.getAgentProfile("agent-1");
			assert.equal(result?.tools.length, 3);
			assert.ok(result?.tools.includes("browser"));
		});

		it("handles multiple agents independently", () => {
			registry.registerAgent(
				createTestAgent("agent-1", [{ id: "typescript" }]),
			);
			registry.registerAgent(createTestAgent("agent-2", [{ id: "python" }]));

			const a1 = registry.getAgentProfile("agent-1");
			const a2 = registry.getAgentProfile("agent-2");

			assert.equal(a1?.skills[0].id, "typescript");
			assert.equal(a2?.skills[0].id, "python");
		});
	});

	describe("AC#2: Agent profiles list all registered skills", () => {
		it("returns full profile with skills", () => {
			const profile = createTestAgent("agent-1", [
				{
					id: "typescript",
					name: "TypeScript",
					category: "language",
					level: "expert",
				},
				{
					id: "react",
					name: "React",
					category: "framework",
					level: "advanced",
				},
				{
					id: "testing",
					name: "Testing",
					category: "testing",
					level: "intermediate",
				},
			]);

			registry.registerAgent(profile);

			const result = registry.getAgentProfile("agent-1");
			assert.equal(result?.skills.length, 3);
			assert.ok(result?.skills.find((s) => s.id === "typescript"));
			assert.ok(result?.skills.find((s) => s.id === "react"));
			assert.ok(result?.skills.find((s) => s.id === "testing"));
		});

		it("lists all registered agents", () => {
			registry.registerAgent(createTestAgent("agent-1"));
			registry.registerAgent(createTestAgent("agent-2"));
			registry.registerAgent(createTestAgent("agent-3"));

			const agents = registry.listAgents();
			assert.equal(agents.length, 3);
		});

		it("filters by availability", () => {
			const a1 = createTestAgent("agent-1");
			a1.available = true;
			const a2 = createTestAgent("agent-2");
			a2.available = false;

			registry.registerAgent(a1);
			registry.registerAgent(a2);

			const available = registry.listAgents({ availableOnly: true });
			assert.equal(available.length, 1);
			assert.equal(available[0].agentId, "agent-1");
		});
	});

	describe("AC#3: Other agents can query and filter by skill", () => {
		it("finds agents by required skill", () => {
			// Setup fresh agents for this test
			registry.registerAgent(
				createTestAgent("ts-expert", [
					{
						id: "typescript",
						name: "TypeScript",
						category: "language",
						level: "expert",
					},
				]),
			);
			registry.registerAgent(
				createTestAgent("python-expert", [
					{
						id: "python",
						name: "Python",
						category: "language",
						level: "expert",
					},
				]),
			);

			const results = registry.searchBySkill({
				requiredSkills: ["typescript"],
			});

			assert.ok(results.length >= 1);
			const agentIds = results.map((r) => r.profile.agentId);
			assert.ok(agentIds.includes("ts-expert"));
			assert.ok(!agentIds.includes("python-expert"));
		});

		it("filters by minimum skill level", () => {
			registry.registerAgent(
				createTestAgent("ts-expert-2", [
					{
						id: "typescript",
						name: "TypeScript",
						category: "language",
						level: "expert",
					},
				]),
			);
			registry.registerAgent(
				createTestAgent("ts-beginner", [
					{
						id: "typescript",
						name: "TypeScript",
						category: "language",
						level: "beginner",
					},
				]),
			);

			const results = registry.searchBySkill({
				requiredSkills: ["typescript"],
				minLevel: "expert",
			});

			// Only expert should match
			const expertResult = results.find(
				(r) => r.profile.agentId === "ts-expert-2",
			);
			const beginnerResult = results.find(
				(r) => r.profile.agentId === "ts-beginner",
			);
			assert.ok(expertResult, "Expert should be found");
			assert.equal(beginnerResult, undefined, "Beginner should not be found");
		});

		it("filters by category", () => {
			registry.registerAgent(
				createTestAgent("framework-agent", [
					{
						id: "react",
						name: "React",
						category: "framework",
						level: "advanced",
					},
				]),
			);

			const results = registry.searchBySkill({ categories: ["framework"] });

			const found = results.find(
				(r) => r.profile.agentId === "framework-agent",
			);
			assert.ok(found, "Agent with framework skill should be found");
		});

		it("combines multiple filters", () => {
			registry.registerAgent(
				createTestAgent("react-advanced", [
					{
						id: "react",
						name: "React",
						category: "framework",
						level: "advanced",
					},
				]),
			);

			const results = registry.searchBySkill({
				requiredSkills: ["react"],
				availableOnly: true,
			});

			const found = results.find((r) => r.profile.agentId === "react-advanced");
			assert.ok(found, "Agent with react should be found");
			assert.ok(found?.matchedSkills.some((s) => s.id === "react"));
		});

		it("respects limit", () => {
			registry.registerAgent(createTestAgent("limit-test-1"));
			registry.registerAgent(createTestAgent("limit-test-2"));

			const results = registry.searchBySkill({ limit: 1 });
			assert.equal(results.length, 1);
		});
	});

	describe("AC#4: Skills persist across sessions in SQLite", () => {
		it("persists data across registry instances", () => {
			registry.registerAgent(
				createTestAgent("agent-1", [
					{
						id: "typescript",
						name: "TypeScript",
						category: "language",
						level: "expert",
					},
				]),
			);

			// Create new registry instance
			const registry2 = new SkillRegistry(testDir);

			const result = registry2.getAgentProfile("agent-1");
			assert.ok(result);
			assert.equal(result.skills.length, 1);
			assert.equal(result.skills[0].id, "typescript");

			registry2.close();
		});

		it("confirms SQLite file exists", () => {
			registry.registerAgent(createTestAgent("agent-1"));
			assert.ok(registry.isPersistent());
		});
	});

	describe("AC#5: Skill match scoring ranks agents by capability fit", () => {
		beforeEach(() => {
			registry.registerAgent(
				createTestAgent("expert-ts", [
					{
						id: "typescript",
						name: "TypeScript",
						category: "language",
						level: "expert",
					},
				]),
			);
			registry.registerAgent(
				createTestAgent("intermediate-ts", [
					{
						id: "typescript",
						name: "TypeScript",
						category: "language",
						level: "intermediate",
					},
				]),
			);
			registry.registerAgent(
				createTestAgent("beginner-ts", [
					{
						id: "typescript",
						name: "TypeScript",
						category: "language",
						level: "beginner",
					},
				]),
			);
		});

		it("scores expert higher than intermediate", () => {
			const results = registry.searchBySkill({
				requiredSkills: ["typescript"],
			});

			const expertIdx = results.findIndex(
				(r) => r.profile.agentId === "expert-ts",
			);
			const interIdx = results.findIndex(
				(r) => r.profile.agentId === "intermediate-ts",
			);

			assert.ok(expertIdx < interIdx, "Expert should rank higher");
		});

		it("returns match scores between 0-100", () => {
			const results = registry.searchBySkill({
				requiredSkills: ["typescript"],
			});

			for (const r of results) {
				assert.ok(r.score >= 0, `Score ${r.score} should be >= 0`);
				assert.ok(r.score <= 100, `Score ${r.score} should be <= 100`);
			}
		});

		it("tracks matched and missing skills", () => {
			const results = registry.searchBySkill({
				requiredSkills: ["typescript", "rust"],
			});

			const expert = results.find((r) => r.profile.agentId === "expert-ts");
			assert.ok(expert);
			assert.ok(expert.matchedSkills.some((s) => s.id === "typescript"));
			assert.ok(expert.missingSkills.includes("rust"));
		});

		it("gives bonus for available agents", () => {
			const unavailable = createTestAgent("unavailable-expert", [
				{
					id: "typescript",
					name: "TypeScript",
					category: "language",
					level: "expert",
				},
			]);
			unavailable.available = false;
			registry.registerAgent(unavailable);

			const results = registry.searchBySkill({
				requiredSkills: ["typescript"],
			});

			const available = results.find((r) => r.profile.agentId === "expert-ts");
			const unavail = results.find(
				(r) => r.profile.agentId === "unavailable-expert",
			);

			// Available agent should generally score higher (unless other factors)
			assert.ok(available);
			assert.ok(unavail);
			assert.ok(available.score >= unavail.score);
		});
	});

	describe("Statistics and utilities", () => {
		it("reports registry stats", () => {
			registry.registerAgent(
				createTestAgent("agent-1", [{ id: "typescript" }, { id: "react" }]),
			);
			registry.registerAgent(createTestAgent("agent-2", [{ id: "python" }]));

			const stats = registry.getStats();
			assert.equal(stats.totalAgents, 2);
			assert.equal(stats.availableAgents, 2);
			assert.equal(stats.totalSkills, 3);
			assert.equal(stats.uniqueSkillTypes, 3);
		});

		it("lists all skills with agent counts", () => {
			registry.registerAgent(
				createTestAgent("agent-1", [
					{ id: "typescript", name: "TypeScript", category: "language" },
				]),
			);
			registry.registerAgent(
				createTestAgent("agent-2", [
					{ id: "typescript", name: "TypeScript", category: "language" },
					{ id: "python", name: "Python", category: "language" },
				]),
			);

			const skills = registry.getAllSkills();
			const tsSkill = skills.find((s) => s.skillId === "typescript");
			assert.ok(tsSkill);
			assert.equal(tsSkill.agentCount, 2);
		});

		it("removes agent from registry", () => {
			registry.registerAgent(createTestAgent("agent-1"));

			const removed = registry.removeAgent("agent-1");
			assert.ok(removed);

			const result = registry.getAgentProfile("agent-1");
			assert.equal(result, null);
		});

		it("updates availability", () => {
			registry.registerAgent(createTestAgent("agent-1"));

			registry.setAvailability("agent-1", false);

			const result = registry.getAgentProfile("agent-1");
			assert.equal(result?.available, false);
		});
	});
});
