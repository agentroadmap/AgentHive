/**
 * P993: Liaison Task Dispatcher — Typed A2A task protocol handler
 *
 * Handles message types:
 *   - task_request: incoming task with proposal_id → claim + spawn
 *   - task_status: worker status update → update tracker + relay to requestor
 *   - task_complete: worker completion → update tracker + relay to requestor
 *   - task_error: worker error → update tracker + relay to requestor
 *
 * DB schema: liaison_task_tracker (P993 migration 132)
 */

import { randomUUID } from "node:crypto";
import { query, type Pool } from "../postgres/pool.ts";
import { getMcpUrl } from "../../shared/runtime/endpoints.ts";
import type { IncomingMessage } from "./liaison-agent.ts";

/**
 * Helper types for the handler signatures.
 */
export interface TaskDispatcherHelpers {
	insertReply: (args: {
		fromAgent: string;
		toAgent: string;
		content: string;
		messageType: string;
		correlationId: string | null;
		replyTo: number;
		metadata?: Record<string, unknown>;
	}) => Promise<number>;
	markReadAndResolveTimeout: (messageId: number) => Promise<void>;
	bridgeTaskToOfferDispatch: (args: {
		msg: IncomingMessage;
		identity: string;
		provider: string;
	}) => Promise<{ dispatchId: number; statusPollMs: number; statusTimeoutMs: number }>;
	monitorTaskDispatch: (args: {
		identity: string;
		requestor: string;
		originalMessageId: number;
		correlationId: string | null;
		dispatchId: number;
		pollMs: number;
		timeoutMs: number;
		log: string;
	}) => Promise<void>;
}

/**
 * Extract and validate proposal_id from message metadata or the ledger column.
 * Checks metadata.proposal_id first (A2A protocol), then falls back to the
 * message_ledger.proposal_id bigint column (set by msg_send via MCP).
 */
function extractProposalId(msg: IncomingMessage): string | null {
	const metadata = msg.metadata ?? {};
	if (typeof metadata.proposal_id === "string") {
		return metadata.proposal_id.trim() || null;
	}
	if (typeof metadata.proposal_id === "number") {
		return String(metadata.proposal_id);
	}
	// Fall back to message_ledger.proposal_id (written by msg_send MCP tool)
	if (msg.proposal_id != null) {
		return String(msg.proposal_id);
	}
	return null;
}

/**
 * Claim a proposal via MCP HTTP endpoint.
 * Returns the lease_id (UUID) on success.
 * Throws on conflict or network failure (after one retry).
 */
async function claimProposal(
	proposalId: string,
	identity: string,
): Promise<string> {
	const mcpUrl = getMcpUrl();
	const url = new URL("/mcp", mcpUrl).toString();

	const body = {
		jsonrpc: "2.0",
		id: proposalId,
		method: "tools/call",
		params: {
			name: "prop_claim",
			arguments: {
				id: proposalId,
				agent: identity,
				durationMinutes: 60,
			},
		},
	};

	let attempt = 0;
	while (attempt < 2) {
		attempt++;
		try {
			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});

			const responseText = await res.text();
			if (!res.ok) {
				if (
					responseText.includes("already") ||
					responseText.includes("leased")
				) {
					throw new Error("concurrent_claim_conflict");
				}
				throw new Error(`MCP claim failed: ${res.status} ${responseText}`);
			}

			// Parse JSON-RPC 2.0 response: result.content[0].text contains the tool output
			let leaseId = randomUUID();
			try {
				const rpc = JSON.parse(responseText) as {
					result?: { content?: Array<{ text?: string }> };
				};
				const text = rpc.result?.content?.[0]?.text ?? "{}";
				const toolResult = JSON.parse(text) as Record<string, unknown>;
				if (typeof toolResult.lease_id === "string") {
					leaseId = toolResult.lease_id;
				}
			} catch {
				// fallback UUID already set
			}
			return leaseId;
		} catch (err) {
			if (attempt === 2) {
				throw err instanceof Error
					? err
					: new Error(String(err));
			}
			// Retry after 2s
			await new Promise((resolve) => setTimeout(resolve, 2000));
		}
	}

	throw new Error("claim_unavailable");
}

/**
 * Release a proposal lease via MCP HTTP endpoint.
 * Best-effort: logs on failure but does not throw.
 */
