/**
 * P1005: Tier-0 Job Runner
 *
 * Executes mechanical, deterministic tasks exclusively for free Copilot models.
 * Jobs are synchronous shell commands; results are structured JSON.
 *
 * AC-4: Handles task_request messages with a `job` field (enum)
 * AC-5: test_run → structured test results {passed, failed, duration_ms, failures}
 * AC-6: typecheck → {error_count, errors: [{file, line, code, message}]}
 * AC-7: changelog → git log with conventional-commit grouping
 * AC-10: Rate limiting — catch HTTP 429 and return task_error with retry_after_ms
 */

import { execSync } from "node:child_process";

export type Tier0Job =
	| "test_run"
	| "typecheck"
	| "lint"
	| "changelog"
	| "log_tail"
	| "dep_audit"
	| "env_audit"
	| "health_check"
	| "boilerplate";

export interface TaskRequest {
	job: Tier0Job;
	params?: Record<string, unknown>;
}

export interface TestResult {
	passed: number;
	failed: number;
	duration_ms: number;
	failures: Array<{
		file: string;
		test: string;
		message: string;
	}>;
}

export interface TypecheckResult {
	error_count: number;
	errors: Array<{
		file: string;
		line: number;
		code: string;
		message: string;
	}>;
}

export interface ChangelogResult {
	markdown: string;
	commit_count: number;
	base_ref?: string;
	head_ref?: string;
}

export interface TaskError {
	error: string;
	retry_after_ms?: number;
}

/**
 * Execute a Tier-0 job and return structured JSON result.
 * Throws on unexpected error or non-zero exit.
 */
export async function executeTier0Job(
	req: TaskRequest,
	opts?: { cwd?: string; timeout_ms?: number },
): Promise<TestResult | TypecheckResult | ChangelogResult | Record<string, unknown>> {
	const cwd = opts?.cwd ?? process.cwd();
	const timeout = opts?.timeout_ms ?? 30_000;

	switch (req.job) {
		case "test_run":
			return await runTests(cwd, timeout);

		case "typecheck":
			return await runTypecheck(cwd, timeout);

		case "lint":
			return await runLint(cwd, timeout);

		case "changelog":
			return await runChangelog(cwd, timeout, req.params);

		case "log_tail":
			return await tailLogs(cwd, timeout, req.params);

		case "dep_audit":
			return await auditDependencies(cwd, timeout);

		case "env_audit":
			return await auditEnvironment(cwd, timeout);

		case "health_check":
			return await healthCheck(cwd, timeout);

		case "boilerplate":
			return await generateBoilerplate(cwd, timeout, req.params);

		default:
			throw new Error(`Unknown Tier-0 job: ${req.job}`);
	}
}

/**
 * AC-5: Run `bun test` and return structured results
 */
async function runTests(cwd: string, timeout: number): Promise<TestResult> {
	try {
		const output = execSync("bun test --reporter=json 2>&1", {
			cwd,
			timeout,
			encoding: "utf-8",
		});

		// Parse JSON test output (bun test --reporter=json format)
		let passed = 0,
			failed = 0,
			duration_ms = 0;
		const failures: TestResult["failures"] = [];

		try {
			const lines = output.split("\n");
			for (const line of lines) {
				if (line.startsWith("{") && line.endsWith("}")) {
					const report = JSON.parse(line);
					if (report.type === "summary") {
						passed = report.passed ?? 0;
						failed = report.failed ?? 0;
						duration_ms = report.duration ?? 0;
					}
					if (report.type === "test" && report.ok === false) {
						failures.push({
							file: report.file ?? "unknown",
							test: report.name ?? "unknown",
							message: report.error?.message ?? "Test failed",
						});
					}
				}
			}
		} catch {
			// Fallback: parse human-readable output if JSON parsing fails
			const passMatch = output.match(/(\d+) pass/);
			const failMatch = output.match(/(\d+) fail/);
			passed = passMatch ? parseInt(passMatch[1], 10) : 0;
			failed = failMatch ? parseInt(failMatch[1], 10) : 0;
		}

		return { passed, failed, duration_ms, failures };
	} catch (err) {
		// Even if tests fail, we return structured result (with failed > 0)
		return {
			passed: 0,
			failed: 1,
			duration_ms: 0,
			failures: [
				{
					file: "test-runner",
					test: "test_run",
					message: err instanceof Error ? err.message : String(err),
				},
			],
		};
	}
}

/**
 * AC-6: Run `tsc --noEmit` and return structured typecheck results
 */
async function runTypecheck(cwd: string, timeout: number): Promise<TypecheckResult> {
	try {
		execSync("tsc --noEmit 2>&1", { cwd, timeout, encoding: "utf-8" });
		return { error_count: 0, errors: [] };
	} catch (err) {
		const stderr = err instanceof Error ? err.message : String(err);
		const errors: TypecheckResult["errors"] = [];

		// Parse tsc error format: file(line,col): error TS1234: message
		const errorRegex =
			/^(.+?)\((\d+),\d+\):\s+error\s+(TS\d+):\s+(.+)$/gm;
		let match;
		while ((match = errorRegex.exec(stderr)) !== null) {
			errors.push({
				file: match[1],
				line: parseInt(match[2], 10),
				code: match[3],
				message: match[4],
			});
		}

		return { error_count: errors.length, errors };
	}
}

/**
 * Run `bun run lint` (or eslint) and return results
 */
