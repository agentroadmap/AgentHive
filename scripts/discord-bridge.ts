/**
 * AgentHive Discord Bridge — Two-way communication with agent routing.
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

import { getPool, query } from "../src/infra/postgres/pool.ts";

const DISCORD_CHANNEL_ID = "1480366428325548200";
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";

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

// Send message to Discord
async function sendToDiscord(content: string): Promise<boolean> {
  if (!DISCORD_BOT_TOKEN) return false;

  try {
    const url = `https://discord.com/api/v10/channels/${DISCORD_CHANNEL_ID}/messages`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bot ${DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    });
    return response.ok;
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

// Handle incoming Discord message
async function handleDiscordMessage(content: string, author: string): Promise<string | null> {
  // Check for status command
  if (content.toLowerCase() === "status") {
    return await getPipelineStatus();
  }

  // Check for help command
  if (content.toLowerCase() === "help") {
    return `**AgentHive Discord Bridge — Commands:**
• \`@agent message\` — Route message to agent (e.g., \`@claude/andy review P149\`)
• \`status\` — Show pipeline status
• \`help\` — Show this help

**Available agents:**
${Object.keys(AGENT_MENTIONS).join(", ")}`;
  }

  // Check for agent mention
  const { agent, message } = parseAgentMention(content);
  if (agent) {
    return await routeToAgent(agent, `From Discord (${author}): ${message}`);
  }

  // No agent mentioned — broadcast to general
  return null;
}

// Get pipeline status
async function getPipelineStatus(): Promise<string> {
  try {
    const result = await query(
      `SELECT current_stage, COUNT(*) as count
       FROM roadmap.workflows
       WHERE completed_at IS NULL
       GROUP BY current_stage
       ORDER BY
         CASE current_stage
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

    let status = "**AgentHive Pipeline Status:**\n";
    for (const row of result.rows) {
      status += `• ${row.current_stage}: ${row.count} workflows\n`;
    }
    return status;
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

    if (channel === "proposal_maturity_changed") {
      const maturity = data.maturity_state || data.maturity;
      return `📊 **MATURITY CHANGE** — ${data.display_id || data.proposal_id} → ${maturity}`;
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

// Poll Discord for new messages
async function pollDiscordMessages(lastMessageId: string | null): Promise<string | null> {
  if (!DISCORD_BOT_TOKEN) return null;

  try {
    const url = `https://discord.com/api/v10/channels/${DISCORD_CHANNEL_ID}/messages${lastMessageId ? `?after=${lastMessageId}` : "?limit=1"}`;
    const response = await fetch(url, {
      headers: { "Authorization": `Bot ${DISCORD_BOT_TOKEN}` },
    });

    if (!response.ok) return null;

    const messages = (await response.json()) as any[];
    if (messages.length === 0) return null;

    // Sort by ID (chronological)
    messages.sort((a, b) => a.id.localeCompare(b.id));

    let newLastId = lastMessageId;

    for (const msg of messages) {
      newLastId = msg.id;

      // Skip bot messages
      if (msg.author.bot) continue;
      if (msg.webhook_id) continue;

      const author = msg.author.global_name || msg.author.username;
      const content = msg.content;

      logger.log(`Received Discord message from ${author}: ${content.substring(0, 50)}...`);

      // Handle the message
      const response = await handleDiscordMessage(content, author);
      if (response) {
        await sendToDiscord(response);
      }
    }

    return newLastId;
  } catch (error) {
    logger.error("Failed to poll Discord:", error);
    return null;
  }
}

async function main() {
  logger.log("Starting Discord Bridge (two-way)...");
  logger.log(`Channel: ${DISCORD_CHANNEL_ID}`);

  const pool = getPool();
  const pgClient = await pool.connect();

  // Listen for state change notifications
  await pgClient.query("LISTEN proposal_gate_ready");
  await pgClient.query("LISTEN proposal_maturity_changed");
  await pgClient.query("LISTEN transition_queued");
  // Listen for outbound messages from agents → Discord
  await pgClient.query("LISTEN discord_send");

  logger.log("Listening for pg_notify events");

  // Handle pg_notify events (push to Discord)
  pgClient.on("notification", async (msg: { channel: string; payload?: string }) => {
    if (!msg.payload) return;
    const notification = formatNotification(msg.channel, msg.payload);
    await sendToDiscord(notification);
  });

  // Poll Discord for incoming messages (every 5 seconds)
  let lastMessageId: string | null = null;
  setInterval(async () => {
    lastMessageId = await pollDiscordMessages(lastMessageId);
  }, 5000);

  // Send startup message
  await sendToDiscord("🟢 **AgentHive Discord Bridge** — Two-way communication active.\n\n**Commands:**\n• `@agent message` — Route to agent\n• `status` — Show pipeline status\n• `help` — Show help");

  logger.log("Discord Bridge running (two-way)...");

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.log(`Received ${signal}, shutting down...`);
    await sendToDiscord("🔴 **AgentHive Discord Bridge** — Shutting down.");
    pgClient.release();
    await pool.end();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[DiscordBridge] Fatal error:", err);
  process.exit(1);
});
