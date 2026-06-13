/**
 * P1124: D4 Merge-Gate E2E Validator
 *
 * Automated AC verification runner that executes at MERGE gate claim-time.
 * Parses "Verification:" lines from proposal ACs, runs deterministic checks
 * (SQL SELECTs, git log, systemctl status, ls), and records gate_decision_log
 * entries. Zero-token advancement for all-pass cases; fall-through to CLI
 * spawn for inconclusive/human review.
 *
 * ## Verification: Line Grammar (BNF)
 *
 * ```
 * verification_line = "Verification:" WS command_spec
 * command_spec = (psql_spec | git_log_spec | ls_spec | systemctl_spec)
 * psql_spec = "psql" WS select_statement
 * git_log_spec = "git_log" WS "git" WS "log" { WS git_log_arg }
 * ls_spec = "ls" WS "ls" { WS ls_arg }
 * systemctl_spec = "systemctl_status" WS "systemctl" WS "status" WS service_name
 * ```
 *
 * Semantics:
 * - Multiple Verification: lines per AC are supported (ALL must pass for the
 *   AC to pass; any fail → AC fails; otherwise any inconclusive → AC inconclusive).
 * - Malformed lines → inconclusive for that AC (error field captures malformation).
 * - ACs with no Verification: line → inconclusive (never auto-fail).
 * - criterion_text is HOSTILE INPUT. Non-psql commands run via execFileSync
 *   argv arrays (shell:false — no interpretation of metacharacters), and any
 *   token containing shell metacharacters is rejected as defense-in-depth.
 * - psql commands run through the app's pg pool (never a psql subprocess);
 *   SELECT-only grammar enforced; INSERT/UPDATE/DELETE/DROP/TRUNCATE/ALTER/
 *   CREATE/COPY/DO/CALL/GRANT/REVOKE and ;-chaining rejected.
 * - Timeout: 10s per command. Subprocesses are killed with SIGKILL on timeout.
 *   pg queries are raced against the timeout (the server-side query may keep
 *   running; result is discarded and the AC goes inconclusive).
 *
 * ## Verdict mapping (review 4363 point 5: filter, NOT a gate)
 *
 * - advance       — every executed command passed
 * - hold          — at least one command FAILED (positive evidence of a problem)
 * - inconclusive  — no failures, but ≥1 AC could not be verified (missing/
 *   malformed Verification line, unsafe command, timeout). Dispatch integration
 *   MUST fall through to the normal agent spawn on inconclusive.
 * - reject        — reserved for manual/operator use; NEVER auto-emitted by
 *   this validator (an unverifiable AC is not evidence of failure).
 *
 * The validator NEVER updates proposal.status. It only writes
 * roadmap_proposal.gate_decision_log rows (gate='D4',
 * decided_by='system/d4-validator' — registered in agent_registry; decided_by
 * has an FK) and returns a verdict the dispatcher acts on. No log row is
 * written for inconclusive results (the decision check constraint does not
 * admit 'inconclusive', and a fall-through is not a gate decision).
 */

import { execFileSync } from "node:child_process";
import { query } from "../../infra/postgres/pool.ts";

const COMMAND_TIMEOUT_MS = 10_000;

/** How long a prior D4 verdict is reused when force_re_run is not set. */
const RESULT_REUSE_WINDOW = "10 minutes";

/** Safe regex: matches psql SELECT (case-insensitive, tolerates a leading block comment). */
const PSQL_SELECT_REGEX = /^\s*(?:\/\*[\s\S]*?\*\/)?\s*(?:SELECT|WITH)\s+/i;

/** Unsafe patterns: any mutating/side-effecting keyword or ;-chaining. */
const PSQL_UNSAFE_PATTERNS = [
	/\bINSERT\s+/i,
	/\bUPDATE\s+/i,
	/\bDELETE\s+/i,
	/\bDROP\s+/i,
	/\bTRUNCATE\s+/i,
	/\bALTER\s+/i,
	/\bCREATE\s+/i,
	/\bCOPY\s+/i,
	/\bDO\s+/i,
	/\bCALL\s+/i,
	/\bGRANT\s+/i,
	/\bREVOKE\s+/i,
	/\bSET\s+/i,
	/\bpg_sleep\b/i,
	/;\s*\S/, // anything after a semicolon = statement chaining
];

/**
 * Tokens containing these are rejected for subprocess commands. With
 * shell:false they would be passed literally anyway; rejecting them keeps
 * Verification lines honest and blocks confused-deputy args like
 * `--output=/etc/cron.d/x`-style tricks at the arg layer below.
 */