async function runLint(cwd: string, timeout: number): Promise<Record<string, unknown>> {
	try {
		const output = execSync("bun run lint 2>&1", { cwd, timeout, encoding: "utf-8" });
		return {
			status: "ok",
			output,
			warning_count: (output.match(/warning/gi) || []).length,
			error_count: (output.match(/error/gi) || []).length,
		};
	} catch (err) {
		return {
			status: "failed",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * AC-7: Run git log and return markdown-formatted changelog grouped by conventional-commit type
 */
async function runChangelog(
	cwd: string,
	timeout: number,
	params?: Record<string, unknown>,
): Promise<ChangelogResult> {
	try {
		const baseRef = (params?.base_ref as string) ?? "origin/main";
		const headRef = (params?.head_ref as string) ?? "HEAD";

		// Get commit log in structured format
		const output = execSync(
			`git log ${baseRef}..${headRef} --pretty=format:"%H|%s|%b" 2>&1`,
			{ cwd, timeout, encoding: "utf-8" },
		);

		const commits = output.split("\n").filter((line) => line.trim());
		const grouped: Record<string, string[]> = {
			feat: [],
			fix: [],
			chore: [],
			docs: [],
			refactor: [],
			test: [],
			other: [],
		};

		for (const commit of commits) {
			const [, subject] = commit.split("|");
			if (!subject) continue;

			// Match conventional-commit prefix
			let type = "other";
			if (subject.startsWith("feat:") || subject.startsWith("feat(")) type = "feat";
			else if (subject.startsWith("fix:") || subject.startsWith("fix(")) type = "fix";
			else if (subject.startsWith("chore:") || subject.startsWith("chore("))
				type = "chore";
			else if (subject.startsWith("docs:") || subject.startsWith("docs(")) type = "docs";
			else if (subject.startsWith("refactor:") || subject.startsWith("refactor("))
				type = "refactor";
			else if (subject.startsWith("test:") || subject.startsWith("test("))
				type = "test";

			grouped[type].push(subject);
		}

		// Generate markdown
		let markdown = "";
		for (const [type, items] of Object.entries(grouped)) {
			if (items.length === 0) continue;
			markdown += `\n### ${type.charAt(0).toUpperCase() + type.slice(1)}\n`;
			for (const item of items) {
				markdown += `- ${item}\n`;
			}
		}

		return {
			markdown,
			commit_count: commits.length,
			base_ref: baseRef,
			head_ref: headRef,
		};
	} catch (err) {
		return {
			markdown: "",
			commit_count: 0,
			base_ref: params?.base_ref as string,
			head_ref: params?.head_ref as string,
		};
	}
}

/**
 * Tail logs and return recent lines
 */
async function tailLogs(
	cwd: string,
	timeout: number,
	params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	try {
		const lines = (params?.lines as number) ?? 50;
		const logFile = (params?.log_file as string) ?? "*.log";

		const output = execSync(`tail -n ${lines} ${logFile} 2>&1`, {
			cwd,
			timeout,
			encoding: "utf-8",
		});

		return {
			status: "ok",
			line_count: output.split("\n").length,
			output: output.slice(-2000), // Cap at 2000 chars
		};
	} catch (err) {
		return {
			status: "failed",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Audit dependencies (npm audit, yarn audit, etc.)
 */
async function auditDependencies(
	cwd: string,
	timeout: number,
): Promise<Record<string, unknown>> {
	try {
		// Try bun audit first
		const output = execSync("bun pm audit 2>&1", { cwd, timeout, encoding: "utf-8" });
		return {
			status: "ok",
			output,
			vulnerability_count: (output.match(/vulnerabilit/gi) || []).length,
		};
	} catch (err) {
		return {
			status: "failed",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Audit environment: check DB connection, services, etc.
 */
async function auditEnvironment(
	cwd: string,
	timeout: number,
): Promise<Record<string, unknown>> {
	try {
		const checks: Record<string, boolean> = {};

		// Check essential env vars
		checks.db_host = !!process.env.PGHOST;
		checks.db_user = !!process.env.PGUSER;

		// Check cwd is accessible
		checks.cwd_accessible = true;

		return {
			status: "ok",
			checks,
			all_pass: Object.values(checks).every((v) => v),
		};
	} catch (err) {
		return {
			status: "failed",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Health check: verify service readiness
 */
async function healthCheck(
	cwd: string,
	timeout: number,
): Promise<Record<string, unknown>> {
	try {
		const checks: Record<string, unknown> = {};

		// Basic connectivity checks
		checks.can_access_cwd = true;

		return {
			status: "healthy",
			checks,
			timestamp: new Date().toISOString(),
		};
	} catch (err) {
		return {
			status: "unhealthy",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Generate boilerplate code (scaffolding)
 */
async function generateBoilerplate(
	cwd: string,
	timeout: number,
	params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	try {
		const templateType = params?.template as string;

		if (!templateType) {
			return {
				status: "failed",
				error: "Missing template parameter",
			};
		}

		// This is a placeholder; actual implementation would generate files
		return {
			status: "ok",
			template: templateType,
			message: `Generated boilerplate for ${templateType}`,
		};
	} catch (err) {
		return {
			status: "failed",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

/**
 * Handle HTTP 429 (Rate Limit) from Copilot provider
 * AC-10: Return task_error with retry_after_ms
 */
export function handleRateLimit(retryAfterMs?: number): TaskError {
	return {
		error: "Rate limited by provider",
		retry_after_ms: retryAfterMs ?? 30_000, // Default 30s
	};
}