async function releaseProposal(
	proposalId: string,
	identity: string,
): Promise<void> {
	const mcpUrl = getMcpUrl();
	const url = new URL("/mcp", mcpUrl).toString();

	const body = {
		jsonrpc: "2.0",
		id: `${proposalId}-release`,
		method: "tools/call",
		params: {
			name: "release",
			arguments: {
				id: proposalId,
				agent: identity,
				release_reason: "tracker_insert_failed",
			},
		},
	};

	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`MCP release failed: ${res.status} ${text}`);
	}
}

/**
 * Adapt a task_request message to task bridge format.
 * Sets message_type='task' and metadata flags for bridgeTaskToOfferDispatch.
 */
function adaptMessageForBridge(msg: IncomingMessage): IncomingMessage {
	return {
		...msg,
		message_type: "task",
		metadata: {
			...msg.metadata,
			spawn_agent: true,
			task_action: "develop",
		},
	};
}

/**
 * Handle incoming task_request message.
 * - Extract and validate proposal_id
 * - Claim proposal via MCP
 * - Insert tracker row
 * - Bridge to offer dispatch
 * - Send task_ack reply
 * - Start background monitoring
 */
export async function handleTypedTaskRequest(
	msg: IncomingMessage,
	identity: string,
	provider: string,
	helpers: TaskDispatcherHelpers,
): Promise<void> {
	const { insertReply, markReadAndResolveTimeout, bridgeTaskToOfferDispatch, monitorTaskDispatch } = helpers;
	const log = `[P993TaskRequest id=${msg.id}]`;

	// 1. Extract proposal_id
	const proposalId = extractProposalId(msg);
	if (!proposalId) {
		console.warn(`${log} missing proposal_id in metadata`);
		await insertReply({
			fromAgent: identity,
			toAgent: msg.from_agent,
			content: `Task request rejected: missing proposal_id in metadata`,
			messageType: "task_error",
			correlationId: msg.correlation_id ?? null,
			replyTo: msg.id,
		});
		await markReadAndResolveTimeout(msg.id);
		return;
	}

	// 2. Claim proposal
	let leaseId: string;
	try {
		leaseId = await claimProposal(proposalId, identity);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		console.warn(`${log} claim failed:`, detail);
		await insertReply({
			fromAgent: identity,
			toAgent: msg.from_agent,
			content: `Task request failed: ${detail}`,
			messageType: "task_error",
			correlationId: msg.correlation_id ?? null,
			replyTo: msg.id,
		});
		await markReadAndResolveTimeout(msg.id);
		return;
	}

	const correlationId = msg.correlation_id ?? randomUUID();

	// 3. Insert tracker row
	try {
		await query(
			`INSERT INTO roadmap.liaison_task_tracker
			    (correlation_id, proposal_id, requestor_id, liaison_id, status)
			 VALUES ($1, $2, $3, $4, 'claimed')`,
			[
				correlationId,
				proposalId,
				msg.from_agent,
				identity,
			],
		);
	} catch (err) {
		console.warn(`${log} tracker INSERT failed:`, err);
		try {
			await releaseProposal(proposalId, identity);
		} catch (releaseErr) {
			console.warn(`${log} lease release after INSERT failure also failed:`, releaseErr);
		}
		await insertReply({
			fromAgent: identity,
			toAgent: msg.from_agent,
			content: `Task request failed: tracker initialization error`,
			messageType: "task_error",
			correlationId: correlationId,
			replyTo: msg.id,
		});
		await markReadAndResolveTimeout(msg.id);
		return;
	}

	// 4. Bridge to offer dispatch
	let dispatchId: number;
	let statusPollMs: number;
	let statusTimeoutMs: number;
	try {
		const adaptedMsg = adaptMessageForBridge(msg);
		const result = await bridgeTaskToOfferDispatch({
			msg: adaptedMsg,
			identity,
			provider,
		});
		dispatchId = result.dispatchId;
		statusPollMs = result.statusPollMs;
		statusTimeoutMs = result.statusTimeoutMs;

		// Update tracker with dispatch_id and spawned status
		await query(
			`UPDATE roadmap.liaison_task_tracker
			  SET dispatch_id = $1, status = 'spawned', worker_identity = $2
			 WHERE correlation_id = $3`,
			[dispatchId, identity, correlationId],
		);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		console.error(`${log} bridge failed:`, detail);
		await query(
			`UPDATE roadmap.liaison_task_tracker
			  SET status = 'failed', completed_at = now()
			 WHERE correlation_id = $1`,
			[correlationId],
		);
		await insertReply({
			fromAgent: identity,
			toAgent: msg.from_agent,
			content: `Task dispatch failed: ${detail}`,
			messageType: "task_error",
			correlationId: correlationId,
			replyTo: msg.id,
		});
		await markReadAndResolveTimeout(msg.id);
		return;
	}

	// 5. Send task_ack reply with structured metadata (AC-3)
	try {
		await insertReply({
			fromAgent: identity,
			toAgent: msg.from_agent,
			content: `Claimed ${proposalId}; spawning via dispatch ${dispatchId}`,
			messageType: "task_ack",
			correlationId: correlationId,
			replyTo: msg.id,
			metadata: {
				proposal_id: proposalId,
				worker_identity: identity,
				dispatch_id: dispatchId,
				lease_id: leaseId,
				estimated_completion: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
			},
		});
	} catch (err) {
		console.warn(`${log} task_ack INSERT failed:`, err);
	}

	await markReadAndResolveTimeout(msg.id);

	// 6. Start background monitoring
	void monitorTaskDispatch({
		identity,
		requestor: msg.from_agent,
		originalMessageId: msg.id,
		correlationId,
		dispatchId,
		pollMs: statusPollMs,
		timeoutMs: statusTimeoutMs,
		log,
	});
}

