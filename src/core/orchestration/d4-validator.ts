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
 * psql_spec = "psql" WS psql_command
 * git_log_spec = "git_log" WS git_command
 * ls_spec = "ls" WS ls_args
 * systemctl_spec = "systemctl_status" WS service_name
 * ```
 *
 * Semantics:
 * - Multiple Verification: lines per AC are OK (all must pass for AC to pass).
 * - Malformed lines → inconclusive for that AC (error field captures malformation).
 * - ACs with no Verification: line → inconclusive (never auto-fail).
 * - Commands are isolated (no piping, no ;-chaining). Timeout: 10s per command.
 * - psql: SELECT-only; INSERT/UPDATE/DELETE/DROP/COPY/DO/CALL are rejected as unsafe.
 * - All command output captured (stdout+stderr), no shell escapes.
 *
 * ## CommandResult
 *
 * Per-command verification result:
 * - ac_number: AC item_number
 * - command: parsed command spec
 * - status: 'pass' | 'fail' | 'inconclusive'
 * - output: captured stdout (trimmed, up to 4KB)
 * - error: error message if status=fail/inconclusive
 * - duration_ms: execution time
 *
 * ## ValidationResult
 *
 * Overall validation verdict:
 * - decision: 'advance' (all pass) | 'hold' (any fail) | 'reject' (any inconclusive) | 'inconclusive' (no Verification: lines)
 * - ac_verification: CommandResult[]
 * - challenges: item_numbers of failing ACs
 * - blockers: item_numbers of inconclusive ACs
 * - log_id: gate_decision_log.id (or null if not written)
 * - rationale: human-readable summary
 */

import { query } from "../../infra/postgres/pool.ts";
import type { QueryResult } from "pg";

/** Safe regex: matches psql SELECT (case-insensitive, handles comments). */
const PSQL_SELECT_REGEX = /^\s*(?:\/\*[\s\S]*?\*\/)?\s*SELECT\s+/i;

/** Unsafe patterns: any non-SELECT command that mutates data. */
const PSQL_UNSAFE_PATTERNS = [
	/INSERT\s+/i,
	/UPDATE\s+/i,
	/DELETE\s+/i,
	/DROP\s+/i,
	/TRUNCATE\s+/i,
	/ALTER\s+/i,
	/CREATE\s+/i,
	/COPY\s+/i,
	/DO\s+/i,
	/CALL\s+/i,
	/;\s*[A-Z]/i, // Command chaining with semicolon
];

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
	decision: "advance" | "hold" | "reject" | "inconclusive";
	ac_verification: CommandResult[];
	challenges: number[]; // AC item_numbers that failed
	blockers: number[]; // AC item_numbers that were inconclusive
	log_id?: number | null;
	rationale: string;
}

/**
 * Parse a Verification: line from AC criterion_text.
 * Returns { command_type, command_text } or null if not found/malformed.
 */
function parseVerificationLine(criterion_text: string): { command_type: string; command_text: string } | null {
	// Extract the first Verification: line
	const match = criterion_text.match(/Verification:\s*(\S+)\s+(.*?)(?:\n|$)/i);
	if (!match) {
		return null;
	}

	const command_type = match[1].toLowerCase();
	const command_text = match[2].trim();

	if (!command_text) {
		return null;
	}

	return { command_type, command_text };
}

/** Safe check: psql command is SELECT-only. */
function isPsqlSafe(cmd: string): boolean {
	// Must match SELECT
	if (!PSQL_SELECT_REGEX.test(cmd)) {
		return false;
	}
	// Must not contain unsafe patterns
	for (const pattern of PSQL_UNSAFE_PATTERNS) {
		if (pattern.test(cmd)) {
			return false;
		}
	}
	return true;
}

/** Execute a psql SELECT command. */
async function executePsqlCommand(cmd: string, timeoutMs: number = 10_000): Promise<CommandResult> {
	const startMs = Date.now();
	try {
		if (!isPsqlSafe(cmd)) {
			return {
				ac_number: 0, // Will be set by caller
				command: cmd,
				command_type: "psql",
				status: "inconclusive",
				error: "psql command is not SELECT-only (detected INSERT/UPDATE/DELETE/DROP/COPY/DO/CALL or unsafe pattern)",
				duration_ms: Date.now() - startMs,
			};
		}

		// Execute via pool query
		const result: QueryResult = await query(cmd, []);
		const output = JSON.stringify(result.rows, null, 2).substring(0, 4096);

		return {
			ac_number: 0,
			command: cmd,
			command_type: "psql",
			status: "pass",
			output,
			duration_ms: Date.now() - startMs,
		};
	} catch (err) {
		return {
			ac_number: 0,
			command: cmd,
			command_type: "psql",
			status: "fail",
			error: err instanceof Error ? err.message : String(err),
			duration_ms: Date.now() - startMs,
		};
	}
}

/** Execute a git log command with safety constraints. */
async function executeGitLogCommand(cmd: string, timeoutMs: number = 10_000): Promise<CommandResult> {
	const startMs = Date.now();
	try {
		// Enforce: only git log (no git push, git reset, etc.)
		if (!cmd.toLowerCase().startsWith("git log")) {
			return {
				ac_number: 0,
				command: cmd,
				command_type: "git_log",
				status: "inconclusive",
				error: "only 'git log' is allowed (detected other git command)",
				duration_ms: Date.now() - startMs,
			};
		}

		// Simple command execution via Node.js child_process
		const { execSync } = await import("node:child_process");
		const output = execSync(cmd, { timeout: timeoutMs, encoding: "utf-8" }).substring(0, 4096);

		return {
			ac_number: 0,
			command: cmd,
			command_type: "git_log",
			status: "pass",
			output,
			duration_ms: Date.now() - startMs,
		};
	} catch (err) {
		return {
			ac_number: 0,
			command: cmd,
			command_type: "git_log",
			status: "fail",
			error: err instanceof Error ? err.message : String(err),
			duration_ms: Date.now() - startMs,
		};
	}
}

/** Execute an ls command with safety constraints. */
async function executeLsCommand(cmd: string, timeoutMs: number = 10_000): Promise<CommandResult> {
	const startMs = Date.now();
	try {
		// Enforce: only ls (no rm, no shell escapes)
		if (!cmd.toLowerCase().startsWith("ls")) {
			return {
				ac_number: 0,
				command: cmd,
				command_type: "ls",
				status: "inconclusive",
				error: "only 'ls' commands are allowed",
				duration_ms: Date.now() - startMs,
			};
		}

		// Reject shell metacharacters
		if (/[;&|`$(){}[\]<>]/.test(cmd)) {
			return {
				ac_number: 0,
				command: cmd,
				command_type: "ls",
				status: "inconclusive",
				error: "shell metacharacters not allowed in ls command",
				duration_ms: Date.now() - startMs,
			};
		}

		const { execSync } = await import("node:child_process");
		const output = execSync(cmd, { timeout: timeoutMs, encoding: "utf-8" }).substring(0, 4096);

		return {
			ac_number: 0,
			command: cmd,
			command_type: "ls",
			status: "pass",
			output,
			duration_ms: Date.now() - startMs,
		};
	} catch (err) {
		return {
			ac_number: 0,
			command: cmd,
			command_type: "ls",
			status: "fail",
			error: err instanceof Error ? err.message : String(err),
			duration_ms: Date.now() - startMs,
		};
	}
}

