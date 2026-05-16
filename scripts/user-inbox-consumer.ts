#!/usr/bin/env bun
/**
 * P1120: User Inbox Consumer
 *
 * Surfaces messages addressed to user/<operator> so the operator's inbox is no longer lossy.
 *
 * - Reads OPERATOR_IDENTITY env var (default: user/gary)
 * - Connects to PG via PGPORT_DIRECT (bypass PgBouncer for LISTEN)
 * - Registers listener_subscription entry
 * - Boot-drains unread messages from last 24h
 * - LISTENs on a2a_msg_user/<operator> for live notifications
 * - Marks read + forwards to state_feed_user_inbox
 * - Cleans up listener_subscription on SIGTERM
 */

import { Client } from "pg";
import { query } from "../src/infra/postgres/pool.ts";

interface Message {
	id: number;
	from_agent: string;
	to_agent: string;
	message_type: string;
	message_content: string;
	created_at: string;
	metadata: Record<string, unknown>;
}

const OPERATOR_IDENTITY = process.env.OPERATOR_IDENTITY ?? "user/gary";
const LISTEN_CHANNEL = `a2a_msg_${OPERATOR_IDENTITY}`;
const FORWARD_CHANNEL = "state_feed_user_inbox";

let listenClient: Client | null = null;

/**
 * Connect directly to PG, bypassing PgBouncer
 */
async function connectListenClient(): Promise<Client> {
	const databaseUrl = process.env.DATABASE_URL
		? new URL(process.env.DATABASE_URL)
		: null;
	const client = new Client({
		host: process.env.PGHOST ?? databaseUrl?.hostname ?? "127.0.0.1",
		port: Number(
			process.env.PGPORT_DIRECT ?? databaseUrl?.port ?? process.env.PGPORT ?? 5432
		),
		user: process.env.PGUSER ?? databaseUrl?.username,
		password: process.env.PGPASSWORD ?? databaseUrl?.password,
		database:
			process.env.PGDATABASE ??
			databaseUrl?.pathname.replace(/^\/+/, "") ??
			"agenthive",
		application_name: `agenthive-user-inbox-consumer-${OPERATOR_IDENTITY}`,
		options:
			process.env.PG_OPTIONS ??
			"-c search_path=roadmap_proposal,roadmap_workforce,roadmap_efficiency,roadmap,public",
	});
	await client.connect();
	return client;
}

/**
 * Mark a message as read
 */
async function markRead(messageId: number): Promise<void> {
	await query(
		`UPDATE roadmap.message_ledger SET read_at = now() WHERE id = $1 AND read_at IS NULL`,
		[messageId]
	);
}

/**
 * Forward message to state_feed_user_inbox channel
 */
async function forwardToStateFeed(msg: Message): Promise<void> {
	const payload = JSON.stringify({
		message_id: msg.id,
		from_agent: msg.from_agent,
		to_agent: msg.to_agent,
		message_type: msg.message_type,
		message_content: msg.message_content,
		created_at: msg.created_at,
		metadata: msg.metadata,
	});

	// Use the listen client to emit the notification
	// (both clients connected to same DB instance)
	if (!listenClient) {
		console.warn("[WARN] listenClient not available for forwarding, skipping state_feed notify");
		return;
	}

	try {
		await listenClient.query(`SELECT pg_notify($1, $2)`, [FORWARD_CHANNEL, payload]);
	} catch (err) {
		console.warn(`[WARN] Failed to notify state_feed: ${err}`);
	}
}

/**
 * Process a single message: mark read + forward
 */
async function processMessage(messageId: number): Promise<void> {
	try {
		const result = await query<Message>(
			`SELECT id, from_agent, to_agent, message_type, message_content, created_at,
			        COALESCE(metadata, '{}'::jsonb) as metadata
			 FROM roadmap.message_ledger
			 WHERE id = $1`,
			[messageId]
		);

		if (result.rows.length === 0) {
			console.warn(`[WARN] Message ${messageId} not found`);
			return;
		}

		const msg = result.rows[0];
		console.log(
			`[INFO] Processing message ${messageId} from ${msg.from_agent} (${msg.message_type})`
		);

		// Mark as read
		await markRead(messageId);

		// Forward to state_feed
		await forwardToStateFeed(msg);
	} catch (err) {
		console.error(`[ERROR] Failed to process message ${messageId}:`, err);
	}
}

