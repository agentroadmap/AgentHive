/**
 * P3563 Step 3: async AC re-execution validator.
 *
 * Wires the previously-orphaned AcTestExecutor into a real invocation path. For
 * a given proposal it re-runs the test-evidence commands recorded on each PASSED
 * acceptance criterion (behavioral/test category → test_file/test_names) and, on
 * a FAILING re-check, flips that AC out of 'pass' to 'fail' with a provenance
 * note. It also re-resolves artifact repo_refs for file/module evidence (path
 * existence) as a lighter-weight check.
 *
 * This is a STANDALONE validator (callable from the CLI / a scheduled hook), not
 * a trigger. The gate trigger only asserts presence + schema-validity +
 * "last re-check not failed" — the heavy re-execution lives here, off the
 * gate-advance hot path.
 *
 * Invocation:
 *   agenthive revalidate-ac --proposal <id> [--worktree <name>]
 *   or programmatically: revalidateProposalAcs(proposalId, { worktree }).
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { query } from "../../postgres/pool.ts";

export interface RevalidationOutcome {
	proposalId: number;
	checked: number;
	stillPassing: number;
	flippedToFail: number;
	skippedNoEvidence: number;
	flippedItems: Array<{ item_number: number; reason: string }>;
}

interface AcRow {
	id: number;
	item_number: number;
	status: string;
	details: any;
	verification_notes: string | null;
}

const DEFAULT_TIMEOUT_MS = 120_000;

function runCommand(
	argv: string[],
	cwd: string,
	timeoutMs: number,
): Promise<{ exitCode: number | null; stderr: string }> {
	return new Promise((res) => {
		const [cmd, ...args] = argv;
		const child = spawn(cmd, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, CI: "true" },
		});
		let stderr = "";
		child.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			stderr += "\n[ac-revalidator] killed after timeout";
		}, timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			res({ exitCode: code, stderr });
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			res({ exitCode: null, stderr: `${stderr}\nspawn error: ${err.message}` });
		});
	});
}

/**
 * Re-execute / re-resolve evidence for every PASSED AC of a proposal and flip
 * failing ones to 'fail'. Returns an outcome summary.
 */
export async function revalidateProposalAcs(
	proposalId: number,
	opts: { worktreeRoot?: string; worktree?: string; timeoutMs?: number } = {},
): Promise<RevalidationOutcome> {
	const repoRoot = opts.worktree
		? resolve(opts.worktreeRoot ?? "/data/code/worktree", opts.worktree)
		: process.cwd();
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const { rows } = await query<AcRow>(
		`SELECT id, item_number, status, details, verification_notes
		   FROM roadmap_proposal.proposal_acceptance_criteria
		  WHERE proposal_id = $1 AND status = 'pass'
		  ORDER BY item_number`,
		[proposalId],
	);

	const outcome: RevalidationOutcome = {
		proposalId,
		checked: 0,
		stillPassing: 0,
		flippedToFail: 0,
		skippedNoEvidence: 0,
		flippedItems: [],
	};

	for (const ac of rows) {
		const details = ac.details ?? null;
		const category = details?.category as string | undefined;

		// behavioral/test → re-run the test file.
		if (category === "behavioral/test" && details?.test_file) {
			outcome.checked++;
			const result = await runCommand(
				["node", "--import", "jiti/register", "--test", String(details.test_file)],
				repoRoot,
				timeoutMs,
			);
			if (result.exitCode !== 0) {
				await flip(ac, `re-execution of ${details.test_file} failed (exit ${result.exitCode}): ${result.stderr.slice(0, 300)}`);
				outcome.flippedToFail++;
				outcome.flippedItems.push({
					item_number: ac.item_number,
					reason: `behavioral/test re-run failed (exit ${result.exitCode})`,
				});
			} else {
				outcome.stillPassing++;
			}
			continue;
		}

		// file/module → re-resolve that the claimed files still exist.
		if (category === "file/module" && Array.isArray(details?.files)) {
			outcome.checked++;
			const missing = (details.files as string[]).filter(
				(f) => !existsSync(resolve(repoRoot, f)),
			);
			if (missing.length > 0) {
				await flip(ac, `file/module artifacts missing on re-check: ${missing.join(", ")}`);
				outcome.flippedToFail++;
				outcome.flippedItems.push({
					item_number: ac.item_number,
					reason: `missing files: ${missing.join(", ")}`,
				});
			} else {
				outcome.stillPassing++;
			}
			continue;
		}

		// No re-executable evidence (schema/migration, mcp_tool, or untagged):
		// leave as-is; the trigger's presence+schema check still covers these.
		outcome.skippedNoEvidence++;
	}

	return outcome;
}

async function flip(ac: AcRow, reason: string): Promise<void> {
	const note =
		`[P3563 re-validator] PASS revoked → FAIL: ${reason}. ` +
		`Previous note: ${ac.verification_notes ?? "(none)"}`;
	await query(
		`UPDATE roadmap_proposal.proposal_acceptance_criteria
		    SET status = 'fail', verification_notes = $2, verified_at = now()
		  WHERE id = $1`,
		[ac.id, note.slice(0, 2000)],
	);
}
