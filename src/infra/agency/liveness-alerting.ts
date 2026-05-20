/**
 * P765: Liveness alerting — offline detection and single-shot Discord alerts.
 *
 * runLivenessAlertTick():
 *   1. Calls scanAndTransitionSilentAgencies() (provider_registry dormant/offline transitions)
 *   2. Calls checkAndMarkOffline() (roadmap.agency dormant→offline at 5 min)
 *   3. Scans for newly-offline agencies and emits single-shot Discord alerts (AC-3/AC-4)
 *   4. Scans for agencies that have recovered and emits resolved-alerts
 *
 * Alert debounce: offline_alert_sent_at column on roadmap.agency.
 *   NULL  = no alert sent yet this episode
 *   SET   = alert already fired; skip to avoid repeat (AC-4)
 *   CLEAR = done by liaisonHeartbeat() / liaisonResume() on recovery start
 */

import { query } from "../postgres/pool.ts";
import { discordSend } from "../discord/notify.ts";
import { scanAndTransitionSilentAgencies } from "../../core/orchestration/resolvers/agency-resolver.ts";
import { checkAndMarkOffline } from "./liaison-service.ts";

const OFFLINE_ALERT_THRESHOLD_MINUTES = 10;

interface OfflineAgencyRow {
	agency_id: string;
	display_name: string;
	status: string;
	last_heartbeat_at: Date | null;
	offline_alert_sent_at: Date | null;
}

interface RecoveredAgencyRow {
	agency_id: string;
	display_name: string;
	status: string;
}

/**
 * Find agencies that are offline for > OFFLINE_ALERT_THRESHOLD_MINUTES
 * and have not yet had an alert sent this episode (offline_alert_sent_at IS NULL).
 * AC-3 + AC-4.
 */
async function findUnalertedOfflineAgencies(): Promise<OfflineAgencyRow[]> {
	const result = await query<OfflineAgencyRow>(`
    SELECT agency_id, display_name, status, last_heartbeat_at, offline_alert_sent_at
    FROM roadmap.agency
    WHERE status = 'offline'
      AND offline_alert_sent_at IS NULL
      AND last_heartbeat_at IS NOT NULL
      AND (now() - last_heartbeat_at) > interval '${OFFLINE_ALERT_THRESHOLD_MINUTES} minutes'
  `);
	return result.rows;
}

/**
 * Find agencies that recently recovered (status ≠ offline) but whose
 * offline_alert_sent_at is still SET — meaning an alert was sent and now
 * a resolved-alert should fire.
 */
async function findJustRecoveredAgencies(): Promise<RecoveredAgencyRow[]> {
	const result = await query<RecoveredAgencyRow>(`
    SELECT agency_id, display_name, status
    FROM roadmap.agency
    WHERE status NOT IN ('offline', 'retired')
      AND offline_alert_sent_at IS NOT NULL
  `);
	return result.rows;
}

/**
 * Mark offline_alert_sent_at = now() for an agency.
 * Prevents duplicate alerts per offline episode (AC-4).
 */
async function markAlertSent(agency_id: string): Promise<void> {
	await query(
		`UPDATE roadmap.agency
     SET offline_alert_sent_at = now()
     WHERE agency_id = $1`,
		[agency_id],
	);
}

/**
 * Clear offline_alert_sent_at after a resolved-alert fires.
 * This resets the debounce so a future offline episode can alert again.
 */
async function clearAlertSent(agency_id: string): Promise<void> {
	await query(
		`UPDATE roadmap.agency
     SET offline_alert_sent_at = NULL
     WHERE agency_id = $1`,
		[agency_id],
	);
}

function silenceLabel(lastSeen: Date | null): string {
	if (!lastSeen) return "unknown";
	const secs = Math.floor((Date.now() - lastSeen.getTime()) / 1000);
	if (secs < 120) return `${secs}s`;
	if (secs < 3600) return `${Math.floor(secs / 60)}m`;
	return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

/**
 * Main liveness alert tick — called by the orchestrator maintenance loop.
 *
 * Steps:
 *   1. provider_registry dormant/offline transitions (scanAndTransitionSilentAgencies)
 *   2. roadmap.agency dormant→offline at 5 min (checkAndMarkOffline)
 *   3. Emit offline alerts for newly-offline agencies (AC-3/AC-4)
 *   4. Emit recovery alerts and clear debounce flags
 */
export async function runLivenessAlertTick(): Promise<void> {
	// Step 1: provider_registry state transitions
	await scanAndTransitionSilentAgencies();

	// Step 2: roadmap.agency dormant→offline
	await checkAndMarkOffline();

	// Step 3: offline alerts
	const unalerted = await findUnalertedOfflineAgencies();
	for (const agency of unalerted) {
		const silence = silenceLabel(agency.last_heartbeat_at);
		await discordSend(
			"liveness-monitor",
			`**Agency offline**: \`${agency.agency_id}\` (${agency.display_name}) — silent for ${silence}`,
			"error",
		);
		await markAlertSent(agency.agency_id);
	}

	// Step 4: recovery alerts
	const recovered = await findJustRecoveredAgencies();
	for (const agency of recovered) {
		await discordSend(
			"liveness-monitor",
			`**Agency recovered**: \`${agency.agency_id}\` (${agency.display_name}) — now ${agency.status}`,
			"success",
		);
		await clearAlertSent(agency.agency_id);
	}
}
