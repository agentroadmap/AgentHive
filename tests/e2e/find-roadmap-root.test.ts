import assert from "node:assert";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	clearProjectRootCache,
	findRoadmapRoot,
} from "../../src/utils/find-roadmap-root.ts";
import { execSync } from "../support/test-utils.ts";

describe("findRoadmapRoot", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = join(tmpdir(), `roadmap-root-test-${Date.now()}`);
		await mkdir(testDir, { recursive: true });
		clearProjectRootCache();
	});

	afterEach(async () => {
		clearProjectRootCache();
		try {
			await rm(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	it("should find root when roadmap/ directory exists at start dir", async () => {
		// Create roadmap structure at root
		await mkdir(join(testDir, "roadmap", "proposals"), { recursive: true });

		const result = await findRoadmapRoot(testDir);
		assert.strictEqual(result, testDir);
	});

	it("should find root when roadmap.json exists at start dir", async () => {
		// Create roadmap.json at root
		await writeFile(
			join(testDir, "roadmap.json"),
			JSON.stringify({ name: "Test" }),
		);

		const result = await findRoadmapRoot(testDir);
		assert.strictEqual(result, testDir);
	});

	it("should find root from a subfolder", async () => {
		// Create roadmap structure at root
		await mkdir(join(testDir, "roadmap", "proposals"), { recursive: true });

		// Create nested subfolder
		const subfolder = join(testDir, "src", "components", "ui");
		await mkdir(subfolder, { recursive: true });

		const result = await findRoadmapRoot(subfolder);
		assert.strictEqual(result, testDir);
	});

	it("should find root from deeply nested subfolder", async () => {
		// Create roadmap.json at root
		await writeFile(
			join(testDir, "roadmap.json"),
			JSON.stringify({ name: "Test" }),
		);

		// Create deeply nested subfolder
		const deepFolder = join(testDir, "a", "b", "c", "d", "e", "f");
		await mkdir(deepFolder, { recursive: true });

		const result = await findRoadmapRoot(deepFolder);
		assert.strictEqual(result, testDir);
	});

	it("should return null when no roadmap project found", async () => {
		// Create a folder with no roadmap setup
		const emptyFolder = join(testDir, "empty");
		await mkdir(emptyFolder, { recursive: true });

		const result = await findRoadmapRoot(emptyFolder);
		assert.strictEqual(result, null);
	});

	it("should prefer roadmap/ directory over git root", async () => {
		// Initialize git repo
		execSync(`git init`, { cwd: testDir });

		// Create roadmap in a subfolder (simulating monorepo)
		const projectFolder = join(testDir, "packages", "my-project");
		await mkdir(join(projectFolder, "roadmap", "proposals"), {
			recursive: true,
		});

		// Search from within the project
		const searchDir = join(projectFolder, "src");
		await mkdir(searchDir, { recursive: true });

		const result = await findRoadmapRoot(searchDir);
		assert.strictEqual(result, projectFolder);
	});

	it("should find git root with roadmap as fallback", async () => {
		// Initialize git repo with roadmap at root
		execSync(`git init`, { cwd: testDir });
		await mkdir(join(testDir, "roadmap", "proposals"), { recursive: true });

		// Create subfolder without its own roadmap
		const subfolder = join(testDir, "packages", "lib");
		await mkdir(subfolder, { recursive: true });

		const result = await findRoadmapRoot(subfolder);
		assert.strictEqual(result, testDir);
	});

	it("should not use git root if it has no roadmap setup", async () => {
		// Initialize git repo WITHOUT roadmap
		execSync(`git init`, { cwd: testDir });

		// Create subfolder
		const subfolder = join(testDir, "src");
		await mkdir(subfolder, { recursive: true });

		const result = await findRoadmapRoot(subfolder);
		assert.strictEqual(result, null);
	});

	it("should handle nested git repos - find nearest roadmap root", async () => {
		// Initialize outer git repo with roadmap
		execSync(`git init`, { cwd: testDir });
		await mkdir(join(testDir, "roadmap", "proposals"), { recursive: true });

		// Create inner project with its own roadmap (nested repo scenario)
		const innerProject = join(testDir, "packages", "inner");
		await mkdir(innerProject, { recursive: true });
		execSync(`git init`, { cwd: innerProject });
		await mkdir(join(innerProject, "roadmap", "proposals"), {
			recursive: true,
		});

		// Search from within inner project
		const innerSrc = join(innerProject, "src");
		await mkdir(innerSrc, { recursive: true });

		const result = await findRoadmapRoot(innerSrc);
		// Should find the inner project's roadmap, not the outer one
		assert.strictEqual(result, innerProject);
	});

	it("should handle roadmap/ with roadmap.yaml", async () => {
		// Create roadmap structure with roadmap.yaml instead of proposals/
		await mkdir(join(testDir, "roadmap"), { recursive: true });
		await writeFile(join(testDir, "roadmap", "roadmap.yaml"), "name: Test");

		const result = await findRoadmapRoot(testDir);
		assert.strictEqual(result, testDir);
	});
});
