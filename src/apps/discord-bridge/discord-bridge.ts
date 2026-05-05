/**
 * DiscordBridgeService — bridges AgentHive A2A messages to Discord.
 *
 * Maintains a Discord Gateway WebSocket (heartbeat every 45s) and subscribes
 * to the pg_notify `new_message` channel. Eligible messages (broadcast, team:*)
 * are formatted as Discord embeds and posted via the REST API.
 *
 * AC-1: DiscordBridgeService class with start()
 * AC-2: WebSocket Gateway + 45s heartbeat
 * AC-5: A2A broadcast → Discord embed relay
 * AC-7: Failed messages queued and retried
 */

import WebSocket from "ws";
import { getPool, query } from "../../infra/postgres/pool.ts";
import { DiscordRateLimiter } from "./rate-limiter.ts";
import {
	formatMessageEmbed,
	type AgentiveMessage,
	type DiscordEmbed,
} from "./message-formatter.ts";
import { HealthChecker } from "./health-check.ts";

const DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const HEARTBEAT_INTERVAL_MS = 45_000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5_000;

interface MessageAck {
	msg: AgentiveMessage;
	retries: number;
}

export class DiscordBridgeService {
	private ws: WebSocket | null = null;
	private messageQueue: Map<string, MessageAck> = new Map();
	private rateLimiter = new DiscordRateLimiter();
	readonly healthChecker = new HealthChecker();
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private retryTimer: ReturnType<typeof setInterval> | null = null;
	private listenerClient: any = null;
	private running = false;

	constructor(private readonly token: string) {}

	async start(): Promise<void> {
		this.running = true;
		this.connectGateway();
		await this.subscribeToA2AMessages();
		this.startRetryLoop();
	}

	// ─── Discord Gateway ─────────────────────────────────────────────────────

	private connectGateway(): void {
		this.ws = new WebSocket(DISCORD_GATEWAY_URL);

		this.ws.on("open", () => {
			this.healthChecker.setConnectionState(true);
			console.log("[discord-bridge] Connected to Discord Gateway");
		});

		this.ws.on("message", (data: Buffer) => {
			this.handleGatewayMessage(data.toString());
		});

		this.ws.on("close", () => {
			this.healthChecker.setConnectionState(false);
			if (this.heartbeatTimer) {
				clearInterval(this.heartbeatTimer);
				this.heartbeatTimer = null;
			}
			if (this.running) {
				console.log(
					"[discord-bridge] Gateway disconnected — reconnecting in 5s",
				);
				setTimeout(() => this.connectGateway(), 5_000);
			}
		});

		this.ws.on("error", (err: Error) => {
			console.error("[discord-bridge] WebSocket error:", err.message);
		});
	}

	private handleGatewayMessage(raw: string): void {
		let payload: { op: number; d: any; s?: number };
		try {
			payload = JSON.parse(raw);
		} catch {
			return;
		}

		switch (payload.op) {
			case 10: // HELLO — start heartbeat + identify
				this.setupHeartbeat(
					payload.d?.heartbeat_interval ?? HEARTBEAT_INTERVAL_MS,
				);
				this.identify();
				break;
			case 11: // HEARTBEAT ACK
				this.healthChecker.recordHeartbeat();
				break;
			case 1: // Server-requested heartbeat
				this.sendHeartbeat(payload.s ?? null);
				break;
		}
	}

	private setupHeartbeat(intervalMs: number): void {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		// Discord requires a jittered first beat
		const jitter = Math.floor(Math.random() * intervalMs);
		setTimeout(() => {
			this.sendHeartbeat(null);
			this.heartbeatTimer = setInterval(
				() => this.sendHeartbeat(null),
				intervalMs,
			);
		}, jitter);
	}

