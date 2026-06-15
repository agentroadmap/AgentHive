/**
 * P3313 AC-2: Closed feedback loop — post-run reliability ledger update.
 *
 * This is the CLOSED LOOP of the P3309 adaptive-matching group:
 *   matcher (P3312) reads reliability_score  ->  agent runs  ->  THIS hook writes
 *   the outcome back into reliability_score  ->  next match sees the new score.
 *
 * Invoked once per completed spawn from offer-dispatch-handler, alongside
 * recordSpawnUsage (P1018). Non-fatal: a failed write never blocks dispatch
 * completion.
 *
 * The actual Beta(α,β) update is done by the DB function
 *   roadmap_workforce.fn_record_run_outcome(scope_type, scope_key, task_class,
 *                                           outcome, weight)
 * (migration 268-p3313). A hard_failure raises β, lowering score = α/(α+β) on
 * the next read — this is what AC-2's integration test asserts.
 *
 * task_class is resolved best-effort from squad_dispatch (the same dimension the
 * P3311 batch refresh joins on); when it cannot be resolved we fall back to
 * '_global' so the model/route still accrues a generic reliability signal.
 */

import { query } from "../postgres/pool.ts";
import { ObservabilityWriter } from "../../core/observability/observability-writer.ts";

const obs = new ObservabilityWriter("agency:reliability-outcome");

/** Run status as recorded in agent_runs / passed by the dispatch handler. */
export type RunStatus =
	| "completed"
	| "failed"
	| "rate_limited"
	| "timeout"
	| "cancelled";

/** Outcome categories understood by fn_record_run_outcome. */
export type ReliabilityOutcome =
	| "success"
	| "hard_failure"
	| "protocol_failure"
	| "rework"
	| "mismatch";

export interface RecordReliabilityOutcomeInput {
	/** agent_runs.id of the completed run. */
	agentRunId: number;
	/** Proposal the run was for (null for ad-hoc runs). Used to resolve task_class. */
	proposalId: number | null;
	/** Agency identity that ran the work (scope_type='agency'). */
	agencyIdentity: string | null;
	/** Model name used (scope_type='model'). */
	modelUsed: string | null;
	/** Route id if known (scope_type='route'). */
	routeId: number | null;
	/** Terminal status of the run. */
	status: RunStatus;
	/** TRUE if the run exited 0 but was judged degenerate/no-artifact (=> rework signal). */
	degenerate?: boolean;
	/** TRUE if claimed provider != resolved provider (=> mismatch signal). */
	providerMismatch?: boolean;
	/** Explicit task_class override (skips DB resolution when provided). */
	taskClass?: string | null;
	/** Test injection seam. */
	exec?: (sql: string, params?: unknown[]) => Promise<unknown>;
}

export interface RecordReliabilityOutcomeResult {
	success: boolean;
	/** Outcome category that was recorded. */
	outcome: ReliabilityOutcome | null;
	/** task_class the outcome was attributed to. */
	taskClass: string;
	/** Number of (scope,task_class) cells updated (model + agency + route). */
	scopesUpdated: number;
	error?: string;
}

/**
 * Map a terminal run status (+ flags) to a reliability outcome category.
 *
 * Precedence: hard terminal failures first, then degraded-success signals.
 * - failed / timeout            -> hard_failure
 * - cancelled / rate_limited    -> ignored (not the model's fault) -> null
 * - completed + degenerate      -> rework   (exited 0 but output rejected)
 * - completed + providerMismatch-> mismatch (ran on wrong provider)
 * - completed (clean)           -> success
 */
export function classifyOutcome(
	status: RunStatus,
	opts: { degenerate?: boolean; providerMismatch?: boolean } = {},
): ReliabilityOutcome | null {
	switch (status) {
		case "failed":
		case "timeout":
			return "hard_failure";
		case "cancelled":
		case "rate_limited":
			// Operator/quota-driven, not a reliability signal for the model.
			return null;
		case "completed":
			if (opts.degenerate) return "rework";
			if (opts.providerMismatch) return "mismatch";
			return "success";
		default:
			return null;
	}
}

/**
 * Resolve task_class for a run, best-effort, from squad_dispatch.
 * Returns '_global' when no class can be determined.
 */
async function resolveTaskClass(
	exec: (sql: string, params?: unknown[]) => Promise<unknown>,
	proposalId: number | null,
	agencyIdentity: string | null,
): Promise<string> {
	if (proposalId == null) return "_global";
	try {
		const res = (await exec(
			`SELECT task_class
			   FROM roadmap_workforce.squad_dispatch
			  WHERE proposal_id = $1
			    AND ($2::text IS NULL OR agency_identity = $2)
			    AND task_class IS NOT NULL
			  ORDER BY COALESCE(completed_at, assigned_at) DESC
			  LIMIT 1`,
			[proposalId, agencyIdentity],
		)) as { rows: Array<{ task_class: string | null }> };
		return res.rows[0]?.task_class ?? "_global";
	} catch {
		return "_global";
	}
}

/**
 * Closed-loop entry point. Writes the run outcome into the reliability ledger
 * for every resolvable scope (model, agency, route).
 */
export async function recordReliabilityOutcome(
	input: RecordReliabilityOutcomeInput,
): Promise<RecordReliabilityOutcomeResult> {
	const exec = input.exec ?? query;

	const outcome = classifyOutcome(input.status, {
		degenerate: input.degenerate,
		providerMismatch: input.providerMismatch,
	});

	const taskClass =
		input.taskClass ??
		(await resolveTaskClass(exec, input.proposalId, input.agencyIdentity));

	// Ignored statuses (cancelled / rate_limited) — nothing to learn.
	if (outcome === null) {
		return {
			success: true,
			outcome: null,
			taskClass,
			scopesUpdated: 0,
		};
	}

	const scopes: Array<{ type: "model" | "agency" | "route"; key: string }> = [];
	if (input.modelUsed) scopes.push({ type: "model", key: input.modelUsed });
	if (input.agencyIdentity)
		scopes.push({ type: "agency", key: input.agencyIdentity });
	if (input.routeId != null)
		scopes.push({ type: "route", key: String(input.routeId) });

	let updated = 0;
	try {
		for (const scope of scopes) {
			await exec(
				`SELECT roadmap_workforce.fn_record_run_outcome($1, $2, $3, $4, $5)`,
				[scope.type, scope.key, taskClass, outcome, 1.0],
			);
			updated++;
		}
		return {
			success: true,
			outcome,
			taskClass,
			scopesUpdated: updated,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		obs.log({
			level: "error",
			message: `recordReliabilityOutcome failed for run=${input.agentRunId} (outcome=${outcome}, task_class=${taskClass})`,
			error: message,
		});
		return {
			success: false,
			outcome,
			taskClass,
			scopesUpdated: updated,
			error: message,
		};
	}
}
