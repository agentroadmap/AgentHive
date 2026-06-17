/**
 * P674 notification router.
 *
 * Drains roadmap.notification_queue (status='pending'), resolves each row's
 * `kind` + `severity` against roadmap.notification_route, dispatches via the
 * transport adapter for each matching route. Retries with exponential backoff
 * up to MAX_ATTEMPTS; on terminal failure, enqueues a CRITICAL row with
 * kind='notification_dispatch_failed' so the operator sees that routing itself
 * broke.
 *
 * Wakes on pg_notify('notification_enqueued') for low-latency dispatch and
 * polls every POLL_INTERVAL_MS as a backstop for missed notifies.
 */

import type { Client, Pool } from "pg";

import type { NotificationChannel, OutboundMessage } from "../messaging/gateway/adapter.ts";
import { moveToDlq } from "../messaging/gateway/dlq.ts";
import { TransportWakeTimeoutError } from "../messaging/gateway/errors.ts";
import type { TransportRegistry } from "../messaging/gateway/registry.ts";
import { FlagKeys } from "../../shared/runtime/config-keys.ts";
import * as runtimeConfig from "../../shared/runtime/config.ts";
import { resolveTransport } from "./transport-registry.ts";
import {
	type NotificationEnvelope,
	type NotificationRoute,
	type Severity,
	severityAtLeast,
	TransportError,
} from "./types.ts";

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [1_000, 4_000, 12_000, 32_000]; // index = attempts already made
const ERROR_TRUNCATE = 4_000;

async function resolveNotificationPollIntervalMs(): Promise<number> {
	try {
		return await runtimeConfig.get(FlagKeys.NOTIFICATION_POLL_INTERVAL_MS);
	} catch {
		return 30_000;
	}
}

async function resolveNotificationBatchSize(): Promise<number> {
	try {
		return await runtimeConfig.get(FlagKeys.NOTIFICATION_BATCH_SIZE);
	} catch {
		return 25;
	}
}

export interface RouterDeps {
	pool: Pool;
	listenerFactory: () => Promise<Client>;
	log?: (msg: string) => void;
	warn?: (msg: string) => void;
	error?: (msg: string) => void;
	/** P304: optional transport registry for wake-up and DLQ integration. */
	transportRegistry?: TransportRegistry;
}

interface QueueRow {
	id: string | number;
	severity: Severity;
	kind: string | null;
	channel: string | null; // legacy direct-route
	proposal_id: string | number | null;
	title: string;
	body: string;
	payload: Record<string, unknown> | null;
	metadata: Record<string, unknown> | null;
	created_at: Date | string;
	dispatch_attempts: number;
}

interface RouteRow {
	id: string | number;
	kind: string;
	severity_min: Severity;
	transport: string;
	target: string | null;
	template: string | null;
	priority: number;
}

export class NotificationRouter {
	private listener: Client | null = null;
	private pollTimer: NodeJS.Timeout | null = null;
	private draining = false;
	private stopped = false;
	private wakePending = false;

	private readonly deps: RouterDeps;
	private readonly log: (m: string) => void;
	private readonly warn: (m: string) => void;
	private readonly errorLog: (m: string) => void;

	constructor(deps: RouterDeps) {
		this.deps = deps;
		this.log = deps.log ?? ((m) => console.log(m));
		this.warn = deps.warn ?? ((m) => console.warn(m));
		this.errorLog = deps.error ?? ((m) => console.error(m));
	}