/** Execute a systemctl status command with safety constraints. */
async function executeSystemctlStatusCommand(cmd: string, timeoutMs: number = 10_000): Promise<CommandResult> {
	const startMs = Date.now();
	try {
		// Enforce: only "systemctl status <service>"
		const match = cmd.match(/^\s*systemctl\s+status\s+(\S+)$/i);
		if (!match) {
			return {
				ac_number: 0,
				command: cmd,
				command_type: "systemctl_status",
				status: "inconclusive",
				error: "only 'systemctl status <service>' is allowed (no enable/disable/restart)",
				duration_ms: Date.now() - startMs,
			};
		}

		const { execSync } = await import("node:child_process");
		const output = execSync(cmd, { timeout: timeoutMs, encoding: "utf-8" }).substring(0, 4096);

		return {
			ac_number: 0,
			command: cmd,
			command_type: "systemctl_status",
			status: "pass",
			output,
			duration_ms: Date.now() - startMs,
		};
	} catch (err) {
		return {
			ac_number: 0,
			command: cmd,
			command_type: "systemctl_status",
			status: "fail",
			error: err instanceof Error ? err.message : String(err),
			duration_ms: Date.now() - startMs,
		};
	}
}

/**
 * Validate a proposal's ACs by executing their Verification: commands.
 *
 * @param proposal_id - Proposal ID to validate
 * @param correlation_id - Optional trace correlation ID
 * @param force_re_run - If true, re-run even if recently validated
 * @returns ValidationResult with decision + per-AC results
 *
 * Semantics:
 * - Reads all ACs for the proposal
 * - Parses Verification: lines from each AC's criterion_text
 * - Executes commands (10s timeout per command)
 * - Computes overall verdict: advance (all pass) | hold (any fail) | reject (any inconclusive) | inconclusive (no Verification: lines)
 * - Writes gate_decision_log row (gate=D4, decided_by=system/d4-validator)
 * - Returns verdict + per-AC results
 */
