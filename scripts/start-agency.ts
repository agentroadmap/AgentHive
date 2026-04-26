/**
 * Generic Agency — Provider-agnostic OfferProvider.
 *
 * Registers as an agency in agent_registry and listens on the
 * work_offers Postgres channel. Supports any provider (copilot, claude, codex, hermes).
 *
 * Configuration via environment:
 *   AGENTHIVE_AGENT_IDENTITY  — e.g. "claude/agency-bot", "copilot/agency-gary"
 *   AGENTHIVE_AGENT_PROVIDER  — explicit provider (codex|copilot|claude|hermes)
 *
 * If AGENTHIVE_AGENT_PROVIDER is not set, derives provider from the identity prefix
 * (e.g. "claude/agency-bot" → "claude"). Falls back to the first enabled route in
 * model_routes if the prefix is not recognized.
 *
 * Usage:
 *   AGENTHIVE_AGENT_IDENTITY=claude/agency-bot \
 *   AGENTHIVE_AGENT_PROVIDER=claude \
 *   node --import jiti/register scripts/start-agency.ts
 */

import { hostname } from "node:os";
import { spawnAgent, resolveActiveRouteProvider } from "../src/core/orchestration/agent-spawner.ts";
import { OfferProvider } from "../src/core/pipeline/offer-provider.ts";
import { closePool, getPool } from "../src/infra/postgres/pool.ts";
import {
	liaisonRegister,
	liaisonHeartbeat,
	endLiaisonSession,
	checkAndMarkDormant,
} from "../src/infra/agency/liaison-service.ts";

const agentIdentity =
	process.env.AGENTHIVE_AGENT_IDENTITY ?? `agency-${hostname()}`;

/**
 * Resolve provider from environment or identity prefix.
 * Explicit AGENTHIVE_AGENT_PROVIDER takes precedence.
 * Falls back to DB route if identity prefix is not a recognized provider.
 */
async function resolveProvider(): Promise<string> {
	// Explicit provider from env takes precedence
	if (process.env.AGENTHIVE_AGENT_PROVIDER) {
		return process.env.AGENTHIVE_AGENT_PROVIDER;
	}

	// Try to extract provider from identity prefix (e.g. "claude/agency-bot" → "claude")
	const identityPrefix = agentIdentity.split("/")[0];

	// Known providers: copilot, claude, codex, hermes
	const knownProviders = ["copilot", "claude", "codex", "hermes"];
	if (knownProviders.includes(identityPrefix)) {
		return identityPrefix;
	}

	// Fall back to first enabled route in DB
	const dbProvider = await resolveActiveRouteProvider();
	if (dbProvider) {
		return dbProvider;
	}

	// Last resort: default to "copilot"
	return "copilot";
}

const offerProvider = new OfferProvider({
	agentIdentity,
	leaseTtlSeconds: Number(process.env.AGENTHIVE_LEASE_TTL_SECONDS ?? "60"),
	renewIntervalMs: Number(process.env.AGENTHIVE_RENEW_INTERVAL_MS ?? "15000"),
	pollIntervalMs: Number(process.env.AGENTHIVE_OFFER_POLL_MS ?? "20000"),
	maxConcurrent: Number(process.env.AGENTHIVE_MAX_CONCURRENT ?? "2"),
	connectListener: async () => getPool().connect(),
	spawnFn: async (req) => {
		const provider = await resolveProvider();
		// pg returns bigint as a JS string; coerce so agent_runs.proposal_id
		// gets populated.
		const proposalIdNum =
			req.proposalId === undefined || req.proposalId === null
				? undefined
				: typeof req.proposalId === "number"
					? req.proposalId
					: Number(req.proposalId);
		return spawnAgent({
			worktree: req.worktree,
			task: req.task,
			proposalId: Number.isFinite(proposalIdNum) ? proposalIdNum : undefined,
			stage: req.stage,
			model: req.model,
			timeoutMs: req.timeoutMs,
			agentLabel: req.agentLabel,
			provider: provider as any,
			// P466: forward warm-boot briefing id so the child gets full context.
			briefingId: req.briefingId,
		});
	},
});

async function main() {
	console.log(`[Agency] Starting as ${agentIdentity} ...`);

	const pool = getPool();
	await pool.query("SELECT 1");
	console.log("[Agency] Database connection verified");

	const provider = await resolveProvider();
	console.log(`[Agency] Provider resolved as: ${provider}`);

	// P464: Register agency in liaison protocol (additive — failure is non-fatal).
	let sessionId: string | null = null;
	let heartbeatTimer: NodeJS.Timeout | null = null;
	let watchdogTimer: NodeJS.Timeout | null = null;
	try {
		const result = await liaisonRegister({
			agency_id: agentIdentity,
			display_name: agentIdentity.split("/").slice(-1)[0],
			provider,
			host_id: hostname(),
			capabilities: [provider, "agent-spawner"],
			metadata: { version: "1.0", pid: process.pid },
		});
		sessionId = result.session_id;
		console.log(`[Agency] Registered liaison session: ${sessionId}`);

		heartbeatTimer = setInterval(async () => {
			try {
				await liaisonHeartbeat({ session_id: sessionId!, status: "active" });
			} catch (err) {
				console.error("[Agency] Heartbeat error:", err);
			}
		}, 30_000);

		watchdogTimer = setInterval(async () => {
			try {
				const dormantCount = await checkAndMarkDormant();
				if (dormantCount > 0) {
					console.log(`[Agency] Dormancy sweep: ${dormantCount} marked dormant`);
				}
			} catch (err) {
				console.error("[Agency] Dormancy sweep error:", err);
			}
		}, 60_000);
	} catch (err) {
		console.warn("[Agency] liaisonRegister failed (non-fatal, will continue with legacy path):", err);
	}

	for (const sig of ["SIGTERM", "SIGINT"] as const) {
		process.on(sig, async () => {
			console.log(`[Agency] ${sig} — draining in-flight claims...`);
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			if (watchdogTimer) clearInterval(watchdogTimer);
			if (sessionId) {
				try {
					await endLiaisonSession(sessionId, "operator");
				} catch (err) {
					console.error("[Agency] endLiaisonSession error:", err);
				}
			}
			await offerProvider.stop();
			await offerProvider.waitForIdle(30_000);
			await closePool();
			process.exit(0);
		});
	}

	await offerProvider.run();
	console.log(`[Agency] ${agentIdentity} listening for work offers`);
}

main().catch((err) => {
	console.error("[Agency] Fatal:", err);
	process.exit(1);
});