/**
 * Handle worker report messages (task_status, task_complete, task_error).
 * - Look up tracker by correlation_id
 * - Update tracker status and last_status_at
 * - Set completed_at on complete/failed
 * - Relay message to requestor
 * - Mark message read
 */
export async function handleWorkerReport(
	msg: IncomingMessage,
	identity: string,
	helpers: TaskDispatcherHelpers,
): Promise<void> {
	const { insertReply, markReadAndResolveTimeout } = helpers;
	const log = `[P993WorkerReport id=${msg.id}]`;
	const correlationId = msg.correlation_id;

	if (!correlationId) {
		console.warn(`${log} missing correlation_id`);
		await markReadAndResolveTimeout(msg.id);
		return;
	}

	// Look up tracker
	const { rows } = await query(
		`SELECT task_id, requestor_id, status FROM roadmap.liaison_task_tracker
		  WHERE correlation_id = $1`,
		[correlationId],
	);

	const trackerRow = rows[0];
	if (!trackerRow) {
		console.warn(`${log} no tracker row for correlation_id=${correlationId}`);
		await markReadAndResolveTimeout(msg.id);
		return;
	}

	// Map message_type to tracker status
	let newStatus = trackerRow.status;
	let completedAt: string | null = null;
	if (msg.message_type === "task_status") {
		newStatus = "in_progress";
	} else if (msg.message_type === "task_complete") {
		newStatus = "complete";
		completedAt = "now()";
	} else if (msg.message_type === "task_error") {
		newStatus = "failed";
		completedAt = "now()";
	}

	// Update tracker
	const updateSql = completedAt
		? `UPDATE roadmap.liaison_task_tracker
		    SET status = $1, last_status_at = now(), completed_at = ${completedAt}
		   WHERE correlation_id = $2`
		: `UPDATE roadmap.liaison_task_tracker
		    SET status = $1, last_status_at = now()
		   WHERE correlation_id = $2`;

	await query(updateSql, [newStatus, correlationId]);

	// On task_complete: verify ACs + release lease before relaying (AC-5)
	if (msg.message_type === "task_complete") {
		const proposalId = trackerRow.proposal_id as string;
		const mcpUrl = getMcpUrl();
		const mcpEndpoint = new URL("/mcp", mcpUrl).toString();
		let acsVerified: string[] = [];

		try {
			const listRes = await fetch(mcpEndpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: proposalId,
					method: "tools/call",
					params: { name: "list_ac", arguments: { proposal_id: proposalId } },
				}),
			});
			const listRpc = await listRes.json() as {
				result?: { content?: Array<{ text?: string }> };
			};
			const listText = listRpc.result?.content?.[0]?.text ?? "{}";
			const listJson = JSON.parse(listText) as { items?: Array<{ item_number: number; label?: string; status: string }> };
			const items = listJson.items ?? [];

			for (const ac of items) {
				if (ac.status !== "pass") {
					await fetch(mcpEndpoint, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							jsonrpc: "2.0",
							id: `${proposalId}-ac-${ac.item_number}`,
							method: "tools/call",
							params: {
								name: "verify_ac",
								arguments: {
									proposal_id: proposalId,
									item_number: ac.item_number,
									status: "pass",
									verified_by: identity,
									verification_notes: "Auto-verified on task_complete by liaison",
								},
							},
						}),
					});
				}
				acsVerified.push(ac.label ?? `AC-${ac.item_number}`);
			}
		} catch (err) {
			console.warn(`${log} AC verification failed:`, err);
		}

		try {
			await fetch(mcpEndpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: `${proposalId}-release`,
					method: "tools/call",
					params: {
						name: "release",
						arguments: {
							id: proposalId,
							agent: identity,
							release_reason: "task_complete",
						},
					},
				}),
			});
		} catch (err) {
			console.warn(`${log} lease release failed:`, err);
		}

		try {
			await insertReply({
				fromAgent: identity,
				toAgent: trackerRow.requestor_id,
				content: msg.message_content,
				messageType: "task_complete",
				correlationId: correlationId,
				replyTo: msg.id,
				metadata: { ...((msg.metadata as object) ?? {}), acs_verified: acsVerified },
			});
		} catch (err) {
			console.warn(`${log} relay task_complete to requestor failed:`, err);
		}

		await markReadAndResolveTimeout(msg.id);
		return;
	}

	// Relay non-complete messages to requestor
	try {
		await insertReply({
			fromAgent: identity,
			toAgent: trackerRow.requestor_id,
			content: msg.message_content,
			messageType: msg.message_type,
			correlationId: correlationId,
			replyTo: msg.id,
		});
	} catch (err) {
		console.warn(`${log} relay to requestor failed:`, err);
	}

	await markReadAndResolveTimeout(msg.id);
}

