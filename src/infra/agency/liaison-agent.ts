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
 *        - explicit spawn task → claimed squad_dispatch + offer_dispatch bridge, or
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
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { query, getPool } from "../postgres/pool.ts";
import { agentNotifyChannel } from "../messaging/a2a-access-control.ts";
import { sendMessage as sendLiaisonMessage } from "./liaison-message-service.ts";
import { handleTypedTaskRequest, handleWorkerReport, type TaskDispatcherHelpers } from "./task-dispatcher.ts";
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
	proposal_id: number | null;
	project_id: number | null;
	metadata: Record<string, unknown>;
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
		child.on("close", (code: number | null) => {
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

	// Resolve the CLI handler for this provider. Alias to a non-null const so
	// inner closures don't lose the narrowed type via TypeScript's closure widening.
	const resolved = await registry.resolve(provider);
	if (!resolved) {
		throw new Error(
			`[Liaison] No CLI handler found for provider "${provider}" — check model_routes config`,
		);
	}
	const handler: CliInvocationHandler = resolved;

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
			        proposal_id, project_id, COALESCE(metadata, '{}'::jsonb) AS metadata,
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

		// P993: Typed A2A task protocol router
		if (msg.message_type === "task_request") {
			try {
				const helpers: TaskDispatcherHelpers = {
					insertReply,
					markReadAndResolveTimeout,
					bridgeTaskToOfferDispatch,
					monitorTaskDispatch,
				};
				await handleTypedTaskRequest(msg, identity, provider, helpers);
			} catch (err) {
				console.error(`${log} task_request handler failed:`, err);
			}
			return;
		}
		if (
			msg.message_type === "task_status" ||
			msg.message_type === "task_complete" ||
			msg.message_type === "task_error"
		) {
			try {
				const helpers: TaskDispatcherHelpers = {
					insertReply,
					markReadAndResolveTimeout,
					bridgeTaskToOfferDispatch,
					monitorTaskDispatch,
				};
				await handleWorkerReport(msg, identity, helpers);
			} catch (err) {
				console.error(`${log} worker report handler failed:`, err);
			}
			return;
		}

		if (msg.message_type === "task" && shouldBridgeTaskToOffer(msg)) {
			try {
				const result = await bridgeTaskToOfferDispatch({
					msg,
					identity,
					provider,
				});
				await insertReply({
					fromAgent: identity,
					toAgent: msg.from_agent,
					content: `Accepted task ${msg.id}; dispatch ${result.dispatchId} queued for ${identity}.`,
					messageType: "ack",
					correlationId: msg.correlation_id ?? null,
					replyTo: msg.id,
				});
				await markReadAndResolveTimeout(msg.id);
				console.log(
					`${log} TASK_BRIDGE dispatch=${result.dispatchId} → ${identity}`,
				);
				void monitorTaskDispatch({
					identity,
					requestor: msg.from_agent,
					originalMessageId: msg.id,
					correlationId: msg.correlation_id ?? null,
					dispatchId: result.dispatchId,
					pollMs: result.statusPollMs,
					timeoutMs: result.statusTimeoutMs,
					log,
				});
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				console.error(`${log} task bridge failed:`, detail);
				await insertReply({
					fromAgent: identity,
					toAgent: msg.from_agent,
					content: `Unable to execute task ${msg.id}: ${detail}`,
					messageType: "error",
					correlationId: msg.correlation_id ?? null,
					replyTo: msg.id,
				});
				await markReadAndResolveTimeout(msg.id);
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

interface TaskBridgeResult {
	dispatchId: number;
	statusPollMs: number;
	statusTimeoutMs: number;
}

function shouldBridgeTaskToOffer(msg: IncomingMessage): boolean {
	const metadata = msg.metadata ?? {};
	const marker =
		metadata.liaison_task_execution ??
		metadata.spawn_agent ??
		metadata.spawnAgent ??
		metadata.bridge ??
		metadata.action ??
		metadata.task_action ??
		metadata.kind;

	if (marker === true) return true;
	if (typeof marker !== "string") return false;
	return [
		"spawn",
		"spawn_agent",
		"agent_spawn",
		"execute",
		"execute_task",
		"offer_dispatch",
		"liaison_task_execution",
	].includes(marker);
}

export async function bridgeTaskToOfferDispatch(args: {
	msg: IncomingMessage;
	identity: string;
	provider: string;
}): Promise<TaskBridgeResult> {
	const { msg, identity, provider } = args;
	const metadata = msg.metadata ?? {};
	const proposalId = numberFrom(metadata.proposal_id) ?? msg.proposal_id;
	if (!proposalId) {
		throw new Error(
			"task bridge requires proposal_id on message_ledger or metadata",
		);
	}

	const role =
		stringFrom(metadata.role) ??
		stringFrom(metadata.dispatch_role) ??
		stringFrom(metadata.stage) ??
		"developer";
	const squadName =
		stringFrom(metadata.squad_name) ??
		stringFrom(metadata.squadName) ??
		"liaison-task";
	const projectId = numberFrom(metadata.project_id) ?? msg.project_id ?? 1;
	const capabilities = stringArrayFrom(
		metadata.required_capabilities ?? metadata.capabilities,
	);
	const requiredCapabilities = capabilities.length > 0 ? capabilities : [role];
	const leaseTtlSeconds = numberFrom(metadata.lease_ttl_seconds) ?? 60;
	const routeHint = stringFrom(metadata.route_hint) ?? provider;
	const worktreeHint =
		stringFrom(metadata.worktree_hint) ??
		stringFrom(metadata.worktree) ??
		process.env.AGENCY_WORKTREE ??
		process.env.AGENTHIVE_DEFAULT_EXECUTOR_WORKTREE ??
		null;
	const statusPollMs = numberFrom(metadata.status_poll_ms) ?? 10_000;
	const statusTimeoutMs =
		numberFrom(metadata.status_timeout_ms) ?? 2 * 60 * 60_000;

	const offerMetadata = {
		task: msg.message_content,
		source: "message_ledger_task_bridge",
		source_message_id: msg.id,
		source_from_agent: msg.from_agent,
		source_correlation_id: msg.correlation_id,
		route_hint: routeHint,
		required_capabilities: requiredCapabilities,
		worktree_hint: worktreeHint,
	};
	const idempotencyKey = `liaison-task:${msg.id}`;

	const { rows } = await query<{
		id: string | number;
		claim_token: string;
		offer_version: number;
	}>(
		`INSERT INTO roadmap_workforce.squad_dispatch
		    (proposal_id, project_id, squad_name, dispatch_role, dispatch_status,
		     offer_status, agent_identity, agency_identity, required_capabilities,
		     metadata, idempotency_key, dispatch_version, claim_token,
		     claim_expires_at, claimed_at, last_renewed_at)
		 VALUES ($1, $2, $3, $4, 'assigned',
		         'claimed', $5, $5, $6::jsonb,
		         $7::jsonb, $8, 1, gen_random_uuid(),
		         now() + ($9::text || ' seconds')::interval, now(), now())
		 ON CONFLICT (idempotency_key)
		   WHERE dispatch_status IN ('open', 'assigned', 'active')
		 DO UPDATE SET
		   offer_status = 'claimed',
		   agent_identity = EXCLUDED.agent_identity,
		   agency_identity = EXCLUDED.agency_identity,
		   claim_token = COALESCE(roadmap_workforce.squad_dispatch.claim_token, gen_random_uuid()),
		   claim_expires_at = now() + ($9::text || ' seconds')::interval,
		   claimed_at = COALESCE(roadmap_workforce.squad_dispatch.claimed_at, now()),
		   last_renewed_at = now(),
		   metadata = roadmap_workforce.squad_dispatch.metadata || EXCLUDED.metadata
		 RETURNING id, claim_token, offer_version`,
		[
			proposalId,
			projectId,
			squadName,
			role,
			identity,
			JSON.stringify(requiredCapabilities),
			JSON.stringify(offerMetadata),
			idempotencyKey,
			leaseTtlSeconds,
		],
	);

	const row = rows[0];
	if (!row) throw new Error("task bridge failed to create dispatch row");
	const dispatchId = Number(row.id);
	const claimToken = row.claim_token;

	await sendLiaisonMessage({
		agency_id: identity,
		direction: "orchestrator->liaison",
		kind: "offer_dispatch",
		correlation_id: msg.correlation_id ?? randomUUID(),
		payload: {
			offer_id: toOfferUuid(dispatchId),
			role,
			required_capabilities: requiredCapabilities,
			route_hint: routeHint,
			claim_token: claimToken,
			dispatch_id: dispatchId,
			proposal_id: proposalId,
			squad_name: squadName,
			lease_ttl_seconds: leaseTtlSeconds,
			worktree_hint: worktreeHint,
			source_message_id: msg.id,
			source_from_agent: msg.from_agent,
		},
	});

	return {
		dispatchId,
		statusPollMs,
		statusTimeoutMs,
	};
}

export async function monitorTaskDispatch(args: {
	identity: string;
	requestor: string;
	originalMessageId: number;
	correlationId: string | null;
	dispatchId: number;
	pollMs: number;
	timeoutMs: number;
	log: string;
}): Promise<void> {
	const deadline = Date.now() + args.timeoutMs;
	let lastStatus = "";

	while (Date.now() < deadline) {
		const { rows } = await query<{
			offer_status: string;
			dispatch_status: string;
			worker_identity: string | null;
			completed_at: Date | string | null;
		}>(
			`SELECT offer_status, dispatch_status, worker_identity, completed_at
			   FROM roadmap_workforce.squad_dispatch
			  WHERE id = $1`,
			[args.dispatchId],
		);
		const row = rows[0];
		if (!row) {
			await insertReply({
				fromAgent: args.identity,
				toAgent: args.requestor,
				content: `Dispatch ${args.dispatchId} disappeared before completion.`,
				messageType: "error",
				correlationId: args.correlationId,
				replyTo: args.originalMessageId,
			});
			return;
		}

		const statusKey = `${row.offer_status}:${row.dispatch_status}:${row.worker_identity ?? ""}`;
		if (statusKey !== lastStatus) {
			lastStatus = statusKey;
			await insertReply({
				fromAgent: args.identity,
				toAgent: args.requestor,
				content:
					`Dispatch ${args.dispatchId} status: offer=${row.offer_status}, ` +
					`dispatch=${row.dispatch_status}` +
					(row.worker_identity ? `, worker=${row.worker_identity}` : ""),
				messageType: terminalOfferStatus(row.offer_status, row.dispatch_status)
					? row.offer_status === "delivered" ||
						row.dispatch_status === "completed"
						? "task_status"
						: "task_error"
					: "task_status",
				correlationId: args.correlationId,
				replyTo: args.originalMessageId,
			});
		}

		if (terminalOfferStatus(row.offer_status, row.dispatch_status)) return;
		await sleep(Math.max(1_000, args.pollMs));
	}

	await insertReply({
		fromAgent: args.identity,
		toAgent: args.requestor,
		content: `Dispatch ${args.dispatchId} is still running after ${Math.round(args.timeoutMs / 1000)}s; monitoring stopped.`,
		messageType: "task_status",
		correlationId: args.correlationId,
		replyTo: args.originalMessageId,
	});
	console.warn(
		`${args.log} TASK_BRIDGE monitor timed out for dispatch=${args.dispatchId}`,
	);
}

function terminalOfferStatus(
	offerStatus: string,
	dispatchStatus: string,
): boolean {
	return (
		["delivered", "failed", "expired", "cancelled"].includes(offerStatus) ||
		["completed", "failed", "cancelled"].includes(dispatchStatus)
	);
}

function toOfferUuid(dispatchId: number): string {
	const hex = BigInt(dispatchId).toString(16).padStart(12, "0").slice(-12);
	return `00000000-0000-0000-0000-${hex}`;
}

function stringFrom(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

function numberFrom(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

function stringArrayFrom(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
export async function insertReply(args: {
	fromAgent: string;
	toAgent: string;
	content: string;
	messageType: string;
	correlationId: string | null;
	replyTo: number;
	metadata?: Record<string, unknown>;
}): Promise<number> {
	const { rows } = await query(
		`INSERT INTO roadmap.message_ledger
		    (from_agent, to_agent, message_type, message_content,
		     correlation_id, reply_to, metadata)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING id`,
		[
			args.fromAgent,
			args.toAgent,
			args.messageType,
			args.content,
			args.correlationId,
			args.replyTo,
			JSON.stringify(args.metadata ?? {}),
		],
	);
	return rows[0].id as number;
}

export async function markReadAndResolveTimeout(messageId: number): Promise<void> {
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
