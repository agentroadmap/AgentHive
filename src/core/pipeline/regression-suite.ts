/**
 * STATE-48: Automated Regression Suite
 *
 * Automated test suite that runs on every proposal change to catch regressions.
 * Ensures new implementations don't break existing functionality.
 *
 * AC#1: Tests run automatically on proposal edit
 * AC#2: Test results posted to group-pulse channel
 * AC#3: Failed tests block proposal progression
 * AC#4: Test history tracked per proposal
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { discoverTests, type TestFile } from "./test-discovery.ts";
import {
	runTests,
	type TestResult,
	type TestRunReport,
} from "./test-runner.ts";

/** Test history entry for a single run */
export interface TestHistoryEntry {
	/** Proposal ID that triggered the run */
	proposalId: string;
	/** Proposal status at time of run */
	proposalStatus: string;
	/** Agent that triggered the run */
	agent: string;
	/** Run results summary */
	summary: TestRunReport["summary"];
	/** Individual test results */
	results: TestResult[];
	/** When the run started */
	startedAt: string;
	/** When the run completed */
	completedAt: string;
	/** Total duration in ms */
	duration: number;
	/** Whether run was triggered automatically */
	automatic: boolean;
}

/** Regression suite configuration */
export interface RegressionConfig {
	/** Enable automatic regression runs on proposal changes */
	enabled: boolean;
	/** Test categories to run (empty = all) */
	categories: string[];
	/** Timeout per test file in ms */
	timeout: number;
	/** Block proposal progression on failure */
	blockOnFailure: boolean;
	/** Post results to pulse channel */
	postToPulse: boolean;
	/** Maximum history entries to keep per proposal */
	maxHistoryPerProposal: number;
	/** Test files to always include (regardless of proposal) */
	alwaysInclude: string[];
	/** Test files to always exclude */
	alwaysExclude: string[];
}

/** Pulse event for posting results */
export interface PulseTestEvent {
	type: "test_run";
	proposalId: string;
	agent: string;
	summary: TestRunReport["summary"];
	passed: boolean;
	duration: number;
	timestamp: string;
	failedTests?: string[];
}

const DEFAULT_CONFIG: RegressionConfig = {
	enabled: true,
	categories: [],
	timeout: 30000,
	blockOnFailure: true,
	postToPulse: true,
	maxHistoryPerProposal: 50,
	alwaysInclude: [],
	alwaysExclude: [],
};

/**
 * Automated Regression Suite
 *
 * Manages automated test execution on proposal changes, tracks history,
 * and integrates with the pulse system for notifications.
 */
export class RegressionSuite {
	private config: RegressionConfig;
	private configPath: string;
	private historyDir: string;
	private projectRoot: string;

	constructor(projectRoot: string, config?: Partial<RegressionConfig>) {
		this.projectRoot = projectRoot;
		const roadmapDir = join(projectRoot, "roadmap");
		this.configPath = join(roadmapDir, ".cache", "regression-config.json");
		this.historyDir = join(roadmapDir, ".cache", "test-history");
		this.config = this.loadConfig();
		if (config) {
			this.config = { ...this.config, ...config };
			this.saveConfig();
		}
	}

	/**
	 * Load configuration from disk.
	 */
	private loadConfig(): RegressionConfig {
		if (existsSync(this.configPath)) {
			try {
				const data = JSON.parse(readFileSync(this.configPath, "utf-8"));
				return { ...DEFAULT_CONFIG, ...data };
			} catch {
				return { ...DEFAULT_CONFIG };
			}
		}
		return { ...DEFAULT_CONFIG };
	}

	/**
	 * Save configuration to disk.
	 */
	private saveConfig(): void {
		const dir = join(this.projectRoot, "roadmap", ".cache");
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
	}

	/**
	 * Get current configuration.
	 */
	getConfig(): RegressionConfig {
		return { ...this.config };
	}

	/**
	 * Update configuration.
	 */
	updateConfig(updates: Partial<RegressionConfig>): RegressionConfig {
		this.config = { ...this.config, ...updates };
		this.saveConfig();
		return this.config;
	}