const SHELL_METACHARACTERS = /[;&|`$(){}<>\\"'\n\r]/;

export interface CommandResult {
	ac_number: number;
	command: string;
	command_type: "psql" | "git_log" | "ls" | "systemctl_status";
	status: "pass" | "fail" | "inconclusive";
	output?: string;
	error?: string;
	duration_ms: number;
}

export interface ValidationResult {
	/** 'reject' is in the union for log-row compatibility but is never auto-emitted. */
	decision: "advance" | "hold" | "reject" | "inconclusive";
	ac_verification: CommandResult[];
	challenges: number[]; // AC item_numbers that failed
	blockers: number[]; // AC item_numbers that were inconclusive
	log_id?: number | null;
	rationale: string;
}

/**
 * Parse ALL Verification: lines from AC criterion_text.
 * Each line: "Verification: <command_type> <command...>".
 * Lines with a recognized prefix but empty command are dropped (malformed →
 * caller treats zero specs as inconclusive).
 */
export function parseVerificationLines(
	criterion_text: string,
): Array<{ command_type: string; command_text: string }> {
	const specs: Array<{ command_type: string; command_text: string }> = [];
	const lineRegex = /Verification:[ \t]*(\S+)[ \t]+([^\n]+)/gi;
	let match: RegExpExecArray | null;
	while ((match = lineRegex.exec(criterion_text)) !== null) {
		const command_text = match[2].trim();
		if (!command_text) continue;
		specs.push({ command_type: match[1].toLowerCase(), command_text });
	}
	return specs;
}

/** SELECT-only grammar check for psql verification commands. Exported for tests. */
export function isPsqlSafe(cmd: string): boolean {
	if (!PSQL_SELECT_REGEX.test(cmd)) {
		return false;
	}
	for (const pattern of PSQL_UNSAFE_PATTERNS) {
		if (pattern.test(cmd)) {
			return false;
		}
	}
	return true;
}

/**
 * Tokenize a subprocess command and vet every token. Returns the argv array
 * or null if any token contains shell metacharacters (criterion_text is
 * hostile input; see module docblock).
 */
export function tokenizeSafeArgv(command_text: string): string[] | null {
	const tokens = command_text.trim().split(/\s+/);
	if (tokens.length === 0 || tokens[0] === "") return null;
	for (const token of tokens) {
		if (SHELL_METACHARACTERS.test(token)) return null;
	}
	return tokens;
}

function blankResult(
	command: string,
	command_type: CommandResult["command_type"],
): CommandResult {
	return {
		ac_number: 0, // set by caller
		command,
		command_type,
		status: "inconclusive",
		duration_ms: 0,
	};
}

/**
 * Run a vetted argv via execFileSync — shell:false, so nothing in argv is
 * interpreted; SIGKILL on timeout.
 */
function runArgv(
	argv: string[],
	command: string,
	command_type: CommandResult["command_type"],
): CommandResult {
	const startMs = Date.now();
	const result = blankResult(command, command_type);
	try {
		const output = execFileSync(argv[0], argv.slice(1), {
			timeout: COMMAND_TIMEOUT_MS,
			killSignal: "SIGKILL",
			encoding: "utf-8",
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		result.status = "pass";
		result.output = output.substring(0, 4096);
	} catch (err) {
		const e = err as NodeJS.ErrnoException & { signal?: string };
		if (e.signal === "SIGKILL") {
			result.status = "inconclusive";
			result.error = `command timed out after ${COMMAND_TIMEOUT_MS}ms (SIGKILL)`;
		} else {
			result.status = "fail";
			result.error = e instanceof Error ? e.message : String(e);
		}
	}
	result.duration_ms = Date.now() - startMs;
	return result;
}

/** Execute a psql SELECT through the pg pool (never a psql subprocess). */
async function executePsqlCommand(cmd: string): Promise<CommandResult> {
	const startMs = Date.now();
	const result = blankResult(cmd, "psql");
	if (!isPsqlSafe(cmd)) {
		result.error =
			"psql command rejected by SELECT-only grammar (mutating keyword, SET, pg_sleep, or ;-chaining detected)";
		result.duration_ms = Date.now() - startMs;
		return result;
	}
	let timer: NodeJS.Timeout | undefined;
	try {
		const queryResult = await Promise.race([
			query(cmd, []),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error(
								`psql verification timed out after ${COMMAND_TIMEOUT_MS}ms (server-side query may still be running; result discarded)`,
							),
						),
					COMMAND_TIMEOUT_MS,
				);
				timer.unref?.();
			}),
		]);
		result.status = "pass";
		result.output = JSON.stringify(queryResult.rows, null, 2).substring(0, 4096);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		result.status = message.includes("timed out") ? "inconclusive" : "fail";
		result.error = message;
	} finally {
		if (timer) clearTimeout(timer);
	}
	result.duration_ms = Date.now() - startMs;
	return result;
}

/** Execute `git log ...` via vetted argv. */
function executeGitLogCommand(cmd: string): CommandResult {
	const argv = tokenizeSafeArgv(cmd);
	if (!argv || argv[0] !== "git" || argv[1] !== "log") {
		const result = blankResult(cmd, "git_log");
		result.error =
			"only 'git log <args>' is allowed (rejected: wrong subcommand or shell metacharacters in args)";
		return result;
	}
	return runArgv(argv, cmd, "git_log");
}

/** Execute `ls ...` via vetted argv. */
function executeLsCommand(cmd: string): CommandResult {
	const argv = tokenizeSafeArgv(cmd);
	if (!argv || argv[0] !== "ls") {
		const result = blankResult(cmd, "ls");
		result.error =
			"only 'ls <args>' is allowed (rejected: wrong command or shell metacharacters in args)";
		return result;
	}
	return runArgv(argv, cmd, "ls");
}

/** Execute `systemctl status <service>` via vetted argv. */
function executeSystemctlStatusCommand(cmd: string): CommandResult {
	const match = cmd.match(/^\s*systemctl\s+status\s+([\w@.\-]+)\s*$/i);
	if (!match) {
		const result = blankResult(cmd, "systemctl_status");
		result.error =
			"only 'systemctl status <service>' is allowed (single [\\w@.-]+ service name; no enable/disable/restart)";
		return result;
	}
	return runArgv(["systemctl", "status", match[1]], cmd, "systemctl_status");
}

async function executeSpec(spec: {
	command_type: string;
	command_text: string;
}): Promise<CommandResult> {
	switch (spec.command_type) {
		case "psql":
			return executePsqlCommand(spec.command_text);
		case "git_log":
			return executeGitLogCommand(spec.command_text);
		case "ls":
			return executeLsCommand(spec.command_text);
		case "systemctl_status":
			return executeSystemctlStatusCommand(spec.command_text);
		default: {
			const result = blankResult(spec.command_text, "psql");
			result.error = `Unknown command type: ${spec.command_type}`;
			return result;
		}
	}
}

/**
 * Compute the overall verdict from per-AC challenge/blocker sets.
 * Exported for tests. See module docblock for the mapping rationale.
 */
export function computeVerdict(
	challenges: number[],
	blockers: number[],
): { decision: ValidationResult["decision"]; rationale: string } {
	if (challenges.length > 0) {
		return {
			decision: "hold",
			rationale: `${challenges.length} AC(s) failed verification: ${challenges.join(", ")}`,
		};
	}
	if (blockers.length > 0) {
		return {
			decision: "inconclusive",
			rationale: `${blockers.length} AC(s) unverifiable (missing/malformed Verification line, unsafe command, or timeout): ${blockers.join(", ")} — falling through to human gate review`,
		};
	}
	return {
		decision: "advance",
		rationale: "All verifiable acceptance criteria passed",
	};
}

/**
 * Validate a proposal's ACs by executing their Verification: commands.
 *
 * @param proposal_id - Proposal ID to validate
 * @param correlation_id - Optional trace correlation ID (recorded in the log rationale)
 * @param force_re_run - If true, ignore a recent D4 verdict and re-run all commands
 */
export async function validateProposal(
	proposal_id: number,
	correlation_id?: string,
	force_re_run?: boolean,
): Promise<ValidationResult> {
	try {
		const propResult = await query(
			`SELECT status, maturity, project_id
			 FROM roadmap_proposal.proposal WHERE id = $1`,
			[proposal_id],
		);
		if (propResult.rows.length === 0) {
			return {
				decision: "inconclusive",
				ac_verification: [],
				challenges: [],
				blockers: [],
				rationale: `Proposal ${proposal_id} not found`,
			};
		}
		const prop = propResult.rows[0] as {
			status: string;
			maturity: string;
			project_id: number;
		};

		// Reuse a fresh prior verdict unless force_re_run (makes repeated
		// dispatch retries free; the MCP tool exposes force_re_run to override).
		if (!force_re_run) {
			const recent = await query(
				`SELECT id, decision, rationale, ac_verification, challenges, blockers
				 FROM roadmap_proposal.gate_decision_log
				 WHERE proposal_id = $1 AND gate = 'D4'
				   AND created_at > now() - interval '${RESULT_REUSE_WINDOW}'
				 ORDER BY created_at DESC LIMIT 1`,
				[proposal_id],
			);
			if (recent.rows.length > 0) {
				const row = recent.rows[0];
				return {
					decision: row.decision as ValidationResult["decision"],
					ac_verification: (row.ac_verification ?? []) as CommandResult[],
					challenges: (row.challenges ?? []).map(Number),
					blockers: (row.blockers ?? []).map(Number),
					log_id: Number(row.id),
					rationale: `(cached D4 verdict, < ${RESULT_REUSE_WINDOW} old) ${row.rationale ?? ""}`,
				};
			}
		}

		const acsResult = await query(
			`SELECT item_number, criterion_text, status
			 FROM roadmap_proposal.proposal_acceptance_criteria
			 WHERE proposal_id = $1
			 ORDER BY item_number`,
			[proposal_id],
		);
		const acs = acsResult.rows as Array<{
			item_number: number;
			criterion_text: string;
			status: string;
		}>;

		if (acs.length === 0) {
			return {
				decision: "inconclusive",
				ac_verification: [],
				challenges: [],
				blockers: [],
				rationale: "No acceptance criteria found for proposal",
			};
		}

		const results: CommandResult[] = [];
		const challenges: number[] = [];
		const blockers: number[] = [];

		for (const ac of acs) {
			const specs = parseVerificationLines(ac.criterion_text);
			if (specs.length === 0) {
				blockers.push(ac.item_number);
				results.push({
					ac_number: ac.item_number,
					command: "(no Verification: line)",
					command_type: "psql", // placeholder
					status: "inconclusive",
					error: "No Verification: line found in criterion_text",
					duration_ms: 0,
				});
				continue;
			}

			// ALL commands for an AC must pass; any fail → AC fails;
			// otherwise any inconclusive → AC inconclusive.
			let acFailed = false;
			let acInconclusive = false;
			for (const spec of specs) {
				const result = await executeSpec(spec);
				result.ac_number = ac.item_number;
				results.push(result);
				if (result.status === "fail") acFailed = true;
				else if (result.status === "inconclusive") acInconclusive = true;
			}
			if (acFailed) challenges.push(ac.item_number);
			else if (acInconclusive) blockers.push(ac.item_number);
		}

		const { decision, rationale } = computeVerdict(challenges, blockers);

		// Write gate_decision_log for actionable decisions only. 'inconclusive'
		// is a fall-through, not a gate decision, and the decision check
		// constraint does not admit it. from/to_state are both the CURRENT
		// status: D4 is a filter and never transitions the proposal.
		let log_id: number | null = null;
		if (decision !== "inconclusive") {
			try {
				const writeResult = await query(
					`INSERT INTO roadmap_proposal.gate_decision_log
					 (proposal_id, from_state, to_state, maturity, gate, decided_by,
					  decision, rationale, ac_verification, challenges, blockers, project_id)
					 VALUES ($1, $2, $2, $3, 'D4', 'system/d4-validator', $4, $5, $6, $7, $8, $9)
					 RETURNING id`,
					[
						proposal_id,
						prop.status,
						prop.maturity,
						decision,
						correlation_id ? `${rationale} [corr=${correlation_id}]` : rationale,
						JSON.stringify(results),
						challenges.length > 0 ? challenges.map(String) : null,
						blockers.length > 0 ? blockers.map(String) : null,
						prop.project_id,
					],
				);
				const rawId = writeResult.rows[0]?.id;
				log_id = rawId == null ? null : Number(rawId); // pg returns bigint as string
			} catch (err) {
				console.error(
					`[d4-validator] Failed to write gate_decision_log for proposal ${proposal_id}:`,
					err instanceof Error ? err.message : err,
				);
			}
		}

		return {
			decision,
			ac_verification: results,
			challenges,
			blockers,
			log_id,
			rationale,
		};
	} catch (err) {
		console.error(
			`[d4-validator] Unhandled error validating proposal ${proposal_id}:`,
			err instanceof Error ? err.message : err,
		);
		return {
			decision: "inconclusive",
			ac_verification: [],
			challenges: [],
			blockers: [],
			rationale: `Validator internal error: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}
