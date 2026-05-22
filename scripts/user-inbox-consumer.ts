/**
 * User Inbox Consumer (P1120) — LISTEN on a2a_msg_user/<operator>, mark
 * read_at on consume, and forward to state_feed_user_inbox for downstream
 * display surfaces (TUI live-feed, Discord bridge).
 *
 * Channel: msg_user/<operator>  (P1103 unified `msg_` prefix)
 * Operator: INBOX_OPERATOR env var, defaults to "gary"
 *
 * Boot-drain: on startup, fetches all messages to_agent='user/<operator>'
 * with read_at IS NULL and created_at > now() - 24h, marks them read, and
 * forwards them to state_feed_user_inbox.
 *
 * LISTEN must bypass PgBouncer (transaction-pool mode silently drops
 * notifications). Use PGPORT_DIRECT (direct PG port, default 5432).
 * All other queries (drain SELECT, mark-read UPDATE, pg_notify) go through
 * the pooled query() helper.
 */
import { existsSync, readFileSync } from "node:fs";
import { Client } from "pg";
import { query, setPoolLifecycleMode } from "../src/infra/postgres/pool.ts";
import { agentNotifyChannel } from "../src/infra/messaging/a2a-access-control.ts";

setPoolLifecycleMode("long-running");

const OPERATOR = process.env.INBOX_OPERATOR ?? "gary";
const IDENTITY = `user/${OPERATOR}`;
const DRAIN_WINDOW_HOURS = 24;
const LOG = `[user-inbox/${OPERATOR}]`;

// ─── Auth helpers ─────────────────────────────────────────────────────────────

function getPGPassword(): string | undefined {
	for (const pw of [process.env.PGPASSWORD, process.env.PG_PASSWORD]) {
		if (pw) return pw;
	}
	const envPaths = [
		(process.env.HOME ?? "") + "/.hermes/.env",
		"/data/code/AgentHive/.env",
	];
	for (const envPath of envPaths) {
		if (!envPath || !existsSync(envPath)) continue;
		for (const line of readFileSync(envPath, "utf-8").split("\n")) {
			const m = /^\s*(?:PGPASSWORD|PG_PASSWORD)\s*=\s*(.+)/.exec(line);
			if (m) return m[1].trim();
		}
	}
	return undefined;
}

// ─── Mark read + resolve timeout ─────────────────────────────────────────────

async function markReadAndResolveTimeout(messageId: number): Promise<void> {
	await query(
		`UPDATE roadmap.message_ledger
		    SET read_at = now()
		  WHERE id = $1 AND read_at IS NULL`,
		[messageId],
	);
	await query(
		`UPDATE roadmap.message_timeout_tracking
		    SET resolved_at = now()
		  WHERE message_id = $1 AND resolved_at IS NULL`,
		[messageId],
	);
}

// ─── Forward to downstream surfaces ─────────────────────────────────────────

type MessageRow = {
	id: number;
	from_agent: string;
	to_agent: string;
	message_type: string;
	message_content: string | null;
	correlation_id: string | null;
	metadata: Record<string, unknown>;
	created_at: Date;
	read_at?: Date | null;
};

async function forward(msg: MessageRow): Promise<void> {
	const payload = JSON.stringify({
		id: msg.id,
		from_agent: msg.from_agent,
		to_agent: msg.to_agent,
		message_type: msg.message_type,
		message_content: msg.message_content,
		correlation_id: msg.correlation_id,
		metadata: msg.metadata,
		created_at: msg.created_at,
	});

	// State-feed / TUI live-feed: downstream subscribers LISTEN on this channel.
	try {
		await query(`SELECT pg_notify('state_feed_user_inbox', $1)`, [payload]);
	} catch (err) {
		console.warn(`${LOG} pg_notify state_feed_user_inbox failed:`, err);
	}

	// Discord: optional webhook if DISCORD_WEBHOOK_INBOX is configured.
	const webhookUrl = process.env.DISCORD_WEBHOOK_INBOX;
	if (webhookUrl) {
		const content =
			`**[inbox/${OPERATOR}]** \`${msg.message_type}\` from \`${msg.from_agent}\`` +
			(msg.message_content ? `\n> ${msg.message_content.slice(0, 400)}` : "");
		try {
			await fetch(webhookUrl, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content }),
			});
		} catch (err) {
			console.warn(`${LOG} Discord webhook forward failed:`, err);
		}
	}
}

// ─── Boot drain ──────────────────────────────────────────────────────────────

async function bootDrain(): Promise<void> {
	console.log(`${LOG} Boot drain: scanning last ${DRAIN_WINDOW_HOURS}h for unread messages…`);
	const { rows } = await query<MessageRow>(
		`SELECT id, from_agent, to_agent, message_type, message_content,
		        correlation_id, COALESCE(metadata, '{}'::jsonb) AS metadata, created_at
		   FROM roadmap.message_ledger
		  WHERE to_agent = $1
		    AND read_at IS NULL
		    AND created_at > now() - make_interval(hours => $2)
		  ORDER BY id ASC`,
		[IDENTITY, DRAIN_WINDOW_HOURS],
	);

	if (rows.length === 0) {
		console.log(`${LOG} Boot drain: no unread messages.`);
		return;
	}

	console.log(`${LOG} Boot drain: processing ${rows.length} unread message(s)…`);
	for (const msg of rows) {
		try {
			await markReadAndResolveTimeout(msg.id);
			await forward(msg);
			console.log(
				`${LOG} drained id=${msg.id} type=${msg.message_type} from=${msg.from_agent}`,
			);
		} catch (err) {
			console.error(`${LOG} drain failed for id=${msg.id}:`, err);
		}
	}
	console.log(`${LOG} Boot drain complete.`);
}