	/**
	 * AC#1: Run regression tests automatically for a proposal change.
	 * Filters tests based on proposal-related categories.
	 */
	async runRegression(options: {
		proposalId: string;
		proposalStatus: string;
		agent: string;
		automatic?: boolean;
		testFiles?: string[];
	}): Promise<
		TestRunReport & { blocked: boolean; pulseEvent?: PulseTestEvent }
	> {
		if (!this.config.enabled) {
			throw new Error("Regression suite is disabled");
		}

		// Discover tests
		const discoveryResult = await discoverTests(this.projectRoot);
		const allTests = discoveryResult.tests;

		// Filter tests based on configuration
		let testsToRun = this.filterTests(allTests, options.proposalId);

		// Override with specific files if provided
		if (options.testFiles && options.testFiles.length > 0) {
			testsToRun = testsToRun.filter((t) =>
				options.testFiles?.includes(t.path),
			);
		}

		if (testsToRun.length === 0) {
			const emptyReport: TestRunReport = {
				results: [],
				summary: { total: 0, passed: 0, failed: 0, errors: 0 },
				totalDuration: 0,
				startedAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
			};
			return { ...emptyReport, blocked: false };
		}

		// Run tests
		const report = await runTests(testsToRun, {
			timeout: this.config.timeout,
			cwd: this.projectRoot,
		});

		// AC#3: Check if blocked
		const blocked = this.config.blockOnFailure && !this.allPassed(report);

		// AC#4: Record history
		this.recordHistory({
			proposalId: options.proposalId,
			proposalStatus: options.proposalStatus,
			agent: options.agent,
			summary: report.summary,
			results: report.results,
			startedAt: report.startedAt,
			completedAt: report.completedAt,
			duration: report.totalDuration,
			automatic: options.automatic ?? true,
		});

		// AC#2: Build pulse event
		const pulseEvent: PulseTestEvent | undefined = this.config.postToPulse
			? {
					type: "test_run",
					proposalId: options.proposalId,
					agent: options.agent,
					summary: report.summary,
					passed: this.allPassed(report),
					duration: report.totalDuration,
					timestamp: report.completedAt,
					failedTests: report.results
						.filter((r) => !r.passed)
						.map((r) => r.file),
				}
			: undefined;

		return { ...report, blocked, pulseEvent };
	}

	/**
	 * Filter tests based on configuration and proposal.
	 */
	private filterTests(tests: TestFile[], _proposalId: string): TestFile[] {
		let filtered = tests;

		// Exclude always-excluded
		if (this.config.alwaysExclude.length > 0) {
			filtered = filtered.filter(
				(t) => !this.config.alwaysExclude.some((ex) => t.path.includes(ex)),
			);
		}

		// Include always-included
		if (this.config.alwaysInclude.length > 0) {
			const included = filtered.map((t) => t.path);
			for (const include of this.config.alwaysInclude) {
				if (!included.includes(include)) {
					filtered.push({
						path: include,
						category: "integration",
						name: include,
						size: 0,
					});
				}
			}
		}

		// Filter by categories if specified
		if (this.config.categories.length > 0) {
			filtered = filtered.filter((t) =>
				this.config.categories.includes(t.category),
			);
		}

		return filtered;
	}

	/**
	 * Check if all tests passed.
	 */
	private allPassed(report: TestRunReport): boolean {
		return (
			report.summary.total > 0 && report.summary.passed === report.summary.total
		);
	}

	/**
	 * AC#4: Record test history for a proposal.
	 */
	private recordHistory(entry: TestHistoryEntry): void {
		if (!existsSync(this.historyDir)) {
			mkdirSync(this.historyDir, { recursive: true });
		}

		const historyPath = join(this.historyDir, `${entry.proposalId}.json`);
		let history: TestHistoryEntry[] = [];

		if (existsSync(historyPath)) {
			try {
				history = JSON.parse(readFileSync(historyPath, "utf-8"));
			} catch {
				history = [];
			}
		}

		history.push(entry);

		// Trim to max history
		if (history.length > this.config.maxHistoryPerProposal) {
			history = history.slice(-this.config.maxHistoryPerProposal);
		}

		writeFileSync(historyPath, JSON.stringify(history, null, 2));
	}

