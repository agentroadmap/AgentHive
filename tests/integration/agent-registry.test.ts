import assert from "node:assert";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import {
	createUniqueTestDir,
	execSync,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;

describe("Agent Registry", () => {
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-agent-registry");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });

		// Initialize git repo
		execSync(`git init`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });

		// Initialize roadmap project
		const core = new Core(TEST_DIR);
		await core.initializeProject("Registry Test Project");
	});

	afterEach(async () => {
		await safeCleanup(TEST_DIR);
	});

	it("should register an agent with new profile fields", async () => {
		const core = new Core(TEST_DIR);

		const agent = await core.registerAgent({
			name: "@test-agent",
			identity: "test@example.com",
			capabilities: ["coding", "testing"],
			status: "active",
			availability: "idle",
			costClass: "medium",
		});

		assert.strictEqual(agent.name, "@test-agent");
		assert.strictEqual(agent.identity, "test@example.com");
		assert.deepStrictEqual(agent.capabilities, ["coding", "testing"]);
		assert.strictEqual(agent.status, "active");
		assert.strictEqual(agent.availability, "idle");
		assert.strictEqual(agent.costClass, "medium");
		assert.strictEqual(agent.trustScore, 100);
		assert.ok(agent.lastSeen);

		// Verify persistence
		const agents = await core.listAgents();
		const saved = agents.find((a) => a.name === "@test-agent");
		assert.ok(saved);
		assert.strictEqual(saved.identity, "test@example.com");
	});

	it("should discover agent profiles from worktrees", async () => {
		const core = new Core(TEST_DIR);
		const worktreeName = "agent-alpha";
		const worktreeDir = join(TEST_DIR, "worktrees", worktreeName);
		await mkdir(worktreeDir, { recursive: true });

		const profile = {
			identity: "alpha@ai.com",
			capabilities: ["scouting"],
			costClass: "low",
			status: "active",
		};

		await writeFile(
			join(worktreeDir, "roadmap-agent.json"),
			JSON.stringify(profile, null, 2),
		);

		const agents = await core.listAgents();
		const discovered = agents.find((a) => a.name === worktreeName);

		assert.ok(discovered, "Agent should be discovered from worktree");
		assert.strictEqual(discovered.identity, "alpha@ai.com");
		assert.deepStrictEqual(discovered.capabilities, ["scouting"]);
		assert.strictEqual(discovered.costClass, "low");
	});

	it("should merge worktree profile into registered agent", async () => {
		const core = new Core(TEST_DIR);
		const agentName = "agent-beta";

		// 1. Register first
		await core.registerAgent({
			name: agentName,
			capabilities: ["old-skill"],
			status: "idle",
		});

		// 2. Create worktree profile with same name
		const worktreeDir = join(TEST_DIR, "worktrees", agentName);
		await mkdir(worktreeDir, { recursive: true });
		await writeFile(
			join(worktreeDir, "roadmap-agent.json"),
			JSON.stringify(
				{
					capabilities: ["new-skill"],
					costClass: "high",
				},
				null,
				2,
			),
		);

		const agents = await core.listAgents();
		const merged = agents.find((a) => a.name === agentName);

		assert.ok(merged);
		assert.deepStrictEqual(
			merged.capabilities,
			["new-skill"],
			"Workspace capabilities should take precedence",
		);
		assert.strictEqual(merged.costClass, "high");
		assert.strictEqual(
			merged.status,
			"idle",
			"Registered status should be preserved if not in workspace",
		);
	});

	it("should handle missing profile fields with safe fallbacks", async () => {
		const core = new Core(TEST_DIR);

		// Minimal registration
		const agent = await core.registerAgent({
			name: "@minimal",
		} as any);

		assert.strictEqual(agent.name, "@minimal");
		assert.deepStrictEqual(agent.capabilities, []);
		assert.strictEqual(agent.status, "idle");
		assert.strictEqual(agent.trustScore, 100);
	});
});
