/**
 * Test Discovery Module
 * Scans test directories and categorizes tests by type.
 */

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

export type TestCategory = "unit" | "integration" | "e2e" | "regression";

export interface TestFile {
	/** Absolute path to the test file */
	path: string;
	/** Filename without directory */
	name: string;
	/** Detected category based on naming convention */
	category: TestCategory;
	/** Estimated size in bytes */
	size: number;
}

export interface TestDiscoveryResult {
	/** All discovered test files */
	tests: TestFile[];
	/** Tests grouped by category */
	byCategory: Record<TestCategory, TestFile[]>;
	/** Total count */
	total: number;
	/** Discovery timestamp */
	discoveredAt: string;
}

/**
 * Determine test category from filename.
 * Naming conventions:
 *   - regression-*.test.ts → regression
 *   - e2e-*.test.ts → e2e
 *   - cli-*.test.ts, mcp-*.test.ts, board-*.test.ts → integration
 *   - *.test.ts → unit
 */
export function categorizeTestFile(filename: string): TestCategory {
	const name = basename(filename);

	if (name.startsWith("regression-")) return "regression";
	if (name.startsWith("e2e-")) return "e2e";
	if (
		name.startsWith("cli-") ||
		name.startsWith("mcp-") ||
		name.startsWith("board-")
	)
		return "integration";

	return "unit";
}

/**
 * Scan a directory for test files recursively.
 */
export async function scanTestDirectory(dirPath: string): Promise<TestFile[]> {
	const results: TestFile[] = [];

	async function scan(dir: string): Promise<void> {
		let entries: Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return; // Directory doesn't exist or not accessible
		}

		for (const entry of entries) {
			const fullPath = join(dir, entry.name);

			if (entry.isDirectory()) {
				// Skip node_modules and hidden directories
				if (entry.name === "node_modules" || entry.name.startsWith("."))
					continue;
				await scan(fullPath);
			} else if (entry.name.endsWith(".test.ts")) {
				const info = await stat(fullPath);
				results.push({
					path: fullPath,
					name: entry.name,
					category: categorizeTestFile(entry.name),
					size: info.size,
				});
			}
		}
	}

	await scan(dirPath);
	return results;
}

/**
 * Discover all tests in the project's test directory.
 */
export async function discoverTests(
	testDir: string,
): Promise<TestDiscoveryResult> {
	const tests = await scanTestDirectory(testDir);

	const byCategory: Record<TestCategory, TestFile[]> = {
		unit: [],
		integration: [],
		e2e: [],
		regression: [],
	};

	for (const test of tests) {
		byCategory[test.category].push(test);
	}

	return {
		tests,
		byCategory,
		total: tests.length,
		discoveredAt: new Date().toISOString(),
	};
}

/**
 * Filter tests by category.
 */
export function filterByCategory(
	result: TestDiscoveryResult,
	category: TestCategory,
): TestFile[] {
	return result.byCategory[category] || [];
}

/**
 * Get test statistics summary.
 */
export function getTestStats(result: TestDiscoveryResult): string {
	const lines = [
		`Total tests: ${result.total}`,
		`  Unit: ${result.byCategory.unit.length}`,
		`  Integration: ${result.byCategory.integration.length}`,
		`  E2E: ${result.byCategory.e2e.length}`,
		`  Regression: ${result.byCategory.regression.length}`,
	];
	return lines.join("\n");
}
