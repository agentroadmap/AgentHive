/**
 * Liaison Agent — A2A inbox/reply loop shared across provider agencies.
 *
 * What it does (in-process, alongside whatever else the agency runs):
 *   1. Ensures roadmap_workforce.agent_registry has a row for this identity
 *      (FK anchor for message_ledger.from_agent / to_agent).
 *   2. Opens a dedicated pg client (NOT pooled) and LISTENs on
 *      agentNotifyChannel(identity), which is the unified `msg_<raw>` channel.
 *      Both message_ledger DMs and liaison_message envelopes wake this channel;
 *      this loop handles only numeric message_ledger ids and leaves UUID
 *      liaison_message envelopes to LiaisonHub. A pooled connection would carry
 *      LISTEN state back into the pool when released, causing stray
 *      notifications on whichever caller borrows it next; we own a dedicated
 *      client and end() it on stop().
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
import { setProviderAuthDown } from "../../core/orchestration/provider-auth.ts";
import {
	type CliInvocationHandler,
	type CliInvocationRegistry,
	globalCliInvocationRegistry,
	invokeCliHandler,
} from "../../core/runtime/cli-invocation.ts";
import { emitOAuthRotateSignal } from "../../core/runtime/oauth-token-monitor.ts";
import * as runtimeConfig from "../../shared/runtime/config.ts";
import { FlagKeys } from "../../shared/runtime/config-keys.ts";
import { agentNotifyChannel } from "../messaging/a2a-access-control.ts";
import { query } from "../postgres/pool.ts";
import {
	AgencyClaimLoop,
	makeAgencyClaimExecutor,
	type ListenerClient as ClaimLoopListenerClient,
} from "./agency-claim-loop.ts";
import { sendMessage as sendLiaisonMessage } from "./liaison-message-service.ts";
import { resolveLiaisonLlmTimeoutMs } from "./liaison-timeout.ts";
import {
	handleTypedTaskRequest,
	handleWorkerReport,
	detectStuckWorkers,
	type TaskDispatcherHelpers,
} from "./task-dispatcher.ts";

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
	/**
	 * P1142: invoked when the LISTEN client emits an `error` event.
	 * start-a2a-host.ts uses this to call process.exit(1) for systemd restart.
	 * When omitted: log-only (backward compat for start-liaison.ts).
	 */
	onListenError?: (err: Error, identity: string) => void;
}

export interface LiaisonAgentHandle {
	stop: () => Promise<void>;
	claimLoop?: AgencyClaimLoop;
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
		: await connectListenClient(identity);
	await listenClient.query(`LISTEN "${channel}"`);
	console.log(`${log} LISTEN active on: ${channel}`);

	// V3-C6 (P1438 step 3b): Conditionally start AgencyClaimLoop if flag enabled
	// This loop allows the agency to self-claim work offers from the shared work_offers
	// channel, avoiding the orchestrator bottleneck of claiming all offers and re-dispatching.
	let claimLoop: AgencyClaimLoop | null = null;
	let claimLoopListenClient: ClaimLoopListenerClient | null = null;

	const claimLoopFlag = await runtimeConfig
		.get(FlagKeys.AGENCY_OFFER_CLAIM_ENABLED)
		.catch(() => false);

	// V3-C6 step-1 canary scoping: AGENCY_OFFER_CLAIM_ENABLED is a GLOBAL flag, so
	// turning it on would enable self-claim for EVERY attached agency at once. The
	// optional AGENTHIVE_SELF_CLAIM_AGENCIES allowlist (comma-separated identities,
	// mirrors a2a-host's AGENTHIVE_AGENCY_FILTER) restricts self-claim to listed
	// agencies even when the global flag is on — enabling a single-agency canary.
	// Empty allowlist = all agencies (backward-compatible with the pre-allowlist
	// behavior). Parsed per-call so it composes with the global flag.
	let rawSelfClaimAllowlist = "";
	try {
		rawSelfClaimAllowlist = await runtimeConfig.get(FlagKeys.SELF_CLAIM_AGENCIES);
	} catch {
		// config unavailable — treat as empty (all agencies allowed)
	}
	const selfClaimAllowlist = rawSelfClaimAllowlist
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const allowedByList =
		selfClaimAllowlist.length === 0 || selfClaimAllowlist.includes(identity);
	const claimLoopEnabled = claimLoopFlag && allowedByList;
	if (claimLoopFlag && !allowedByList) {
		console.log(
			`${log} self-claim flag on but ${identity} not in SELF_CLAIM_AGENCIES allowlist — staying on orchestrator-dispatch`,
		);
	}

