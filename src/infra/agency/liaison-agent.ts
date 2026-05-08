/**
 * Liaison Agent — A2A inbox/reply loop shared across provider agencies.
 *
 * What it does (in-process, alongside whatever else the agency runs):
 *   1. Ensures roadmap_workforce.agent_registry has a row for this identity
 *      (FK anchor for message_ledger.from_agent / to_agent).
 *   2. Opens a dedicated pg client (NOT pooled) and LISTENs on
 *      agentNotifyChannel(identity), which is the same `a2a_msg_<raw>`
 *      channel the trigger emits on (P888 migration 119). A pooled connection
 *      would carry LISTEN state back into the pool when released, causing
 *      stray notifications on whichever caller borrows it next; we own a
 *      dedicated client and end() it on stop().
 *   3. On each notification, fetches the row and either:
 *        - protocol_ping → protocol_pong fast-path (no LLM, P856), or
 *        - invokes the per-provider LLM handler via CliInvocationRegistry to compose a text reply.
 *   4. Writes replies directly to roadmap.message_ledger with correlation_id
 *      copied from the original and reply_to = original.id, then marks the
 *      original read and resolves any pending timeout-tracking row. This
 *      mirrors handleMsgReply in msg-reply.ts and intentionally does NOT
 *      route through PgMessagingHandlers.sendMessage (which would strip
 *      correlation_id + reply_to and apply an ACL check that would deny most
 *      agency↔agent replies).
 *
 * The DB INSERT trigger (fn_a2a_message_notify) emits pg_notify on
 * a2a_msg_<recipient> automatically; this module does not call pg_notify
 * itself.
 *
 * P920: Refactored to use CliInvocationRegistry instead of inline
 * resolveLiaisonHandler switches.
 */
import { Client } from "pg";
import { query, getPool } from "../postgres/pool.ts";
import { agentNotifyChannel } from "../messaging/a2a-access-control.ts";
import {
	globalCliInvocationRegistry,
	invokeCliHandler,
	CliInvocationRegistry,
	type CliInvocationHandler,
} from "../../core/runtime/cli-invocation.ts";

export interface IncomingMessage {
	id: number;
	from_agent: string;
	to_agent: string;
	message_content: string;
	message_type: string;
	correlation_id: string | null;
}

export type LlmInvoke = (msg: IncomingMessage) => Promise<string>;

export interface LiaisonAgentOptions {
	identity: string;
	provider: string;
	loggerPrefix?: string;
	/** Override for tests; defaults to a fresh `pg.Client()` reading PG* env. */
	createListenClient?: () => Promise<Client>;
	/** Override for tests; defaults to globalCliInvocationRegistry. */
	registry?: CliInvocationRegistry;
}

export interface LiaisonAgentHandle {
	stop: () => Promise<void>;
}

interface NotifyPayload {
	message_id: number;
	correlation_id?: string;
	from_agent?: string;
}

export function spawnCliCapture(bin: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, {
			env: { ...process.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (d: Buffer) => {
			out += d.toString();
		});
		child.stderr.on("data", (d: Buffer) => {
			err += d.toString();
		});
		child.on("close", (code) => {
			if (code === 0) resolve(out.trim());
			else reject(new Error(`${bin} exited ${code}: ${err.slice(0, 300)}`));
		});
		child.on("error", reject);
	});
}

