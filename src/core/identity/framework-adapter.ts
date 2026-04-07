/**
 * STATE-41: Framework Adapter Contract
 *
 * Standard interface for agents to work with different project frameworks.
 * Defines how agents discover project structure, coding standards, and testing patterns.
 *
 * AC#1: Framework adapter interface defined
 * AC#2: Project detection identifies framework from package.json
 * AC#3: Coding standards loaded from project config
 * AC#4: Testing patterns adapt to project setup
 * AC#5: Adapter contract versioned for compatibility
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Contract version for compatibility checking */
export const FRAMEWORK_ADAPTER_VERSION = "1.0.0";

/** Supported framework types */
export type FrameworkType =
	| "react"
	| "vue"
	| "angular"
	| "svelte"
	| "nextjs"
	| "nuxt"
	| "express"
	| "fastify"
	| "nest"
	| "astro"
	| "remix"
	| "node"
	| "unknown";

/** Detected project metadata */
export interface ProjectDetection {
	/** Primary framework detected */
	framework: FrameworkType;
	/** All dependencies that were matched */
	matchedDeps: string[];
	/** TypeScript enabled */
	typescript: boolean;
	/** Package manager detected */
	packageManager: "npm" | "yarn" | "pnpm" | "bun" | "unknown";
	/** Monorepo detected */
	isMonorepo: boolean;
	/** Raw package.json content */
	packageJson: Record<string, unknown>;
}

/** Coding standard configuration */
export interface CodingStandards {
	/** Indentation style */
	indentation: "spaces" | "tabs";
	/** Indentation size */
	indentSize: number;
	/** Semicolons required */
	semi: boolean;
	/** Single or double quotes */
	quotes: "single" | "double" | "backtick";
	/** Trailing commas */
	trailingComma: "none" | "es5" | "all";
	/** Max line length */
	lineLength: number;
	/** Linter configured */
	linter: "eslint" | "biome" | "none";
	/** Formatter configured */
	formatter: "prettier" | "biome" | "none";
	/** Source config (prettier, eslint, biome, etc) */
	sourceConfig: Record<string, unknown>;
}

/** Testing pattern configuration */
export interface TestingPatterns {
	/** Test runner */
	runner:
		| "jest"
		| "vitest"
		| "mocha"
		| "playwright"
		| "cypress"
		| "node-test"
		| "none";
	/** Test file patterns */
	filePatterns: string[];
	/** Test directory */
	testDir: string;
	/** Snapshot testing supported */
	snapshots: boolean;
	/** Mock utilities available */
	mocking: boolean;
	/** Coverage tool */
	coverage: string | null;
}

/** Complete framework adapter contract */
export interface FrameworkAdapter {
	/** Contract version */
	version: typeof FRAMEWORK_ADAPTER_VERSION;
	/** Project root path */
	projectRoot: string;
	/** Detected project info */
	detection: ProjectDetection;
	/** Coding standards */
	standards: CodingStandards;
	/** Testing patterns */
	testing: TestingPatterns;
	/** Recommended file extensions */
	extensions: {
		source: string[];
		test: string[];
		config: string[];
	};
	/** Available scripts from package.json */
	scripts: Record<string, string>;
}

/** Framework detection rules */
const FRAMEWORK_RULES: Array<{
	framework: FrameworkType;
	deps: string[];
	score: number;
}> = [
	{ framework: "nextjs", deps: ["next"], score: 10 },
	{ framework: "nuxt", deps: ["nuxt", "@nuxt/kit"], score: 10 },
	{ framework: "astro", deps: ["astro"], score: 10 },
	{
		framework: "remix",
		deps: ["@remix-run/react", "@remix-run/node"],
		score: 10,
	},
	{ framework: "angular", deps: ["@angular/core", "@angular/cli"], score: 10 },
	{ framework: "svelte", deps: ["svelte", "@sveltejs/kit"], score: 9 },
	{ framework: "vue", deps: ["vue", "vue-router", "vuex", "pinia"], score: 8 },
	{
		framework: "react",
		deps: ["react", "react-dom", "react-router"],
		score: 8,
	},
	{ framework: "nest", deps: ["@nestjs/core", "@nestjs/common"], score: 10 },
	{ framework: "fastify", deps: ["fastify", "@fastify/*"], score: 9 },
	{ framework: "express", deps: ["express"], score: 8 },
	{ framework: "node", deps: [], score: 1 }, // Default for Node.js projects
];

