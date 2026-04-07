/**
 * Tests for proposal-41: Framework Adapter Contract
 * - Framework adapter interface defined
 * - Project detection identifies framework from package.json
 * - Coding standards loaded from project config
 * - Testing patterns adapt to project setup
 * - Adapter contract versioned for compatibility
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	FRAMEWORK_ADAPTER_VERSION,
	FrameworkAdapterImpl,
} from "../../src/core/identity/framework-adapter.ts";

const TEST_BASE = join(import.meta.dirname, "../../tmp/test-framework-adapter");

describe("proposal-41: Framework Adapter Contract", () => {
	let testDir: string;
	let adapter: FrameworkAdapterImpl;
	let testCounter = 0;

	beforeEach(() => {
		testCounter++;
		testDir = join(TEST_BASE, `test-${Date.now()}-${testCounter}`);
		mkdirSync(testDir, { recursive: true });
		adapter = new FrameworkAdapterImpl(testDir);
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	const writePackageJson = (pkg: Record<string, unknown>) => {
		writeFileSync(join(testDir, "package.json"), JSON.stringify(pkg, null, 2));
	};

	describe("AC#1: Framework adapter interface defined", () => {
		it("returns complete adapter contract", () => {
			writePackageJson({
				name: "test-project",
				dependencies: { react: "^18.0.0" },
				devDependencies: { typescript: "^5.0.0" },
			});

			const result = adapter.getAdapter();

			assert.equal(result.version, FRAMEWORK_ADAPTER_VERSION);
			assert.equal(result.projectRoot, testDir);
			assert.ok(result.detection);
			assert.ok(result.standards);
			assert.ok(result.testing);
			assert.ok(result.extensions);
			assert.ok(result.scripts);
		});

		it("includes version in contract", () => {
			const result = adapter.getAdapter();
			assert.ok(result.version);
			assert.match(result.version, /^\d+\.\d+\.\d+$/);
		});

		it("caches adapter result", () => {
			writePackageJson({ name: "test" });
			const r1 = adapter.getAdapter();
			const r2 = adapter.getAdapter();
			assert.strictEqual(r1, r2);
		});

		it("invalidates cache when requested", () => {
			writePackageJson({ name: "test" });
			const r1 = adapter.getAdapter();
			adapter.invalidateCache();
			const r2 = adapter.getAdapter();
			assert.notStrictEqual(r1, r2);
		});
	});

	describe("AC#2: Project detection from package.json", () => {
		it("detects React project", () => {
			writePackageJson({
				dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" },
			});

			const result = adapter.getAdapter();
			assert.equal(result.detection.framework, "react");
			assert.ok(result.detection.matchedDeps.includes("react"));
		});

		it("detects Vue project", () => {
			writePackageJson({
				dependencies: { vue: "^3.0.0", "vue-router": "^4.0.0" },
			});

			const result = adapter.getAdapter();
			assert.equal(result.detection.framework, "vue");
		});

		it("detects Next.js project (higher priority than React)", () => {
			writePackageJson({
				dependencies: { next: "^14.0.0", react: "^18.0.0" },
			});

			const result = adapter.getAdapter();
			assert.equal(result.detection.framework, "nextjs");
		});

		it("detects Express project", () => {
			writePackageJson({
				dependencies: { express: "^4.0.0" },
			});

			const result = adapter.getAdapter();
			assert.equal(result.detection.framework, "express");
		});

		it("detects NestJS project", () => {
			writePackageJson({
				dependencies: {
					"@nestjs/core": "^10.0.0",
					"@nestjs/common": "^10.0.0",
				},
			});

			const result = adapter.getAdapter();
			assert.equal(result.detection.framework, "nest");
		});

		it("detects TypeScript", () => {
			writePackageJson({
				devDependencies: { typescript: "^5.0.0" },
			});

			const result = adapter.getAdapter();
			assert.equal(result.detection.typescript, true);
		});

		it("detects TypeScript from tsconfig.json", () => {
			writePackageJson({ name: "test" });
			writeFileSync(join(testDir, "tsconfig.json"), "{}");

			const result = adapter.getAdapter();
			assert.equal(result.detection.typescript, true);
		});

		it("detects npm package manager", () => {
			writePackageJson({ name: "test" });
			writeFileSync(join(testDir, "package-lock.json"), "{}");

			const result = adapter.getAdapter();
			assert.equal(result.detection.packageManager, "npm");
		});

		it("detects pnpm package manager", () => {
			writePackageJson({ name: "test" });
			writeFileSync(join(testDir, "pnpm-lock.yaml"), "");

			const result = adapter.getAdapter();
			assert.equal(result.detection.packageManager, "pnpm");
		});

		it("detects monorepo from workspaces", () => {
			writePackageJson({
				name: "monorepo",
				workspaces: ["packages/*"],
			});

			const result = adapter.getAdapter();
			assert.equal(result.detection.isMonorepo, true);
		});

		it("detects monorepo from pnpm-workspace.yaml", () => {
			writePackageJson({ name: "test" });
			writeFileSync(
				join(testDir, "pnpm-workspace.yaml"),
				"packages:\n  - packages/*",
			);

			const result = adapter.getAdapter();
			assert.equal(result.detection.isMonorepo, true);
		});

		it("returns unknown for missing package.json", () => {
			const result = adapter.getAdapter();
			assert.equal(result.detection.framework, "unknown");
			assert.equal(result.detection.packageManager, "unknown");
		});
	});

	describe("AC#3: Coding standards from project config", () => {
		it("loads defaults when no config exists", () => {
			writePackageJson({ name: "test" });

			const result = adapter.getAdapter();
			assert.equal(result.standards.indentation, "spaces");
			assert.equal(result.standards.indentSize, 2);
			assert.equal(result.standards.semi, true);
		});

		it("loads Prettier configuration", () => {
			writePackageJson({ name: "test" });
			writeFileSync(
				join(testDir, ".prettierrc"),
				JSON.stringify({
					singleQuote: true,
					tabWidth: 4,
					useTabs: true,
					printWidth: 120,
				}),
			);

			const result = adapter.getAdapter();
			assert.equal(result.standards.formatter, "prettier");
			assert.equal(result.standards.quotes, "single");
			assert.equal(result.standards.indentSize, 4);
			assert.equal(result.standards.indentation, "tabs");
			assert.equal(result.standards.lineLength, 120);
		});

		it("loads Biome configuration", () => {
			writePackageJson({ name: "test" });
			writeFileSync(
				join(testDir, "biome.json"),
				JSON.stringify({
					format: {
						indentStyle: "tab",
						lineWidth: 80,
					},
				}),
			);

			const result = adapter.getAdapter();
			assert.equal(result.standards.linter, "biome");
			assert.equal(result.standards.formatter, "biome");
			assert.equal(result.standards.indentation, "tabs");
			assert.equal(result.standards.lineLength, 80);
		});

		it("detects ESLint", () => {
			writePackageJson({ name: "test" });
			writeFileSync(join(testDir, ".eslintrc.json"), "{}");

			const result = adapter.getAdapter();
			assert.equal(result.standards.linter, "eslint");
		});

		it("applies Vue framework defaults", () => {
			writePackageJson({
				dependencies: { vue: "^3.0.0" },
			});

			const result = adapter.getAdapter();
			assert.equal(result.standards.indentSize, 2);
			assert.equal(result.standards.quotes, "double");
		});

		it("applies Angular framework defaults", () => {
			writePackageJson({
				dependencies: { "@angular/core": "^17.0.0" },
			});

			const result = adapter.getAdapter();
			assert.equal(result.standards.quotes, "single");
		});
	});

	describe("AC#4: Testing patterns adapt to project setup", () => {
		it("detects Vitest", () => {
			writePackageJson({
				devDependencies: { vitest: "^1.0.0" },
			});

			const result = adapter.getAdapter();
			assert.equal(result.testing.runner, "vitest");
			assert.equal(result.testing.snapshots, true);
			assert.equal(result.testing.mocking, true);
		});

		it("detects Jest", () => {
			writePackageJson({
				devDependencies: { jest: "^29.0.0" },
			});

			const result = adapter.getAdapter();
			assert.equal(result.testing.runner, "jest");
			assert.equal(result.testing.snapshots, true);
		});

		it("detects Playwright", () => {
			writePackageJson({
				devDependencies: { "@playwright/test": "^1.40.0" },
			});

			const result = adapter.getAdapter();
			assert.equal(result.testing.runner, "playwright");
			assert.ok(result.testing.filePatterns.includes("**/*.e2e.ts"));
		});

		it("detects Cypress", () => {
			writePackageJson({
				devDependencies: { cypress: "^13.0.0" },
			});

			const result = adapter.getAdapter();
			assert.equal(result.testing.runner, "cypress");
		});

		it("detects node:test from scripts", () => {
			writePackageJson({
				devDependencies: { typescript: "^5.0.0" },
				scripts: { test: "node --test" },
			});

			const result = adapter.getAdapter();
			assert.equal(result.testing.runner, "node-test");
		});

		it("detects test directory", () => {
			writePackageJson({ name: "test" });
			mkdirSync(join(testDir, "tests"));

			const result = adapter.getAdapter();
			assert.equal(result.testing.testDir, "tests");
		});

		it("returns none for empty project", () => {
			writePackageJson({ name: "test" });

			const result = adapter.getAdapter();
			assert.equal(result.testing.runner, "none");
		});
	});

	describe("AC#5: Adapter contract versioned for compatibility", () => {
		it("returns current version", () => {
			assert.ok(FRAMEWORK_ADAPTER_VERSION);
			assert.match(FRAMEWORK_ADAPTER_VERSION, /^\d+\.\d+\.\d+$/);
		});

		it("compatible when major version matches", () => {
			const [major] = FRAMEWORK_ADAPTER_VERSION.split(".");
			const result = adapter.checkCompatibility(`${major}.0.0`);
			assert.equal(result, true);
		});

		it("incompatible when required major is higher", () => {
			const result = adapter.checkCompatibility("99.0.0");
			assert.equal(result, false);
		});

		it("compatible when required major is lower", () => {
			const result = adapter.checkCompatibility("0.0.1");
			assert.equal(result, true);
		});
	});

	describe("File extensions", () => {
		it("returns TS extensions for TypeScript project", () => {
			writePackageJson({
				devDependencies: { typescript: "^5.0.0" },
			});

			const result = adapter.getAdapter();
			assert.ok(result.extensions.source.includes(".ts"));
			assert.ok(result.extensions.test.includes(".test.ts"));
		});

		it("returns JS extensions for non-TypeScript project", () => {
			writePackageJson({ name: "test" });

			const result = adapter.getAdapter();
			assert.ok(result.extensions.source.includes(".js"));
			assert.ok(result.extensions.test.includes(".test.js"));
		});

		it("includes JSX extensions for React", () => {
			writePackageJson({
				dependencies: { react: "^18.0.0" },
				devDependencies: { typescript: "^5.0.0" },
			});

			const result = adapter.getAdapter();
			assert.ok(result.extensions.source.includes(".tsx"));
		});
	});
});
