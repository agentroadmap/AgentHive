/**
 * Discord Bridge Service — A2A to Discord gateway relay.
 *
 * Opens a Discord Gateway WebSocket, subscribes to pg_notify new_message,
 * and relays broadcast / team:* A2A messages to mapped Discord channels.
 */

import WebSocket from "ws";
import { getPool } from "../../infra/postgres/pool.ts";
import { DiscordRateLimiter } from "./rate-limiter.ts";
import { formatMessageEmbed, type AgentiveMessage } from "./message-formatter.ts";
import { HealthChecker } from "./health-check.ts";

const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";
const MAX_RETRIES = 3;

interface QueuedMessage {
	msg: AgentiveMessage;
	channelId: string;
	retries: number;
}

interface GatewayPayload {
	op: number;
	d?: { heartbeat_interval?: number } | null;
}

export class DiscordBridgeService {
	private ws: WebSocket | null = null;
	private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
	private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
	private retryInterval: ReturnType<typeof setInterval> | null = null;
	private readonly rateLimiter: DiscordRateLimiter;
	private readonly healthChecker: HealthChecker;
	private messageQueue: QueuedMessage[] = [];
	private readonly channelMappings = new Map<string, string>();
	private readonly botToken: string;

	constructor(botToken: string, healthChecker: HealthChecker) {
		this.botToken = botToken;
		this.rateLimiter = new DiscordRateLimiter();
		this.healthChecker = healthChecker;
	}

	async start(): Promise<void> {
		await this.loadChannelMappings();
		this.connectGateway();
		await this.subscribeToMessages();
		this.startRetryLoop();
	}

	private async loadChannelMappings(): Promise<void> {
		const pool = getPool();
		const result = await pool.query<{
			agentive_channel: string;
			discord_channel_id: string;
		}>(
			`SELECT agentive_channel, discord_channel_id
			 FROM roadmap.discord_channel_mapping
			 WHERE enabled = true`,
		);
		for (const row of result.rows) {
			this.channelMappings.set(row.agentive_channel, row.discord_channel_id);
		}
	}

	private connectGateway(): void {
		this.ws = new WebSocket(DISCORD_GATEWAY);

		this.ws.on("open", () => {
			this.healthChecker.setConnectionState(true);
		});

		this.ws.on("message", (data: WebSocket.RawData) => {
			try {
				const payload = JSON.parse(data.toString()) as GatewayPayload;
				this.handleGatewayPayload(payload);
			} catch (err) {
				console.error("[DiscordBridge] Bad gateway payload:", err);
			}
		});

		this.ws.on("close", () => {
			this.healthChecker.setConnectionState(false);
			this.clearHeartbeat();
		});

		this.ws.on("error", (err: Error) => {
			console.error("[DiscordBridge] WS error:", err.message);
			this.healthChecker.setConnectionState(false);
		});
	}

	private handleGatewayPayload(payload: GatewayPayload): void {
		switch (payload.op) {
			case OP_HELLO: {
				const interval = payload.d?.heartbeat_interval ?? 45_000;
				// Jitter: start heartbeat at a random offset within the interval
				this.heartbeatTimer = setTimeout(() => {
					this.sendHeartbeat();
					this.heartbeatInterval = setInterval(
						() => this.sendHeartbeat(),
						interval,
					);
				}, Math.random() * interval);
				this.identify();
				break;
			}
			case OP_HEARTBEAT_ACK:
				this.healthChecker.recordHeartbeat();
				break;
		}
	}