/**
 * AC#1: Framework Adapter Interface
 * Main class for project detection and framework adaptation.
 */
export class FrameworkAdapterImpl {
	private projectRoot: string;
	private cachedAdapter?: FrameworkAdapter;

	constructor(projectRoot: string) {
		this.projectRoot = projectRoot;
	}

	/**
	 * AC#2: Project detection - identifies framework from package.json
	 */
	detectProject(): ProjectDetection {
		const packageJsonPath = join(this.projectRoot, "package.json");

		if (!existsSync(packageJsonPath)) {
			return {
				framework: "unknown",
				matchedDeps: [],
				typescript: false,
				packageManager: "unknown",
				isMonorepo: false,
				packageJson: {},
			};
		}

		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
		const allDeps = {
			...(packageJson.dependencies ?? {}),
			...(packageJson.devDependencies ?? {}),
			...(packageJson.peerDependencies ?? {}),
		};

		// Detect framework
		let detectedFramework: FrameworkType = "unknown";
		let highestScore = 0;
		const matchedDeps: string[] = [];

		for (const rule of FRAMEWORK_RULES) {
			let score = 0;
			const matches: string[] = [];

			for (const dep of rule.deps) {
				if (dep.includes("*")) {
					// Wildcard match (e.g., @fastify/*)
					const prefix = dep.replace("/*", "");
					const wildcardMatches = Object.keys(allDeps).filter((d) =>
						d.startsWith(prefix),
					);
					if (wildcardMatches.length > 0) {
						score += rule.score / rule.deps.length;
						matches.push(...wildcardMatches);
					}
				} else if (allDeps[dep]) {
					score += rule.score / rule.deps.length;
					matches.push(dep);
				}
			}

			if (score > highestScore) {
				highestScore = score;
				detectedFramework = rule.framework;
				matchedDeps.length = 0;
				matchedDeps.push(...matches);
			}
		}

		// Detect TypeScript
		const typescript = !!(
			allDeps.typescript ||
			existsSync(join(this.projectRoot, "tsconfig.json")) ||
			existsSync(join(this.projectRoot, "tsconfig.json"))
		);

		// Detect package manager
		let packageManager: ProjectDetection["packageManager"] = "unknown";
		if (existsSync(join(this.projectRoot, "pnpm-lock.yaml")))
			packageManager = "pnpm";
		else if (existsSync(join(this.projectRoot, "yarn.lock")))
			packageManager = "yarn";
		else if (
			existsSync(join(this.projectRoot, "bun.lockb")) ||
			existsSync(join(this.projectRoot, "bun.lock"))
		)
			packageManager = "bun";
		else if (existsSync(join(this.projectRoot, "package-lock.json")))
			packageManager = "npm";

		// Detect monorepo
		const isMonorepo = !!(
			packageJson.workspaces ||
			existsSync(join(this.projectRoot, "lerna.json")) ||
			existsSync(join(this.projectRoot, "pnpm-workspace.yaml")) ||
			existsSync(join(this.projectRoot, "nx.json"))
		);

		return {
			framework: detectedFramework,
			matchedDeps,
			typescript,
			packageManager,
			isMonorepo,
			packageJson,
		};
	}

