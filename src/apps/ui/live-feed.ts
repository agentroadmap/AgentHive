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

// Module-level cache of the last successful query result. The original
// catch path fell back to getRecentEvents() (in-process buffer) which is
// empty in a freshly spawned `roadmap board` process — that produced the
// "feed empty on re-entry" symptom when a transient pool/query hiccup
// kicked the second invocation onto the fallback. Caching the most recent
// success means the panel keeps showing the last known feed instead of
// going blank.
let lastSuccessfulFeed: StreamEvent[] = [];

export async function getBoardLiveFeed(limit = 100): Promise<StreamEvent[]> {
	try {
		const { rows } = await query<FeedRow>(
			`
			WITH hosts AS (
				SELECT lower(host_id) AS host_id
				FROM roadmap.agency
				WHERE host_id IS NOT NULL
			),
			feed AS (
				SELECT
					'state-' || pst.id::text AS id,
					'handoff' AS type,
					EXTRACT(EPOCH FROM pst.transitioned_at) * 1000 AS timestamp_ms,
					p.display_id AS proposal_id,
					pst.transitioned_by AS agent_id,
					p.display_id || ' state ' || upper(COALESCE(pst.from_state, '?')) || ' -> ' || upper(pst.to_state)
						|| COALESCE(' by ' || NULLIF(pst.transitioned_by, ''), '')
						|| COALESCE(' — ' || left(p.title, 48), '') AS message
				FROM roadmap_proposal.proposal_state_transitions pst
				LEFT JOIN roadmap_proposal.proposal p ON p.id = pst.proposal_id

				UNION ALL

				SELECT
					'maturity-' || pmt.id::text AS id,
					'proposal_reviewing' AS type,
					EXTRACT(EPOCH FROM pmt.created_at) * 1000 AS timestamp_ms,
					p.display_id AS proposal_id,
					pmt.transitioned_by AS agent_id,
					p.display_id || ' [' || upper(COALESCE(state_at.to_state, p.status, '?')) || '] maturity ' ||
						COALESCE(pmt.from_maturity, '?') || ' -> ' || pmt.to_maturity
						|| COALESCE(' by ' || NULLIF(pmt.transitioned_by, ''), '')
						|| COALESCE(' — ' || left(p.title, 48), '') AS message
				FROM roadmap_proposal.proposal_maturity_transitions pmt
				LEFT JOIN roadmap_proposal.proposal p ON p.id = pmt.proposal_id
				LEFT JOIN LATERAL (
					SELECT pst2.to_state
					FROM roadmap_proposal.proposal_state_transitions pst2
					WHERE pst2.proposal_id = pmt.proposal_id
					  AND pst2.transitioned_at <= pmt.created_at
					ORDER BY pst2.transitioned_at DESC, pst2.id DESC
					LIMIT 1
				) state_at ON true

				UNION ALL

				SELECT
					'event-' || pe.id::text AS id,
					'custom' AS type,
					EXTRACT(EPOCH FROM pe.created_at) * 1000 AS timestamp_ms,
					p.display_id AS proposal_id,
					COALESCE(pe.payload->>'agent', pe.payload->>'agent_identity', pe.payload->>'reviewer', pe.payload->>'source') AS agent_id,
					CASE
						WHEN pe.event_type = 'proposal_created' THEN
							COALESCE(p.display_id || ' ', '') || 'created ' || COALESCE(p.title, '(untitled)')
						WHEN pe.event_type = 'lease_claimed' THEN
							COALESCE(p.display_id || ' ', '') || 'lease claimed by ' ||
								COALESCE(pe.payload->>'agent', pe.payload->>'agent_identity', 'agent') ||
								CASE
									WHEN pe.payload->>'expires_at' IS NOT NULL THEN
										' until ' || (pe.payload->>'expires_at')
									ELSE ''
								END
						WHEN pe.event_type = 'lease_released' THEN
							COALESCE(p.display_id || ' ', '') || 'lease released by ' ||
								COALESCE(pe.payload->>'agent', pe.payload->>'agent_identity', 'agent') ||
								CASE
									WHEN pe.payload->>'release_reason' IS NOT NULL THEN
										' (' || (pe.payload->>'release_reason') || ')'
									ELSE ''
								END
						WHEN pe.event_type = 'status_changed' THEN
							COALESCE(p.display_id || ' ', '') || 'state ' ||
								COALESCE(pe.payload->>'from', '?') || ' -> ' || COALESCE(pe.payload->>'to', '?')
						WHEN pe.event_type = 'maturity_changed' THEN
							COALESCE(p.display_id || ' ', '') || 'maturity ' ||
								COALESCE(pe.payload->>'from', '?') || ' -> ' || COALESCE(pe.payload->>'to', '?')
						WHEN pe.event_type = 'decision_made' THEN
							COALESCE(p.display_id || ' ', '') ||
								'[' || upper(COALESCE(pe.payload->>'proposal_status', p.status, '?')) || '] decision ' ||
								CASE WHEN pe.payload->>'gate' IS NOT NULL
									THEN '(' || (pe.payload->>'gate') || ') '
									ELSE '' END ||
								COALESCE(
									pe.payload->>'gate_decision',
									pe.payload->>'verdict',
									left(pe.payload->>'decision', 80),
									'?'
								) ||
								CASE WHEN pe.payload->>'to_state' IS NOT NULL
									THEN ' -> ' || (pe.payload->>'to_state')
									WHEN pe.payload->>'target_state' IS NOT NULL
									THEN ' -> ' || (pe.payload->>'target_state')
									ELSE '' END
						WHEN pe.event_type = 'review_submitted' THEN
							COALESCE(p.display_id || ' ', '') ||
								'[' || upper(COALESCE(p.status, '?')) || '] review by ' ||
								COALESCE(pe.payload->>'reviewer', pe.payload->>'agent', 'agent') ||
								': ' || COALESCE(pe.payload->>'verdict', '?')
						ELSE
							COALESCE(p.display_id || ' ', '') ||
								'[' || upper(COALESCE(p.status, '?')) || '] ' || pe.event_type
					END
						|| CASE
							WHEN pe.event_type = 'proposal_created' THEN ''
							ELSE COALESCE(' — ' || left(p.title, 48), '')
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
						left(regexp_replace(COALESCE(ml.message_content, ''), E'[\\n\\r]+', ' ', 'g'), 120)
						|| COALESCE(' — ' || left(p.title, 48), '') AS message
				FROM roadmap.message_ledger ml
				LEFT JOIN roadmap_proposal.proposal p ON p.id = ml.proposal_id
				WHERE btrim(COALESCE(ml.message_content, '')) <> ''
				  AND NOT (
					ml.message_type = 'event'
					AND btrim(ml.message_content) = 'heartbeat'
					AND COALESCE(ml.channel, '') LIKE 'system:liaison:%'
				  )

				UNION ALL

				SELECT
					'run-' || ar.id::text AS id,
					CASE WHEN ar.status = 'completed' THEN 'review_passed'
						WHEN ar.status = 'failed' THEN 'review_failed'
						ELSE 'proposal_coding'
					END AS type,
					EXTRACT(EPOCH FROM COALESCE(ar.completed_at, ar.started_at)) * 1000 AS timestamp_ms,
					p.display_id AS proposal_id,
					-- agent_id surfaces in the headlines view's sender column. For
					-- legacy hash identities (ccs46ant-bot-archi-a) substitute the
					-- agent_cli ('claude'/'codex'/'gemini') so the operator sees
					-- which CLI is running instead of a useless "agent" placeholder.
					-- Permanent agents (andy, mimo, claude-mimo-a) keep their name.
					CASE
						WHEN ar.agent_identity ~ '^[a-z0-9]{6,10}-bot-[a-z]{2,6}-[a-z]$'
							THEN COALESCE(mr.agent_cli, mr.route_provider, 'agent')
						ELSE ar.agent_identity
					END AS agent_id,
					-- Drop the obfuscated legacy agent_identity (e.g. ccs46ant-bot-enhan-a)
					-- from the displayed message. stage + provider already convey what's
					-- running; the long hash adds no info. Permanent agents (andy, mimo,
					-- claude-mimo-a) still show because their display_label differs from
					-- the hash pattern.
					COALESCE(p.display_id || ' ', '') ||
						'run-' || ar.id::text ||
						CASE
							WHEN COALESCE(ar_reg.display_label, ar.agent_identity) ~ '^[a-z0-9]{6,10}-bot-[a-z]{2,6}-[a-z]$'
								THEN ''  -- legacy obfuscated identity, hide
							ELSE ' ' || COALESCE(ar_reg.display_label, ar.agent_identity)
						END ||
						' ' || ar.stage || ' ' ||
						COALESCE(ar.activity, ar.status) ||
						CASE
							WHEN mr.route_provider IS NOT NULL THEN
								' (' || mr.route_provider || '/' || mr.agent_provider || ')'
							ELSE ' (' || ar.model_used || ')'
						END ||
						CASE
							WHEN ar.duration_ms IS NOT NULL THEN ' [' || (ar.duration_ms / 1000)::text || 's]'
							ELSE ''
						END
						|| COALESCE(' — ' || left(p.title, 48), '') AS message
				FROM roadmap_workforce.agent_runs ar
				LEFT JOIN roadmap_proposal.proposal p ON p.id = ar.proposal_id
				LEFT JOIN roadmap_workforce.v_agent_display_label ar_reg ON ar_reg.agent_identity = ar.agent_identity
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
					COALESCE(p.display_id || ' ', '') || COALESCE(tl_reg.display_label, tl.agent_identity) || ' tokens ' || tl.token_count::text ||
						' cost $' || to_char(tl.cost_usd, 'FM999999990.0000') AS message
				FROM roadmap_efficiency.token_ledger tl
				LEFT JOIN roadmap_proposal.proposal p ON p.id = tl.proposal_id
				LEFT JOIN roadmap_workforce.v_agent_display_label tl_reg ON tl_reg.agent_identity = tl.agent_identity

				UNION ALL

				SELECT
					'cache-hit-' || chl.id::text AS id,
					'heartbeat' AS type,
					EXTRACT(EPOCH FROM chl.hit_at) * 1000 AS timestamp_ms,
					NULL AS proposal_id,
					chl.agent_identity AS agent_id,
					COALESCE(chl_reg.display_label, chl.agent_identity) || ' cache hit saved $' || to_char(chl.cost_saved_usd, 'FM999999990.0000') AS message
				FROM roadmap_efficiency.cache_hit_log chl
				LEFT JOIN roadmap_workforce.v_agent_display_label chl_reg ON chl_reg.agent_identity = chl.agent_identity
			)
			SELECT id, type, timestamp_ms, proposal_id, agent_id, message
			FROM feed
			WHERE timestamp_ms IS NOT NULL
			ORDER BY timestamp_ms DESC
			LIMIT $1
			`,
			[limit],
		);

		const events = rows.map((row) => ({
			id: row.id,
			type: row.type,
			timestamp: timestampToMillis(row.timestamp_ms),
			proposalId: row.proposal_id ?? undefined,
			agentId: row.agent_id ?? undefined,
			message: row.message,
			metadata: {},
		}));

		// Filter out liaison heartbeat noise and blank messages at the event layer so
		// the SQL UNION remains stable across branches. The ledger writes a
		// display string like "<from> -> <to_or_channel>: <message_content>"; detect
		// liaison heartbeats by matching the recipient part for 'system:liaison' and
		// the payload word 'heartbeat'. Be conservative: only drop fully blank
		// messages for the message ledger rows (type === 'message').
		const filteredEvents = events.filter((ev) => {
			if (!ev.message || String(ev.message).trim() === "") {
				// preserve non-message events even if their message is blank
				if (ev.type !== "message") return true;
				return false;
			}
			if (ev.type === "message") {
				const msg = String(ev.message).toLowerCase().trim();
				// Regex: '->' then recipient containing 'system:liaison' then a 'heartbeat' word
				if (/->\s*[^:]*system:liaison\b[\w:.-]*[:\s].*\bheartbeat\b/.test(msg)) return false;
			}
			return true;
		});

		const result = dedupeBoardLiveFeed(filteredEvents);
		if (result.length > 0) lastSuccessfulFeed = result;
		return result;
	} catch (err) {
		if (process.env.AGENTHIVE_TUI_PERF) {
			process.stderr.write(`[live-feed] query failed: ${(err as Error)?.message ?? err}\n`);
		}
		// Prefer the cached last-good feed over the in-process memory buffer
		// (which is empty in a fresh roadmap board process).
		if (lastSuccessfulFeed.length > 0) return lastSuccessfulFeed.slice(0, limit);
		return getRecentEvents(limit);
	}
}
