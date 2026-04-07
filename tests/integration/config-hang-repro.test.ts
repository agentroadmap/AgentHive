import assert from "node:assert";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Core } from "../../src/core/roadmap.ts";
import { FileSystem } from "../../src/file-system/operations.ts";
import type { RoadmapConfig } from "../../src/types/index.ts";
import { expect } from "../support/test-utils.ts";

describe("Config Loading & Migration", () => {
	const testRoot = "/tmp/test-config-migration";
	const roadmapDir = join(testRoot, "roadmap");
	const configPath = join(roadmapDir, "config.yml");

	beforeEach(async () => {
		await rm(testRoot, { recursive: true, force: true });
		await mkdir(roadmapDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(testRoot, { recursive: true, force: true });
	});

	it("should load config from standard roadmap directory", async () => {
		const config = `project_name: "Test Project"
statuses: ["New", "Active", "Accepted", "Complete", "Abandoned"]
labels: []
directives: []
default_status: "New"
date_format: "yyyy-mm-dd"
max_column_width: 20
auto_commit: false`;

		await writeFile(configPath, config);

		const fs = new FileSystem(testRoot);

		// This should complete without hanging
		const timeoutPromise = new Promise((_, reject) => {
			setTimeout(
				() =>
					reject(
						new Error("Config loading timed out - infinite loop detected!"),
					),
				5000,
			);
		});

		const loadedConfig = (await Promise.race([
			fs.loadConfig(),
			timeoutPromise,
		])) as RoadmapConfig | null;

		assert.ok(loadedConfig);
		assert.strictEqual(loadedConfig?.projectName, "Test Project");
	});

	it("should migrate legacy .roadmap directory to roadmap", async () => {
		// Create a legacy .roadmap directory instead of roadmap
		const legacyRoadmapDir = join(testRoot, ".roadmap");
		const legacyConfigPath = join(legacyRoadmapDir, "config.yml");

		await rm(roadmapDir, { recursive: true, force: true });
		await mkdir(legacyRoadmapDir, { recursive: true });

		const legacyConfig = `project_name: "Legacy Project"
statuses: ["New", "Active", "Accepted", "Complete", "Abandoned"]
labels: []
directives: []
default_status: "New"
date_format: "yyyy-mm-dd"
max_column_width: 20
auto_commit: false`;

		await writeFile(legacyConfigPath, legacyConfig);

		const fs = new FileSystem(testRoot);
		const config = await fs.loadConfig();

		// Check that config was loaded
		assert.ok(config);
		assert.strictEqual(config?.projectName, "Legacy Project");

		// Check that the directory was renamed
		const newRoadmapExists = stat(join(testRoot, "roadmap", "config.yml"))
			.then(() => true)
			.catch(() => false);
		const oldRoadmapExists = stat(join(testRoot, ".roadmap", "config.yml"))
			.then(() => true)
			.catch(() => false);

		assert.strictEqual(newRoadmapExists, true);
		assert.strictEqual(oldRoadmapExists, false);
	});

	it("migrates legacy config directives into directive files and removes config directives key", async () => {
		const config = `project_name: "Legacy Directives Project"
statuses: ["New", "Active", "Accepted", "Complete", "Abandoned"]
labels: []
directives: ["Release 1", "Release 2"]
default_status: "New"
date_format: "yyyy-mm-dd"
max_column_width: 20
auto_commit: false`;

		await writeFile(configPath, config);
		const core = new Core(testRoot);
		await core.ensureConfigMigrated();

		const migratedDirectives = await core.filesystem.listDirectives();
		expect(
			migratedDirectives.map((directive) => directive.title).sort(),
		).toEqual(["Release 1", "Release 2"]);

		const rewrittenConfig = await await readFile(configPath, "utf-8");
		assert.ok(!rewrittenConfig.includes("directives:"));
	});

	it("migrates quoted legacy directive names containing commas", async () => {
		const config = `project_name: "Legacy Directives Project"
statuses: ["New", "Active", "Accepted", "Complete", "Abandoned"]
labels: []
directives: ["Release, Part 1", "Release 2"]
default_status: "New"
date_format: "yyyy-mm-dd"
max_column_width: 20
auto_commit: false`;

		await writeFile(configPath, config);
		const core = new Core(testRoot);
		await core.ensureConfigMigrated();

		const migratedDirectives = await core.filesystem.listDirectives();
		expect(
			migratedDirectives.map((directive) => directive.title).sort(),
		).toEqual(["Release 2", "Release, Part 1"]);
	});

	it("migrates multiline legacy directive list values with comments", async () => {
		const config = `project_name: "Legacy Directives Project"
statuses: ["New", "Active", "Accepted", "Complete", "Abandoned"]
labels: []
directives:
  - "Release 1"
  - Release 2 # comment
  - 'Release #3'
default_status: "New"
date_format: "yyyy-mm-dd"
max_column_width: 20
auto_commit: false`;

		await writeFile(configPath, config);
		const core = new Core(testRoot);
		await core.ensureConfigMigrated();

		const migratedDirectives = await core.filesystem.listDirectives();
		expect(
			migratedDirectives.map((directive) => directive.title).sort(),
		).toEqual(["Release #3", "Release 1", "Release 2"]);

		const rewrittenConfig = await await readFile(configPath, "utf-8");
		assert.ok(!rewrittenConfig.includes("directives:"));
	});

	it("migrates multiline bracketed legacy directive arrays", async () => {
		const config = `project_name: "Legacy Directives Project"
statuses: ["New", "Active", "Accepted", "Complete", "Abandoned"]
labels: []
directives: [
  "Release 1",
  "Release 2"
]
default_status: "New"
date_format: "yyyy-mm-dd"
max_column_width: 20
auto_commit: false`;

		await writeFile(configPath, config);
		const core = new Core(testRoot);
		await core.ensureConfigMigrated();

		const migratedDirectives = await core.filesystem.listDirectives();
		expect(
			migratedDirectives.map((directive) => directive.title).sort(),
		).toEqual(["Release 1", "Release 2"]);
	});

	it("migrates single-quoted legacy directives with escaped apostrophes", async () => {
		const config = `project_name: "Legacy Directives Project"
statuses: ["New", "Active", "Accepted", "Complete", "Abandoned"]
labels: []
directives:
  - 'Release ''Alpha'''
default_status: "New"
date_format: "yyyy-mm-dd"
max_column_width: 20
auto_commit: false`;

		await writeFile(configPath, config);
		const core = new Core(testRoot);
		await core.ensureConfigMigrated();

		const migratedDirectives = await core.filesystem.listDirectives();
		expect(migratedDirectives.map((directive) => directive.title)).toEqual([
			"Release 'Alpha'",
		]);
	});
});
