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
  liaisonHeartbeat,
  endLiaisonSession,
  type LiaisonRegisterResult,
} from "./liaison-service.js";

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
export function readAgencyConfig(): AgencyConfig {
  const agency_id = process.env.AGENCY_ID?.trim();
  const provider = process.env.AGENCY_PROVIDER?.trim();
  const host_id = process.env.AGENCY_HOST_ID?.trim();

  if (!agency_id) throw new Error("AGENCY_ID env var is required");
  if (!provider) throw new Error("AGENCY_PROVIDER env var is required");
  if (!host_id) throw new Error("AGENCY_HOST_ID env var is required");

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
 * Usage:
 *   const handle = await bootLiaison();
 *   process.on('SIGTERM', () => handle.shutdown());
 */
export async function bootLiaison(
  configOverride?: Partial<AgencyConfig>
): Promise<LiaisonBootHandle> {
  const base = readAgencyConfig();
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

  let running = true;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const scheduleNext = () => {
    if (!running) return;
    timer = setTimeout(async () => {
      if (!running) return;
      try {
        await liaisonHeartbeat({
          session_id: session.session_id,
          status: "active",
          capacity_envelope: {},
        });
      } catch {
        // Non-fatal: heartbeat failure is logged by orchestrator watchdog
      }
      scheduleNext();
    }, config.heartbeat_interval_ms);
  };

  scheduleNext();

  const shutdown = async (
    reason: "normal" | "crash" | "operator" | "throttle" = "normal"
  ) => {
    running = false;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    await endLiaisonSession(session.session_id, reason);
  };

  return { config, session, shutdown };
}
