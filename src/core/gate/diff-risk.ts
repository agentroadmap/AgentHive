/**
 * P3565 diff-risk signal for the DEVELOP→MERGE gate.
 *
 * A high-blast-radius merge (touches fn_* triggers, migrations, auth, the gate
 * advance path, or prop_claim) must not advance without a GENUINE operator
 * authorization. Reading a branch diff from inside a Postgres trigger is
 * infeasible, so the risk SIGNAL is computed here (the advance-handler boundary)
 * and recorded onto the gate_decision_log row as
 *   ac_verification->'diff_risk' = { high, operator_authorized, touched, token_id }
 * The DB trigger (migration 291) then enforces the invariant: high-risk ⇒
 * operator_authorized must be true. operator_authorized is set ONLY after a
 * successful authorizeOperatorByToken() (P3508) — never from the impersonable
 * app.agent_identity GUC.
 *
 * Tractable risk signal: the set of touched paths for the proposal's branch.
 * Sources, in order of preference:
 *   1. an explicit `changed_files` list passed by the caller (CI / handler),
 *   2. `git diff --name-only <base>...<branch>` when a branch ref is provided,
 *   3. proposal_versions.diff_summary text (best-effort path extraction).
 * A path is HIGH-RISK if it matches any of the patterns below.
 */

const HIGH_RISK_PATTERNS: RegExp[] = [
	/(^|\/)migrations\//i,
	/(^|\/)scripts\/migrations\//i,
	/\bfn_[a-z0-9_]+/i, // fn_* SQL functions
	/gate_advance/i,
	/\bgate\b.*\b(guard|advance|decision)\b/i,
	/(^|\/)auth/i,
	/operator-auth/i,
	/prop_claim|proposal-integrity|lease/i,
];

export interface DiffRiskResult {
	high: boolean;
	/** the subset of touched paths that matched a high-risk pattern */
	matched: string[];
	/** all touched paths considered */
	touched: string[];
}

/** Classify an explicit list of changed file paths. Pure + synchronous. */
export function classifyChangedFiles(changedFiles: string[]): DiffRiskResult {
	const touched = changedFiles.map((f) => f.trim()).filter(Boolean);
	const matched = touched.filter((f) =>
		HIGH_RISK_PATTERNS.some((re) => re.test(f)),
	);
	return { high: matched.length > 0, matched, touched };
}

/**
 * Resolve changed files for a proposal's branch and classify risk.
 *
 * @param opts.changedFiles  explicit list (preferred; bypasses git/db lookup)
 * @param opts.branchRef     branch to diff against base (used when no list given)
 * @param opts.baseRef       base ref (default "main")
 * @param opts.diffSummary   proposal_versions.diff_summary fallback text
 */
export async function computeDiffRisk(opts: {
	changedFiles?: string[];
	branchRef?: string;
	baseRef?: string;
	diffSummary?: string;
	repoRoot?: string;
}): Promise<DiffRiskResult> {
	if (opts.changedFiles && opts.changedFiles.length > 0) {
		return classifyChangedFiles(opts.changedFiles);
	}

	if (opts.branchRef) {
		try {
			const { execFile } = await import("node:child_process");
			const { promisify } = await import("node:util");
			const run = promisify(execFile);
			const base = opts.baseRef ?? "main";
			const { stdout } = await run(
				"git",
				["diff", "--name-only", `${base}...${opts.branchRef}`],
				{ cwd: opts.repoRoot ?? process.cwd(), timeout: 15_000 },
			);
			const files = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
			if (files.length > 0) return classifyChangedFiles(files);
		} catch {
			// git unavailable / bad ref — fall through to diff_summary.
		}
	}

	if (opts.diffSummary) {
		// Best-effort: pull path-like tokens out of the summary text.
		const tokens =
			opts.diffSummary.match(/[A-Za-z0-9_./-]+\.(ts|tsx|sql|js|json)/g) ?? [];
		if (tokens.length > 0) return classifyChangedFiles(tokens);
	}

	// No signal available → not high-risk (the trigger still requires the
	// gate_decision_log row; a missing diff is not an automatic block).
	return { high: false, matched: [], touched: [] };
}

/**
 * Build the diff_risk JSON fragment to embed in gate_decision_log.ac_verification.
 * operator_authorized is set ONLY when a verified operator token authorized the
 * advance (caller passes the P3508 outcome) — never inferred from agent identity.
 */
export function buildDiffRiskMetadata(
	risk: DiffRiskResult,
	operator: { authorized: boolean; tokenId?: number | null } | null,
): Record<string, unknown> {
	return {
		diff_risk: {
			high: risk.high,
			operator_authorized: operator?.authorized === true,
			token_id: operator?.tokenId ?? null,
			matched: risk.matched,
			touched_count: risk.touched.length,
		},
	};
}
