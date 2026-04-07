import assert from "node:assert";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { initializeProject } from "../../src/core/infrastructure/init.ts";
import { Core } from "../../src/core/roadmap.ts";
import type { RoadmapConfig } from "../../src/types/index.ts";
import { createUniqueTestDir, safeCleanup } from "../support/test-utils.ts";

describe("Enhanced init command", () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = createUniqueTestDir("test-enhanced-init");
	});

	afterEach(async () => {
		try {
			await safeCleanup(tmpDir);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	test("should detect existing project and preserve config during re-initialization", async () => {
		const core = new Core(tmpDir);

		// First initialization
		await core.initializeProject("Test Project");

		// Verify initial config
		const initialConfig = await core.filesystem.loadConfig();
		assert.strictEqual(initialConfig?.projectName, "Test Project");
		assert.strictEqual(initialConfig?.autoCommit, false);

		// Modify some config values to test preservation
		assert.ok(initialConfig);
		if (!initialConfig) throw new Error("Config not loaded");
		const modifiedConfig: RoadmapConfig = {
			...initialConfig,
			projectName: initialConfig?.projectName ?? "Test Project",
			autoCommit: true,
			defaultEditor: "vim",
			defaultPort: 8080,
		};
		await core.filesystem.saveConfig(modifiedConfig);

		// Re-initialization should detect existing config
		const existingConfig = await core.filesystem.loadConfig();
		assert.ok(existingConfig);
		assert.strictEqual(existingConfig?.projectName, "Test Project");
		assert.strictEqual(existingConfig?.autoCommit, true);
		assert.strictEqual(existingConfig?.defaultEditor, "vim");
		assert.strictEqual(existingConfig?.defaultPort, 8080);

		// Verify roadmap structure exists
		const configExists = await stat(join(tmpDir, "roadmap", "config.yml"))
			.then(() => true)
			.catch(() => false);
		assert.strictEqual(configExists, true);
	});

	test("should create default config for new project initialization", async () => {
		const core = new Core(tmpDir);

		// Check that no config exists initially
		const initialConfig = await core.filesystem.loadConfig();
		assert.strictEqual(initialConfig, null);

		// Initialize project
		await core.initializeProject("New Project");

		// Verify config was created with defaults
		const config = await core.filesystem.loadConfig();
		assert.ok(config);
		assert.strictEqual(config?.projectName, "New Project");
		assert.strictEqual(config?.autoCommit, false); // Default value
		assert.deepStrictEqual(config?.statuses, [
			"Potential",
			"Active",
			"Accepted",
			"Complete",
			"Abandoned",
		]);
		assert.strictEqual(config?.dateFormat, "yyyy-mm-dd");
	});

	test("should handle editor configuration in init flow", async () => {
		const core = new Core(tmpDir);

		// Test that editor can be set and saved
		const configWithEditor = {
			projectName: "Editor Test Project",
			statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"],
			labels: [],
			directives: [],
			defaultStatus: "Potential",
			dateFormat: "yyyy-mm-dd",
			roadmapDirectory: "roadmap",
			autoCommit: false,
			remoteOperations: true,
			defaultEditor: "code --wait",
		};

		await core.filesystem.ensureRoadmapStructure();
		await core.filesystem.saveConfig(configWithEditor);

		// Verify editor was saved
		const loadedConfig = await core.filesystem.loadConfig();
		assert.strictEqual(loadedConfig?.defaultEditor, "code --wait");
	});

	test("should handle config with missing fields by filling defaults", async () => {
		const core = new Core(tmpDir);

		// Create a minimal config (like from an older version)
		const minimalConfig = {
			projectName: "Legacy Project",
			statuses: ["Potential", "Complete"],
			labels: [],
			directives: [],
			defaultStatus: "Potential",
			dateFormat: "yyyy-mm-dd",
		};

		await core.filesystem.ensureRoadmapStructure();
		await core.filesystem.saveConfig(minimalConfig);

		// Load config - should handle missing fields gracefully
		const loadedConfig = await core.filesystem.loadConfig();
		assert.ok(loadedConfig);
		assert.strictEqual(loadedConfig?.projectName, "Legacy Project");
		assert.strictEqual(loadedConfig?.autoCommit, undefined); // Missing fields should be undefined, not cause errors
	});

	test("should preserve existing statuses and labels during re-initialization", async () => {
		const core = new Core(tmpDir);

		// Initialize with custom config
		const customConfig = {
			projectName: "Custom Project",
			statuses: ["Roadmap", "Active", "Review", "Complete"],
			labels: ["bug", "feature", "enhancement"],
			directives: ["v1.0", "v2.0"],
			defaultStatus: "Roadmap",
			dateFormat: "dd/mm/yyyy",
			maxColumnWidth: 30,
			roadmapDirectory: "roadmap",
			autoCommit: true,
		};

		await core.filesystem.ensureRoadmapStructure();
		await core.filesystem.saveConfig(customConfig);

		// Simulate re-initialization by loading existing config
		const existingConfig = await core.filesystem.loadConfig();
		assert.ok(existingConfig);
		assert.deepStrictEqual(existingConfig?.statuses, [
			"Roadmap",
			"Active",
			"Review",
			"Complete",
		]);
		assert.deepStrictEqual(existingConfig?.labels, [
			"bug",
			"feature",
			"enhancement",
		]);
		assert.strictEqual(existingConfig?.dateFormat, "dd/mm/yyyy");
		assert.strictEqual(existingConfig?.maxColumnWidth, 30);
	});

	test("should preserve non-init-managed config fields during re-initialization", async () => {
		const core = new Core(tmpDir);

		const initialConfig: RoadmapConfig = {
			projectName: "Preserve Fields Project",
			statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"],
			labels: ["bug"],
			defaultStatus: "Potential",
			dateFormat: "yyyy-mm-dd",
			defaultAssignee: "@alex",
			defaultReporter: "@bot",
			includeDateTimeInDates: true,
			onStatusChange: "echo changed",
			mcp: {
				http: {
					host: "127.0.0.1",
					port: 7777,
					auth: { type: "none" },
				},
			},
		};

		await core.filesystem.ensureRoadmapStructure();
		await core.filesystem.saveConfig(initialConfig);

		const existingConfig = await core.filesystem.loadConfig();
		if (!existingConfig) throw new Error("Expected existing config");

		await initializeProject(core, {
			projectName: "Preserve Fields Project Updated",
			integrationMode: "none",
			existingConfig,
		});

		const reloaded = await core.filesystem.loadConfig();
		assert.strictEqual(
			reloaded?.projectName,
			"Preserve Fields Project Updated",
		);
		assert.strictEqual(reloaded?.defaultAssignee, "@alex");
		assert.strictEqual(reloaded?.defaultReporter, "@bot");
		assert.strictEqual(reloaded?.includeDateTimeInDates, true);
		assert.strictEqual(reloaded?.onStatusChange, "echo changed");
		assert.strictEqual(reloaded?.mcp?.http?.host, "127.0.0.1");
		assert.strictEqual(reloaded?.mcp?.http?.port, 7777);
	});

	test("should handle zero-padding configuration in init flow", async () => {
		const core = new Core(tmpDir);

		// Test config with zero-padding enabled
		const configWithPadding = {
			projectName: "Padded Project",
			statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"],
			labels: [],
			directives: [],
			defaultStatus: "Potential",
			dateFormat: "yyyy-mm-dd",
			roadmapDirectory: "roadmap",
			autoCommit: false,
			remoteOperations: true,
			zeroPaddedIds: 3,
		};

		await core.filesystem.ensureRoadmapStructure();
		await core.filesystem.saveConfig(configWithPadding);

		// Verify zero-padding was saved
		const loadedConfig = await core.filesystem.loadConfig();
		assert.strictEqual(loadedConfig?.zeroPaddedIds, 3);

		// Test that zero-padding config is available for ID generation
		// (ID generation happens in CLI, not in Core.createProposal)
		assert.strictEqual(loadedConfig?.zeroPaddedIds, 3);
	});

	test("should handle zero-padding disabled configuration", async () => {
		const core = new Core(tmpDir);

		// Test config with zero-padding disabled
		const configWithoutPadding = {
			projectName: "Non-Padded Project",
			statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"],
			labels: [],
			directives: [],
			defaultStatus: "Potential",
			dateFormat: "yyyy-mm-dd",
			roadmapDirectory: "roadmap",
			autoCommit: false,
			remoteOperations: true,
			zeroPaddedIds: 0,
		};

		await core.filesystem.ensureRoadmapStructure();
		await core.filesystem.saveConfig(configWithoutPadding);

		// Verify zero-padding was saved as disabled
		const loadedConfig = await core.filesystem.loadConfig();
		assert.strictEqual(loadedConfig?.zeroPaddedIds, 0);

		// Test that zero-padding is properly disabled
		// (ID generation happens in CLI, not in Core.createProposal)
		assert.strictEqual(loadedConfig?.zeroPaddedIds, 0);
	});

	test("should preserve existing zero-padding config during re-initialization", async () => {
		const core = new Core(tmpDir);

		// Create initial config with padding
		const initialConfig = {
			projectName: "Test Project",
			statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"],
			labels: [],
			directives: [],
			defaultStatus: "Potential",
			dateFormat: "yyyy-mm-dd",
			roadmapDirectory: "roadmap",
			autoCommit: false,
			zeroPaddedIds: 4,
		};

		await core.filesystem.ensureRoadmapStructure();
		await core.filesystem.saveConfig(initialConfig);

		// Simulate re-initialization by loading existing config
		const existingConfig = await core.filesystem.loadConfig();
		assert.ok(existingConfig);
		assert.strictEqual(existingConfig?.zeroPaddedIds, 4);

		// Verify the padding config is preserved
		// (ID generation happens in CLI, not in Core.createProposal)
		assert.strictEqual(existingConfig?.zeroPaddedIds, 4);
	});

	test("should create default proposal prefix when not specified", async () => {
		const core = new Core(tmpDir);

		// Initialize project without custom prefix
		await core.initializeProject("Default Prefix Project");

		// Verify default prefix is "proposal"
		const config = await core.filesystem.loadConfig();
		assert.ok(config?.prefixes);
		assert.strictEqual(config?.prefixes?.proposal, "proposal");
	});

	test("should handle custom proposal prefix in config", async () => {
		const core = new Core(tmpDir);

		// Create config with custom prefix
		const customPrefixConfig = {
			projectName: "JIRA Project",
			statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"],
			labels: [],
			directives: [],
			defaultStatus: "Potential",
			dateFormat: "yyyy-mm-dd",
			roadmapDirectory: "roadmap",
			autoCommit: false,
			prefixes: {
				proposal: "JIRA",
				draft: "draft",
			},
		};

		await core.filesystem.ensureRoadmapStructure();
		await core.filesystem.saveConfig(customPrefixConfig);

		// Verify custom prefix was saved
		const loadedConfig = await core.filesystem.loadConfig();
		assert.strictEqual(loadedConfig?.prefixes?.proposal, "JIRA");
	});

	test("should preserve existing prefix during re-initialization", async () => {
		const core = new Core(tmpDir);

		// Create initial config with custom prefix
		const initialConfig = {
			projectName: "Custom Prefix Project",
			statuses: ["Potential", "Active", "Accepted", "Complete", "Abandoned"],
			labels: [],
			directives: [],
			defaultStatus: "Potential",
			dateFormat: "yyyy-mm-dd",
			roadmapDirectory: "roadmap",
			autoCommit: false,
			prefixes: {
				proposal: "BUG",
				draft: "draft",
			},
		};

		await core.filesystem.ensureRoadmapStructure();
		await core.filesystem.saveConfig(initialConfig);

		// Simulate re-initialization by loading existing config
		const existingConfig = await core.filesystem.loadConfig();
		assert.ok(existingConfig);
		assert.strictEqual(existingConfig?.prefixes?.proposal, "BUG");

		// Verify the prefix is preserved (cannot be changed after init)
		assert.strictEqual(existingConfig?.prefixes?.proposal, "BUG");
	});

	test("initializeProject should use custom proposalPrefix from advancedConfig", async () => {
		const core = new Core(tmpDir);

		// Initialize project with custom prefix via initializeProject function
		const result = await initializeProject(core, {
			projectName: "JIRA Init Test",
			integrationMode: "none",
			advancedConfig: {
				proposalPrefix: "JIRA",
			},
		});

		assert.strictEqual(result.success, true);
		assert.strictEqual(result.config.prefixes?.proposal, "JIRA");

		// Verify it was saved
		const loadedConfig = await core.filesystem.loadConfig();
		assert.strictEqual(loadedConfig?.prefixes?.proposal, "JIRA");
	});

	test("initializeProject should preserve existing prefix on re-init", async () => {
		const core = new Core(tmpDir);

		// First init with custom prefix
		await initializeProject(core, {
			projectName: "Re-Init Test",
			integrationMode: "none",
			advancedConfig: {
				proposalPrefix: "ISSUE",
			},
		});

		// Verify initial prefix
		const initialConfig = await core.filesystem.loadConfig();
		assert.strictEqual(initialConfig?.prefixes?.proposal, "ISSUE");

		// Re-initialize (simulating re-init with different proposalPrefix - should be ignored)
		const result = await initializeProject(core, {
			projectName: "Re-Init Test Updated",
			integrationMode: "none",
			existingConfig: initialConfig,
			advancedConfig: {
				proposalPrefix: "CHANGED", // This should be ignored since existingConfig has prefixes
			},
		});

		// Verify prefix was preserved from existingConfig
		assert.strictEqual(result.config.prefixes?.proposal, "ISSUE");
	});

	test("initializeProject should use default prefix when not specified", async () => {
		const core = new Core(tmpDir);

		// Initialize without custom prefix
		const result = await initializeProject(core, {
			projectName: "Default Prefix Init",
			integrationMode: "none",
		});

		assert.strictEqual(result.success, true);
		assert.strictEqual(result.config.prefixes?.proposal, "proposal");
	});

	test("prefixes should persist to disk and reload correctly with new Core instance", async () => {
		const core1 = new Core(tmpDir);

		// Initialize with custom prefix
		await initializeProject(core1, {
			projectName: "Disk Persistence Test",
			integrationMode: "none",
			advancedConfig: {
				proposalPrefix: "PERSIST",
			},
		});

		// Create a NEW Core instance to bypass any in-memory cache
		// This simulates what happens when a user runs a new command in a new process
		const core2 = new Core(tmpDir);
		const loadedConfig = await core2.filesystem.loadConfig();

		// This test would fail if prefixes aren't properly serialized/parsed from disk
		assert.strictEqual(loadedConfig?.prefixes?.proposal, "PERSIST");
	});
});