	private sendHeartbeat(seq: number | null): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify({ op: 1, d: seq }));
		}
	}

	private identify(): void {
		if (this.ws?.readyState !== WebSocket.OPEN) return;
		this.ws.send(
			JSON.stringify({
				op: 2,
				d: {
					token: this.token,
					intents: 0,
					properties: {
						os: "linux",
						browser: "agenthive-discord-bridge",
						device: "agenthive-discord-bridge",
					},
				},
			}),
		);
	}

	// ─── A2A Subscription (pg_notify) ────────────────────────────────────────

	private async subscribeToA2AMessages(): Promise<void> {
		const pool = getPool();
		this.listenerClient = await pool.connect();
		await this.listenerClient.query("LISTEN new_message");

		this.listenerClient.on("notification", (msg: any) => {
			if (msg.channel === "new_message") {
				void this.handleNewMessageNotification(msg.payload as string);
			}
		});

		console.log("[discord-bridge] Subscribed to A2A new_message notifications");
	}

	private async handleNewMessageNotification(payload: string): Promise<void> {
		let notification: { message_id: number; channel: string };
		try {
			notification = JSON.parse(payload);
		} catch {
			return;
		}

		const ch = notification.channel ?? "";
		if (ch !== "broadcast" && !ch.startsWith("team:")) return;

		try {
			const { rows } = await query<AgentiveMessage>(
				`SELECT id::text AS id,
				        channel,
				        from_agent,
				        to_agent,
				        message_content,
				        message_type,
				        proposal_id::text AS proposal_id,
				        created_at
				 FROM message_ledger
				 WHERE id = $1`,
				[notification.message_id],
			);
			if (rows[0]) await this.relayMessage(rows[0]);
		} catch (err) {
			console.error("[discord-bridge] Failed to fetch/relay message:", err);
		}
	}

	// ─── Message Relay ────────────────────────────────────────────────────────

	async relayMessage(msg: AgentiveMessage): Promise<void> {
		const mapping = await this.getDiscordChannel(msg.channel);
		if (!mapping) {
			console.warn(
				`[discord-bridge] No Discord mapping for channel '${msg.channel}'`,
			);
			return;
		}

		if (!this.rateLimiter.allow(mapping.discord_channel_id)) {
			this.messageQueue.set(String(msg.id), { msg, retries: 0 });
			this.healthChecker.setQueueLength(this.messageQueue.size);
			return;
		}

		const embed = formatMessageEmbed(msg);
		await this.trySend(String(msg.id), mapping.discord_channel_id, embed);
	}

	private async trySend(
		agentiveMsgId: string,
		discordChannelId: string,
		embed: DiscordEmbed,
	): Promise<void> {
		try {
			const sent = await this.sendToDiscord(discordChannelId, embed);
			await this.recordAck(agentiveMsgId, sent.id, discordChannelId, "sent");
		} catch (err) {
			await this.recordAck(
				agentiveMsgId,
				null,
				discordChannelId,
				"failed",
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	private async getDiscordChannel(
		agentiveChannel: string,
	): Promise<{ discord_channel_id: string } | null> {
		try {
			const { rows } = await query<{ discord_channel_id: string }>(
				`SELECT discord_channel_id
				 FROM roadmap.discord_channel_mapping
				 WHERE agentive_channel = $1 AND enabled = true`,
				[agentiveChannel],
			);
			return rows[0] ?? null;
		} catch {
			return null;
		}
	}

	private async sendToDiscord(
		channelId: string,
		embed: DiscordEmbed,
	): Promise<{ id: string }> {
		const res = await fetch(
			`https://discord.com/api/v10/channels/${channelId}/messages`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bot ${this.token}`,
					"User-Agent":
						"AgentHive Discord Bridge (https://github.com/agenthive, 1.0)",
				},
				body: JSON.stringify({ embeds: [embed] }),
			},
		);

		if (!res.ok) {
			const text = await res.text();
			throw new Error(`Discord API ${res.status}: ${text}`);
		}

		return res.json() as Promise<{ id: string }>;
	}

	private async recordAck(
		agentiveMsgId: string,
		discordMsgId: string | null,
		discordChannelId: string,
		status: "sent" | "failed" | "retrying",
		errorReason?: string,
	): Promise<void> {
		try {
			await query(
				`INSERT INTO roadmap.discord_message_ack
				   (agentive_msg_id, discord_msg_id, discord_channel_id, status, error_reason, acked_at)
				 VALUES ($1, $2, $3, $4, $5, $6)
				 ON CONFLICT (agentive_msg_id) DO UPDATE SET
				   discord_msg_id     = EXCLUDED.discord_msg_id,
				   discord_channel_id = EXCLUDED.discord_channel_id,
				   status             = EXCLUDED.status,
				   attempt_count      = roadmap.discord_message_ack.attempt_count + 1,
				   last_attempt_at    = now(),
				   error_reason       = EXCLUDED.error_reason,
				   acked_at           = EXCLUDED.acked_at`,
				[
					agentiveMsgId,
					discordMsgId,
					discordChannelId,
					status,
					errorReason ?? null,
					status === "sent" ? new Date() : null,
				],
			);
		} catch (err) {
			console.error("[discord-bridge] Failed to record ACK:", err);
		}
	}

	// ─── Retry Loop (AC-7) ───────────────────────────────────────────────────

	private startRetryLoop(): void {
		this.retryTimer = setInterval(async () => {
			if (this.messageQueue.size === 0) return;

			for (const [msgId, ack] of this.messageQueue) {
				const mapping = await this.getDiscordChannel(ack.msg.channel);
				if (!mapping) {
					this.messageQueue.delete(msgId);
					continue;
				}

				if (!this.rateLimiter.allow(mapping.discord_channel_id)) continue;

				if (ack.retries >= MAX_RETRIES) {
					await this.recordAck(
						msgId,
						null,
						mapping.discord_channel_id,
						"failed",
						"Max retries exceeded",
					);
					this.messageQueue.delete(msgId);
					continue;
				}

				const embed = formatMessageEmbed(ack.msg);
				try {
					const sent = await this.sendToDiscord(
						mapping.discord_channel_id,
						embed,
					);
					await this.recordAck(
						msgId,
						sent.id,
						mapping.discord_channel_id,
						"sent",
					);
					this.messageQueue.delete(msgId);
				} catch (err) {
					ack.retries++;
					await this.recordAck(
						msgId,
						null,
						mapping.discord_channel_id,
						"retrying",
						err instanceof Error ? err.message : String(err),
					);
				}
			}

			this.healthChecker.setQueueLength(this.messageQueue.size);
		}, RETRY_DELAY_MS);
	}

	// ─── Lifecycle ───────────────────────────────────────────────────────────

	async stop(): Promise<void> {
		this.running = false;

		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = null;
		}
		if (this.retryTimer) {
			clearInterval(this.retryTimer);
			this.retryTimer = null;
		}
		if (this.listenerClient) {
			try {
				await this.listenerClient.query("UNLISTEN new_message");
			} catch {
				// ignore
			}
			this.listenerClient.release();
			this.listenerClient = null as any;
		}
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
	}
}