	private sendHeartbeat(): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify({ op: OP_HEARTBEAT, d: null }));
		}
	}

	private identify(): void {
		if (this.ws?.readyState !== WebSocket.OPEN) return;
		this.ws.send(
			JSON.stringify({
				op: OP_IDENTIFY,
				d: {
					token: this.botToken,
					intents: 0,
					properties: {
						os: "linux",
						browser: "agentive-discord-bridge",
						device: "agentive-discord-bridge",
					},
				},
			}),
		);
	}

	private async subscribeToMessages(): Promise<void> {
		const pool = getPool();
		const pgClient = await pool.connect();
		await pgClient.query("LISTEN new_message");

		pgClient.on(
			"notification",
			async (n: { channel: string; payload?: string }) => {
				if (!n.payload) return;
				try {
					await this.handleNotification(n.payload);
				} catch (err) {
					console.error("[DiscordBridge] Notification error:", err);
				}
			},
		);
	}

	private async handleNotification(payload: string): Promise<void> {
		const data = JSON.parse(payload) as { id?: unknown; msg_id?: unknown };
		const msgId = data.id ?? data.msg_id;
		if (msgId == null) return;

		const pool = getPool();
		const result = await pool.query<AgentiveMessage>(
			`SELECT id, channel, from_agent, to_agent, message_content,
			        message_type, proposal_id, title, created_at
			 FROM roadmap.message_ledger
			 WHERE id = $1`,
			[msgId],
		);
		const msg = result.rows[0];
		if (!msg) return;

		const ch = msg.channel ?? "";
		// P720: Allow broadcast, team:*, and system:proposal-feed channels
		if (ch !== "broadcast" && !ch.startsWith("team:") && ch !== "system:proposal-feed") return;

		const discordChannelId = this.channelMappings.get(ch);
		if (!discordChannelId) return;

		await this.relayMessage(msg, discordChannelId);
	}

	async relayMessage(msg: AgentiveMessage, channelId: string): Promise<void> {
		if (this.rateLimiter.allow(channelId)) {
			await this.sendToDiscord(msg, channelId);
		} else {
			this.messageQueue.push({ msg, channelId, retries: 0 });
			this.healthChecker.setQueueLength(this.messageQueue.length);
		}
	}

	private async sendToDiscord(
		msg: AgentiveMessage,
		channelId: string,
	): Promise<void> {
		const embed = formatMessageEmbed(msg);
		const response = await fetch(
			`${DISCORD_API}/channels/${channelId}/messages`,
			{
				method: "POST",
				headers: {
					Authorization: `Bot ${this.botToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ embeds: [embed] }),
			},
		);

		const pool = getPool();
		if (response.ok) {
			const discordMsg = (await response.json()) as { id: string };
			await pool.query(
				`INSERT INTO roadmap.discord_message_ack
				   (agentive_msg_id, discord_msg_id, discord_channel_id, status, attempt_count, acked_at)
				 VALUES ($1, $2, $3, 'sent', 1, now())
				 ON CONFLICT (agentive_msg_id) DO UPDATE
				   SET discord_msg_id = $2, status = 'sent', acked_at = now()`,
				[String(msg.id), discordMsg.id, channelId],
			);
		} else {
			await pool.query(
				`INSERT INTO roadmap.discord_message_ack
				   (agentive_msg_id, discord_channel_id, status, attempt_count)
				 VALUES ($1, $2, 'failed', 1)
				 ON CONFLICT (agentive_msg_id) DO UPDATE
				   SET status = 'failed',
				       attempt_count = discord_message_ack.attempt_count + 1,
				       last_attempt_at = now()`,
				[String(msg.id), channelId],
			);
		}
	}

	private startRetryLoop(): void {
		this.retryInterval = setInterval(async () => {
			if (this.messageQueue.length === 0) return;
			const remaining: QueuedMessage[] = [];
			for (const item of this.messageQueue) {
				if (this.rateLimiter.allow(item.channelId)) {
					try {
						await this.sendToDiscord(item.msg, item.channelId);
					} catch {
						item.retries++;
						if (item.retries < MAX_RETRIES) remaining.push(item);
					}
				} else {
					item.retries++;
					if (item.retries < MAX_RETRIES) remaining.push(item);
				}
			}
			this.messageQueue = remaining;
			this.healthChecker.setQueueLength(this.messageQueue.length);
		}, 5_000);
	}

	private clearHeartbeat(): void {
		if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
		if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
		this.heartbeatTimer = null;
		this.heartbeatInterval = null;
	}

	getQueueLength(): number {
		return this.messageQueue.length;
	}

	async stop(): Promise<void> {
		this.clearHeartbeat();
		if (this.retryInterval) clearInterval(this.retryInterval);
		this.retryInterval = null;
		this.ws?.close();
		this.ws = null;
		this.healthChecker.setConnectionState(false);
	}
}
