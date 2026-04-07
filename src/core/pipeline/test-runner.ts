/**
 * Test Runner Module
 * Executes discovered tests with isolation and reporting.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TestCategory, TestFile } from "./test-discovery.ts";

const execFileAsync = promisify(execFile);

export interface TestRunOptions {
	/** Specific test files to run (defaults to all) */
	files?: string[];
	/** Filter by category */
	category?: TestCategory;
	/** Timeout per test file in ms */
	timeout?: number;
	/** Working directory */
	cwd?: string;
	/** Extra node test arguments */
	extraArgs?: string[];
}

export interface TestResult {
	/** Test file path */
	file: string;
	/** Whether test passed */
	passed: boolean;
	/** Exit code from test process */
	exitCode: number;
	/** Standard output */
	stdout: string;
	/** Standard error */
	stderr: string;
	/** Execution time in ms */
	duration: number;
	/** Error message if test failed to run */
	error?: string;
}

export interface TestRunReport {
	/** All test results */
	results: TestResult[];
	/** Summary counts */
	summary: {
		total: number;
		passed: number;
		failed: number;
		errors: number;
	};
	/** Total execution time in ms */
	totalDuration: number;
	/** When the run started */
	startedAt: string;
	/** When the run completed */
	completedAt: string;
}

/**
 * Run a single test file and capture results.
 */
export async function runTestFile(
	filePath: string,
	options: { timeout?: number; cwd?: string; extraArgs?: string[] } = {},
): Promise<TestResult> {
	const startTime = Date.now();
	const timeout = options.timeout || 30000;

	try {
		const { stdout, stderr } = await execFileAsync(
			"node",
			["--test", ...(options.extraArgs || []), filePath],
			{
				cwd: options.cwd || process.cwd(),
				timeout,
				encoding: "utf-8",
			},
		);

		return {
			file: filePath,
			passed: true,
			exitCode: 0,
			stdout,
			stderr,
			duration: Date.now() - startTime,
		};
	} catch (err: unknown) {
		const error = err as {
			stdout?: string;
			stderr?: string;
			code?: number;
			message?: string;
		};
		return {
			file: filePath,
			passed: false,
			exitCode: error.code || 1,
			stdout: error.stdout || "",
			stderr: error.stderr || error.message || "Unknown error",
			duration: Date.now() - startTime,
			error: error.message,
		};
	}
}

/**
 * Run multiple test files sequentially.
 */
export async function runTests(
	testFiles: TestFile[],
	options: TestRunOptions = {},
): Promise<TestRunReport> {
	const startedAt = new Date().toISOString();
	const startTime = Date.now();
	const results: TestResult[] = [];

	const filesToRun = options.files || testFiles.map((t) => t.path);

	for (const file of filesToRun) {
		const result = await runTestFile(file, {
			timeout: options.timeout,
			cwd: options.cwd,
			extraArgs: options.extraArgs,
		});
		results.push(result);
	}

	const completedAt = new Date().toISOString();
	const totalDuration = Date.now() - startTime;

	const summary = {
		total: results.length,
		passed: results.filter((r) => r.passed).length,
		failed: results.filter((r) => !r.passed && r.exitCode !== 0).length,
		errors: results.filter((r) => !r.passed && r.exitCode === 0).length,
	};

	return { results, summary, totalDuration, startedAt, completedAt };
}

/**
 * Format test run report for display.
 */
export function formatTestReport(report: TestRunReport): string {
	const lines = [
		"Test Run Report",
		"===============",
		`Started: ${report.startedAt}`,
		`Duration: ${(report.totalDuration / 1000).toFixed(1)}s`,
		"",
		`Summary: ${report.summary.passed}/${report.summary.total} passed`,
	];

	if (report.summary.failed > 0) {
		lines.push(`  Failed: ${report.summary.failed}`);
	}
	if (report.summary.errors > 0) {
		lines.push(`  Errors: ${report.summary.errors}`);
	}

	const failedTests = report.results.filter((r) => !r.passed);
	if (failedTests.length > 0) {
		lines.push("", "Failed Tests:");
		for (const test of failedTests) {
			lines.push(`  ❌ ${test.file}`);
			if (test.error) {
				lines.push(`     ${test.error}`);
			}
		}
	}

	return lines.join("\n");
}

/**
 * Check if a report indicates all tests passed.
 */
export function allTestsPassed(report: TestRunReport): boolean {
	return report.summary.passed === report.summary.total;
}
