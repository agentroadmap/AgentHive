/**
 * State Feed — pg_notify listener that forwards proposal state/maturity
 * changes to Discord webhook. Zero LLM, pure Postgres LISTEN + REST.
 */
import { Client } from "pg";
import { readFileSync, existsSync } from "node:fs";

// Config
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_STATEFEED
  ?? (() => { throw new Error("DISCORD_WEBHOOK_STATEFEED not set — add to ~/.hermes/.env"); })();
const CHANNELS = [
  "proposal_maturity_changed",
  "proposal_gate_ready",
  "proposal_state_changed",
];

// Load PG password
function getPGPassword(): string {
  const candidates = [
    process.env.PGPASSWORD,
  ];
  for (const pw of candidates) {
    if (pw) return pw;
  }
  // Try .env files
  const envPaths = [
    process.env.HOME + "/.hermes/.env",
    "/data/code/AgentHive/.env",
  ];
  for (const envPath of envPaths) {
    if (!envPath || !existsSync(envPath)) continue;
    for (const line of readFileSync(envPath, "utf-8").split("\n")) {
      const m = /^\s*PGPASSWORD\s*=\s*(.+)/.exec(line);
      if (m) return m[1].trim();
    }
  }
  throw new Error("PGPASSWORD not found in env or .env files");
}

async function sendToDiscord(content: string) {
  const truncated = content.slice(0, 1900);
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: truncated }),
    });
  } catch (err) {
    console.error("[state-feed] Discord send failed:", err);
  }
}

async function queryProposal(client: Client, proposalId: number) {
  const res = await client.query(
    `SELECT display_id, title, status, maturity, type
     FROM roadmap_proposal.proposal WHERE id = $1`,
    [proposalId]
  );
  return res.rows[0] || null;
}

async function handleNotification(client: Client, channel: string, payload: string) {
  console.log(`[state-feed] ${channel}: ${payload.slice(0, 100)}`);

  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(payload);
  } catch {
    data = { raw: payload };
  }

  const proposalId = Number(data.proposal_id ?? data.id);
  let msg = "";

  if (channel === "proposal_maturity_changed") {
    const p = proposalId ? await queryProposal(client, proposalId) : null;
    if (p) {
      const arrow = `${data.old_maturity ?? "?"} → ${data.new_maturity ?? p.maturity}`;
      msg = `⏫ **${p.display_id}** maturity: ${arrow}\n${p.title}\n[${p.type}] ${p.status}`;
    } else {
      msg = `⏫ Maturity change: ${payload}`;
    }
  } else if (channel === "proposal_gate_ready") {
    const p = proposalId ? await queryProposal(client, proposalId) : null;
    if (p) {
      msg = `🚪 **${p.display_id}** gate ready: ${p.status} (${p.maturity})\n${p.title}`;
    } else {
      msg = `🚪 Gate ready: ${payload}`;
    }
  } else if (channel === "proposal_state_changed") {
    const p = proposalId ? await queryProposal(client, proposalId) : null;
    if (p) {
      const arrow = `${data.old_status ?? "?"} → ${data.new_status ?? p.status}`;
      msg = `📝 **${p.display_id}** state: ${arrow} (${p.maturity})\n${p.title}`;
    } else {
      msg = `📝 State change: ${payload}`;
    }
  } else {
    msg = `🔔 ${channel}: ${payload}`;
  }

  if (msg) {
    await sendToDiscord(msg);
  }
}

async function main() {
  const pgPassword = getPGPassword();
  const client = new Client({
    host: "127.0.0.1",
    port: 5432,
    user: "xiaomi",
    password: pgPassword,
    database: "agenthive",
  });

  await client.connect();
  console.log("[state-feed] Connected to Postgres");

  // Listen on channels
  for (const ch of CHANNELS) {
    await client.query(`LISTEN ${ch}`);
    console.log(`[state-feed] Listening on ${ch}`);
  }

  // Handle notifications
  client.on("notification", async (msg) => {
    if (!msg.channel || !msg.payload) return;
    try {
      await handleNotification(client, msg.channel, msg.payload);
    } catch (err) {
      console.error(`[state-feed] Error handling ${msg.channel}:`, err);
    }
  });

  client.on("error", (err) => {
    console.error("[state-feed] PG error:", err);
    // Reconnect after delay
    setTimeout(() => main().catch(console.error), 5000);
  });

  console.log("[state-feed] Ready — forwarding state changes to Discord");
}

main().catch((err) => {
  console.error("[state-feed] Fatal:", err);
  process.exit(1);
});
