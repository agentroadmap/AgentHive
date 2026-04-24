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

// Load PG password — falls back to .pgpass if not set
function getPGPassword(): string | undefined {
  const candidates = [
    process.env.PGPASSWORD,
    process.env.PG_PASSWORD,
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
      const m = /^\s*(?:PGPASSWORD|PG_PASSWORD)\s*=\s*(.+)/.exec(line);
      if (m) return m[1].trim();
    }
  }
  // pg module will use .pgpass automatically if no password provided
  return undefined;
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
    `SELECT display_id, title, status, maturity, type,
            (SELECT COUNT(*) FROM roadmap_proposal.proposal_dependencies pd
             WHERE pd.proposal_id = p.id AND pd.status = 'active') as blocked_deps
     FROM roadmap_proposal.proposal p WHERE p.id = $1`,
    [proposalId]
  );
  return res.rows[0] || null;
}

// What each state transition unlocks
const STATE_IMPLICATIONS: Record<string, Record<string, string>> = {
  DRAFT:   { REVIEW:  "Ready for gate review — architecture validation, feasibility check" },
  REVIEW:  { DEVELOP: "Approved — coding can begin, agents can claim implementation work" },
  DEVELOP: { MERGE:   "Implementation done — branch merge, CI, integration testing" },
  MERGE:   { COMPLETE:"Shipped — ready for production, dependents can proceed" },
};

// Maturity implications
const MATURITY_IMPLICATIONS: Record<string, string> = {
  mature: "Gate decision can be requested — work is complete enough to advance",
  active: "Under active lease — agent is iterating on this",
  new:    "Awaiting claim — no agent assigned yet",
};

// State transition emoji
function stateEmoji(from: string, to: string): string {
  if (to === "COMPLETE") return "🏁";
  if (to === "MERGE")    return "🔀";
  if (to === "DEVELOP")  return "🔨";
  if (to === "REVIEW")   return "🔍";
  return "🔄";
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
      const oldM = String(data.old_maturity ?? "?");
      const newM = String(data.new_maturity ?? p.maturity);
      const impl = MATURITY_IMPLICATIONS[newM] ?? "";
      msg = `⏫ **${p.display_id}** maturity: ${oldM} → **${newM}**`
        + `\n_${p.title}_`
        + (impl ? `\n→ ${impl}` : "");
    } else {
      msg = `⏫ Maturity change: ${payload}`;
    }
  } else if (channel === "proposal_gate_ready") {
    const p = proposalId ? await queryProposal(client, proposalId) : null;
    if (p) {
      msg = `🚪 **${p.display_id}** gate ready: ${p.status} (${p.maturity})`
        + `\n_${p.title}_`
        + `\n→ Awaiting gate decision to advance`;
    } else {
      msg = `🚪 Gate ready: ${payload}`;
    }
  } else if (channel === "proposal_state_changed") {
    const p = proposalId ? await queryProposal(client, proposalId) : null;
    if (p) {
      const oldS = String(data.old_status ?? "?");
      const newS = String(data.new_status ?? p.status);
      const emoji = stateEmoji(oldS, newS);
      const impl = STATE_IMPLICATIONS[oldS]?.[newS] ?? "";

      msg = `${emoji} **${p.display_id}** ${oldS} → **${newS}**`
        + `\n_${p.title}_`
        + (impl ? `\n→ ${impl}` : "");
    } else {
      msg = `🔄 State change: ${payload}`;
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
    host: process.env.PGHOST ?? process.env.PG_HOST ?? "127.0.0.1",
    port: Number(process.env.PGPORT ?? process.env.PG_PORT ?? "5432"),
    user: process.env.PGUSER ?? process.env.PG_USER ?? "xiaomi",
    password: pgPassword,
    database: process.env.PGDATABASE ?? process.env.PG_DATABASE ?? "agenthive",
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
