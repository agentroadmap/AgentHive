#!/usr/bin/env -S bun run
/**
 * P499 AC-2: PgBouncer tenant_db_provisioned listener
 *
 * Listens for pg_notify on 'tenant_db_provisioned' channel and reloads
 * PgBouncer admin console within 60s SLA (via systemctl reload).
 *
 * Runs as a standalone daemon or can be integrated into an existing service.
 *
 * Usage:
 *   bun scripts/pgbouncer/listen-provision.ts
 *
 * Env vars (inherited from provision-pgbouncer.ts):
 *   PGHOST, PGPORT_DIRECT, PGUSER, PGDATABASE (all optional, reasonable defaults)
 *
 * Expected to be killed/restarted by systemd or manual control (no graceful shutdown).
 * Exits on listener error (systemd will restart).
 */

import { Client } from "pg";
import { execSync } from "node:child_process";

const PGHOST = process.env.PGHOST ?? "127.0.0.1";
const PGPORT_DIRECT = Number(process.env.PGPORT_DIRECT ?? process.env.PGPORT ?? 5432);
const PGUSER = process.env.PGUSER ?? (() => {
  throw new Error("PGUSER is required");
})();
const PGDATABASE = process.env.PGDATABASE ?? "agenthive";

/**
 * Connect to Postgres (direct, not through PgBouncer) and listen for
 * tenant_db_provisioned notifications. On each notification, issue a
 * RELOAD to PgBouncer admin console (systemctl reload pgbouncer pattern).
 */
async function listenAndReload(): Promise<void> {
  const client = new Client({
    host: PGHOST,
    port: PGPORT_DIRECT,
    user: PGUSER,
    database: PGDATABASE,
    keepAlive: true,
  });

  try {
    await client.connect();
    console.log(`[P499-AC2] Connected to Postgres ${PGHOST}:${PGPORT_DIRECT}/${PGDATABASE}`);

    await client.query("LISTEN tenant_db_provisioned");
    console.log("[P499-AC2] Listening on channel 'tenant_db_provisioned' (60s SLA)");

    client.on("notification", async (msg) => {
      const timestamp = new Date().toISOString();
      const payload = msg.payload ?? "(no payload)";
      console.log(`[${timestamp}] NOTIFY received: payload="${payload}". Reloading PgBouncer...`);

      try {
        // Systemctl reload sends HUP to pgbouncer process, which re-reads config.
        // If the new tenant DB entry is in [databases], the pool is created immediately.
        execSync("systemctl reload pgbouncer", { stdio: "inherit" });
        console.log(`[${timestamp}] PgBouncer reload completed.`);
      } catch (err) {
        console.error(`[${timestamp}] ERROR: systemctl reload pgbouncer failed:`, err);
        // Continue listening; next notification will retry.
      }
    });

    client.on("error", (err) => {
      console.error("[P499-AC2] LISTEN client error (exiting for systemd restart):", err);
      process.exit(1);
    });

    // Keep the process alive; the listener drives the loop.
    // Systemd will send SIGTERM on shutdown; no graceful handling needed.
    await new Promise<never>(() => {});
  } catch (err) {
    console.error("[P499-AC2] Failed to connect or set up listener:", err);
    process.exit(1);
  }
}

listenAndReload().catch((err) => {
  console.error("[P499-AC2] Unexpected error:", err);
  process.exit(1);
});