	async run(): Promise<void> {
		this.listener = await this.deps.listenerFactory();
		await this.listener.query("LISTEN notification_enqueued");
		this.listener.on("notification", (msg) => {
			if (msg.channel === "notification_enqueued") {
				void this.scheduleDrain();
			}
		});
		this.listener.on("error", (err) => {
			this.errorLog(`[notification-router] LISTEN error: ${err.message}`);
		});

		const pollIntervalMs = await resolveNotificationPollIntervalMs();
		this.pollTimer = setInterval(() => {
			void this.scheduleDrain();
		}, pollIntervalMs);
		this.pollTimer.unref?.();

		// Initial drain in case anything was waiting before we attached.
		await this.scheduleDrain();
		this.log("[notification-router] running (listening for notification_enqueued)");
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		if (this.listener) {
			try {
				await this.listener.query("UNLISTEN notification_enqueued");
			} catch {
				/* ignore */
			}
			try {
				await this.listener.end();
			} catch {
				/* ignore */
			}
			this.listener = null;
		}
		// Wait for any in-flight drain to finish.
		while (this.draining) await sleep(50);
	}

	private async scheduleDrain(): Promise<void> {
		if (this.stopped) return;
		if (this.draining) {
			this.wakePending = true;
			return;
		}
		this.draining = true;
		try {
			do {
				this.wakePending = false;
				await this.drainOnce();
			} while (this.wakePending && !this.stopped);
		} finally {
			this.draining = false;
		}
	}

	private async drainOnce(): Promise<void> {
		const rows = await this.claimBatch();
		for (const row of rows) {
			if (this.stopped) return;
			await this.dispatchRow(row);
		}
	}

	private async claimBatch(): Promise<QueueRow[]> {
		// FIFO by created_at within severity rank; newer CRITICAL outranks older INFO.
		// Schema drift fix (P1140 sibling): live notification_queue lacks
		// `payload`, `dispatched_at`, and `next_attempt_at` columns. Pending-row
		// detection uses `status='pending'` (live CHECK constraint). payload is
		// materialized as NULL so QueueRow stays shape-compatible.
		const { rows } = await this.deps.pool.query<QueueRow>(
			`SELECT id, severity, kind, channel, proposal_id,
			        title, body, NULL::jsonb AS payload, metadata, created_at, dispatch_attempts
			   FROM roadmap.notification_queue
			  WHERE status = 'pending'
			    AND created_at <= now()
			  ORDER BY
			    CASE severity
			      WHEN 'CRITICAL' THEN 0
			      WHEN 'URGENT'   THEN 1
			      WHEN 'ALERT'    THEN 2
			      ELSE 3
			    END,
			    created_at ASC
			  LIMIT $1
			  FOR UPDATE SKIP LOCKED`,
			[await resolveNotificationBatchSize()],
		);
		return rows;
	}

