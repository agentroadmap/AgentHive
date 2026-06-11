/**
 * P1018: Record per-spawn token usage and cost into budget tables.
 *
 * Called once per completed spawn from offer-dispatch-handler (line ~566).
 * This is the single writer for all budget tables; transaction boundaries
 * ensure atomicity.
 *
 * Architecture:
 * 1. Extract token usage via per-provider CliUsageAdapter
 * 2. Fallback to estimator if extraction fails
 * 3. Calculate cost_usd from model_metadata pricing
 * 4. Record atomically in one transaction:
 *    - UPDATE agent_runs with tokens_in/out, cost_usd
 *    - INSERT agent_budget_ledger with proposal/agency/tokens/cost
 *    - INSERT agent_usage_snapshot if quota signal available
 *
 * Exported: recordSpawnUsage() — called by offer-dispatch-handler
 */

import { query } from "../postgres/pool.ts";
import type { SpawnResult } from "../../core/orchestration/agent-spawner.ts";
import {
	getCliUsageAdapter,
	estimateTokensAndCost,
	type SpawnUsage,
} from "./cli-usage-adapter.ts";
import { ObservabilityWriter } from "../../core/observability/observability-writer.ts";
import { checkExtractionFailureAlarm } from "./extraction-failure-alarm.ts";

const obs = new ObservabilityWriter("agency:spawn-usage");

export interface RecordSpawnUsageInput {
	/** Agent run ID from agent_runs table. */
	agentRunId: number;
	/** Proposal ID (may be null for non-proposal runs). */
	proposalId: number | null;
	/** Agent identity claiming the dispatch. */
	agencyIdentity: string;
	/** Model name used. */
	modelUsed: string;
	/** Provider name (anthropic, openai, google, copilot). */
	provider: string;
	/** Wall-clock duration of spawn in milliseconds. */
	durationMs: number;
	/** The SpawnResult from agent-spawner (stdout/stderr/exitCode). */
	spawnResult: SpawnResult;
	/** Stage/role for cost attribution (e.g., 'develop', 'review'). */
	stage: string | null;
	/** Proposal status at time of dispatch (for cost bucketing). */
	proposalStatus: string | null;
	/** Gate if running in a gate context (D1/D2/D3/D4). */
	gateIdentity: string | null;
	/** Optional role at dispatch time (for reviewer cost bucketing). */
	agentRole: string | null;
	/** Completion status of the run (completed, failed, etc.). */
	status: "completed" | "failed" | "rate_limited" | "timeout" | "cancelled";
	/** Override for test injection. */
	exec?: (sql: string, params?: unknown[]) => Promise<unknown>;
}

export interface RecordSpawnUsageResult {
	/** TRUE if all tables were successfully written. */
	success: boolean;
	/** Cost recorded (USD). */
	costUsd: number;
	/** Tokens in (may be estimated). */
	tokensIn: number | null;
	/** Tokens out (may be estimated). */
	tokensOut: number | null;
	/** TRUE if cost came from real extraction; FALSE if estimated. */
	costSourceReal: boolean;
	/** Diagnostic message on failure. */
	error?: string;
}

/**
 * Main entry point: record spawn usage after completion.
 *
 * Called from offer-dispatch-handler.runSpawn() after the spawn exits,
 * before fn_complete_work_offer (which doesn't update tokens).
 *
 * Returns a result object; caller should log/alert if success=false.
 * Non-fatal: a failed write does not block offer completion, so the
 * dispatch can still complete cleanly even if the ledger write fails.
 */
