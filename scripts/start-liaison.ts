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
import {
	runLiaisonAgent,
	type LiaisonAgentHandle,
} from "../src/infra/agency/liaison-agent.ts";
import { closePool } from "../src/infra/postgres/pool.ts";

const agencyId = process.env.AGENCY_ID?.trim() ?? "(unknown)";
// AGENCY_PROVIDER is the canonical var; AGENTHIVE_AGENT_PROVIDER is the legacy
// per-instance env file var. Accept either so both service templates work.
const agencyProvider =
	(process.env.AGENCY_PROVIDER?.trim() || process.env.AGENTHIVE_AGENT_PROVIDER?.trim()) ?? "";

let handle: Awaited<ReturnType<typeof bootLiaison>> | undefined;
let agentHandle: LiaisonAgentHandle | undefined;

async function main() {
	console.log(`[liaison:${agencyId}] starting`);

	handle = await bootLiaison();

	console.log(
		`[liaison:${agencyId}] registered session=${handle.session.session_id}`,
	);

	// Start the message_ledger LISTEN loop — handles task_request, task_status,
	// task_complete, task_error, offer_dispatch, and protocol_ping from msg_send.
	// This is layered on top of the hub (which listens on liaison_message_*).
	if (agencyProvider) {
		try {
			agentHandle = await runLiaisonAgent({
				identity: agencyId,
				provider: agencyProvider,
				loggerPrefix: `[liaison-agent:${agencyId}]`,
			});
			console.log(`[liaison:${agencyId}] message_ledger LISTEN active`);
		} catch (err) {
			console.warn(`[liaison:${agencyId}] runLiaisonAgent failed (non-fatal):`, err);
		}
	} else {
		console.warn(`[liaison:${agencyId}] AGENCY_PROVIDER not set — message_ledger LISTEN disabled`);
	}

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

	if (agentHandle) {
		try {
			await agentHandle.stop();
		} catch (err) {
			console.error(`[liaison:${agencyId}] agentHandle.stop error:`, err);
		}
	}
	await handle.shutdown("normal");
	await closePool();
	console.log(`[liaison:${agencyId}] stopped`);
}

main().catch((err) => {
	console.error(`[liaison:${agencyId}] fatal:`, err);
	process.exit(1);
});
