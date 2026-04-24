/**
 * postWorkOffer — shared utility for posting a work offer to squad_dispatch.
 *
 * Used by both PipelineCron (gate transitions) and the Orchestrator (agent
 * dispatch). Posting an offer decouples the caller from knowing which CLI
 * or binary path to use — the agency that claims the offer handles that.
 */

import { query as defaultQuery } from "../../infra/postgres/pool.ts";

export type QueryFn = typeof defaultQuery;

export interface WorkOfferInput {
	proposalId: number;
	squadName: string;
	role: string;
	task: string;
	stage?: string;
	phase?: string;
	model?: string;
	timeoutMs?: number;
	worktreeHint?: string;
	requiredCapabilities?: string[];
}

export interface WorkOfferResult {
	dispatchId: number;
}

/**
 * Insert a work offer into squad_dispatch and notify the work_offers channel.
 * Any registered OfferProvider listening on that channel will race to claim it.
 */
export async function postWorkOffer(
	input: WorkOfferInput,
	queryFn: QueryFn = defaultQuery,
): Promise<WorkOfferResult> {
	const metadata: Record<string, unknown> = { task: input.task };
	if (input.stage) metadata.stage = input.stage;
	if (input.phase) metadata.phase = input.phase;
	if (input.model) metadata.model = input.model;
	if (input.timeoutMs) metadata.timeout_ms = input.timeoutMs;
	if (input.worktreeHint) metadata.worktree_hint = input.worktreeHint;

	const caps = input.requiredCapabilities?.length
		? JSON.stringify({ all: input.requiredCapabilities })
		: "{}";

	const existing = await queryFn<{ id: number }>(
		`SELECT id
		 FROM roadmap_workforce.squad_dispatch
		 WHERE proposal_id = $1
		   AND dispatch_role = $2
		   AND (
		     completed_at IS NULL
		     OR dispatch_status IN ('assigned', 'active', 'blocked')
		     OR offer_status IN ('open', 'claimed', 'activated')
		   )
		 ORDER BY assigned_at DESC
		 LIMIT 1`,
		[input.proposalId, input.role],
	);
	const existingId = existing.rows[0]?.id;
	if (existingId) return { dispatchId: existingId };

	const { rows } = await queryFn<{ id: number }>(
		`INSERT INTO roadmap_workforce.squad_dispatch
		   (proposal_id, squad_name, dispatch_role, dispatch_status,
		    offer_status, agent_identity, required_capabilities, metadata)
		 VALUES ($1, $2, $3, 'open', 'open', NULL, $4::jsonb, $5::jsonb)
		 RETURNING id`,
		[
			input.proposalId,
			input.squadName,
			input.role,
			caps,
			JSON.stringify(metadata),
		],
	);

	const dispatchId = rows[0]?.id;
	if (!dispatchId) throw new Error("postWorkOffer: INSERT returned no id");

	await queryFn(`SELECT pg_notify('work_offers', $1)`, [
		JSON.stringify({
			event: "emitted",
			dispatch_id: dispatchId,
			proposal_id: input.proposalId,
			role: input.role,
		}),
	]);

	return { dispatchId };
}