export async function recordSpawnUsage(
	input: RecordSpawnUsageInput,
): Promise<RecordSpawnUsageResult> {
	const exec = input.exec ?? query;

	try {
		// Step 1: Extract token usage via per-provider adapter
		const adapter = getCliUsageAdapter(input.provider);
		const extracted = adapter.extract(
			input.spawnResult.stdout,
			input.spawnResult.stderr,
		);

		// Step 2: Determine final token counts and cost source
		let tokensIn: number | null = extracted.input_tokens;
		let tokensOut: number | null = extracted.output_tokens;
		let costUsd: number | null = null;
		let costSourceReal = true;

		// If extraction succeeded, calculate cost from pricing
		if (tokensIn !== null && tokensOut !== null) {
			costUsd = await calculateCost(
				input.modelUsed,
				input.provider,
				tokensIn,
				tokensOut,
				extracted.cache_read_tokens ?? 0,
				extracted.cache_creation_tokens ?? 0,
			);
		}

		// Step 3: Fallback estimator if extraction failed
		if (tokensIn === null || tokensOut === null) {
			const modelMetadata = await fetchModelMetadata(
				input.modelUsed,
				input.provider,
			);
			const estimated = estimateTokensAndCost(
				input.durationMs,
				modelMetadata,
			);
			if (estimated.tokens !== null) {
				tokensIn = estimated.tokens;
				tokensOut = 0; // Conservative estimate
				costUsd = estimated.cost_usd;
				costSourceReal = false;
			}
		}

		// Step 4: Record in database (single transaction)
		await exec("BEGIN");
		try {
			// 4a: Update agent_runs with tokens and cost
			if (tokensIn !== null || tokensOut !== null || costUsd !== null) {
				await exec(
					`UPDATE roadmap_workforce.agent_runs
					 SET tokens_in = COALESCE($1, tokens_in),
					     tokens_out = COALESCE($2, tokens_out),
					     cost_usd = COALESCE($3, cost_usd)
					 WHERE id = $4`,
					[tokensIn, tokensOut, costUsd, input.agentRunId],
				);
			}

			// 4b: Insert into agent_budget_ledger (one row per spawn)
			if (input.proposalId && tokensIn !== null) {
				await exec(
					`INSERT INTO roadmap_efficiency.agent_budget_ledger (
					   proposal_id, agent_run_id, agent_identity, model_used,
					   tokens_in, tokens_out, cost_usd, cost_source,
					   proposal_status_at_run, agent_role_at_run, gate_at_run,
					   recorded_at
					 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())`,
					[
						input.proposalId,
						input.agentRunId,
						input.agencyIdentity,
						input.modelUsed,
						tokensIn,
						tokensOut ?? 0,
						costUsd ?? 0,
						costSourceReal ? "real" : "estimated",
						input.proposalStatus,
						input.agentRole,
						input.gateIdentity,
					],
				);
			}

			// 4c: Insert into agent_usage_snapshot if quota signal available
			if (
				extracted.quota_remaining !== null ||
				extracted.quota_limit !== null
			) {
				await exec(
					`INSERT INTO roadmap_workforce.agent_usage_snapshot (
					   provider, agent_identity, tokens_in, tokens_out,
					   cache_creation_tokens, cache_read_tokens,
					   quota_remaining, quota_limit, quota_reset_at,
					   cost_usd_estimate, raw_headers, recorded_at
					 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())`,
					[
						input.provider,
						input.agencyIdentity,
						extracted.input_tokens,
						extracted.output_tokens,
						extracted.cache_creation_tokens,
						extracted.cache_read_tokens,
						extracted.quota_remaining,
						extracted.quota_limit,
						extracted.quota_reset_at,
						costUsd,
						extracted.raw_metadata
							? JSON.stringify(extracted.raw_metadata)
							: null,
					],
				);
			}

			await exec("COMMIT");

			// Step 5: Check extraction failure alarm (non-fatal, runs after transaction)
			const extractionSuccess = tokensIn !== null && tokensOut !== null;
			void checkExtractionFailureAlarm({
				provider: input.provider,
				agentRunId: input.agentRunId,
				extractionSuccess,
				exec,
			}).catch((err) => {
				obs.log({
					level: "warn",
					message: `Extraction failure alarm check failed for run=${input.agentRunId}`,
					error: err instanceof Error ? err.message : String(err),
				});
			});

			return {
				success: true,
				costUsd: costUsd ?? 0,
				tokensIn,
				tokensOut,
				costSourceReal,
			};
		} catch (txnErr) {
			await exec("ROLLBACK").catch(() => {
				/* ignore rollback error */
			});
			throw txnErr;
		}
	} catch (err) {
		const message =
			err instanceof Error ? err.message : String(err);
		obs.log({
			level: "error",
			message: `recordSpawnUsage failed for run=${input.agentRunId}`,
			error: message,
		});

		return {
			success: false,
			costUsd: 0,
			tokensIn: null,
			tokensOut: null,
			costSourceReal: false,
			error: message,
		};
	}
}

/**
 * Fetch model metadata (pricing) from the database.
 *
 * Returns the row from roadmap.model_metadata if found.
 */
async function fetchModelMetadata(
	modelName: string,
	provider: string,
): Promise<{
	expected_tpm?: number;
	cost_per_million_input?: number;
} | null> {
	try {
		const result = (await query(
			`SELECT expected_tpm, cost_per_million_input
			 FROM roadmap.model_metadata
			 WHERE model_name = $1 AND provider = $2`,
			[modelName, provider],
		)) as {
			rows: Array<{
				expected_tpm?: number;
				cost_per_million_input?: number;
			}>;
		};
		return result.rows[0] ?? null;
	} catch {
		return null;
	}
}

/**
 * Calculate cost_usd from extracted token counts and model pricing.
 *
 * Formula: (tokens_in / 1_000_000) * cost_per_million_input
 *        + (tokens_out / 1_000_000) * cost_per_million_output
 *        + (cache_read / 1_000_000) * cost_per_million_cache_hit
 *        + (cache_create / 1_000_000) * cost_per_million_cache_write
 *
 * Returns NULL if pricing unavailable (graceful: 0 cost is better than NULL).
 */
async function calculateCost(
	modelName: string,
	provider: string,
	tokensIn: number,
	tokensOut: number,
	cacheRead: number,
	cacheCreate: number,
): Promise<number | null> {
	try {
		const result = (await query(
			`SELECT cost_per_million_input, cost_per_million_output,
				    cost_per_million_cache_hit, cost_per_million_cache_write
			 FROM roadmap.model_metadata
			 WHERE model_name = $1 AND provider = $2`,
			[modelName, provider],
		)) as {
			rows: Array<{
				cost_per_million_input?: number;
				cost_per_million_output?: number;
				cost_per_million_cache_hit?: number;
				cost_per_million_cache_write?: number;
			}>;
		};

		if (!result.rows[0]) return null;

		const pricing = result.rows[0];
		let cost = 0;

		if (pricing.cost_per_million_input) {
			cost += (tokensIn / 1_000_000) * pricing.cost_per_million_input;
		}
		if (pricing.cost_per_million_output) {
			cost += (tokensOut / 1_000_000) * pricing.cost_per_million_output;
		}
		if (cacheRead > 0 && pricing.cost_per_million_cache_hit) {
			cost += (cacheRead / 1_000_000) * pricing.cost_per_million_cache_hit;
		}
		if (cacheCreate > 0 && pricing.cost_per_million_cache_write) {
			cost += (cacheCreate / 1_000_000) * pricing.cost_per_million_cache_write;
		}

		return cost;
	} catch {
		return null;
	}
}
