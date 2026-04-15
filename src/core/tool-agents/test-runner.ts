/**
 * Test Runner — zero-cost npm test executor.
 *
 * Runs npm test for proposals in Develop stage and reports results.
 * Parses test output for pass/fail counts and writes results to the DB.
 */

import { spawn } from "node:child_process";
import { query } from "../../infra/postgres/pool.ts";
import type { ToolAgent, ToolTask, ToolResult } from "./registry.ts";

const WORKTREE_ROOT = "/data/code/worktree";

interface TestRunnerConfig {
	testTimeout?: number;
}

interface TestParseResult {
	passed: number;
	failed: number;
	total: number;
	summary: string;
}

export class TestRunner implements ToolAgent {
	identity = "tool/test-runner";
	capabilities = ["test-execution", "result-parsing", "coverage"];

	private readonly testTimeout: number;

	constructor(config: Record<string, unknown>) {
		const cfg = config as TestRunnerConfig;
		this.testTimeout = cfg.testTimeout ?? 120_000;
	}

	async invoke(task: ToolTask): Promise<ToolResult> {
		const proposalId = task.proposalId;
		const worktree = task.payload.worktree as string | undefined;

		if (!proposalId) {
			return {
				success: false,
				output: "No proposal_id provided",
				tokensUsed: 0,
			};
		}

		if (!worktree) {
			return {
				success: false,
				output: "Missing worktree in task payload — cannot run tests without a target worktree",
				tokensUsed: 0,
			};
		}

		const worktreePath = `${WORKTREE_ROOT}/${worktree}`;
		const result = await this.runTests(worktreePath);
		const parsed = this.parseOutput(result.stdout + result.stderr);

		// Write test results to DB
		await query(
			`INSERT INTO roadmap.test_results
			    (proposal_id, worktree, passed, failed, total, output, status, ran_at)
			  VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
			[
				proposalId,
				worktree,
				parsed.passed,
				parsed.failed,
				parsed.total,
				result.stdout.slice(0, 2000),
				parsed.failed === 0 ? "pass" : "fail",
			],
		).catch(() => {
			// test_results table may not exist yet — non-fatal
		});

		if (parsed.failed > 0) {
			return {
				success: false,
				output: `Tests FAILED: ${parsed.summary}`,
				tokensUsed: 0,
				escalate: parsed.failed > 5, // escalate if many failures
				escalationReason:
					parsed.failed > 5
						? `${parsed.failed} test failures — may need LLM triage`
						: undefined,
			};
		}

		return {
			success: true,
			output: `Tests PASSED: ${parsed.summary}`,
			tokensUsed: 0,
		};
	}

	async healthCheck(): Promise<boolean> {
		try {
			const result = await this.runTests(WORKTREE_ROOT);
			return result.exitCode !== null;
		} catch {
			return false;
		}
	}

	private runTests(
		cwd: string,
	): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
		return new Promise((resolve) => {
			const child = spawn("npm", ["test"], {
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, CI: "true" },
			});

			let stdout = "";
			let stderr = "";

			child.stdout?.on("data", (d: Buffer) => {
				stdout += d.toString();
			});
			child.stderr?.on("data", (d: Buffer) => {
				stderr += d.toString();
			});

			const timer = setTimeout(() => {
				child.kill("SIGTERM");
				stderr += "\n[test-runner] Killed after timeout";
			}, this.testTimeout);

			child.on("close", (code) => {
				clearTimeout(timer);
				resolve({ stdout, stderr, exitCode: code });
			});

			child.on("error", (err) => {
				clearTimeout(timer);
				resolve({
					stdout,
					stderr: `${stderr}\nspawn error: ${err.message}`,
					exitCode: null,
				});
			});
		});
	}

	private parseOutput(output: string): TestParseResult {
		// Try vitest/jest summary pattern: "X passed, Y failed"
		const summaryMatch = output.match(
			/(\d+)\s+passed.*?(\d+)\s+failed/i,
		);
		if (summaryMatch) {
			const passed = parseInt(summaryMatch[1], 10);
			const failed = parseInt(summaryMatch[2], 10);
			return {
				passed,
				failed,
				total: passed + failed,
				summary: `${passed} passed, ${failed} failed`,
			};
		}

		// Try "Tests X passed" pattern
		const passMatch = output.match(/Tests\s+(\d+)\s+passed/i);
		if (passMatch) {
			const passed = parseInt(passMatch[1], 10);
			return {
				passed,
				failed: 0,
				total: passed,
				summary: `${passed} passed`,
			};
		}

		// Fallback: check for pass/fail keywords
		const hasFail =
			output.includes("FAIL") || output.includes("failed");
		return {
			passed: hasFail ? 0 : 1,
			failed: hasFail ? 1 : 0,
			total: 1,
			summary: hasFail ? "Tests failed (parse fallback)" : "Tests passed (parse fallback)",
		};
	}
}
