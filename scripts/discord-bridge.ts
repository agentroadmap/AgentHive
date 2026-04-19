/**
 * AgentHive Discord Bridge — Two-way communication with agent routing.
 * Uses discord.js for WebSocket connection (bot shows online).
 *
 * PUSH: State changes → Discord channel
 * RECEIVE: Discord messages → Route to registered agents
 *
 * Agent routing:
 *   @claude/andy  → claude/andy agent
 *   @claude/one   → claude/one agent
 *   @codex/andy   → codex/andy agent
 *   @xiaomi       → xiaomi agent
 *   @skeptic      → skeptic agent
 *   @architect    → architect agent
 *   @reviewer     → reviewer agent
 *   @developer    → developer agent
 *
 * Usage in Discord:
 *   "@claude/andy review P149" → routes to claude/andy
 *   "@xiaomi enhance P080" → routes to xiaomi
 *   "@skeptic challenge P050" → routes to skeptic
 *   "status" → show pipeline status
 */

import { Client, GatewayIntentBits, TextChannel } from "discord.js";
import { getPool, query } from "../src/infra/postgres/pool.ts";
import { execFile } from "child_process";

const DISCORD_CHANNEL_ID = "1480366428325548200";
const DISCORD_DM_CHANNEL_ID = "1481167953348137084";
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";

// Allowed user IDs (only these users can send commands)
const ALLOWED_USER_IDS: Set<string> = new Set([
  "361693793973436428", // xiaomi
]);

// Agent mention mapping
const AGENT_MENTIONS: Record<string, string> = {
  "@claude/andy": "claude/andy",
  "@claude/one": "claude/one",
  "@claude": "claude/andy",
  "@codex/andy": "codex/andy",
  "@codex": "codex/andy",
  "@copilot/gary": "copilot/gary",
  "@copilot": "copilot/gary",
  "@xiaomi": "xiaomi",
  "@skeptic": "skeptic",
  "@architect": "architect",
  "@reviewer": "reviewer",
  "@developer": "developer",
  "@merge": "merge-agent",
  "@triage": "triage-agent",
  "@fix": "fix-agent",
  "@enhancer": "enhancer",
  "@researcher": "researcher",
  "@documenter": "documenter",
};

const logger = {
  log: (...args: unknown[]) => console.log("[DiscordBridge]", ...args),
  warn: (...args: unknown[]) => console.warn("[DiscordBridge]", ...args),
  error: (...args: unknown[]) => console.error("[DiscordBridge]", ...args),
};

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

// Send message to Discord channel
async function sendToDiscord(content: string): Promise<boolean> {
  try {
    const channel = client.channels.cache.get(DISCORD_CHANNEL_ID) as TextChannel | undefined;
    if (!channel) {
      logger.error("Channel not found:", DISCORD_CHANNEL_ID);
      return false;
    }
    await channel.send(content);
    return true;
  } catch (error) {
    logger.error("Failed to send to Discord:", error);
    return false;
  }
}

// Parse agent mention from message
function parseAgentMention(content: string): { agent: string | null; message: string } {
  for (const [mention, agent] of Object.entries(AGENT_MENTIONS)) {
    if (content.toLowerCase().startsWith(mention.toLowerCase())) {
      return {
        agent,
        message: content.substring(mention.length).trim(),
      };
    }
  }
  return { agent: null, message: content };
}