	private async dispatchRow(row: QueueRow): Promise<void> {
		const envelope = toEnvelope(row);
		const routes = await this.resolveRoutes(envelope, row.channel);

		if (routes.length === 0) {
			this.warn(
				`[notification-router] no route for kind=${envelope.kind} severity=${envelope.severity} (queue_id=${envelope.queueId}); marking suppressed`,
			);
			await this.markSuppressed(envelope.queueId, "no matching route");
			return;
		}

		// P304: wake-up check — if the registry knows this channel's adapter
		// and it's offline, attempt to bring it online before dispatching.
		if (this.deps.transportRegistry) {
			const effectiveChannel = row.channel ?? transportNameToChannel(routes[0]?.transport ?? "");
			if (effectiveChannel) {
				const adapter = this.deps.transportRegistry.tryGetAdapterByChannel(effectiveChannel);
				if (adapter) {
					const available = await adapter.isAvailable();
					if (!available) {
						try {
							await adapter.wakeUp();
						} catch (err) {
							if (err instanceof TransportWakeTimeoutError) {
								const newAttempts = row.dispatch_attempts + 1;
								if (newAttempts >= MAX_ATTEMPTS) {
									await this.markFailed(envelope.queueId, newAttempts, err.message);
									await this.moveToDlqRow(envelope, newAttempts, effectiveChannel, "WAKE_TIMEOUT");
									return;
								}
								const delay = BACKOFF_MS[Math.min(newAttempts - 1, BACKOFF_MS.length - 1)];
								await this.recordAttempt(envelope.queueId, newAttempts, err.message, delay);
								setTimeout(() => void this.scheduleDrain(), delay).unref?.();
								return;
							}
							throw err;
						}
					}
				}
			}
		}

		const errors: string[] = [];
		for (const route of routes) {
			const transport = resolveTransport(route.transport);
			if (!transport) {
				errors.push(`route ${route.id}: unknown transport "${route.transport}"`);
				continue;
			}
			try {
				await transport.send({ envelope, route });
			} catch (err) {
				const detail =
					err instanceof TransportError
						? `${err.transport}: ${err.message}`
						: (err as Error)?.message ?? String(err);
				errors.push(`route ${route.id} (${route.transport}): ${detail}`);
			}
		}

		if (errors.length === 0) {
			await this.markSent(envelope.queueId);
			return;
		}

		const newAttempts = row.dispatch_attempts + 1;
		const lastError = errors.join("; ").slice(0, ERROR_TRUNCATE);

		if (newAttempts >= MAX_ATTEMPTS) {
			await this.markFailed(envelope.queueId, newAttempts, lastError);
			const effectiveChannel = row.channel
				?? transportNameToChannel(routes[0]?.transport ?? "")
				?? routes[0]?.transport
				?? "unknown";
			await this.moveToDlqRow(envelope, newAttempts, effectiveChannel, lastError);
			return;
		}

		const delay = BACKOFF_MS[Math.min(newAttempts - 1, BACKOFF_MS.length - 1)];
		await this.recordAttempt(envelope.queueId, newAttempts, lastError, delay);
		setTimeout(() => void this.scheduleDrain(), delay).unref?.();
	}

	private async moveToDlqRow(
		envelope: NotificationEnvelope,
		attemptCount: number,
		channel: string,
		errorCode: string,
	): Promise<void> {
		const msg: OutboundMessage = {
			notificationId: BigInt(envelope.queueId),
			channel: channel as NotificationChannel,
			title: envelope.title,
			body: envelope.body,
			metadata: envelope.payload,
		};
		try {
			await moveToDlq(this.deps.pool, msg, attemptCount, errorCode);
		} catch (dlqErr) {
			// Fall back to escalation if DLQ write fails.
			this.errorLog(
				`[notification-router] DLQ write failed for queue_id=${envelope.queueId}: ${(dlqErr as Error).message}; falling back to escalation`,
			);
			await this.escalateDispatchFailure(envelope, errorCode);
			return;
		}
		this.errorLog(
			`[notification-router] moved queue_id=${envelope.queueId} kind=${envelope.kind} to DLQ after ${attemptCount} attempts`,
		);
	}

	private async resolveRoutes(
		envelope: NotificationEnvelope,
		legacyChannel: string | null,
	): Promise<NotificationRoute[]> {
		// Legacy compatibility: if the row was inserted with a `channel` set
		// (pre-P674 caller), short-circuit to the matching transport so we
		// don't break old code while it's being migrated.
		if (legacyChannel) {
			const transportName = legacyChannel === "discord"
				? "discord_webhook"
				: legacyChannel;
			this.warn(
				`[notification-router] legacy channel="${legacyChannel}" on queue_id=${envelope.queueId}; routing to ${transportName}. Migrate caller to use kind+payload.`,
			);
			return [
				{
					id: -1,
					kind: envelope.kind,
					severityMin: "INFO",
					transport: transportName,
					target: null,
					template: null,
					priority: 0,
				},
			];
		}

		if (!envelope.kind) {
			return [];
		}

		const { rows } = await this.deps.pool.query<RouteRow>(
			`SELECT id, kind, severity_min, transport, target, template, priority
			   FROM roadmap.notification_route
			  WHERE enabled = true
			    AND kind = $1
			  ORDER BY priority ASC, id ASC`,
			[envelope.kind],
		);

		return rows
			.filter((r) => severityAtLeast(envelope.severity, r.severity_min))
			.map((r) => ({
				id: Number(r.id),
				kind: r.kind,
				severityMin: r.severity_min,
				transport: r.transport,
				target: r.target,
				template: r.template,
				priority: r.priority,
			}));
	}