/**
 * Boot drain: fetch all unread messages from last 24h and process
 */
async function bootDrain(): Promise<number> {
	try {
		const result = await query<{ id: number }>(
			`SELECT id FROM roadmap.message_ledger
			 WHERE to_agent = $1
			   AND read_at IS NULL
			   AND created_at > now() - interval '24 hours'
			 ORDER BY id
			 LIMIT 500`,
			[OPERATOR_IDENTITY]
		);

		const count = result.rows.length;
		console.log(`[INFO] Boot drain: found ${count} unread messages`);

		for (const row of result.rows) {
			await processMessage(row.id);
		}

		return count;
	} catch (err) {
		console.error("[ERROR] Boot drain failed:", err);
		return 0;
	}
}

/**
 * Setup listener_subscription entry
 */
async function registerListener(pid: number): Promise<void> {
	try {
		await query(
			`INSERT INTO roadmap.listener_subscription
			    (agent_identity, channel, established_at, established_pid)
			 VALUES ($1, $2, now(), $3)
			 ON CONFLICT (agent_identity, channel) DO UPDATE SET
			   established_at = now(),
			   established_pid = EXCLUDED.established_pid`,
			[OPERATOR_IDENTITY, LISTEN_CHANNEL, pid]
		);
		console.log(`[INFO] listener_subscription registered for ${LISTEN_CHANNEL}`);
	} catch (err) {
		console.warn(`[WARN] Failed to register listener_subscription:`, err);
		// Continue anyway; listening is the primary goal
	}
}

/**
 * Cleanup listener_subscription on exit
 */
async function unregisterListener(): Promise<void> {
	try {
		await query(
			`DELETE FROM roadmap.listener_subscription
			 WHERE agent_identity = $1 AND channel = $2`,
			[OPERATOR_IDENTITY, LISTEN_CHANNEL]
		);
		console.log(`[INFO] listener_subscription cleaned up`);
	} catch (err) {
		console.warn(`[WARN] Failed to clean up listener_subscription:`, err);
	}
}

/**
 * Main consumer loop
 */
async function main(): Promise<void> {
	console.log(`[INFO] Starting user-inbox-consumer for ${OPERATOR_IDENTITY}`);

	// Connect listen client
	listenClient = await connectListenClient();
	const listenPid = listenClient.processID;
	console.log(`[INFO] Connected to PG with PID ${listenPid}`);

	// Register listener
	await registerListener(listenPid);

	// Setup LISTEN
	try {
		await listenClient.query(`LISTEN "${LISTEN_CHANNEL}"`);
		console.log(`[INFO] LISTEN active on ${LISTEN_CHANNEL}`);
	} catch (err) {
		console.error(`[ERROR] Failed to LISTEN on ${LISTEN_CHANNEL}:`, err);
		process.exit(1);
	}

	// Boot drain
	const drainCount = await bootDrain();
	console.log(`[INFO] Boot drain completed: ${drainCount} messages processed`);

	// Setup notification handler
	listenClient.on("notification", async (msg) => {
		if (!msg.payload) {
			console.warn("[WARN] Empty notification payload");
			return;
		}

		try {
			const payload = JSON.parse(msg.payload);
			const messageId = payload.message_id;

			if (!messageId) {
				console.warn(`[WARN] No message_id in notification payload: ${msg.payload}`);
				return;
			}

			console.log(`[INFO] Received notification for message ${messageId}`);
			await processMessage(messageId);
		} catch (err) {
			console.error(`[ERROR] Failed to handle notification:`, err);
		}
	});

	// Setup error handler
	listenClient.on("error", (err) => {
		console.error("[ERROR] Listen client error:", err);
		// Don't exit; reconnect would be handled by process manager
	});

	// Setup signal handlers
	const cleanup = async () => {
		console.log("[INFO] Received SIGTERM, cleaning up...");
		await unregisterListener();
		if (listenClient) {
			try {
				await listenClient.end();
			} catch {
				/* ignore */
			}
		}
		process.exit(0);
	};

	process.on("SIGTERM", cleanup);
	process.on("SIGINT", cleanup);

	console.log("[INFO] Consumer ready. Listening for messages...");
}

main().catch((err) => {
	console.error("[FATAL]", err);
	process.exit(1);
});