// Route message to agent via MCP msg_send
async function routeToAgent(agent: string, message: string): Promise<string> {
  try {
    // Store message for the agent to read
    await query(
      `INSERT INTO roadmap.message_ledger (from_agent, to_agent, channel, message_content, message_type, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      ["discord-bridge", agent, "direct", message, "task"]
    );

    // Notify the agent via pg_notify
    const pool = getPool();
    await pool.query(
      `SELECT pg_notify('new_message', $1)`,
      [JSON.stringify({ to_agent: agent, from_agent: "discord-bridge", message })]
    );

    return `✅ Message routed to ${agent}. They will respond when ready.`;
  } catch (error) {
    logger.error("Failed to route message:", error);
    return `❌ Failed to route message to ${agent}. Error: ${error}`;
  }
}

// Spawn hermes CLI and get response
function askHermes(message: string): Promise<string> {
  return new Promise((resolve) => {
    const hermesBin = "/home/xiaomi/.local/bin/hermes";
    logger.log(`Spawning hermes for: ${message.substring(0, 50)}...`);

    execFile(
      hermesBin,
      ["--no-banner", "--quiet", message],
      {
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          HOME: "/home/xiaomi",
          PATH: "/home/xiaomi/.local/bin:/usr/local/bin:/usr/bin:/bin",
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          logger.error("Hermes error:", err.message);
          resolve(`❌ Hermes error: ${err.message}`);
          return;
        }
        const output = (stdout || "").trim();
        resolve(output || "🤷 Hermes returned empty response.");
      }
    );
  });
}

// Handle incoming Discord message
async function handleDiscordMessage(content: string, author: string): Promise<string | null> {
  // Check for status command
  if (content.toLowerCase() === "status") {
    return await getPipelineStatus();
  }

  // Check for help command
  if (content.toLowerCase() === "help") {
    return `**AgentHive Discord Bridge — Commands:**
• \`@hermes message\` — Talk to Hermes directly
• \`@agent message\` — Route to agent (e.g., \`@claude/andy review P149\`)
• \`status\` — Show pipeline status
• \`help\` — Show this help

**Available agents:**
@hermes, ${Object.keys(AGENT_MENTIONS).join(", ")}`;
  }

  // Check for @hermes — spawn hermes CLI directly
  if (content.toLowerCase().startsWith("@hermes")) {
    const message = content.substring(7).trim();
    if (!message) return "Usage: @hermes <your message>";
    const response = await askHermes(message);
    return response;
  }

  // Check for agent mention
  const { agent, message } = parseAgentMention(content);
  if (agent) {
    return await routeToAgent(agent, `From Discord (${author}): ${message}`);
  }

  // No agent mentioned — broadcast to general
  return null;
}

// Get pipeline status grouped by workflow
async function getPipelineStatus(): Promise<string> {
  try {
    const result = await query(
      `SELECT COALESCE(t.name, 'Unknown') AS workflow,
              UPPER(w.current_stage) AS stage,
              COUNT(*) AS count
       FROM roadmap.workflows w
       LEFT JOIN roadmap.workflow_templates t ON w.template_id = t.id
       WHERE w.completed_at IS NULL
       GROUP BY t.name, UPPER(w.current_stage)
       ORDER BY t.name,
         CASE UPPER(w.current_stage)
           WHEN 'DRAFT' THEN 1
           WHEN 'REVIEW' THEN 2
           WHEN 'TRIAGE' THEN 3
           WHEN 'FIX' THEN 4
           WHEN 'DEVELOP' THEN 5
           WHEN 'MERGE' THEN 6
           WHEN 'COMPLETE' THEN 7
           WHEN 'DEPLOYED' THEN 8
           ELSE 9
         END`
    );

    // Group by workflow
    const byWorkflow: Record<string, string[]> = {};
    for (const row of result.rows) {
      const wf = row.workflow;
      if (!byWorkflow[wf]) byWorkflow[wf] = [];
      byWorkflow[wf].push(`${row.stage}: ${row.count}`);
    }

    let status = "**AgentHive Pipeline Status:**\n";
    for (const [wf, stages] of Object.entries(byWorkflow)) {
      status += `\n**${wf}**\n`;
      for (const s of stages) {
        status += `  • ${s}\n`;
      }
    }
    return status || "No active workflows.";
  } catch (error) {
    return "Failed to get pipeline status";
  }
}

// Format state change notification
function formatNotification(channel: string, payload: string): string {
  try {
    const data = JSON.parse(payload);

    if (channel === "proposal_gate_ready") {
      return `🚪 **GATE READY** — Proposal ${data.proposal_id || data.id} is ready for gate evaluation`;
    }

    if (channel === "proposal_state_changed") {
      const from = data.from_state ?? "?";
      const to = data.to_state ?? "?";
      const by = data.transitioned_by ? ` by ${data.transitioned_by}` : "";
      const reason = data.reason ? ` (${data.reason})` : "";
      return `🔄 **STATE** — ${data.display_id ?? data.proposal_id}: ${from} → ${to}${by}${reason}`;
    }

    if (channel === "proposal_maturity_changed") {
      const from = data.from_maturity ?? "?";
      const to = data.to_maturity ?? data.maturity_state ?? data.maturity ?? "?";
      const by = data.transitioned_by ? ` by ${data.transitioned_by}` : "";
      return `📊 **MATURITY** — ${data.display_id ?? data.proposal_id}: ${from} → ${to}${by}`;
    }

    if (channel === "transition_queued") {
      return `🔄 **TRANSITION QUEUED** — ${data.enqueued || 1} transitions queued for processing`;
    }

    if (channel === "discord_send") {
      const LEVEL_ICONS: Record<string, string> = {
        info: "💬",
        success: "✅",
        warning: "⚠️",
        error: "❌",
      };
      const icon = LEVEL_ICONS[data.level ?? "info"] ?? "💬";
      const from = data.from ?? "agent";
      return `${icon} **[${from}]** ${data.message ?? payload}`;
    }

    return `📢 **${channel}** — ${JSON.stringify(data).substring(0, 200)}`;
  } catch {
    return `📢 **${channel}** — ${payload.substring(0, 200)}`;
  }
}

// Discord event: bot ready
client.once("ready", async () => {
  logger.log(`Connected as ${client.user?.tag}`);
  logger.log(`Guilds: ${client.guilds.cache.size}, Channels: ${client.channels.cache.size}`);

  const pool = getPool();
  const pgClient = await pool.connect();

  // Listen for state change notifications
  await pgClient.query("LISTEN proposal_state_changed");
  await pgClient.query("LISTEN proposal_gate_ready");
  await pgClient.query("LISTEN proposal_maturity_changed");
  await pgClient.query("LISTEN transition_queued");
  await pgClient.query("LISTEN discord_send");

  logger.log("Listening for pg_notify events");

  // Handle pg_notify events (push to Discord)
  pgClient.on("notification", async (msg: { channel: string; payload?: string }) => {
    if (!msg.payload) return;
    const notification = formatNotification(msg.channel, msg.payload);
    await sendToDiscord(notification);
  });

  // REST polling for messages (DMs + server channel)
  // WebSocket messageCreate isn't reliable for DMs in some setups
  let lastServerMsgId: string | null = null;
  let lastDmMsgId: string | null = null;

  async function pollChannel(channelId: string, label: string, lastId: string | null): Promise<string | null> {
    if (!DISCORD_BOT_TOKEN) return lastId;
    try {
      const url = `https://discord.com/api/v10/channels/${channelId}/messages?limit=${lastId ? "5" : "1"}${lastId ? `&after=${lastId}` : ""}`;
      const response = await fetch(url, {
        headers: { "Authorization": `Bot ${DISCORD_BOT_TOKEN}` },
      });
      if (!response.ok) return lastId;
      const messages = (await response.json()) as any[];
      if (messages.length === 0) return lastId;

      messages.sort((a: any, b: any) => a.id.localeCompare(b.id));
      let newLastId = lastId;

      for (const msg of messages) {
        newLastId = msg.id;
        if (msg.author.bot) continue;
        if (!ALLOWED_USER_IDS.has(msg.author.id)) continue;

        const author = msg.author.global_name || msg.author.username;
        const content = msg.content;
        logger.log(`[REST:${label}] Received from ${author}: ${content.substring(0, 50)}...`);

        const response = await handleDiscordMessage(content, author);
        if (response) {
          // Send reply via discord.js (keeps WebSocket connection alive)
          const channel = client.channels.cache.get(channelId);
          if (channel && "send" in channel) {
            await (channel as any).send(response);
          }
        }
      }
      return newLastId;
    } catch (error) {
      logger.error(`[REST:${label}] Poll error:`, error);
      return lastId;
    }
  }

  // Poll every 3 seconds
  setInterval(async () => {
    lastServerMsgId = await pollChannel(DISCORD_CHANNEL_ID, "server", lastServerMsgId);
    lastDmMsgId = await pollChannel(DISCORD_DM_CHANNEL_ID, "dm", lastDmMsgId);
  }, 3000);

  // Send startup message
  await sendToDiscord("🟢 **AgentHive Discord Bridge** — Two-way communication active.\n\n**Commands:**\n• `@agent message` — Route to agent\n• `status` — Show pipeline status\n• `help` — Show help");

  logger.log("Discord Bridge running (two-way)...");
});

// Discord event: message received
client.on("messageCreate", async (msg) => {
  // Debug: log ALL messages
  logger.log(`[DEBUG] messageCreate: channel=${msg.channel.id} type=${msg.channel.type} author=${msg.author.id}/${msg.author.username} bot=${msg.author.bot} guild=${msg.guild?.id ?? "DM"}`);

  // Skip bot messages
  if (msg.author.bot) return;

  // Accept: server channel OR DM from allowed user
  const isServerChannel = msg.channel.id === DISCORD_CHANNEL_ID;
  const isDM = !msg.guild && msg.channel.type === 1; // DMChannel
  if (!isServerChannel && !isDM) return;

  // Skip unauthorized users
  if (!ALLOWED_USER_IDS.has(msg.author.id)) {
    if (!isDM) logger.log(`Ignoring message from unauthorized user ${msg.author.id} (${msg.author.username})`);
    return;
  }

  const author = msg.author.globalName || msg.author.username;
  const content = msg.content;

  logger.log(`Received Discord message from ${author}: ${content.substring(0, 50)}...`);

  const response = await handleDiscordMessage(content, author);
  if (response) {
    await msg.channel.send(response);
  }
});

// Graceful shutdown
const shutdown = async (signal: string) => {
  logger.log(`Received ${signal}, shutting down...`);
  client.destroy();
  process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Login
if (!DISCORD_BOT_TOKEN) {
  logger.error("DISCORD_BOT_TOKEN not set");
  process.exit(1);
}

client.login(DISCORD_BOT_TOKEN).catch((err) => {
  logger.error("Failed to login:", err);
  process.exit(1);
});
