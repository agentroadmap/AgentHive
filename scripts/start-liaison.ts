/**
 * Liaison Boot Process — Agency Liaison and Two-Way Orchestrator Protocol (P463)
 *
 * This is the minimal always-on representative process for an agency. It:
 *   1. Reads AGENCY_ID and AGENCY_SIGNING_KEY from env (AC-1)
 *   2. Registers the agency with the orchestrator via liaisonRegister
 *   3. Sends heartbeats every 30s so v_agency_status keeps dispatchable=true
 *   4. Runs a dormancy-sweep watchdog every 60s (AC-5)
 *   5. Shuts down cleanly on SIGTERM/SIGINT, ending the session
 *
 * Required env vars:
 *   AGENCY_ID            — stable identifier for this agency (e.g. "claude/agency-prod")
 *   AGENCY_SIGNING_KEY   — opaque secret used to authenticate future signed requests
 *
 * Optional env vars:
 *   AGENCY_DISPLAY_NAME  — human-readable name (defaults to AGENCY_ID)
 *   AGENCY_PROVIDER      — provider tag (defaults to prefix of AGENCY_ID or "unknown")
 *   AGENCY_HOST_ID       — host identifier (defaults to hostname)
 *   AGENCY_HEARTBEAT_MS  — heartbeat interval in ms (default 30000)
 *   AGENCY_WATCHDOG_MS   — dormancy sweep interval in ms (default 60000)
 *
 * Usage:
 *   AGENCY_ID=claude/agency-prod \
 *   AGENCY_SIGNING_KEY=<secret> \
 *   node --import jiti/register scripts/start-liaison.ts
 */

import { hostname } from "node:os";
import { closePool } from "../src/infra/postgres/pool.ts";
import {
	liaisonRegister,
	liaisonHeartbeat,
	endLiaisonSession,
	checkAndMarkDormant,
} from "../src/infra/agency/liaison-service.ts";

// --- AC-1: Read required env vars ---
const agencyId = process.env.AGENCY_ID;
const signingKey = process.env.AGENCY_SIGNING_KEY;

if (!agencyId) {
	console.error("[Liaison] AGENCY_ID environment variable is required");
	process.exit(1);
}
if (!signingKey) {
	console.error("[Liaison] AGENCY_SIGNING_KEY environment variable is required");
	process.exit(1);
}

const displayName = process.env.AGENCY_DISPLAY_NAME ?? agencyId;
const provider =
	process.env.AGENCY_PROVIDER ??
	(agencyId.includes("/") ? agencyId.split("/")[0] : "unknown");
const hostId = process.env.AGENCY_HOST_ID ?? hostname();
const heartbeatMs = Number(process.env.AGENCY_HEARTBEAT_MS ?? "30000");
const watchdogMs = Number(process.env.AGENCY_WATCHDOG_MS ?? "60000");

async function main() {
	console.log(`[Liaison] Booting agency=${agencyId} provider=${provider} host=${hostId}`);

	// --- Register with orchestrator ---
	let sessionId: string;
	try {
		const reg = await liaisonRegister({
			agency_id: agencyId!,
			display_name: displayName,
			provider,
			host_id: hostId,
			capabilities: [provider, "liaison"],
			metadata: { pid: process.pid, signing_key_hint: signingKey!.slice(0, 4) + "…" },
		});
		sessionId = reg.session_id;
		console.log(`[Liaison] Registered session=${sessionId} status=${reg.status}`);
	} catch (err) {
		console.error("[Liaison] Registration failed:", err);
		await closePool();
		process.exit(1);
	}

	// --- AC-5: Heartbeat loop (every 30s) ---
	const heartbeatTimer = setInterval(async () => {
		try {
			const hb = await liaisonHeartbeat({ session_id: sessionId, status: "active" });
			if (!hb.dispatchable) {
				console.warn(`[Liaison] Heartbeat OK but agency not dispatchable: status=${hb.agency_status} silence=${hb.silence_seconds}s`);
			}
		} catch (err) {
			console.error("[Liaison] Heartbeat error:", err);
		}
	}, heartbeatMs);

	// --- AC-5: Dormancy-sweep watchdog (every 60s) ---
	const watchdogTimer = setInterval(async () => {
		try {
			const dormantCount = await checkAndMarkDormant();
			if (dormantCount > 0) {
				console.log(`[Liaison] Dormancy sweep: ${dormantCount} agenc${dormantCount === 1 ? "y" : "ies"} marked dormant`);
			}
		} catch (err) {
			console.error("[Liaison] Dormancy sweep error:", err);
		}
	}, watchdogMs);

	// --- Graceful shutdown ---
	async function shutdown(sig: string) {
		console.log(`[Liaison] ${sig} received — shutting down`);
		clearInterval(heartbeatTimer);
		clearInterval(watchdogTimer);
		try {
			await endLiaisonSession(sessionId, sig === "SIGTERM" ? "operator" : "normal");
			console.log("[Liaison] Session ended cleanly");
		} catch (err) {
			console.error("[Liaison] endLiaisonSession error (non-fatal):", err);
		}
		await closePool();
		process.exit(0);
	}

	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));

	console.log(
		`[Liaison] Running: heartbeat every ${heartbeatMs / 1000}s, dormancy sweep every ${watchdogMs / 1000}s`,
	);
}

main().catch((err) => {
	console.error("[Liaison] Fatal:", err);
	process.exit(1);
});
