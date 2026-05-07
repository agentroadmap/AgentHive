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
import {
	runLiaisonAgent,
	spawnCliCapture,
	type LiaisonAgentHandle,
	type IncomingMessage,
	type LlmInvoke,
} from "../src/infra/agency/liaison-agent.ts";
import { pulseHeartbeat } from "../src/infra/pulse/heartbeat.ts";

const agentIdentity =
	process.env.AGENTHIVE_AGENT_IDENTITY ?? `agency-${hostname()}`;

interface LiaisonProviderHandler {
	bin: string;
	buildArgs: (prompt: string) => string[];
	brand: string;
}

/**
 * Map provider → (CLI binary, argv builder, brand label for system prompt).
 * Adding a provider here turns on inbox-reply support for any agency that
 * resolves to it (start-agency.ts is the generic startup; provider-specific
 * scripts like start-copilot-agency.ts wire their own handler directly).
 */
function resolveLiaisonHandler(provider: string): LiaisonProviderHandler | null {
	switch (provider) {
		case "claude":
			return {
				bin: process.env.CLAUDE_BIN ?? "claude",
				buildArgs: (p) => ["--print", p],
				brand: "Claude",
			};
		case "codex":
			return {
				bin: process.env.CODEX_BIN ?? "codex",
				buildArgs: (p) => [
					"exec",
					"--dangerously-bypass-approvals-and-sandbox",
					p,
				],
				brand: "Codex",
			};
		case "copilot":
			return {
				bin: process.env.COPILOT_BIN ?? "copilot",
				buildArgs: (p) => ["-p", p, "--yolo"],
				brand: "GitHub Copilot",
			};
		default:
			return null;
	}
}

function buildLiaisonPrompt(brand: string, msg: IncomingMessage): string {
	const systemContext =
		`You are ${agentIdentity}, a ${brand} liaison agent in the AgentHive system. ` +
		`You received a ${msg.message_type} message from ${msg.from_agent}. ` +
		`Reply concisely. If it's a task, acknowledge and outline your approach in 2-3 sentences.`;
	return `${systemContext}\n\n---\nIncoming message:\n${msg.message_content}`;
}

function buildLiaisonInvokeLlm(
	handler: LiaisonProviderHandler,
): LlmInvoke {
	return (msg) =>
		spawnCliCapture(
			handler.bin,
			handler.buildArgs(buildLiaisonPrompt(handler.brand, msg)),
		);
}

/**
 * Resolve provider from environment or identity prefix.
 * Explicit AGENTHIVE_AGENT_PROVIDER takes precedence.
 * Falls back to DB route if identity prefix is not a recognized provider.
 *
 * P743: known-provider list is sourced from roadmap.model_routes (DISTINCT
 * agent_provider) rather than a hardcoded literal array. Adding a new
 * provider is a DB row change.
 */
let knownProvidersPromise: Promise<Set<string>> | undefined;
async function loadKnownProviders(): Promise<Set<string>> {
	if (!knownProvidersPromise) {
		knownProvidersPromise = (async () => {
			try {
				const { rows } = await getPool().query<{ agent_provider: string }>(
					`SELECT DISTINCT agent_provider
					   FROM roadmap.model_routes
					  WHERE is_enabled = true AND agent_provider IS NOT NULL`,
				);
				return new Set(rows.map((r) => r.agent_provider));
			} catch (err) {
				console.warn(
					"[Agency] Failed to load known providers from DB; identity-prefix detection disabled:",
					err,
				);
				return new Set<string>();
			}
		})();
	}
	return knownProvidersPromise;
}

