/**
 * P469: Agency observability alerting — Discord alerts for stale assistance
 * requests (>10 min) and silent agencies (>600 seconds).
 *
 * Deduplication uses `roadmap.agency_observability_alert_state` (UPSERT).
 * An alert re-fires only if the last_fired_at is older than 10 minutes,
 * preventing alert storms on sustained conditions.
 *
 * Extracted from AppServer.scanAgencyObservabilityAlerts() so it can be
 * unit-tested via _setQueryForTest injection.
 */

import { query as defaultQuery } from "../postgres/pool.ts";
import { discordSend } from "../discord/notify.ts";

type QueryFn = typeof defaultQuery;
let _query: QueryFn = defaultQuery;

/** Override the query function for testing. Restore a no-op after each test. */
export function _setQueryForTest(fn: QueryFn): void {
	_query = fn;
}

interface AlertRow {
	agency_id: string;
	display_name: string;
	silence_seconds: number | string | null;
	oldest_open_assistance_at: string | null;
	open_assistance: number | string;
}

/**
 * Scan v_agency_dashboard for agencies with stale assistance or silence
 * conditions, then emit single-shot Discord warnings via the dedup table.
 */
export async function runObservabilityAlertTick(): Promise<void> {
	const { rows } = await _query<AlertRow>(
		`SELECT agency_id, display_name, silence_seconds,
		        oldest_open_assistance_at, open_assistance
		   FROM roadmap.v_agency_dashboard
		  WHERE (oldest_open_assistance_at IS NOT NULL
		         AND oldest_open_assistance_at < now() - interval '10 minutes')
		     OR (silence_seconds IS NOT NULL AND silence_seconds > 600)`,
	);

	for (const row of rows) {
		const alerts: Array<{ type: string; message: string; metadata: Record<string, unknown> }> = [];
		const silenceSeconds = Number(row.silence_seconds ?? 0);

		if (silenceSeconds > 600) {
			alerts.push({
				type: "agency_silent",
				message: `Agency ${row.display_name} (${row.agency_id}) has been silent for ${Math.round(silenceSeconds / 60)} minutes.`,
				metadata: { silence_seconds: silenceSeconds },
			});
		}
		if (row.oldest_open_assistance_at) {
			alerts.push({
				type: "assistance_stale",
				message: `Agency ${row.display_name} (${row.agency_id}) has ${row.open_assistance} open assistance request(s); oldest opened at ${row.oldest_open_assistance_at}.`,
				metadata: {
					open_assistance: Number(row.open_assistance ?? 0),
					oldest_open_assistance_at: row.oldest_open_assistance_at,
				},
			});
		}

		for (const alert of alerts) {
			const alertKey = `${alert.type}:${row.agency_id}`;
			const { rows: stateRows } = await _query<{ should_send: boolean }>(
				`INSERT INTO roadmap.agency_observability_alert_state
				   (alert_key, agency_id, alert_type, last_fired_at, metadata)
				 VALUES ($1, $2, $3, now(), $4::jsonb)
				 ON CONFLICT (alert_key) DO UPDATE
				   SET last_fired_at = CASE
				       WHEN roadmap.agency_observability_alert_state.last_fired_at < now() - interval '10 minutes'
				       THEN now()
				       ELSE roadmap.agency_observability_alert_state.last_fired_at
				     END,
				     cleared_at = NULL,
				     metadata = EXCLUDED.metadata
				 RETURNING last_fired_at >= now() - interval '5 seconds' AS should_send`,
				[alertKey, row.agency_id, alert.type, JSON.stringify(alert.metadata)],
			);
			if (stateRows[0]?.should_send) {
				await discordSend("agency-observability", alert.message, "warning");
			}
		}
	}
}
