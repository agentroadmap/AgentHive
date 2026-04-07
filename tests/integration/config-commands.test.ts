import assert from "node:assert";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { PromptRunner } from "../../src/commands/advanced-config-wizard.ts";
import { configureAdvancedSettings } from "../../src/commands/configure-advanced-settings.ts";
import { Core } from "../../src/core/roadmap.ts";
import {
	createUniqueTestDir,
	execSync,
	expect,
	safeCleanup,
} from "../support/test-utils.ts";

let TEST_DIR: string;
const CLI_PATH = join(process.cwd(), "src", "cli.ts");

describe("Config commands", () => {
	let core: Core;

	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-config-commands");
		await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
		await mkdir(TEST_DIR, { recursive: true });

		// Configure git for tests - required for CI
		execSync(`git init`, { cwd: TEST_DIR });
		execSync(`git config user.email test@example.com`, { cwd: TEST_DIR });
		execSync(`git config user.name "Test User"`, { cwd: TEST_DIR });

		core = new Core(TEST_DIR);
		await core.initializeProject("Test Config Project");
	});

	function createPromptStub(
		sequence: Array<Record<string, unknown>>,
	): PromptRunner {
		const stub: PromptRunner = async () => {
			return sequence.shift() ?? {};
		};
		return stub;
	}

	it("configureAdvancedSettings keeps defaults when no changes requested", async () => {
		const promptStub = createPromptStub([
			{ installCompletions: false },
			{ checkActiveBranches: true },
			{ remoteOperations: true },
			{ activeBranchDays: 30 },
			{ bypassGitHooks: false },
			{ autoCommit: false },
			{ enableZeroPadding: false },
			{ editor: "" },
			{ configureWebUI: false },
			{ installClaudeAgent: false },
		]);

		const { mergedConfig, installClaudeAgent, installShellCompletions } =
			await configureAdvancedSettings(core, {
				promptImpl: promptStub,
			});

		assert.strictEqual(installClaudeAgent, false);
		assert.strictEqual(installShellCompletions, false);
		assert.strictEqual(mergedConfig.checkActiveBranches, true);
		assert.strictEqual(mergedConfig.remoteOperations, true);
		assert.strictEqual(mergedConfig.activeBranchDays, 30);
		assert.strictEqual(mergedConfig.bypassGitHooks, false);
		assert.strictEqual(mergedConfig.autoCommit, false);
		assert.strictEqual(mergedConfig.zeroPaddedIds, undefined);
		assert.strictEqual(mergedConfig.defaultEditor, undefined);
		assert.strictEqual(mergedConfig.defaultPort, 6420);
		assert.strictEqual(mergedConfig.autoOpenBrowser, true);

		const reloadedConfig = await core.filesystem.loadConfig();
		assert.strictEqual(reloadedConfig?.defaultPort, 6420);
		assert.strictEqual(reloadedConfig?.autoOpenBrowser, true);
	});

	it("configureAdvancedSettings applies wizard selections", async () => {
		const promptStub = createPromptStub([
			{ installCompletions: true },
			{ checkActiveBranches: true },
			{ remoteOperations: false },
			{ activeBranchDays: 14 },
			{ bypassGitHooks: true },
			{ autoCommit: true },
			{ enableZeroPadding: true },
			{ paddingWidth: 4 },
			{ editor: "echo" },
			{ configureWebUI: true },
			{ defaultPort: 7007, autoOpenBrowser: false },
			{ installClaudeAgent: true },
		]);

		const { mergedConfig, installClaudeAgent, installShellCompletions } =
			await configureAdvancedSettings(core, {
				promptImpl: promptStub,
			});

		assert.strictEqual(installClaudeAgent, true);
		assert.strictEqual(installShellCompletions, true);
		assert.strictEqual(mergedConfig.checkActiveBranches, true);
		assert.strictEqual(mergedConfig.remoteOperations, false);
		assert.strictEqual(mergedConfig.activeBranchDays, 14);
		assert.strictEqual(mergedConfig.bypassGitHooks, true);
		assert.strictEqual(mergedConfig.autoCommit, true);
		assert.strictEqual(mergedConfig.zeroPaddedIds, 4);
		assert.strictEqual(mergedConfig.defaultEditor, "echo");
		assert.strictEqual(mergedConfig.defaultPort, 7007);
		assert.strictEqual(mergedConfig.autoOpenBrowser, false);

		const reloadedConfig = await core.filesystem.loadConfig();
		assert.strictEqual(reloadedConfig?.zeroPaddedIds, 4);
		assert.strictEqual(reloadedConfig?.defaultEditor, "echo");
		assert.strictEqual(reloadedConfig?.defaultPort, 7007);
		assert.strictEqual(reloadedConfig?.autoOpenBrowser, false);
		assert.strictEqual(reloadedConfig?.bypassGitHooks, true);
		assert.strictEqual(reloadedConfig?.autoCommit, true);
	});

	it("exposes config list/get/set subcommands", async () => {
		const listOutput = execSync(
			`node --experimental-strip-types ${CLI_PATH} config list`,
			{ cwd: TEST_DIR },
		).text();
		assert.ok(listOutput.includes("Configuration:"));

		execSync(
			`node --experimental-strip-types ${CLI_PATH} config set defaultPort 7001`,
			{ cwd: TEST_DIR },
		);

		const portOutput = execSync(
			`node --experimental-strip-types ${CLI_PATH} config get defaultPort`,
			{ cwd: TEST_DIR },
		).text();
		expect(portOutput.trim()).toBe("7001");
	});

	it("surfaces directives in config get/list from directive files", async () => {
		await core.filesystem.createDirective("Release 1");

		const directivesOutput = execSync(
			`node --experimental-strip-types ${CLI_PATH} config get directives`,
			{ cwd: TEST_DIR },
		).text();
		expect(directivesOutput.trim()).toBe("m-0");

		const listOutput = execSync(
			`node --experimental-strip-types ${CLI_PATH} config list`,
			{ cwd: TEST_DIR },
		).text();
		assert.ok(listOutput.includes("directives: [m-0]"));
	});

	afterEach(async () => {
		try {
			await safeCleanup(TEST_DIR);
		} catch {
			// Ignore cleanup errors - the unique directory names prevent conflicts
		}
	});

	it("should save and load defaultEditor config", async () => {
		// Load initial config
		const config = await core.filesystem.loadConfig();
		assert.ok(config);
		assert.strictEqual(config?.defaultEditor, undefined);

		// Set defaultEditor
		if (config) {
			config.defaultEditor = "nano";
			await core.filesystem.saveConfig(config);
		}

		// Reload config and verify it was saved
		const reloadedConfig = await core.filesystem.loadConfig();
		assert.ok(reloadedConfig);
		assert.strictEqual(reloadedConfig?.defaultEditor, "nano");
	});

	it("should handle config with and without defaultEditor", async () => {
		// Initially undefined
		let config = await core.filesystem.loadConfig();
		assert.strictEqual(config?.defaultEditor, undefined);

		// Set to a value
		if (config) {
			config.defaultEditor = "vi";
			await core.filesystem.saveConfig(config);
		}

		config = await core.filesystem.loadConfig();
		assert.strictEqual(config?.defaultEditor, "vi");

		// Clear the value
		if (config) {
			config.defaultEditor = undefined;
			await core.filesystem.saveConfig(config);
		}

		config = await core.filesystem.loadConfig();
		assert.strictEqual(config?.defaultEditor, undefined);
	});

	it("should preserve other config values when setting defaultEditor", async () => {
		let config = await core.filesystem.loadConfig();
		const originalProjectName = config?.projectName;
		const originalStatuses = config ? [...config.statuses] : [];

		// Set defaultEditor
		if (config) {
			config.defaultEditor = "code";
			await core.filesystem.saveConfig(config);
		}

		// Reload and verify other values are preserved
		config = await core.filesystem.loadConfig();
		assert.strictEqual(config?.defaultEditor, "code");
		assert.strictEqual(config?.projectName, originalProjectName ?? "");
		assert.deepStrictEqual(config?.statuses, originalStatuses);
	});
});
