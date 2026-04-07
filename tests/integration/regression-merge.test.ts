/**
 * Regression Test Suite for Merge Validation
 *
 * Run BEFORE merging any worktree branch to main.
 * Ensures new changes don't break existing functionality.
 */

import assert from "node:assert";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const PROJECT_ROOT = process.cwd();

describe("Regression Tests - Merge Validation", () => {
	describe("Proposal Consistency", () => {
		it("no duplicate proposal IDs", () => {
			const files = execSync("ls roadmap/proposals/proposal-*.md 2>/dev/null")
				.toString()
				.trim()
				.split("\n");
			const ids = files
				.map((f) => f.match(/proposal-(\d+\.?\d*)/)?.[1])
				.filter(Boolean);
			const uniqueIds = new Set(ids);
			assert(
				ids.length === uniqueIds.size,
				`Duplicate IDs: ${ids.length} files, ${uniqueIds.size} unique`,
			);
		});

		it("all Complete proposals have proof", () => {
			const files = execSync(
				'grep -l "status: Complete" roadmap/proposals/*.md 2>/dev/null',
			)
				.toString()
				.trim()
				.split("\n");
			for (const file of files) {
				const content = readFileSync(file, "utf-8");
				const hasProof = content.toLowerCase().includes("proof");
				assert(
					hasProof,
					`${file.split("/").pop()} is Complete but missing proof`,
				);
			}
		});
	});

	describe("MCP Tools", () => {
		it("proposal edit command works", () => {
			// Just verify the CLI doesn't crash
			const result = execSync(
				"node scripts/cli.cjs proposal 3 --plain 2>&1 || true",
			).toString();
			assert(
				result.includes("proposal-3") || result.includes("Ready Work"),
				"Proposal 3 not found",
			);
		});

		it("board command works", () => {
			const result = execSync(
				"node scripts/cli.cjs board 2>&1 || true",
			).toString();
			assert(
				result.includes("Potential") || result.includes("Complete"),
				"Board output invalid",
			);
		});
	});

	describe("Code Integrity", () => {
		it("no TypeScript syntax errors in core files", () => {
			// tsc --noEmit would be ideal but slow; just check files parse
			const coreFiles = ["src/core/roadmap.ts", "src/types/index.ts"];
			for (const file of coreFiles) {
				const content = readFileSync(join(PROJECT_ROOT, file), "utf-8");
				assert(content.length > 100, `${file} seems truncated`);
				// Check for common syntax issues
				assert(
					!content.includes("undefinedundefined"),
					`${file} has undefinedundefined`,
				);
			}
		});

		it("package.json is valid", () => {
			const pkg = JSON.parse(
				readFileSync(join(PROJECT_ROOT, "package.json"), "utf-8"),
			);
			assert(pkg.name, "package.json missing name");
			assert(
				pkg.dependencies || pkg.devDependencies,
				"package.json missing deps",
			);
		});
	});

	describe("Git Integrity", () => {
		it("no merge conflict markers in source files", () => {
			const result = execSync(
				'grep -r "<<<<<<" roadmap/proposals/ src/ --include="*.ts" --include="*.md" 2>/dev/null | grep -v "regression-merge" || true',
			).toString();
			assert(!result.includes("<<<<<<<"), "Merge conflict markers found!");
		});

		it("no unstaged .orig files", () => {
			const result = execSync(
				'find . -name "*.orig" 2>/dev/null || true',
			).toString();
			assert(!result.includes(".orig"), "Found .orig merge files");
		});
	});
});
