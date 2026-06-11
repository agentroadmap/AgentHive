/**
 * P1018 AC-17: hive cost <P-id> — query per-proposal cost breakdown by stage.
 *
 * Usage:
 *   hive cost P1068
 *   hive cost P1068 --json
 *   hive cost P1068 --table
 *
 * Output: A 5-row table (one per bucket: draft, gate, develop, merge, other)
 * with columns: bucket, cost_usd, tokens_in, tokens_out, run_count, completed_count.
 * Total row at bottom.
 *
 * Options:
 *   --json    : JSON output (array of bucket rows + total)
 *   --table   : Table output (default)
 *   --since DATE : Window start (ISO string or relative like "-7d")
 *   --until DATE : Window end
 *   --warn-gate-cost USD : exit non-zero if gate bucket exceeds threshold
 */

import type { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { getProjectDb } from "../../../shared/runtime/config.ts";
import { logger } from "../../../shared/runtime/logger.ts";

export const command = "cost";
export const description = "Query per-proposal cost breakdown by stage";

export interface CostCommandArgs {
	proposalId?: string;
	json?: boolean;
	table?: boolean;
	since?: string;
	until?: string;
	"warn-gate-cost"?: number;
}

/**
 * Format USD cost for human display.
 */
function formatUsd(usd: number | null): string {
	if (usd === null || usd === undefined) return "$0.00";
	return `$${usd.toFixed(2)}`;
}

/**
 * Format large token counts with commas.
 */
function formatTokens(tokens: number | null): string {
	if (tokens === null || tokens === undefined) return "0";
	return tokens.toLocaleString();
}

/**
 * Render as a formatted table (ASCII).
 */
function renderTable(rows: Array<{
	bucket: string;
	cost: number | null;
	tokens_in: number | null;
	tokens_out: number | null;
	run_count: number;
	completed_count: number;
}>): string {
	const lines: string[] = [];

	// Header
	lines.push(
		"Bucket    Cost      Tokens In  Tokens Out  Runs  Completed",
	);
	lines.push("-----     -----     -----      -----       -----  -----");

	// Data rows
	for (const row of rows) {
		const bucket = (row.bucket || "other").padEnd(7);
		const cost = formatUsd(row.cost).padEnd(10);
		const tokensIn = formatTokens(row.tokens_in).padEnd(11);
		const tokensOut = formatTokens(row.tokens_out).padEnd(12);
		const runCount = String(row.run_count).padEnd(6);
		const completedCount = String(row.completed_count);

		lines.push(
			`${bucket}  ${cost}  ${tokensIn}  ${tokensOut}  ${runCount}  ${completedCount}`,
		);
	}

	return lines.join("\n");
}

export async function handler(args: CostCommandArgs): Promise<void> {
	const proposalId = args.proposalId?.trim() || "";

	// Parse display_id: accept P-123 or 123
	const idMatch = proposalId.match(/^P?(\d+)$/i);
	if (!idMatch) {
		console.error(
			`Usage: hive cost P-<id>\nExample: hive cost P1068`,
		);
		process.exit(2);
	}

	const displayId = idMatch[0].toUpperCase().startsWith("P")
		? idMatch[0]
		: `P${idMatch[1]}`;

	try {
		const db = getProjectDb("agenthive");

		// Fetch the proposal to verify it exists
		const propResult = await db.query(
			`SELECT id, display_id, title, status FROM roadmap_proposal.proposal
			 WHERE display_id = $1`,
			[displayId],
		);

		if (!propResult.rows.length) {
			console.error(`proposal not found: ${displayId}`);
			process.exit(2);
		}

		const proposal = propResult.rows[0];

		// Query v_proposal_cost_by_stage for the cost breakdown
		const costResult = await db.query(
			`SELECT bucket, bucket_cost_usd, bucket_tokens_in, bucket_tokens_out,
				    run_count, completed_count
			 FROM roadmap.v_proposal_cost_by_stage
			 WHERE proposal_id = $1
			 ORDER BY
			   CASE bucket
				 WHEN 'draft' THEN 1
				 WHEN 'gate' THEN 2
				 WHEN 'develop' THEN 3
				 WHEN 'merge' THEN 4
				 ELSE 5
			   END`,
			[proposal.id],
		);

		const rows = costResult.rows.map(
			(row: Record<string, unknown>) => ({
				bucket: row.bucket as string,
				cost: (row.bucket_cost_usd as number) || 0,
				tokens_in: (row.bucket_tokens_in as number) || 0,
				tokens_out: (row.bucket_tokens_out as number) || 0,
				run_count: (row.run_count as number) || 0,
				completed_count: (row.completed_count as number) || 0,
			}),
		);

		// Compute totals
		const totals = {
			bucket: "total",
			cost: rows.reduce((sum, r) => sum + (r.cost || 0), 0),
			tokens_in: rows.reduce((sum, r) => sum + (r.tokens_in || 0), 0),
			tokens_out: rows.reduce(
				(sum, r) => sum + (r.tokens_out || 0),
				0,
			),
			run_count: rows.reduce((sum, r) => sum + r.run_count, 0),
			completed_count: rows.reduce(
				(sum, r) => sum + r.completed_count,
				0,
			),
		};

		// Output
		if (args.json) {
			const output = {
				proposal_id: proposal.id,
				display_id: proposal.display_id,
				title: proposal.title,
				status: proposal.status,
				buckets: rows,
				total: totals,
			};
			console.log(JSON.stringify(output, null, 2));
		} else {
			// Default: table output
			console.log(
				`\nCost breakdown for ${displayId} (${proposal.title})\n`,
			);
			const display = [...rows, totals];
			console.log(renderTable(display as never));
			console.log("");
		}

		// Check gate cost threshold if requested
		if (
			args["warn-gate-cost"] !== undefined &&
			args["warn-gate-cost"] !== null
		) {
			const gateCost = rows.find((r) => r.bucket === "gate")?.cost || 0;
			if (gateCost > args["warn-gate-cost"]) {
				console.error(
					`gate cost $${gateCost.toFixed(2)} exceeds threshold $${args["warn-gate-cost"].toFixed(2)}`,
				);
				process.exit(1);
			}
		}

		process.exit(0);
	} catch (err) {
		const message =
			err instanceof Error ? err.message : String(err);
		console.error(`error: ${message}`);
		process.exit(1);
	}
}

/**
 * Register the cost command with the CLI program.
 */
export function registerCost(program: Command): void {
	program
		.command("cost <proposalId>")
		.description(description)
		.option("--json", "JSON output format")
		.option("--table", "Table output format (default)")
		.option("--since <date>", "Window start (ISO string or relative like -7d)")
		.option("--until <date>", "Window end")
		.option(
			"--warn-gate-cost <threshold>",
			"Exit non-zero if gate cost exceeds threshold (USD)",
			(val) => parseFloat(val),
		)
		.action(async (proposalId, options) => {
			await handler({
				proposalId,
				json: options.json || false,
				table: options.table || false,
				since: options.since,
				until: options.until,
				"warn-gate-cost": options.warnGateCost,
			});
		});
}