// ─── Notification handler ─────────────────────────────────────────────────────

type NotifyPayload = { message_id: number };

async function handleNotify(payload: string): Promise<void> {
	let parsed: NotifyPayload;
	try {
		parsed = JSON.parse(payload) as NotifyPayload;
	} catch {
		console.warn(`${LOG} Bad notify payload:`, payload);
		return;
	}

	const messageId = parsed.message_id;
	if (!messageId || !Number.isFinite(messageId)) {
		console.warn(`${LOG} Missing/invalid message_id in payload:`, payload);
		return;
	}

	const { rows } = await query<MessageRow>(
		`SELECT id, from_agent, to_agent, message_type, message_content,
		        correlation_id, COALESCE(metadata, '{}'::jsonb) AS metadata, created_at
		   FROM roadmap.message_ledger
		  WHERE id = $1`,
		[messageId],
	);

	const msg = rows[0];
	if (!msg) {
		console.warn(`${LOG} Message ${messageId} not found`);
		return;
	}
	if (msg.read_at !== undefined && msg.read_at !== null) {
		// Already read (race with drain or duplicate notify)
		return;
	}

	console.log(
		`${LOG} RECV id=${msg.id} type=${msg.message_type} from=${msg.from_agent}`,
	);

	await markReadAndResolveTimeout(msg.id);
	await forward(msg);
}

// ─── listener_subscription management ───────────────────────────────────────

async function recordSubscription(
	channel: string,
	pid: number | undefined,
): Promise<void> {
	try {
		await query(
			`INSERT INTO roadmap.listener_subscription
			    (agent_identity, channel, established_at, established_pid)
			 VALUES ($1, $2, now(), $3)
			 ON CONFLICT (agent_identity, channel) DO UPDATE SET
			   established_at = now(),
			   established_pid = EXCLUDED.established_pid`,
			[IDENTITY, channel, pid ?? null],
		);
		console.log(`${LOG} listener_subscription recorded pid=${pid} channel=${channel}`);
	} catch (err) {
		// Non-fatal: watchdog will detect and reconcile
		console.warn(`${LOG} Failed to record listener_subscription:`, err);
	}
}

async function deleteSubscription(channel: string): Promise<void> {
	try {
		await query(
			`DELETE FROM roadmap.listener_subscription
			  WHERE agent_identity = $1 AND channel = $2`,
			[IDENTITY, channel],
		);
		console.log(`${LOG} listener_subscription cleaned up`);
	} catch (err) {
		console.warn(`${LOG} Failed to delete listener_subscription:`, err);
	}
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
	const channel = agentNotifyChannel(IDENTITY);
	const pgPassword = getPGPassword();

	// Ensure user/gary exists in agent_registry (idempotent; migration 161 also seeds it).
	await query(
		`INSERT INTO roadmap_workforce.agent_registry
		    (agent_identity, agent_type, trust_tier, status)
		 VALUES ($1, 'human', 'authority', 'active')
		 ON CONFLICT (agent_identity) DO UPDATE SET status = 'active'`,
		[IDENTITY],
	);

	// Dedicated LISTEN client — must bypass PgBouncer.
	const listenClient = new Client({
		host: process.env.PGHOST ?? process.env.PG_HOST ?? "127.0.0.1",
		port: Number(
			process.env.PGPORT_DIRECT ??
				process.env.PGPORT ??
				process.env.PG_PORT ??
				"5432",
		),
		user: process.env.PGUSER ?? process.env.PG_USER,
		password: pgPassword,
		database: process.env.PGDATABASE ?? process.env.PG_DATABASE ?? "agenthive",
		application_name: `agenthive-user-inbox-${OPERATOR}`,
	});

	await listenClient.connect();
	console.log(`${LOG} Connected to Postgres (PGPORT_DIRECT path)`);

	await listenClient.query(`LISTEN "${channel}"`);
	console.log(`${LOG} LISTEN active on: ${channel}`);

	await recordSubscription(channel, listenClient.processID);

	// Drain unread messages that arrived while consumer was offline.
	await bootDrain();

	listenClient.on("notification", (n) => {
		if (n.channel !== channel || !n.payload) return;
		handleNotify(n.payload).catch((err) =>
			console.error(`${LOG} handleNotify error:`, err),
		);
	});

	listenClient.on("error", (err) => {
		console.error(`${LOG} PG listen client error:`, err);
		// Reconnect after a brief pause.
		setTimeout(() => main().catch(console.error), 5000);
	});

	const shutdown = async (signal: string) => {
		console.log(`${LOG} ${signal} received — shutting down`);
		try {
			await listenClient.query(`UNLISTEN "${channel}"`);
		} catch {
			/* socket may already be closing */
		}
		await deleteSubscription(channel);
		listenClient.removeAllListeners();
		try {
			await listenClient.end();
		} catch {
			/* ignore */
		}
		process.exit(0);
	};

	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));

	console.log(`${LOG} Ready — consuming inbox for ${IDENTITY}`);
}

main().catch((err) => {
	console.error(`${LOG} Fatal:`, err);
	process.exit(1);
});