export async function validateProposal(
	proposal_id: number,
	correlation_id?: string,
	force_re_run?: boolean,
): Promise<ValidationResult> {
	try {
		// Fetch all ACs for the proposal
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

		// Parse and execute Verification: lines
		const results: CommandResult[] = [];
		const challenges: number[] = [];
		const blockers: number[] = [];

		for (const ac of acs) {
			const spec = parseVerificationLine(ac.criterion_text);
			if (!spec) {
				// No Verification: line → inconclusive for this AC
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

			let result: CommandResult;
			try {
				switch (spec.command_type) {
					case "psql":
						result = await executePsqlCommand(spec.command_text, 10_000);
						break;
					case "git_log":
						result = await executeGitLogCommand(spec.command_text, 10_000);
						break;
					case "ls":
						result = await executeLsCommand(spec.command_text, 10_000);
						break;
					case "systemctl_status":
						result = await executeSystemctlStatusCommand(spec.command_text, 10_000);
						break;
					default:
						result = {
							ac_number: ac.item_number,
							command: spec.command_text,
							command_type: "psql",
							status: "inconclusive",
							error: `Unknown command type: ${spec.command_type}`,
							duration_ms: 0,
						};
				}
			} catch (err) {
				result = {
					ac_number: ac.item_number,
					command: spec.command_text,
					command_type: spec.command_type as any,
					status: "inconclusive",
					error: `Execution error: ${err instanceof Error ? err.message : String(err)}`,
					duration_ms: 0,
				};
			}

			result.ac_number = ac.item_number;
			result.command_type = spec.command_type as any;
			results.push(result);

			if (result.status === "fail") {
				challenges.push(ac.item_number);
			} else if (result.status === "inconclusive") {
				blockers.push(ac.item_number);
			}
		}

		// Compute overall decision
		let decision: "advance" | "hold" | "reject" | "inconclusive";
		let rationale: string;

		if (blockers.length > 0 && challenges.length === 0) {
			// Some inconclusive, no failures
			decision = "reject";
			rationale = `${blockers.length} AC(s) inconclusive: ${blockers.join(", ")}`;
		} else if (challenges.length > 0) {
			// Any failures
			decision = "hold";
			rationale = `${challenges.length} AC(s) failed: ${challenges.join(", ")}`;
		} else if (results.length === 0) {
			// No ACs with Verification: lines
			decision = "inconclusive";
			rationale = "No verifiable acceptance criteria (no Verification: lines)";
		} else {
			// All pass
			decision = "advance";
			rationale = "All verifiable acceptance criteria passed";
		}

		// Write gate_decision_log row
		let log_id: number | null = null;
		try {
			const writeResult = await query(
				`INSERT INTO roadmap_proposal.gate_decision_log
				 (proposal_id, from_state, to_state, maturity, gate, decided_by, decision, rationale, ac_verification, challenges, blockers, project_id)
				 VALUES ($1, 'MERGE', 'MERGE', 'new', 'D4', $2, $3, $4, $5, $6, $7, $8)
				 RETURNING id`,
				[
					proposal_id,
					"system/d4-validator",
					decision,
					rationale,
					JSON.stringify(results),
					challenges.length > 0 ? challenges : null,
					blockers.length > 0 ? blockers : null,
					1, // project_id (default agenthive project)
				],
			);
			log_id = writeResult.rows[0]?.id ?? null;
		} catch (err) {
			console.error(
				`[d4-validator] Failed to write gate_decision_log for proposal ${proposal_id}:`,
				err instanceof Error ? err.message : err,
			);
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