	/**
	 * AC#4: Get test history for a proposal.
	 */
	getProposalHistory(proposalId: string, limit?: number): TestHistoryEntry[] {
		const historyPath = join(this.historyDir, `${proposalId}.json`);

		if (!existsSync(historyPath)) {
			return [];
		}

		try {
			const history: TestHistoryEntry[] = JSON.parse(
				readFileSync(historyPath, "utf-8"),
			);
			return limit ? history.slice(-limit) : history;
		} catch {
			return [];
		}
	}

	/**
	 * Get history across all proposals.
	 */
	getGlobalHistory(limit?: number): TestHistoryEntry[] {
		if (!existsSync(this.historyDir)) {
			return [];
		}

		const allHistory: TestHistoryEntry[] = [];
		const files = readdirSync(this.historyDir);

		for (const file of files) {
			if (file.endsWith(".json")) {
				try {
					const history: TestHistoryEntry[] = JSON.parse(
						readFileSync(join(this.historyDir, file), "utf-8"),
					);
					allHistory.push(...history);
				} catch {
					// Skip corrupted files
				}
			}
		}

		// Sort by timestamp descending
		allHistory.sort((a, b) => b.completedAt.localeCompare(a.completedAt));

		return limit ? allHistory.slice(0, limit) : allHistory;
	}

	/**
	 * Get test statistics for a proposal.
	 */
	getProposalStats(proposalId: string): {
		totalRuns: number;
		passedRuns: number;
		failedRuns: number;
		lastRunAt: string | null;
		lastResult: "passed" | "failed" | null;
		averageDuration: number;
	} {
		const history = this.getProposalHistory(proposalId);

		if (history.length === 0) {
			return {
				totalRuns: 0,
				passedRuns: 0,
				failedRuns: 0,
				lastRunAt: null,
				lastResult: null,
				averageDuration: 0,
			};
		}

		const passedRuns = history.filter(
			(h) => h.summary.passed === h.summary.total,
		).length;

		return {
			totalRuns: history.length,
			passedRuns,
			failedRuns: history.length - passedRuns,
			lastRunAt: history[history.length - 1].completedAt,
			lastResult: passedRuns === history.length ? "passed" : "failed",
			averageDuration: Math.round(
				history.reduce((sum, h) => sum + h.duration, 0) / history.length,
			),
		};
	}

	/**
	 * Clear history for a proposal.
	 */
	clearProposalHistory(proposalId: string): boolean {
		const historyPath = join(this.historyDir, `${proposalId}.json`);
		if (existsSync(historyPath)) {
			unlinkSync(historyPath);
			return true;
		}
		return false;
	}

	/**
	 * Format pulse event for display.
	 */
	formatPulseEvent(event: PulseTestEvent): string {
		const icon = event.passed ? "✅" : "❌";
		const lines = [
			`${icon} Regression Tests: ${event.proposalId}`,
			`   Agent: ${event.agent}`,
			`   Results: ${event.summary.passed}/${event.summary.total} passed`,
			`   Duration: ${(event.duration / 1000).toFixed(1)}s`,
		];

		if (event.failedTests && event.failedTests.length > 0) {
			lines.push("   Failed:");
			for (const test of event.failedTests.slice(0, 5)) {
				lines.push(`     - ${test}`);
			}
			if (event.failedTests.length > 5) {
				lines.push(`     ... and ${event.failedTests.length - 5} more`);
			}
		}

		return lines.join("\n");
	}
}

/**
 * Create a regression suite for a project.
 */
export function createRegressionSuite(
	projectRoot: string,
	config?: Partial<RegressionConfig>,
): RegressionSuite {
	return new RegressionSuite(projectRoot, config);
}
