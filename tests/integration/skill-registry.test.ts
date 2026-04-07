import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	type AgentProfile,
	type Skill,
	SkillRegistry,
} from "../../src/core/identity/skill-registry.ts";

const TEST_DIR = join(process.cwd(), "tmp", "test-skill-registry");

describe("Skill Registry Module", () => {
	let registry: SkillRegistry;

	beforeEach(() => {
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true, force: true });
		}
		mkdirSync(join(TEST_DIR, "roadmap"), { recursive: true });
		registry = new SkillRegistry(TEST_DIR);
	});

	afterEach(() => {
		registry.close();
		if (existsSync(TEST_DIR)) {
			rmSync(TEST_DIR, { recursive: true, force: true });
		}
	});

	const createMockProfile = (
		id: string,
		skills: Skill[] = [],
	): AgentProfile => ({
		agentId: id,
		name: `Agent ${id}`,
		available: true,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		skills,
		tools: ["tool-1"],
	});

	it("should initialize and register an agent", () => {
		const skill: Skill = {
			id: "ts",
			name: "TypeScript",
			category: "language",
			level: "expert",
		};
		const profile = createMockProfile("agent-1", [skill]);

		registry.registerAgent(profile);

		const fetched = registry.getAgentProfile("agent-1");
		assert.ok(fetched);
		assert.equal(fetched?.agentId, "agent-1");
		assert.equal(fetched?.skills.length, 1);
		assert.equal(fetched?.skills[0]?.id, "ts");
	});

	it("should persist data to SQLite", () => {
		const profile = createMockProfile("persist-test");
		registry.registerAgent(profile);
		assert.ok(registry.isPersistent());

		registry.close();
		const secondRegistry = new SkillRegistry(TEST_DIR);
		const fetched = secondRegistry.getAgentProfile("persist-test");
		assert.ok(fetched);
		assert.equal(fetched?.agentId, "persist-test");
		secondRegistry.close();
	});

	it("should search and score agents by skill", () => {
		const tsExpert: Skill = {
			id: "ts",
			name: "TypeScript",
			category: "language",
			level: "expert",
		};
		const tsBeginner: Skill = {
			id: "ts",
			name: "TypeScript",
			category: "language",
			level: "beginner",
		};
		const goExpert: Skill = {
			id: "go",
			name: "Go",
			category: "language",
			level: "expert",
		};

		registry.registerAgent(createMockProfile("expert-ts", [tsExpert]));
		registry.registerAgent(createMockProfile("beginner-ts", [tsBeginner]));
		registry.registerAgent(createMockProfile("expert-go", [goExpert]));

		const matches = registry.searchBySkill({
			requiredSkills: ["ts"],
			minLevel: "advanced",
		});

		assert.equal(matches.length, 1);
		assert.equal(matches[0]?.profile.agentId, "expert-ts");
		assert.ok(matches[0]?.score > 50);
	});

	it("should handle availability", () => {
		const profile = createMockProfile("avail-test");
		registry.registerAgent(profile);

		assert.equal(registry.listAgents({ availableOnly: true }).length, 1);

		registry.setAvailability("avail-test", false);
		assert.equal(registry.listAgents({ availableOnly: true }).length, 0);
		assert.equal(registry.listAgents().length, 1);
	});

	it("should provide statistics", () => {
		registry.registerAgent(
			createMockProfile("a1", [
				{ id: "s1", name: "S1", category: "tool", level: "expert" },
			]),
		);
		registry.registerAgent(
			createMockProfile("a2", [
				{ id: "s1", name: "S1", category: "tool", level: "expert" },
			]),
		);

		const stats = registry.getStats();
		assert.equal(stats.totalAgents, 2);
		assert.equal(stats.uniqueSkillTypes, 1);
	});
});
