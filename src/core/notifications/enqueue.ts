/**
 * P674 caller-facing API for emitting notifications.
 *
 * Callers write `(severity, kind, title, body, payload)`. They MUST NOT pass a
 * transport/channel — the router resolves that from notification_route.
 *
 * For the deprecation window, code that still wants to short-circuit to a
 * specific transport may pass `legacyChannel`, which writes the existing
 * `channel` column. New code should never use this.
 */

import { query } from "../../infra/postgres/pool.ts";
import type { Severity } from "./types.ts";

export interface EnqueueArgs {
	severity: Severity;
	kind: string;
	title: string;
	body: string;
	payload?: Record<string, unknown>;
	proposalId?: number | null;
	legacyChannel?: "discord" | "email" | "sms" | "push" | "digest";
}

export async function enqueueNotification(args: EnqueueArgs): Promise<number> {
	const {
		severity,
		kind,
		title,
		body,
		payload = {},
		proposalId = null,
		legacyChannel,
	} = args;

	if (!kind || kind.trim().length === 0) {
		throw new Error("enqueueNotification: `kind` is required");
	}

	const { rows } = await query<{ id: string | number }>(
		`INSERT INTO roadmap.notification_queue
		   (proposal_id, severity, kind, channel, title, body, payload, metadata)
		 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $7::jsonb)
		 RETURNING id`,
		[
			proposalId,
			severity,
			kind,
			legacyChannel ?? null,
			title,
			body,
			JSON.stringify(payload),
		],
	);

	return Number(rows[0]?.id ?? 0);
}
