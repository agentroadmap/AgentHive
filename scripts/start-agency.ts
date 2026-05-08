/**
 * Generic Agency Runtime — provider-agnostic.
 *
 * P912: this script delegates lifecycle (registry upsert, liaison session,
 * offer_dispatch hub, heartbeats, dormancy sweep) to the shared module
 * src/infra/agency/agency-self-registration.ts. All providers — Claude,
 * Codex, Copilot, Hermes — use the same runtime; per-provider behavior is
 * limited to (a) the LLM CLI handler for inbox replies via runLiaisonAgent
 * and (b) any provider-only env (e.g. CLAUDE_BIN, CODEX_BIN).
 *
 * P912 AC-7: the legacy OfferProvider pull-claim loop is retired here. The
 * push-dispatch path through startLiaisonHub (started by the shared module)
 * is the canonical claim mechanism. Anything that previously instantiated
 * `new OfferProvider({...})` and called `.run()` should be deleted, not
 * re-enabled.
 *
 * Configuration via environment:
 *   AGENTHIVE_AGENT_IDENTITY  — e.g. "claude/agency-bot", "codex/agency-bot"
 *   AGENTHIVE_AGENT_PROVIDER  — explicit provider (codex|copilot|claude|hermes)
 *   AGENTHIVE_AGENT_PROJECTS  — optional comma-separated project IDs to opt
 *                               into via provider_registry on boot.
 *
 * If AGENTHIVE_AGENT_PROVIDER is not set, derives provider from the identity
 * prefix (e.g. "claude/agency-bot" → "claude"). Falls back to the first
 * enabled route in roadmap.model_routes if the prefix is not recognized.
 *
 * Usage:
 *   AGENTHIVE_AGENT_IDENTITY=claude/agency-bot \
 *   AGENTHIVE_AGENT_PROVIDER=claude \
 *   node --import jiti/register scripts/start-agency.ts
 */

import { hostname } from "node:os";
import { resolveActiveRouteProvider } from "../src/core/orchestration/agent-spawner.ts";
import { closePool, getPool } from "../src/infra/postgres/pool.ts";
import {
	selfRegisterAgency,
	AgencyAlreadyActive,
} from "../src/infra/agency/agency-self-registration.ts";
import {
	runLiaisonAgent,
	spawnCliCapture,
	type LiaisonAgentHandle,
	type IncomingMessage,
	type LlmInvoke,
} from "../src/infra/agency/liaison-agent.ts";

const agentIdentity =
	process.env.AGENTHIVE_AGENT_IDENTITY ?? `agency-${hostname()}`;

interface LiaisonProviderHandler {
	bin: string;
	buildArgs: (prompt: string) => string[];
	brand: string;
}

/**
 * Map provider → (CLI binary, argv builder, brand label for system prompt).
 * Adding a provider here turns on inbox-reply support via runLiaisonAgent.
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

function buildLiaisonInvokeLlm(handler: LiaisonProviderHandler): LlmInvoke {
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
 * agent_provider) rather than a hardcoded literal array.
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
	if (process.env.AGENTHIVE_AGENT_PROVIDER) {
		return process.env.AGENTHIVE_AGENT_PROVIDER;
	}
	const identityPrefix = agentIdentity.split("/")[0];
	const known = await loadKnownProviders();
	if (known.has(identityPrefix)) {
		return identityPrefix;
	}
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

function parseProjectIds(): number[] {
	const raw = process.env.AGENTHIVE_AGENT_PROJECTS;
	if (!raw?.trim()) return [];
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) => Number(s))
		.filter((n) => Number.isFinite(n) && n > 0);
}

async function main(): Promise<void> {
	console.log(`[Agency] Starting as ${agentIdentity} ...`);

	const pool = getPool();
	await pool.query("SELECT 1");
	console.log("[Agency] Database connection verified");

	// Load the per-process StateNames registry — spawnAgent reads RfcStates
	// when assembling proposal context (used by runLiaisonAgent's reply path
	// when the provider's child spawn references state names).
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

	const projectIds = parseProjectIds();
	if (projectIds.length > 0) {
		console.log(
			`[Agency] Opting into projects on boot: ${projectIds.join(", ")}`,
		);
	}

	// P912: shared self-registration owns identity upsert, capability seed,
	// optional project opt-in, liaison session open, hub start, heartbeat,
	// and dormancy sweep. Provider runtime just hands in identity + capabilities.
	let registration: Awaited<ReturnType<typeof selfRegisterAgency>> | null =
		null;
	try {
		registration = await selfRegisterAgency({
			agencyId: agentIdentity,
			provider,
			capabilities: [provider, "agent-spawner", "messaging"],
			projectIds,
			metadata: { version: "1.0", pid: process.pid },
		});
	} catch (err) {
		// P921 AC-7: AgencyAlreadyActive means a duplicate session exists.
		// Exit cleanly (code 0) so systemd Restart=on-failure doesn't loop.
		if (err instanceof AgencyAlreadyActive) {
			console.log(
				`[Agency] AgencyAlreadyActive: ${err.agency_id} — ` +
					`existing session=${err.existing_session_id} pid=${err.existing_liaison_pid}. ` +
					`Exiting cleanly.`,
			);
			process.exit(0);
		}
		console.error(
			"[Agency] selfRegisterAgency failed; agency cannot accept push dispatch:",
			err,
		);
		// Don't exit — provider-specific reply handlers below may still work
		// even without a session. The orchestrator just won't dispatch to us.
	}

	// Provider-specific A2A inbox-reply loop. This is layered on top of the
	// shared lifecycle: messages whose handler is the LLM CLI go through
	// runLiaisonAgent; offer_dispatch downlinks go through the hub started by
	// selfRegisterAgency. The two surfaces are independent.
	let liaisonHandle: LiaisonAgentHandle | null = null;
	const handler = resolveLiaisonHandler(provider);
	if (!handler) {
		console.warn(
			`[Agency] No liaison-agent CLI handler for provider '${provider}'; ` +
				`inbox replies disabled. Push dispatch via the hub is unaffected.`,
		);
	} else {
		try {
			liaisonHandle = await runLiaisonAgent({
				identity: agentIdentity,
				loggerPrefix: `[Agency:liaison(${provider})]`,
				invokeLlm: buildLiaisonInvokeLlm(handler),
			});
		} catch (err) {
			console.error("[Agency] runLiaisonAgent failed (non-fatal):", err);
		}
	}

	for (const sig of ["SIGTERM", "SIGINT"] as const) {
		process.on(sig, async () => {
			console.log(`[Agency] ${sig} — shutting down ...`);
			if (liaisonHandle) {
				try {
					await liaisonHandle.stop();
				} catch (err) {
					console.error("[Agency] liaison stop error:", err);
				}
			}
			if (registration) {
				try {
					await registration.stop("operator");
				} catch (err) {
					console.error("[Agency] registration.stop error:", err);
				}
			}
			// Hard-exit guard: pool.end() can hang on open LISTEN sockets.
			const hardExit = setTimeout(() => process.exit(0), 5_000);
			hardExit.unref();
			await closePool();
			process.exit(0);
		});
	}

	console.log(`[Agency] ${agentIdentity} ready`);
}

main().catch((err) => {
	console.error("[Agency] Fatal:", err);
	process.exit(1);
});
