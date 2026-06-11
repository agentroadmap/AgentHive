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
  liaisonSetOffline,
  endLiaisonSession,
  type LiaisonRegisterResult,
} from "./liaison-service.js";
import { startLiaisonHub, propagateHeartbeat } from "./liaison-hub.ts";
import {
  clearThrottleIfExpired,
  getCapacityEnvelope,
} from "./subscription-policy.ts";

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
  // AGENCY_PROVIDER is canonical; AGENTHIVE_AGENT_PROVIDER is legacy fallback
  // for older per-instance env files that haven't been updated yet.
  const provider =
    (process.env.AGENCY_PROVIDER?.trim() || process.env.AGENTHIVE_AGENT_PROVIDER?.trim()) ?? "";
  const host_id = process.env.AGENCY_HOST_ID?.trim();

  if (!agency_id) throw new Error("AGENCY_ID env var is required");
  if (!provider) throw new Error("AGENCY_PROVIDER (or AGENTHIVE_AGENT_PROVIDER fallback) env var is required");
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
  // If the caller supplies the three required fields directly (host-managed
  // multi-tenant case, e.g. start-a2a-host.ts), skip readAgencyConfig() so the
  // host process doesn't need per-agency env vars set. Standalone callers
  // (start-liaison.ts) still go through the env-driven path.
  const hasOverrideRequired = !!(
    configOverride?.agency_id &&
    configOverride?.provider &&
    configOverride?.host_id
  );
  const config: AgencyConfig = hasOverrideRequired
    ? {
        agency_id: configOverride!.agency_id!,
        provider: configOverride!.provider!,
        host_id: configOverride!.host_id!,
        display_name:
          configOverride!.display_name ?? configOverride!.agency_id!,
        public_key: configOverride!.public_key,
        capabilities: configOverride!.capabilities ?? [],
        heartbeat_interval_ms:
          configOverride!.heartbeat_interval_ms ?? 30000,
      }
    : { ...readAgencyConfig(), ...configOverride };

  // AC#2: Registration handshake — liaison calls liaison_register.
  // supersede_stale_session: the a2a-host is a systemd singleton per host and
  // its agencies are host-bound, so any open session at boot belongs to a dead
  // predecessor (e.g. P1142 fail-fast exit(1) restarts within seconds, while
  // the dead instance's heartbeat is still fresh enough to defeat the
  // freshness-guarded orphan heal).
  const session = await liaisonRegister({
    agency_id: config.agency_id,
    display_name: config.display_name,
    provider: config.provider,
    host_id: config.host_id,
    capabilities: config.capabilities,
    capacity_envelope: {},
    public_key: config.public_key,
    supersede_stale_session: true,
  });

  // Start bidirectional message hub — listens for uplink messages from subagents
  // and handles downlink directives and cross-project hiveCentral broadcasts.
  const hub = startLiaisonHub(config.agency_id);


  let running = true;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const scheduleNext = () => {
    if (!running) return;
    timer = setTimeout(async () => {
      if (!running) return;
      try {
        // P465: clear any expired throttle window before declaring status
        await clearThrottleIfExpired(config.agency_id).catch(() => { /* best-effort */ });

        // P465: build capacity envelope from local meter
        const envelope = await getCapacityEnvelope(config.agency_id).catch(() => null);
        const envelopePayload: Record<string, unknown> = envelope
          ? {
              windows: envelope.windows,
              free_claim_slots: envelope.free_claim_slots,
              in_flight_claims: envelope.in_flight_claims,
            }
          : {};

        // P465: if any window is exhausted (free_claim_slots=0), declare throttled
        const isThrottled = envelope !== null && envelope.free_claim_slots <= 0;

        const hbResult = await liaisonHeartbeat({
          session_id: session.session_id,
          status: isThrottled ? "throttled" : "active",
          capacity_envelope: envelopePayload,
        });
        // Propagate heartbeat to A2A surface so orchestrators/observers react
        await propagateHeartbeat(
          config.agency_id,
          hbResult.agency_status,
          hbResult.dispatchable
        );
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
    hub.stop();
    // P1104: mark presence offline before closing the session
    await liaisonSetOffline(config.agency_id);
    await endLiaisonSession(session.session_id, reason);
  };

  return { config, session, shutdown };
}