	if (claimLoopEnabled) {
		try {
			const capabilities = await loadAgencyClaimCapabilities(identity);
			if (capabilities.length === 0) {
				console.warn(
					`${log} self-claim enabled but no claim capabilities were found; AgencyClaimLoop not started`,
				);
			} else {
				// Create the executor that handles claimed offers via the existing
				// offer-dispatch path (reuses handleOfferDispatch, not duplicating logic)
				const executor = makeAgencyClaimExecutor(identity);

				// Open a dedicated LISTEN client for the claim loop
				claimLoopListenClient = await connectListenClient(`${identity}-claim`);

				// Construct and start the claim loop
				claimLoop = new AgencyClaimLoop({
					agencyIdentity: identity,
					provider, // AC-5: needed for auth readiness checks
					capabilities, // Real agency capabilities for offer matching
					onClaim: executor,
					connectListener: async () => claimLoopListenClient!,
					projectId: null, // Accept any project this agency is subscribed to
					leaseTtlSeconds: 1320, // 22 minutes, must exceed spawn timeout
					pollIntervalMs: 30_000,
					maxConcurrent: 8,
					logger: { log: console.log, warn: console.warn, error: console.error },
				});

				await claimLoop.start();
				console.log(
					`${log} AgencyClaimLoop started with capabilities: ${JSON.stringify(capabilities)}`,
				);
			}
		} catch (err) {
			console.error(
				`${log} Failed to start AgencyClaimLoop:`,
				err instanceof Error ? err.message : err,
			);
			// Continue liaison function even if claim loop startup fails — the liaison
			// A2A path (explicit task dispatch) still works.
		}
	}

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
				timeoutMs: await resolveLiaisonLlmTimeoutMs(provider),
			});
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			console.error(`${log} LLM handler failed:`, errMsg);

			// AC-2: Detect 401/403 auth errors and mark provider auth as down
			if (errMsg.includes("401") || errMsg.includes("403") ||
			    errMsg.includes("Unauthorized") || errMsg.includes("Forbidden") ||
			    errMsg.includes("invalid api key") || errMsg.includes("authentication")) {
				const statusCode = errMsg.includes("403") ? 403 : 401;
				console.warn(`${log} Auth error detected; marking provider '${provider}' auth as down`);
				try {
					await setProviderAuthDown(identity, provider, statusCode, errMsg);
				} catch (authErr) {
					console.error(`${log} Failed to log auth failure:`, authErr);
				}

				// P1967 AC-6: Emit structured rotation signal for 401 OAuth token failures
				if (statusCode === 401 && provider === "claude") {
					emitOAuthRotateSignal(401, `${provider} liaison handler returned 401 Unauthorized: ${errMsg.slice(0, 100)}`);
				}
			}

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
		let parsed: NotifyPayload | null;
		try {
			parsed = parseLedgerNotifyPayload(n.payload);
		} catch {
			console.warn(`${log} Bad notify payload:`, n.payload);
			return;
		}
		if (!parsed) return;
		handle(parsed).catch((err) => console.error(`${log} Handler error:`, err));
	});

	listenClient.on("error", (err) => {
		console.error(`${log} LISTEN client error:`, err);
		// AC-2: Invoke callback (if provided) AFTER the log
		if (opts.onListenError) {
			opts.onListenError(err, identity);
		}
	});

	// P3315 AC-3: Periodic reaper — flip orphaned active tracker rows to 'failed'
	// so stale rows from failed dispatches never permanently wedge retries.
	const REAPER_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
	const reaperInterval = setInterval(() => {
		detectStuckWorkers().catch((err) =>
			console.warn(`${log} detectStuckWorkers error:`, err),
		);
	}, REAPER_INTERVAL_MS);

	return {
		stop: async () => {
			clearInterval(reaperInterval);
			// Stop the claim loop first if it's running
			if (claimLoop) {
				try {
					await claimLoop.stop();
					console.log(`${log} AgencyClaimLoop stopped`);
				} catch (err) {
					console.error(
						`${log} Error stopping AgencyClaimLoop:`,
						err instanceof Error ? err.message : err,
					);
				}
			}

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
		claimLoop,
	};
}

