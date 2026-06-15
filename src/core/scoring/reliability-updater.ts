/**
 * P3311 AC-7b: Named entry point for post-run reliability score updates.
 *
 * This is the named module required by AC-7b. It loads the completed agent_run
 * row by ID and delegates to recordReliabilityOutcome to write the Beta-Bernoulli
 * update into reliability_score (via fn_record_run_outcome).
 *
 * Usage (e.g. from a cron or post-run hook):
 *   await updateReliabilityScore(agentRunId);
 *
 * For offer-dispatch-handler (live path) use recordReliabilityOutcome directly,
 * since the run fields are already in memory.
 */

import { query } from "../../infra/postgres/pool.ts";
import {
	recordReliabilityOutcome,
	type RunStatus,
} from "../../infra/agency/record-reliability-outcome.ts";

type ExecFn = (sql: string, params?: unknown[]) => Promise<unknown>;

/**
 * Load agent_run row by ID and write its outcome into the reliability ledger.
 *
 * @param runId  - agent_runs.id of the completed run
 * @param db     - optional query executor (defaults to live pool; inject for tests)
 */
export async function updateReliabilityScore(
	runId: number,
	db?: ExecFn,
): Promise<void> {
	const exec = db ?? query;

	const res = (await exec(
		`SELECT proposal_id, agency_identity, model_used, route_id,
		        status, provider_mismatch
		   FROM roadmap_workforce.agent_runs
		  WHERE id = $1`,
		[runId],
	)) as {
		rows: Array<{
			proposal_id: number | null;
			agency_identity: string | null;
			model_used: string | null;
			route_id: number | null;
			status: string;
			provider_mismatch: boolean;
		}>;
	};

	const row = res.rows[0];
	if (!row) return;

	await recordReliabilityOutcome({
		agentRunId: runId,
		proposalId: row.proposal_id,
		agencyIdentity: row.agency_identity,
		modelUsed: row.model_used,
		routeId: row.route_id,
		status: row.status as RunStatus,
		providerMismatch: row.provider_mismatch ?? false,
		exec,
	});
}
