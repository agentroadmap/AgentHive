import {
	getRecentEvents,
	type StreamEvent,
} from "../../core/messaging/event-stream.ts";
import { query } from "../../postgres/pool.ts";

type FeedRow = {
	id: string;
	type: StreamEvent["type"];
	timestamp_ms: number | string | Date;
	proposal_id: string | null;
	agent_id: string | null;
	message: string;
};

export function dedupeBoardLiveFeed(events: StreamEvent[]): StreamEvent[] {
	const seen = new Set<string>();
	const deduped: StreamEvent[] = [];

	for (const event of events) {
		const key = [
			event.type,
			event.proposalId ?? "",
			event.agentId ?? "",
			event.message.trim(),
			String(event.timestamp),
		].join("|");
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(event);
	}

	return deduped;
}

export function timestampToMillis(value: FeedRow["timestamp_ms"]): number {
	if (value instanceof Date) return value.getTime();
	if (typeof value === "number") return value;
	const parsed = Number(value);
	if (Number.isFinite(parsed)) return parsed;
	const fallback = Date.parse(value);
	return Number.isFinite(fallback) ? fallback : Date.now();
}

export async function getBoardLiveFeed(limit = 100): Promise<StreamEvent[]> {
	try {
		const { rows } = await query<FeedRow>(
			`
			WITH feed AS (
				SELECT
					'state-' || pst.id::text AS id,
					'handoff' AS type,
					EXTRACT(EPOCH FROM pst.transitioned_at) * 1000 AS timestamp_ms,
					p.display_id AS proposal_id,
					pst.transitioned_by AS agent_id,
					p.display_id || ' state ' || pst.from_state || ' -> ' || pst.to_state AS message
				FROM roadmap_proposal.proposal_state_transitions pst
				LEFT JOIN roadmap_proposal.proposal p ON p.id = pst.proposal_id

				UNION ALL

				SELECT
					'maturity-' || pmt.id::text AS id,
					'proposal_reviewing' AS type,
					EXTRACT(EPOCH FROM pmt.created_at) * 1000 AS timestamp_ms,
					p.display_id AS proposal_id,
					pmt.transitioned_by AS agent_id,
					p.display_id || ' maturity ' || COALESCE(pmt.from_maturity, '?') || ' -> ' || pmt.to_maturity AS message
				FROM roadmap_proposal.proposal_maturity_transitions pmt
				LEFT JOIN roadmap_proposal.proposal p ON p.id = pmt.proposal_id

				UNION ALL

				SELECT
					'event-' || pe.id::text AS id,
					'custom' AS type,
					EXTRACT(EPOCH FROM pe.created_at) * 1000 AS timestamp_ms,
					p.display_id AS proposal_id,
					COALESCE(pe.payload->>'agent', pe.payload->>'agent_identity', pe.payload->>'source') AS agent_id,
					CASE
						WHEN pe.event_type = 'proposal_created' THEN
							COALESCE(p.display_id || ' ', '') || 'created ' || COALESCE(p.title, '(untitled)')
						WHEN pe.event_type = 'lease_claimed' THEN
							COALESCE(p.display_id || ' ', '') || 'lease claimed by ' ||
								COALESCE(pe.payload->>'agent', pe.payload->>'agent_identity', 'agent') ||
								CASE
									WHEN pe.payload->>'expires_at' IS NOT NULL THEN
										' until ' || pe.payload->>'expires_at'
									ELSE ''
								END
						WHEN pe.event_type = 'lease_released' THEN
							COALESCE(p.display_id || ' ', '') || 'lease released by ' ||
								COALESCE(pe.payload->>'agent', pe.payload->>'agent_identity', 'agent') ||
								CASE
									WHEN pe.payload->>'release_reason' IS NOT NULL THEN
										' (' || pe.payload->>'release_reason' || ')'
									ELSE ''
								END
						WHEN pe.event_type = 'status_changed' THEN
							COALESCE(p.display_id || ' ', '') || 'state ' ||
								COALESCE(pe.payload->>'from', '?') || ' -> ' || COALESCE(pe.payload->>'to', '?')
						WHEN pe.event_type = 'maturity_changed' THEN
							COALESCE(p.display_id || ' ', '') || 'maturity ' ||
								COALESCE(pe.payload->>'from', '?') || ' -> ' || COALESCE(pe.payload->>'to', '?')
						ELSE
							COALESCE(p.display_id || ' ', '') || pe.event_type
					END AS message
				FROM roadmap_proposal.proposal_event pe
				LEFT JOIN roadmap_proposal.proposal p ON p.id = pe.proposal_id
				WHERE pe.event_type NOT IN ('status_changed', 'maturity_changed', 'lease_claimed', 'lease_released')

				UNION ALL

				SELECT
					'msg-' || ml.id::text AS id,
					'message' AS type,
					EXTRACT(EPOCH FROM ml.created_at) * 1000 AS timestamp_ms,
					p.display_id AS proposal_id,
					ml.from_agent AS agent_id,
					COALESCE(ml.from_agent, 'agent') || ' -> ' || COALESCE(ml.to_agent, ml.channel, 'broadcast') || ': ' ||
						left(regexp_replace(COALESCE(ml.message_content, ''), E'[\\n\\r]+', ' ', 'g'), 120) AS message
				FROM roadmap.message_ledger ml
				LEFT JOIN roadmap_proposal.proposal p ON p.id = ml.proposal_id

				UNION ALL

				SELECT
					'run-' || ar.id::text AS id,
					CASE WHEN ar.status = 'completed' THEN 'review_passed'
						WHEN ar.status = 'failed' THEN 'review_failed'
						ELSE 'proposal_coding'
					END AS type,
					EXTRACT(EPOCH FROM COALESCE(ar.completed_at, ar.started_at)) * 1000 AS timestamp_ms,
					p.display_id AS proposal_id,
					ar.agent_identity AS agent_id,
					COALESCE(p.display_id || ' ', '') ||
						'run-' || ar.id::text || ' ' ||
						ar.agent_identity || ' ' ||
						COALESCE(ar.activity, ar.status) ||
						' stage=' || ar.stage ||
						' model=' || ar.model_used ||
						CASE
							WHEN mr.route_provider IS NOT NULL THEN
								' provider=' || mr.route_provider || '/' || mr.agent_provider ||
								' cli=' || COALESCE(mr.agent_cli, '-')
							ELSE ''
						END ||
						CASE
							WHEN ar.duration_ms IS NOT NULL THEN ' duration=' || ar.duration_ms::text || 'ms'
							ELSE ''
						END AS message
				FROM roadmap_workforce.agent_runs ar
				LEFT JOIN roadmap_proposal.proposal p ON p.id = ar.proposal_id
				LEFT JOIN LATERAL (
					SELECT model_name, route_provider, agent_provider, agent_cli
					FROM roadmap.model_routes
					WHERE model_name = ar.model_used
					ORDER BY is_default DESC, priority ASC
					LIMIT 1
				) mr ON true

				UNION ALL

				SELECT
					'token-' || tl.id::text AS id,
					'heartbeat' AS type,
					EXTRACT(EPOCH FROM tl.created_at) * 1000 AS timestamp_ms,
					p.display_id AS proposal_id,
					tl.agent_identity AS agent_id,
					COALESCE(p.display_id || ' ', '') || tl.agent_identity || ' tokens ' || tl.token_count::text ||
						' cost $' || to_char(tl.cost_usd, 'FM999999990.0000') AS message
				FROM roadmap_efficiency.token_ledger tl
				LEFT JOIN roadmap_proposal.proposal p ON p.id = tl.proposal_id

				UNION ALL

				SELECT
					'cache-hit-' || chl.id::text AS id,
					'heartbeat' AS type,
					EXTRACT(EPOCH FROM chl.hit_at) * 1000 AS timestamp_ms,
					NULL AS proposal_id,
					chl.agent_identity AS agent_id,
					chl.agent_identity || ' cache hit saved $' || to_char(chl.cost_saved_usd, 'FM999999990.0000') AS message
				FROM roadmap_efficiency.cache_hit_log chl
			)
			SELECT id, type, timestamp_ms, proposal_id, agent_id, message
			FROM feed
			WHERE timestamp_ms IS NOT NULL
			ORDER BY timestamp_ms DESC
			LIMIT $1
			`,
			[limit],
		);

		return dedupeBoardLiveFeed(
			rows.map((row) => ({
				id: row.id,
				type: row.type,
				timestamp: timestampToMillis(row.timestamp_ms),
				proposalId: row.proposal_id ?? undefined,
				agentId: row.agent_id ?? undefined,
				message: row.message,
				metadata: {},
			})),
		);
	} catch {
		return getRecentEvents(limit);
	}
}