	// Schema drift fix (P1140 sibling): live notification_queue lacks
	// `dispatched_at` and `next_attempt_at` columns. delivered_at + status
	// carry the terminal-success/failure signal; recordAttempt no longer
	// schedules an explicit next attempt — the poll cadence picks pending
	// rows back up on next tick. Retry-delay precision lost (was per-row
	// backoff; now uniform poll interval) — flagged for the proper router
	// rework when the notification subsystem is consolidated.
	private async markSent(queueId: number): Promise<void> {
		await this.deps.pool.query(
			`UPDATE roadmap.notification_queue
			    SET status = 'sent',
			        delivered_at = now()
			  WHERE id = $1`,
			[queueId],
		);
	}

	private async markSuppressed(queueId: number, reason: string): Promise<void> {
		await this.deps.pool.query(
			`UPDATE roadmap.notification_queue
			    SET status = 'suppressed',
			        last_error = $2,
			        delivered_at = now()
			  WHERE id = $1`,
			[queueId, reason],
		);
	}

	private async markFailed(
		queueId: number,
		attempts: number,
		lastError: string,
	): Promise<void> {
		await this.deps.pool.query(
			`UPDATE roadmap.notification_queue
			    SET status = 'failed',
			        dispatch_attempts = $2,
			        last_error = $3,
			        delivered_at = now()
			  WHERE id = $1`,
			[queueId, attempts, lastError],
		);
	}

	private async recordAttempt(
		queueId: number,
		attempts: number,
		lastError: string,
		_delayMs: number,
	): Promise<void> {
		// next_attempt_at column gone; row stays status='pending' so the next
		// poll picks it up. dispatch_attempts increment lets max-attempt limit
		// still terminate retry loop. Delay precision deferred to a proper
		// router rework.
		await this.deps.pool.query(
			`UPDATE roadmap.notification_queue
			    SET dispatch_attempts = $2,
			        last_error = $3
			  WHERE id = $1`,
			[queueId, attempts, lastError],
		);
	}

	private async escalateDispatchFailure(
		envelope: NotificationEnvelope,
		lastError: string,
	): Promise<void> {
		await this.deps.pool.query(
			`INSERT INTO roadmap.notification_queue
			   (proposal_id, severity, kind, title, body, payload, metadata)
			 VALUES ($1, 'CRITICAL', 'notification_dispatch_failed', $2, $3, $4::jsonb, $4::jsonb)`,
			[
				envelope.proposalId,
				`Dispatch failed for ${envelope.kind} (queue_id=${envelope.queueId})`,
				`Last error: ${lastError}`,
				JSON.stringify({
					original_queue_id: envelope.queueId,
					original_kind: envelope.kind,
					original_severity: envelope.severity,
					last_error: lastError,
				}),
			],
		);
		this.errorLog(
			`[notification-router] escalated dispatch failure for queue_id=${envelope.queueId} kind=${envelope.kind}`,
		);
	}
}

function toEnvelope(row: QueueRow): NotificationEnvelope {
	return {
		queueId: Number(row.id),
		severity: row.severity,
		kind: row.kind ?? "",
		payload: (row.payload ?? row.metadata ?? {}) as Record<string, unknown>,
		proposalId:
			row.proposal_id === null || row.proposal_id === undefined
				? null
				: Number(row.proposal_id),
		title: row.title,
		body: row.body,
		createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Maps a static transport name to the channel name used in transport_registry. */
function transportNameToChannel(transportName: string): string | null {
	const MAP: Record<string, string> = {
		discord_webhook: 'discord',
		email: 'email',
		sms: 'sms',
		push: 'push',
		digest: 'digest',
	};
	return MAP[transportName] ?? null;
}