export async function runLiaisonAgent(
	opts: LiaisonAgentOptions,
): Promise<LiaisonAgentHandle> {
	const { identity, provider } = opts;
	const log = opts.loggerPrefix ?? `[Liaison ${identity}]`;
	const registry = opts.registry ?? globalCliInvocationRegistry;

	// Resolve the CLI handler for this provider
	const handler = await registry.resolve(provider);
	if (!handler) {
		throw new Error(
			`[Liaison] No CLI handler found for provider "${provider}" — check model_routes config`,
		);
	}

	// Validates the identity (charset + 63-byte channel limit) and returns
	// the same channel the DB trigger emits on. Throws on invalid identity
	// rather than silently producing a channel name no one will hear.
	const channel = agentNotifyChannel(identity);

	await query(
		`INSERT INTO roadmap_workforce.agent_registry
		    (agent_identity, agent_type, trust_tier, status)
		 VALUES ($1, 'agency', 'authority', 'active')
		 ON CONFLICT (agent_identity) DO UPDATE SET status = 'active'`,
		[identity],
	);

	const listenClient = opts.createListenClient
		? await opts.createListenClient()
		: await connectListenClient();
	await listenClient.query(`LISTEN "${channel}"`);
	console.log(`${log} LISTEN active on: ${channel}`);

	async function fetchMessage(messageId: number) {
		const { rows } = await query(
			`SELECT id, from_agent, to_agent, message_content, message_type,
			        correlation_id, read_at
			   FROM roadmap.message_ledger
			  WHERE id = $1`,
			[messageId],
		);
		return rows[0] ?? null;
	}

	async function handle(payload: NotifyPayload) {
		const msg = await fetchMessage(payload.message_id);
		if (!msg) {
			console.warn(`${log} Message ${payload.message_id} not found`);
			return;
		}
		if (msg.from_agent === identity) return;
		if (msg.read_at) return;

		console.log(
			`${log} RECV [${msg.message_type}] id=${msg.id}` +
				` from=${msg.from_agent} corr=${msg.correlation_id ?? "none"}`,
		);

		// P856: protocol_ping fast-path. Reply 'protocol_pong' synchronously
		// with reply_to + correlation_id matched. Skip LLM entirely.
		if (msg.message_type === "protocol_ping") {
			try {
				await insertReply({
					fromAgent: identity,
					toAgent: msg.from_agent,
					content: "pong",
					messageType: "protocol_pong",
					correlationId: msg.correlation_id ?? null,
					replyTo: msg.id,
				});
				await markReadAndResolveTimeout(msg.id);
				console.log(`${log} PONG → ${msg.from_agent} (reply_to=${msg.id})`);
			} catch (err) {
				console.warn(`${log} protocol_pong INSERT failed:`, err);
			}
			return;
		}

		let replyContent: string;
		try {
			const systemContext =
				`You are ${identity}, a ${handler.brand} liaison agent in the AgentHive system. ` +
				`You received a ${msg.message_type} message from ${msg.from_agent}. ` +
				`Reply concisely. If it's a task, acknowledge and outline your approach in 2-3 sentences.`;
			const prompt = `${systemContext}\n\n---\nIncoming message:\n${msg.message_content}`;

			replyContent = await invokeCliHandler(handler, prompt, {
				timeoutMs: 30000,
			});
		} catch (err) {
			console.error(`${log} LLM handler failed:`, err);
			replyContent = `[${identity}] Unable to process message ${msg.id} — handler failed.`;
		}

		try {
			const replyId = await insertReply({
				fromAgent: identity,
				toAgent: msg.from_agent,
				content: replyContent,
				messageType: "text",
				correlationId: msg.correlation_id ?? null,
				replyTo: msg.id,
			});
			await markReadAndResolveTimeout(msg.id);
			console.log(`${log} SENT reply id=${replyId} → ${msg.from_agent}`);
		} catch (err) {
			console.error(`${log} reply INSERT failed:`, err);
		}
	}

	listenClient.on("notification", (n) => {
		if (n.channel !== channel || !n.payload) return;
		let parsed: NotifyPayload;
		try {
			parsed = JSON.parse(n.payload);
		} catch {
			console.warn(`${log} Bad notify payload:`, n.payload);
			return;
		}
		handle(parsed).catch((err) => console.error(`${log} Handler error:`, err));
	});

	listenClient.on("error", (err) => {
		console.error(`${log} LISTEN client error:`, err);
	});

	return {
		stop: async () => {
			try {
				await listenClient.query(`UNLISTEN "${channel}"`);
			} catch {
				/* socket may already be closed */
			}
			listenClient.removeAllListeners("notification");
			listenClient.removeAllListeners("error");
			try {
				await listenClient.end();
			} catch {
				/* ignore */
			}
		},
	};
}

/**
 * Direct INSERT into message_ledger, mirroring handleMsgReply semantics:
 * carries correlation_id + reply_to so threads stay intact and the
 * trigger emits pg_notify on the recipient's channel automatically.
 *
 * Intentionally skips PgMessagingHandlers.sendMessage:
 *   - sendMessage doesn't accept correlation_id (P907 AC3 finding)
 *   - sendMessage applies ACL — agency↔agent replies in-thread should not
 *     require an explicit DM grant from the agency to every agent that
 *     ever messaged it. Same rationale used by handleMsgReply.
 */
async function insertReply(args: {
	fromAgent: string;
	toAgent: string;
	content: string;
	messageType: string;
	correlationId: string | null;
	replyTo: number;
}): Promise<number> {
	const { rows } = await query(
		`INSERT INTO roadmap.message_ledger
		    (from_agent, to_agent, message_type, message_content,
		     correlation_id, reply_to)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING id`,
		[
			args.fromAgent,
			args.toAgent,
			args.messageType,
			args.content,
			args.correlationId,
			args.replyTo,
		],
	);
	return rows[0].id as number;
}

async function markReadAndResolveTimeout(messageId: number): Promise<void> {
	await query(
		`UPDATE roadmap.message_ledger
		    SET read_at = now()
		  WHERE id = $1 AND read_at IS NULL`,
		[messageId],
	);
	// Cancel any pending timeout escalation for the same message.
	await query(
		`UPDATE roadmap.message_timeout_tracking
		    SET resolved_at = now()
		  WHERE message_id = $1 AND resolved_at IS NULL`,
		[messageId],
	);
}

async function connectListenClient(): Promise<Client> {
	// P844: getPool() handles password resolution and search_path.
	// We use a dedicated client from the pool for LISTEN.
	const client = await getPool().connect();
	return client as unknown as Client;
}