async function resolveProvider(): Promise<string> {
	// Explicit provider from env takes precedence
	if (process.env.AGENTHIVE_AGENT_PROVIDER) {
		return process.env.AGENTHIVE_AGENT_PROVIDER;
	}

	// Try to extract provider from identity prefix (e.g. "claude/agency-bot" → "claude")
	const identityPrefix = agentIdentity.split("/")[0];
	const known = await loadKnownProviders();
	if (known.has(identityPrefix)) {
		return identityPrefix;
	}

	// Fall back to first enabled route in DB
	const dbProvider = await resolveActiveRouteProvider();
	if (dbProvider) {
		return dbProvider;
	}

	throw new Error(
		`[Agency] Unable to resolve provider for identity "${agentIdentity}". ` +
			`Set AGENTHIVE_AGENT_PROVIDER, register the prefix in roadmap.model_routes, ` +
			`or seed at least one enabled route.`,
	);
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

	// Load the per-process StateNames registry — spawnAgent reads RfcStates
	// when assembling proposal context. Without this every spawn throws
	// "[StateNames] Registry not loaded".
	try {
		const { loadStateNames } = await import(
			"../src/core/workflow/state-names.ts"
		);
		await loadStateNames(pool);
		console.log("[Agency] State-names registry loaded from database");
	} catch (err) {
		console.error("[Agency] Failed to load state-names registry:", err);
	}

	const provider = await resolveProvider();
	console.log(`[Agency] Provider resolved as: ${provider}`);

	// P464: Register agency in liaison protocol (additive — failure is non-fatal).
	let sessionId: string | null = null;
	let heartbeatTimer: NodeJS.Timeout | null = null;
	let watchdogTimer: NodeJS.Timeout | null = null;
	let liaisonHandle: LiaisonAgentHandle | null = null;
	try {
		const result = await liaisonRegister({
			agency_id: agentIdentity,
			display_name: agentIdentity.split("/").slice(-1)[0],
			provider,
			host_id: hostname(),
			capabilities: [provider, "agent-spawner", "messaging"],
			metadata: { version: "1.0", pid: process.pid },
		});
		sessionId = result.session_id;
		console.log(`[Agency] Registered liaison session: ${sessionId}`);

		// P888 follow-up: start the A2A inbox/reply loop in this same process.
		// liaisonRegister is a DB write; runLiaisonAgent owns the long-running
		// listener. They live together so an agency that registers always has
		// a process answering its inbox. The CLI handler dispatches by the
		// resolved provider — never default silently to claude when the offer
		// path will spawn codex/copilot, or replies will lie about who's
		// answering.
		const liaisonProviderHandler = resolveLiaisonHandler(provider);
		if (!liaisonProviderHandler) {
			console.warn(
				`[Agency] No liaison-agent CLI handler for provider '${provider}'; ` +
					`inbox replies disabled. Agency will still claim work offers.`,
			);
		} else {
			try {
				liaisonHandle = await runLiaisonAgent({
					identity: agentIdentity,
					loggerPrefix: `[Agency:liaison(${provider})]`,
					invokeLlm: buildLiaisonInvokeLlm(liaisonProviderHandler),
				});
			} catch (err) {
				console.error("[Agency] runLiaisonAgent failed (non-fatal):", err);
			}
		}

		heartbeatTimer = setInterval(async () => {
			try {
				await liaisonHeartbeat({ session_id: sessionId!, status: "active" });
			} catch (err) {
				console.error("[Agency] Heartbeat error:", err);
			}
			pulseHeartbeat(agentIdentity, { currentTask: "offer-provider" }).catch(
				(e) => console.warn("[Agency] pulse heartbeat failed:", e),
			);
		}, 30_000);
		// Emit immediately so the agency is visible without waiting 30s
		pulseHeartbeat(agentIdentity, { currentTask: "starting" }).catch(
			(e) => console.warn("[Agency] initial pulse heartbeat failed:", e),
		);

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
			if (liaisonHandle) {
				try {
					await liaisonHandle.stop();
				} catch (err) {
					console.error("[Agency] liaison stop error:", err);
				}
			}
			if (sessionId) {
				try {
					await endLiaisonSession(sessionId, "operator");
				} catch (err) {
					console.error("[Agency] endLiaisonSession error:", err);
				}
			}
			await offerProvider.stop();
			await offerProvider.waitForIdle(30_000);
			// Hard-exit guard: pool.end() can hang on open LISTEN sockets.
			const hardExit = setTimeout(() => process.exit(0), 5_000);
			hardExit.unref();
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