	/**
	 * AC#3: Coding standards loaded from project config
	 * Reads from prettier, biome, eslint, or editorconfig
	 */
	loadCodingStandards(detection: ProjectDetection): CodingStandards {
		const standards: CodingStandards = {
			indentation: "spaces",
			indentSize: 2,
			semi: true,
			quotes: "double",
			trailingComma: "es5",
			lineLength: 100,
			linter: "none",
			formatter: "none",
			sourceConfig: {},
		};

		// Check Biome (has higher priority if present)
		const biomePath = join(this.projectRoot, "biome.json");
		if (existsSync(biomePath)) {
			try {
				const biome = JSON.parse(readFileSync(biomePath, "utf-8"));
				standards.linter = "biome";
				standards.formatter = "biome";
				standards.sourceConfig = biome;

				if (biome.format?.indentStyle === "tab") standards.indentation = "tabs";
				if (biome.format?.indentSize)
					standards.indentSize = biome.format.indentSize;
				if (biome.format?.lineWidth)
					standards.lineLength = biome.format.lineWidth;
				// Biome defaults match our defaults, so we're good
			} catch {}
		}

		// Check Prettier
		const prettierPaths = [
			join(this.projectRoot, ".prettierrc"),
			join(this.projectRoot, ".prettierrc.json"),
			join(this.projectRoot, ".prettierrc.js"),
		];
		for (const p of prettierPaths) {
			if (existsSync(p)) {
				standards.formatter = "prettier";
				try {
					const content = readFileSync(p, "utf-8");
					// Only parse JSON variants
					if (p.endsWith(".json") || p.endsWith(".prettierrc")) {
						const prettier = JSON.parse(content);
						standards.sourceConfig = prettier;
						if (prettier.semi === false) standards.semi = false;
						if (prettier.singleQuote) standards.quotes = "single";
						if (prettier.tabWidth) standards.indentSize = prettier.tabWidth;
						if (prettier.useTabs) standards.indentation = "tabs";
						if (prettier.trailingComma === "none")
							standards.trailingComma = "none";
						if (prettier.printWidth) standards.lineLength = prettier.printWidth;
					}
				} catch {}
				break;
			}
		}

		// Check ESLint
		const eslintPaths = [
			join(this.projectRoot, ".eslintrc"),
			join(this.projectRoot, ".eslintrc.json"),
			join(this.projectRoot, "eslint.config.js"),
		];
		for (const p of eslintPaths) {
			if (existsSync(p)) {
				standards.linter = "eslint";
				break;
			}
		}

		// Framework-specific defaults
		switch (detection.framework) {
			case "vue":
				standards.indentSize = 2;
				standards.quotes = "double";
				break;
			case "angular":
				standards.indentSize = 2;
				standards.quotes = "single";
				break;
			case "express":
			case "node":
				standards.indentSize = 2;
				break;
		}

		return standards;
	}

