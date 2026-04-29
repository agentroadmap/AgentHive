/**
 * AC Test Executor — runs acceptance-criteria-specific tests for a proposal.
 *
 * Unlike the generic TestRunner, this agent:
 *   1. Queries proposal_acceptance_criteria for AC items tagged with a test ref
 *   2. Runs only those targeted tests (or npm test if none tagged)
 *   3. Updates AC item status (pass/fail) per result
 *   4. Returns success only if ALL AC items with test refs pass
 */

import { spawn } from "node:child_process";
import { query } from "../../infra/postgres/pool.ts";
import type { ToolAgent, ToolTask, ToolResult } from "./registry.ts";

const WORKTREE_ROOT = "/data/code/worktree";

interface AcTestExecutorConfig {
	testTimeout?: number;
	passThreshold?: number;
}

interface AcItem {
	id: number;
	item_number: number;
	criterion_text: string;
	test_ref: string | null;
	status: string;
}

interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
}

export class AcTestExecutor implements ToolAgent {
	identity = "tool/ac-test-executor";
	capabilities = ["ac-test-execution", "test-result-parsing", "pass-fail-reporting"];

	private readonly testTimeout: number;
	private readonly passThreshold: number;

	constructor(config: Record<string, unknown>) {
		const cfg = config as AcTestExecutorConfig;
		this.testTimeout = cfg.testTimeout ?? 120_000;
		this.passThreshold = cfg.passThreshold ?? 1.0;
	}

	async invoke(task: ToolTask): Promise<ToolResult> {
		const { proposalId } = task;
		const worktree = task.payload.worktree as string | undefined;

		if (!proposalId) {
			return { success: false, output: "No proposal_id provided", tokensUsed: 0 };
		}
		if (!worktree) {
			return {
				success: false,
				output: "Missing worktree in task payload",
				tokensUsed: 0,
			};
		}

		const worktreePath = `${WORKTREE_ROOT}/${worktree}`;

		// Load AC items that have a test reference
		const acItems = await this.loadAcItems(proposalId);
		const testableItems = acItems.filter((ac) => ac.test_ref);

		let passed = 0;
		let failed = 0;
		const failures: string[] = [];

		if (testableItems.length === 0) {
			// No tagged test refs — run full npm test as a fallback
			const result = await this.runCommand(["npm", "test"], worktreePath);
			const exitOk = result.exitCode === 0;

			// Update all pending AC items based on overall result
			for (const ac of acItems.filter((a) => a.status === "pending")) {
				await this.updateAcStatus(
					ac.id,
					exitOk ? "pass" : "fail",
					exitOk ? "Full test suite passed" : result.stderr.slice(0, 500),
				).catch(() => {});
			}

			return {
				success: exitOk,
				output: exitOk
					? `All tests passed (no per-AC test refs; ran full suite)`
					: `Full test suite failed: ${result.stderr.slice(0, 400)}`,
				tokensUsed: 0,
				escalate: !exitOk,
				escalationReason: exitOk
					? undefined
					: "AC test suite failed — LLM triage needed",
			};
		}

		// Run each AC's test file individually
		for (const ac of testableItems) {
			const testRef = ac.test_ref as string;
			const result = await this.runCommand(
				["node", "--import", "jiti/register", "--test", testRef],
				worktreePath,
			);
			const ok = result.exitCode === 0;

			if (ok) {
				passed++;
			} else {
				failed++;
				failures.push(`AC#${ac.item_number}: ${testRef}`);
			}

			await this.updateAcStatus(
				ac.id,
				ok ? "pass" : "fail",
				ok ? "Test passed" : result.stderr.slice(0, 500),
			).catch(() => {});
		}

		const total = passed + failed;
		const passRate = total > 0 ? passed / total : 1;
		const meetsThreshold = passRate >= this.passThreshold;

		const summary = `${passed}/${total} AC tests passed`;

		if (!meetsThreshold) {
			return {
				success: false,
				output: `AC tests FAILED: ${summary}. Failing: ${failures.join(", ")}`,
				tokensUsed: 0,
				escalate: failed > 3,
				escalationReason:
					failed > 3 ? `${failed} AC test failures — LLM triage needed` : undefined,
			};
		}

		return {
			success: true,
			output: `AC tests PASSED: ${summary}`,
			tokensUsed: 0,
		};
	}

	async healthCheck(): Promise<boolean> {
		const r = await query("SELECT 1").catch(() => null);
		return r !== null;
	}

	private async loadAcItems(proposalId: number): Promise<AcItem[]> {
		const r = await query<AcItem>(
			`SELECT id, item_number, criterion_text, test_ref, status
			   FROM roadmap_proposal.proposal_acceptance_criteria
			  WHERE proposal_id = $1
			  ORDER BY item_number`,
			[proposalId],
		).catch(() => ({ rows: [] as AcItem[] }));
		return r.rows;
	}

	private async updateAcStatus(
		acId: number,
		status: "pass" | "fail",
		note: string,
	): Promise<void> {
		await query(
			`UPDATE roadmap_proposal.proposal_acceptance_criteria
			    SET status = $1, verification_notes = $2, verified_at = now()
			  WHERE id = $3`,
			[status, note, acId],
		);
	}

	private runCommand(argv: string[], cwd: string): Promise<RunResult> {
		return new Promise((resolve) => {
			const [cmd, ...args] = argv;
			const child = spawn(cmd, args, {
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
				stderr += "\n[ac-test-executor] Killed after timeout";
			}, this.testTimeout);

			child.on("close", (code) => {
				clearTimeout(timer);
				resolve({ stdout, stderr, exitCode: code });
			});

			child.on("error", (err) => {
				clearTimeout(timer);
				resolve({ stdout, stderr: `${stderr}\nspawn error: ${err.message}`, exitCode: null });
			});
		});
	}
}