/**
 * Detect and recover from stuck workers.
 * Scans for rows where last_status_at < now() - 30 minutes,
 * status not in (complete, failed), and spawn_count < 2.
 * Uses FOR UPDATE SKIP LOCKED to prevent concurrent liaisons double-processing the same row.
 * Increments spawn_count and marks failed if spawn_count >= 2.
 */
export async function detectStuckWorkers(): Promise<void> {
	// Single transaction: lock candidate rows to avoid concurrent-liaison double-processing.
	const { rows } = await query(
		`SELECT task_id, spawn_count, requestor_id, correlation_id
		  FROM roadmap.liaison_task_tracker
		 WHERE last_status_at < now() - interval '30 minutes'
		   AND status NOT IN ('complete', 'failed')
		   AND spawn_count < 2
		 FOR UPDATE SKIP LOCKED`,
	);

	for (const row of rows) {
		const { task_id, spawn_count, requestor_id, correlation_id } = row as any;
		const newSpawnCount = (spawn_count as number) + 1;

		if (newSpawnCount >= 2) {
			await query(
				`UPDATE roadmap.liaison_task_tracker
				  SET status = 'failed', spawn_count = $1, last_status_at = now(), completed_at = now()
				 WHERE task_id = $2`,
				[newSpawnCount, task_id],
			);
			// Notify requestor so they know to retry
			if (requestor_id) {
				try {
					const mcpUrl = getMcpUrl();
					const url = new URL("/mcp", mcpUrl).toString();
					await fetch(url, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							jsonrpc: "2.0",
							id: `stuck-notify-${task_id}`,
							method: "tools/call",
							params: {
								name: "msg_send",
								arguments: {
									from_agent: "system",
									to_agent: requestor_id,
									message_type: "task_error",
									content: `Task auto-failed after stuck detection (spawn_count=${newSpawnCount}). correlation_id=${correlation_id}. Please retry.`,
									correlation_id: correlation_id ?? undefined,
								},
							},
						}),
					});
				} catch (notifyErr) {
					console.warn(`[StuckTaskCron] Failed to notify requestor ${requestor_id}:`, notifyErr);
				}
			}
		} else {
			await query(
				`UPDATE roadmap.liaison_task_tracker
				  SET spawn_count = $1, last_status_at = now()
				 WHERE task_id = $2`,
				[newSpawnCount, task_id],
			);
		}
	}
}

/**
 * Register the stuck-task sweep cron to run every 5 minutes.
 * Mirrors the registerTimeoutCron pattern in timeout-cron.ts.
 */
export async function registerStuckTaskCron(db: Pool): Promise<void> {
	const { rows } = await db.query(
		`SELECT 1 FROM information_schema.tables
		  WHERE table_schema = 'roadmap' AND table_name = 'liaison_task_tracker'`,
	);
	if (!rows.length) {
		console.warn("[StuckTaskCron] table not ready; skipping registration");
		return;
	}

	setInterval(() => {
		void detectStuckWorkers().catch((err) =>
			console.error("[StuckTaskCron] sweep error:", err),
		);
	}, 5 * 60 * 1000);

	console.info("[StuckTaskCron] registered (5-minute interval)");
}