	/**
	 * AC#4: Testing patterns adapt to project setup
	 */
	loadTestingPatterns(detection: ProjectDetection): TestingPatterns {
		const deps = detection.packageJson.dependencies as
			| Record<string, string>
			| undefined;
		const devDeps = detection.packageJson.devDependencies as
			| Record<string, string>
			| undefined;
		const allDeps: Record<string, string> = {
			...(deps ?? {}),
			...(devDeps ?? {}),
		};

		const patterns: TestingPatterns = {
			runner: "none",
			filePatterns: [],
			testDir: "test",
			snapshots: false,
			mocking: false,
			coverage: null,
		};

		// Detect test runner (priority order)
		if (allDeps.vitest) {
			patterns.runner = "vitest";
			patterns.filePatterns = [
				"**/*.test.ts",
				"**/*.test.tsx",
				"**/*.spec.ts",
				"**/*.spec.tsx",
			];
			patterns.snapshots = true;
			patterns.mocking = true;
			patterns.coverage = "v8";
		} else if (allDeps.jest) {
			patterns.runner = "jest";
			patterns.filePatterns = [
				"**/*.test.ts",
				"**/*.test.tsx",
				"**/*.spec.ts",
				"**/*.spec.tsx",
			];
			patterns.snapshots = true;
			patterns.mocking = true;
			patterns.coverage = "jest";
		} else if (allDeps["@playwright/test"]) {
			patterns.runner = "playwright";
			patterns.filePatterns = ["**/*.spec.ts", "**/*.e2e.ts"];
			patterns.testDir = "e2e";
		} else if (allDeps.cypress) {
			patterns.runner = "cypress";
			patterns.filePatterns = ["**/*.cy.ts", "**/*.cy.js"];
			patterns.testDir = "cypress/e2e";
		} else if (allDeps.mocha) {
			patterns.runner = "mocha";
			patterns.filePatterns = ["**/*.test.ts", "**/*.spec.ts"];
			patterns.mocking = true;
		}

		// Check if node:test is used (no external dep needed for Node.js)
		if (patterns.runner === "none" && detection.typescript) {
			// Check for test scripts
			const scripts = (detection.packageJson.scripts ?? {}) as Record<
				string,
				string
			>;
			if (scripts.test?.includes("node --test")) {
				patterns.runner = "node-test";
				patterns.filePatterns = ["**/*.test.ts", "**/*.test.js"];
			}
		}

		// Check for test directory existence
		const possibleTestDirs = [
			"test",
			"tests",
			"__tests__",
			"spec",
			"__mocks__",
		];
		for (const dir of possibleTestDirs) {
			if (existsSync(join(this.projectRoot, dir))) {
				patterns.testDir = dir;
				break;
			}
		}

		return patterns;
	}

	/**
	 * Get recommended file extensions based on detected framework
	 */
	getExtensions(detection: ProjectDetection): FrameworkAdapter["extensions"] {
		const isTS = detection.typescript;
		const ext = isTS ? ".ts" : ".js";
		const jsxExt = isTS ? ".tsx" : ".jsx";

		// Frontend frameworks use JSX/TSX
		const isFrontend = [
			"react",
			"vue",
			"svelte",
			"nextjs",
			"nuxt",
			"astro",
			"remix",
		].includes(detection.framework);

		const source = isFrontend ? [jsxExt, ext] : [ext];
		const test = [`.test${ext}`, `.spec${ext}`];
		if (isFrontend) {
			test.push(`.test${jsxExt}`, `.spec${jsxExt}`);
		}

		return {
			source,
			test,
			config: [".json", ".js", ".ts", ".yaml", ".yml"],
		};
	}

	/**
	 * AC#5: Get full adapter contract with version
	 */
	getAdapter(): FrameworkAdapter {
		if (this.cachedAdapter) return this.cachedAdapter;

		const detection = this.detectProject();
		const standards = this.loadCodingStandards(detection);
		const testing = this.loadTestingPatterns(detection);
		const extensions = this.getExtensions(detection);

		// Extract scripts from package.json
		const scripts = (detection.packageJson.scripts ?? {}) as Record<
			string,
			string
		>;

		this.cachedAdapter = {
			version: FRAMEWORK_ADAPTER_VERSION,
			projectRoot: this.projectRoot,
			detection,
			standards,
			testing,
			extensions,
			scripts,
		};

		return this.cachedAdapter;
	}

	/**
	 * Invalidate cached adapter (call after project changes)
	 */
	invalidateCache(): void {
		this.cachedAdapter = undefined;
	}

	/**
	 * Check adapter contract compatibility
	 */
	checkCompatibility(requiredVersion: string): boolean {
		const [requiredMajor] = requiredVersion.split(".").map(Number);
		const [currentMajor] = FRAMEWORK_ADAPTER_VERSION.split(".").map(Number);
		return currentMajor >= requiredMajor;
	}
}

/**
 * Create a framework adapter for a project.
 */
export function createFrameworkAdapter(
	projectRoot: string,
): FrameworkAdapterImpl {
	return new FrameworkAdapterImpl(projectRoot);
}
