/**
 * Agency Supervisor Entrypoint — P1125.
 *
 * One process for the whole agency fleet. Reads active agency identities from
 * `roadmap_workforce.agent_registry` (agent_type='agency', status='active') and
 * runs the full liaison stack (bootLiaison + runLiaisonAgent) for each in-process.
 *
 * Replaces the 9 instances of `agenthive-agency@<name>.service` with a single
 * `agenthive-agency.service`. Per-agency env files retire — identity + provider
 * + host come from agent_registry rows.
 *
 * Connection footprint per agency:
 *   - 1 LISTEN connection on liaison_message_<id> (via startLiaisonHub)
 *   - 1 LISTEN connection on a2a_msg_<id> (via runLiaisonAgent → connectListenClient)
 * Plus one shared query pool across all agencies (vs N pools today).
 *
 * Lifecycle:
 *   - Boot: read agent_registry, for each row run bootLiaison + runLiaisonAgent.
 *           Failures of one agency do NOT crash the supervisor — log + continue.
 *   - Runtime: each agency's LISTEN client + heartbeat timer runs independently.
 *   - Shutdown: SIGTERM stops all agencies in parallel, then closes shared pool.
 *
 * Per-agency restart is exposed via MCP (P1125 Phase D) — operator can rebuild
 * one identity's LISTEN session without restarting the supervisor.
 *
 * Env vars consumed (process-wide, NOT per-agency):
 *   DATABASE_URL / PG* — Postgres connection (shared pool + LISTEN clients)
 *   PGPORT_DIRECT       — required for LISTEN bypass of PgBouncer
 *   LIAISON_HEARTBEAT_INTERVAL_MS — heartbeat interval (default 30000)
 *   AGENTHIVE_HOST      — host filter for which agencies to run (default "bot")
 *   AGENTHIVE_SUPERVISOR_HOST_FILTER — overrides AGENTHIVE_HOST for selection
 */

import { bootLiaison, type LiaisonBootHandle } from "../src/infra/agency/liaison-boot.ts";
import {
  runLiaisonAgent,
  type LiaisonAgentHandle,
} from "../src/infra/agency/liaison-agent.ts";
import {
  closePool,
  query,
  setPoolLifecycleMode,
} from "../src/infra/postgres/pool.ts";

// Protect the shared pool from stray pool.end() in shared CLI code.
setPoolLifecycleMode("long-running");

interface AgencyRow {
  agent_identity: string;
  preferred_provider: string | null;
  host_affinity: string | null;
  display_alias: string | null;
}

interface ManagedAgency {
  identity: string;
  bootHandle: LiaisonBootHandle;
  agentHandle: LiaisonAgentHandle | null;
}

const HOST_FILTER =
  process.env.AGENTHIVE_SUPERVISOR_HOST_FILTER?.trim() ||
  process.env.AGENTHIVE_HOST?.trim() ||
  "bot";

const managed = new Map<string, ManagedAgency>();
let shuttingDown = false;

async function loadActiveAgencies(): Promise<AgencyRow[]> {
  // Select identities the supervisor should run on this host.
  // host_affinity NULL or empty = runnable anywhere; non-null must match HOST_FILTER.
  const { rows } = await query<AgencyRow>(
    `SELECT agent_identity, preferred_provider, host_affinity, display_alias
       FROM roadmap_workforce.agent_registry
      WHERE agent_type = 'agency'
        AND status     = 'active'
        AND (
              host_affinity IS NULL
           OR host_affinity = ''
           OR host_affinity = $1
            )
        AND coalesce(preferred_provider, '') <> ''
      ORDER BY agent_identity`,
    [HOST_FILTER],
  );
  return rows;
}

async function startAgency(row: AgencyRow): Promise<void> {
  const identity = row.agent_identity;
  const provider = row.preferred_provider!;
  const display_name = row.display_alias ?? identity;

  console.log(`[supervisor] starting agency ${identity} (provider=${provider})`);

  let bootHandle: LiaisonBootHandle;
  try {
    bootHandle = await bootLiaison({
      agency_id: identity,
      provider,
      host_id: HOST_FILTER,
      display_name,
    });
  } catch (err) {
    console.error(
      `[supervisor] bootLiaison failed for ${identity}: ${(err as Error).message}`,
    );
    return;
  }

  let agentHandle: LiaisonAgentHandle | null = null;
  try {
    agentHandle = await runLiaisonAgent({
      identity,
      provider,
      loggerPrefix: `[liaison-agent:${identity}]`,
    });
    console.log(`[supervisor] ${identity} message_ledger LISTEN active`);
  } catch (err) {
    console.warn(
      `[supervisor] runLiaisonAgent failed for ${identity} (non-fatal): ${(err as Error).message}`,
    );
  }

  managed.set(identity, { identity, bootHandle, agentHandle });
}

async function stopAgency(identity: string, reason: "normal" | "operator" = "normal"): Promise<void> {
  const m = managed.get(identity);
  if (!m) return;
  managed.delete(identity);
  console.log(`[supervisor] stopping agency ${identity}`);
  if (m.agentHandle) {
    try {
      await m.agentHandle.stop();
    } catch (err) {
      console.warn(`[supervisor] ${identity} agentHandle.stop error:`, err);
    }
  }
  try {
    await m.bootHandle.shutdown(reason);
  } catch (err) {
    console.warn(`[supervisor] ${identity} bootHandle.shutdown error:`, err);
  }
}

async function shutdownAll(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const identities = Array.from(managed.keys());
  console.log(`[supervisor] shutdown — stopping ${identities.length} agencies in parallel`);
  await Promise.allSettled(identities.map((id) => stopAgency(id, "normal")));
  setPoolLifecycleMode("one-shot");
  try {
    await closePool();
  } catch (err) {
    console.warn(`[supervisor] closePool error (non-fatal):`, err);
  }
  console.log(`[supervisor] stopped`);
}

async function main(): Promise<void> {
  console.log(`[supervisor] starting on host=${HOST_FILTER}`);

  const agencies = await loadActiveAgencies();
  if (agencies.length === 0) {
    console.warn(
      `[supervisor] no active agencies found in agent_registry for host=${HOST_FILTER}; idling`,
    );
  } else {
    console.log(
      `[supervisor] booting ${agencies.length} agencies: ${agencies.map((a) => a.agent_identity).join(", ")}`,
    );
  }

  // Boot all agencies in parallel — slower ones (gemini-3.1-pro-preview route
  // resolution etc.) shouldn't gate the rest.
  await Promise.allSettled(agencies.map((row) => startAgency(row)));

  console.log(
    `[supervisor] boot complete — ${managed.size} of ${agencies.length} agencies running`,
  );

  // Keep the process alive; the LISTEN clients and heartbeat timers drive the loop.
  await new Promise<void>((resolve) => {
    const onSignal = (sig: string) => {
      console.log(`[supervisor] ${sig} received`);
      resolve();
    };
    process.once("SIGTERM", () => onSignal("SIGTERM"));
    process.once("SIGINT", () => onSignal("SIGINT"));
  });

  await shutdownAll();
}

main().catch(async (err) => {
  console.error(`[supervisor] fatal:`, err);
  await shutdownAll();
  process.exit(1);
});
