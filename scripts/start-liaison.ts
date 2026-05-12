/**
 * Liaison Runtime Entrypoint — P299-E / P902 A8.
 *
 * Boots a per-agency liaison process: registers the agency, starts the
 * hub message loop (offer_dispatch handler, uplink relay), and maintains
 * the 30-second heartbeat. Each active agency runs exactly one instance
 * of this script via agenthive-liaison@<agency-id>.service.
 *
 * Required env vars (set via /etc/agenthive/liaison-<instance>.env):
 *   AGENCY_ID          — agency identity (e.g. "claude-agency-bot")
 *   AGENCY_PROVIDER    — provider name   (e.g. "anthropic")
 *   AGENCY_HOST_ID     — host policy key (e.g. "bot")
 *
 * Optional:
 *   AGENCY_DISPLAY_NAME           — human-readable label (defaults to AGENCY_ID)
 *   AGENCY_CAPABILITIES           — comma-separated capability tags
 *   AGENCY_PUBLIC_KEY             — base64 PEM for request signing
 *   LIAISON_HEARTBEAT_INTERVAL_MS — heartbeat interval ms (default 30000)
 */

import { bootLiaison } from "../src/infra/agency/liaison-boot.ts";
import { closePool } from "../src/infra/postgres/pool.ts";

const agencyId = process.env.AGENCY_ID?.trim() ?? "(unknown)";

let handle: Awaited<ReturnType<typeof bootLiaison>> | undefined;

async function main() {
	console.log(`[liaison:${agencyId}] starting`);

	handle = await bootLiaison();

	console.log(
		`[liaison:${agencyId}] registered session=${handle.session.session_id}`,
	);

	// Keep the process alive — hub and heartbeat timer drive the loop.
	await new Promise<void>((resolve) => {
		process.once("SIGTERM", () => {
			console.log(`[liaison:${agencyId}] SIGTERM received — shutting down`);
			resolve();
		});
		process.once("SIGINT", () => {
			console.log(`[liaison:${agencyId}] SIGINT received — shutting down`);
			resolve();
		});
	});

	await handle.shutdown("normal");
	await closePool();
	console.log(`[liaison:${agencyId}] stopped`);
}

main().catch((err) => {
	console.error(`[liaison:${agencyId}] fatal:`, err);
	process.exit(1);
});