export function parseLedgerNotifyPayload(
	rawPayload: string,
): NotifyPayload | null {
	const payload = JSON.parse(rawPayload) as { message_id?: unknown } & Record<
		string,
		unknown
	>;
	const messageId = payload.message_id;
	const numericId =
		typeof messageId === "number"
			? messageId
			: typeof messageId === "string" && /^\d+$/.test(messageId)
				? Number(messageId)
				: null;

	if (!Number.isSafeInteger(numericId) || numericId <= 0) return null;

	return {
		message_id: numericId,
		correlation_id:
			typeof payload.correlation_id === "string"
				? payload.correlation_id
				: undefined,
		from_agent:
			typeof payload.from_agent === "string" ? payload.from_agent : undefined,
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
	try {
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
			const isTerminal = terminalOfferStatus(row.offer_status, row.dispatch_status);
			const isSuccess = row.offer_status === "delivered" || row.dispatch_status === "completed";
			const messageType = isTerminal
				? isSuccess
					? "task_result"
					: "task_error"
				: "task_status";
			await insertReply({
				fromAgent: args.identity,
				toAgent: args.requestor,
				content:
					`Dispatch ${args.dispatchId} status: offer=${row.offer_status}, ` +
					`dispatch=${row.dispatch_status}` +
					(row.worker_identity ? `, worker=${row.worker_identity}` : ""),
				messageType,
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
	} catch (err) {
		console.warn(
			`${args.log} monitorTaskDispatch swallowed error to keep liaison alive:`,
			err instanceof Error ? err.message : err,
		);
	}
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

function stringArrayFromJsonish(value: unknown): string[] {
	if (Array.isArray(value)) {
		return stringArrayFrom(value)
			.map((entry) => entry.trim())
			.filter(Boolean);
	}
	if (typeof value !== "string") return [];

	const trimmed = value.trim();
	if (!trimmed) return [];
	try {
		return stringArrayFromJsonish(JSON.parse(trimmed));
	} catch {
		return [trimmed];
	}
}

function capabilitiesFromSkills(value: unknown): string[] {
	if (Array.isArray(value)) return stringArrayFromJsonish(value);
	if (!value || typeof value !== "object") return [];

	const capabilities: string[] = [];
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (raw === true) {
			capabilities.push(key);
			continue;
		}
		if (["all", "capabilities", "jobs"].includes(key)) {
			capabilities.push(...stringArrayFromJsonish(raw));
		}
	}
	return capabilities;
}

function uniqueSortedCapabilities(values: string[]): string[] {
	return Array.from(
		new Set(
			values
				.map((value) => value.trim())
				.filter((value) => value.length > 0),
		),
	).sort((a, b) => a.localeCompare(b));
}

export async function loadAgencyClaimCapabilities(
	identity: string,
): Promise<string[]> {
	const { rows } = await query<{
		skills: unknown;
		provider_jobs: unknown;
		agent_caps: string[] | null;
	}>(
		`SELECT
		    ar.skills,
		    COALESCE(
		      jsonb_agg(DISTINCT job.capability)
		        FILTER (WHERE job.capability IS NOT NULL),
		      '[]'::jsonb
		    ) AS provider_jobs,
		    COALESCE(
		      array_agg(DISTINCT ac.capability)
		        FILTER (WHERE ac.capability IS NOT NULL),
		      ARRAY[]::text[]
		    ) AS agent_caps
		   FROM roadmap_workforce.agent_registry ar
		   LEFT JOIN roadmap_workforce.provider_registry pr
		     ON pr.agency_id = ar.id
		    AND pr.is_active = true
		    AND pr.status NOT IN ('offline', 'retired')
		   LEFT JOIN LATERAL jsonb_array_elements_text(
		     COALESCE(pr.capabilities->'jobs', '[]'::jsonb)
		   ) AS job(capability)
		     ON true
		   LEFT JOIN roadmap_workforce.agent_capability ac
		     ON ac.agent_id = ar.id
		  WHERE ar.agent_identity = $1
		  GROUP BY ar.id, ar.skills`,
		[identity],
	);

	const row = rows[0];
	if (!row) return [];
	return uniqueSortedCapabilities([
		...stringArrayFromJsonish(row.provider_jobs),
		...(row.agent_caps ?? []),
		...capabilitiesFromSkills(row.skills),
	]);
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

export async function markReadAndResolveTimeout(
	messageId: number,
): Promise<void> {
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

async function connectListenClient(identity?: string): Promise<Client> {
	// LISTEN must bypass PgBouncer transaction pooling. Normal queries use the
	// shared pool; this long-lived client connects directly and is ended on stop.
	const tag = identity ?? process.env.AGENCY_ID ?? "unknown";
	const databaseUrl = process.env.DATABASE_URL
		? new URL(process.env.DATABASE_URL)
		: null;
	const client = new Client({
		host: process.env.PGHOST ?? databaseUrl?.hostname ?? "127.0.0.1",
		port: Number(
			process.env.PGPORT_DIRECT ??
				databaseUrl?.port ??
				process.env.PGPORT ??
				5432,
		),
		user: process.env.PGUSER ?? databaseUrl?.username,
		password: process.env.PGPASSWORD ?? databaseUrl?.password,
		database:
			process.env.PGDATABASE ??
			databaseUrl?.pathname.replace(/^\/+/, "") ??
			"agenthive",
		application_name: `agenthive-a2a-listen-${tag}`,
		options:
			process.env.PG_OPTIONS ??
			"-c search_path=roadmap_proposal,roadmap_workforce,roadmap_efficiency,roadmap,public",
	});
	await client.connect();
	return client;
}
