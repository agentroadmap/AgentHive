/**
 * Discord Bridge — bidirectional CLI ↔ Discord communication.
 *
 * Inbound:  Polls Discord API for messages, writes to roadmap.message_ledger
 *           for A2A dispatcher to route to the appropriate agent.
 *
 * Outbound: Listens on pg_notify('discord_send'), formats and POSTs
 *           to Discord API with level-based icons.
 *
 * Zero LLM calls, zero token cost.
 */

import { getPool, query } from "../postgres/pool.ts";

const DISCORD_API = "https://discord.com/api/v10";

// ─── Config ──────────────────────────────────────────────────────────────────

interface BridgeConfig {
	botToken: string;
	channelId: string;
	agentIdentity?: string;
	pollIntervalMs?: number;
}

function loadConfig(): BridgeConfig {
	const botToken = process.env.DISCORD_BOT_TOKEN;
	const channelId = process.env.DISCORD_CHANNEL_ID;

	if (!botToken || !channelId) {
		throw new Error(
			"DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID environment variables are required",
		);
	}

	return {
		botToken,
		channelId,
		agentIdentity: process.env.DISCORD_AGENT_IDENTITY ?? "discord-bridge",
		pollIntervalMs: Number(process.env.DISCORD_POLL_INTERVAL_MS) || 30_000,
	};
}

// ─── Outbound: pg_notify → Discord ──────────────────────────────────────────

const LEVEL_ICONS: Record<string, string> = {
	info: "💬",
	success: "✅",
	warning: "⚠️",
	error: "❌",
};

async function sendToDiscord(
	config: BridgeConfig,
	content: string,
): Promise<void> {
	try {
		const resp = await fetch(
			`${DISCORD_API}/channels/${config.channelId}/messages`,
			{
				method: "POST",
				headers: {
					Authorization: `Bot ${config.botToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ content }),
			},
		);

		if (!resp.ok) {
			const text = await resp.text();
			console.error(`[discord-bridge] Discord API error ${resp.status}: ${text}`);
		}
	} catch (err) {
		console.error(
			`[discord-bridge] Failed to send to Discord: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

async function startOutboundListener(config: BridgeConfig): Promise<void> {
	const pool = getPool();
	const client = await pool.connect();

	await client.query("LISTEN discord_send");

	client.on(
		"notification",
		(msg: { channel: string; payload?: string }) => {
			if (msg.channel !== "discord_send" || !msg.payload) return;

			try {
				const data = JSON.parse(msg.payload);
				const icon = LEVEL_ICONS[data.level] ?? "💬";
				const from = data.from ?? "agent";
				const message = data.message ?? "";
				const content = `${icon} **${from}**: ${message}`;

				void sendToDiscord(config, content);
			} catch (err) {
				console.error(
					`[discord-bridge] Failed to parse discord_send payload: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
	);

	console.log("[discord-bridge] Outbound listener active on pg_notify('discord_send')");
}

// ─── Inbound: Discord → message_ledger ──────────────────────────────────────

let lastPolledId: string | undefined;

async function pollInbound(config: BridgeConfig): Promise<void> {
	try {
		const url = `${DISCORD_API}/channels/${config.channelId}/messages?${lastPolledId ? `after=${lastPolledId}` : "limit=1"}`;

		const resp = await fetch(url, {
			headers: { Authorization: `Bot ${config.botToken}` },
		});

		if (!resp.ok) {
			console.error(`[discord-bridge] Inbound poll error: ${resp.status}`);
			return;
		}

		const messages = (await resp.json()) as Array<{
			id: string;
			author: { bot?: boolean; username: string; global_name?: string };
			webhook_id?: string;
			content: string;
		}>;

		if (messages.length === 0) return;

		messages.sort((a, b) => a.id.localeCompare(b.id));

		for (const msg of messages) {
			lastPolledId = msg.id;

			// Skip bot messages and webhooks to avoid loops
			if (msg.author.bot) continue;
			if (msg.webhook_id) continue;

			const from = msg.author.global_name || msg.author.username;
			const text = msg.content.trim();
			if (!text) continue;

			// Check for direct commands (status, help)
			const lowerText = text.toLowerCase();
			if (lowerText === "status" || lowerText === "help") {
				await handleDirectCommand(config, lowerText, from);
				continue;
			}

			// Write to message_ledger for A2A routing
			try {
				// Parse @mentions: "@claude/one do something" → target = "claude/one"
				const mentionMatch = text.match(/^@(\S+)\s+(.*)$/s);
				const target = mentionMatch ? mentionMatch[1] : undefined;
				const content = mentionMatch ? mentionMatch[2].trim() : text;

				await query(
					`INSERT INTO roadmap.message_ledger
					    (from_agent, to_agent, channel, message_content, message_type, created_at)
					  VALUES ($1, $2, 'discord', $3, 'task', now())`,
					[from, target ?? null, content],
				);

				console.log(`[discord-bridge] Inbound: ${from} → ${target ?? "broadcast"}: ${content.slice(0, 80)}`);
			} catch (err) {
				console.error(
					`[discord-bridge] Failed to write to message_ledger: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	} catch (err) {
		console.error(
			`[discord-bridge] Inbound poll error: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

async function handleDirectCommand(
	config: BridgeConfig,
	command: string,
	from: string,
): Promise<void> {
	if (command === "help") {
		const helpText = [
			"**AgentHive Discord Bridge**",
			"Send commands by typing in this channel:",
			"- `@claude/one <task>` — Assign a task to claude/one",
			"- `@claude/andy <task>` — Assign a task to claude/andy",
			"- `status` — Show pipeline status",
			"- `help` — Show this message",
		].join("\n");
		await sendToDiscord(config, helpText);
		return;
	}

	if (command === "status") {
		try {
			const { rows } = await query<{
				status: string;
				count: string;
			}>(
				`SELECT status, COUNT(*)::text as count
				   FROM roadmap.proposal
				  GROUP BY status
				  ORDER BY status`,
			);

			const lines = ["**Pipeline Status**"];
			for (const row of rows) {
				lines.push(`- ${row.status}: ${row.count}`);
			}

			await sendToDiscord(config, lines.join("\n"));
		} catch (err) {
			await sendToDiscord(
				config,
				`❌ Failed to query status: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	console.log("[discord-bridge] Starting...");

	const config = loadConfig();

	// Start outbound listener (pg_notify → Discord)
	await startOutboundListener(config);

	// Start inbound poller (Discord → message_ledger)
	const pollMs = config.pollIntervalMs ?? 30_000;
	const pollTimer = setInterval(() => {
		void pollInbound(config);
	}, pollMs);

	// Run initial poll
	void pollInbound(config);

	console.log(
		`[discord-bridge] Running. Channel: ${config.channelId}, Poll: ${pollMs}ms`,
	);

	// Graceful shutdown
	const shutdown = async (signal: string): Promise<void> => {
		console.log(`[discord-bridge] Received ${signal}, shutting down...`);
		clearInterval(pollTimer);
		process.exit(0);
	};

	process.on("SIGINT", () => {
		void shutdown("SIGINT");
	});
	process.on("SIGTERM", () => {
		void shutdown("SIGTERM");
	});
}

main().catch((err) => {
	console.error(`[discord-bridge] Fatal: ${err}`);
	process.exit(1);
});
