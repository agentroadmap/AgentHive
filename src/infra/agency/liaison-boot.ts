/**
 * Liaison Boot — reads agency identity from local config (env vars) and
 * registers with the orchestrator, then maintains a 30-second heartbeat loop.
 *
 * P463 AC#1: Liaison process boots and reads agency identity from local config.
 * P463 AC#3: Heartbeat contract — every 30s, liaison posts capacity envelope.
 *
 * Required env vars:
 *   AGENCY_ID           — unique agency identity (e.g. "claude/agency-bot")
 *   AGENCY_PROVIDER     — provider name  (e.g. "anthropic")
 *   AGENCY_HOST_ID      — host policy key (e.g. "bot")
 *   AGENCY_DISPLAY_NAME — human-readable name (defaults to AGENCY_ID)
 *
 * Optional env vars:
 *   AGENCY_PUBLIC_KEY              — base64 PEM public key for request signing
 *   AGENCY_CAPABILITIES            — comma-separated capability tags
 *   LIAISON_HEARTBEAT_INTERVAL_MS  — heartbeat interval in ms (default 30000)
 */

import {
  liaisonRegister,
  // P1132: liaisonHeartbeat import removed — per-process periodic heartbeat
  // deleted (liveness is event-driven from A2A host service).
  endLiaisonSession,
  type LiaisonRegisterResult,
} from "./liaison-service.js";
import { startLiaisonHub } from "./liaison-hub.ts";

export interface AgencyConfig {
  agency_id: string;
  provider: string;
  host_id: string;
  display_name: string;
  public_key?: string;
  capabilities: string[];
  heartbeat_interval_ms: number;
}

export interface LiaisonBootHandle {
  config: AgencyConfig;
  session: LiaisonRegisterResult;
  /** Stop the heartbeat loop and end the session gracefully. */
  shutdown(reason?: "normal" | "crash" | "operator" | "throttle"): Promise<void>;
}

/**
 * Read agency config from environment variables.
 * Throws if required vars are missing.
 */
/**
 * Build an AgencyConfig from a caller-provided override that already has
 * the required fields. Used by the P1125 supervisor path which reads identity
 * from agent_registry rather than env.
 */
function buildDefaultConfig(override: Partial<AgencyConfig>): AgencyConfig {
  if (!override.agency_id?.trim() || !override.provider?.trim()) {
    throw new Error("buildDefaultConfig requires agency_id + provider");
  }
  return {
    agency_id: override.agency_id,
    provider: override.provider,
    host_id: override.host_id ?? "bot",
    display_name: override.display_name ?? override.agency_id,
    public_key: override.public_key,
    capabilities: override.capabilities ?? [],
    heartbeat_interval_ms: override.heartbeat_interval_ms ?? 30000,
  };
}

export function readAgencyConfig(): AgencyConfig {
  const agency_id = process.env.AGENCY_ID?.trim();
  // Accept legacy AGENTHIVE_AGENT_PROVIDER from agency-*.env per-instance files
  const provider =
    process.env.AGENCY_PROVIDER?.trim() ||
    process.env.AGENTHIVE_AGENT_PROVIDER?.trim();
  // Default host to "bot" — the shared operator host; override via AGENCY_HOST_ID
  const host_id = process.env.AGENCY_HOST_ID?.trim() || "bot";

  if (!agency_id) throw new Error("AGENCY_ID env var is required");
  if (!provider) throw new Error("AGENCY_PROVIDER env var is required");

  const display_name =
    process.env.AGENCY_DISPLAY_NAME?.trim() || agency_id;
  const public_key = process.env.AGENCY_PUBLIC_KEY?.trim() || undefined;
  const capabilities = (process.env.AGENCY_CAPABILITIES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const heartbeat_interval_ms = parseInt(
    process.env.LIAISON_HEARTBEAT_INTERVAL_MS || "30000",
    10
  );

  return {
    agency_id,
    provider,
    host_id,
    display_name,
    public_key,
    capabilities,
    heartbeat_interval_ms,
  };
}

/**
 * Boot the liaison: register the agency, then start the heartbeat loop.
 *
 * Returns a handle that lets callers stop the loop and end the session.
 * The heartbeat loop runs every `heartbeat_interval_ms` ms (default 30s).
 *
 * Two call shapes:
 *   - bootLiaison()                — legacy single-tenant; reads env via readAgencyConfig
 *   - bootLiaison({...full config}) — P1125 supervisor; pass full config, skip env reads
 *   - bootLiaison({partial})        — env first, then override (back-compat)
 *
 * P1125: A full `AgencyConfig` (containing required agency_id + provider) skips
 * readAgencyConfig() entirely so the supervisor can boot N agencies without env.
 *
 * Usage:
 *   const handle = await bootLiaison();
 *   process.on('SIGTERM', () => handle.shutdown());
 */
export async function bootLiaison(
  configOverride?: Partial<AgencyConfig>
): Promise<LiaisonBootHandle> {
  // P1125: if caller provides a complete config (required fields filled), skip
  // the env-reading path so the supervisor can drive multiple agencies in-process.
  const hasFullConfig =
    !!configOverride?.agency_id?.trim() &&
    !!configOverride?.provider?.trim();
  const base = hasFullConfig ? buildDefaultConfig(configOverride!) : readAgencyConfig();
  const config: AgencyConfig = { ...base, ...configOverride };

  // AC#2: Registration handshake — liaison calls liaison_register
  const session = await liaisonRegister({
    agency_id: config.agency_id,
    display_name: config.display_name,
    provider: config.provider,
    host_id: config.host_id,
    capabilities: config.capabilities,
    capacity_envelope: {},
    public_key: config.public_key,
  });

  // Start bidirectional message hub — listens for uplink messages from subagents
  // and handles downlink directives and cross-project hiveCentral broadcasts.
  const hub = startLiaisonHub(config.agency_id);

  // P1132: per-process periodic heartbeat removed. Liveness is now event-driven
  // from the A2A host service (start-a2a-host.ts) which calls fn_pulse(state)
  // on lifecycle transitions plus one per-host presence-refresh timer that
  // keeps agent_registry.last_heartbeat_at fresh for existing dispatchability
  // and maintenance consumers. heartbeat_interval_ms in AgencyConfig is kept
  // for backwards compatibility but no longer drives a timer in this path.

  const shutdown = async (
    reason: "normal" | "crash" | "operator" | "throttle" = "normal"
  ) => {
    hub.stop();
    await endLiaisonSession(session.session_id, reason);
  };

  return { config, session, shutdown };
}
