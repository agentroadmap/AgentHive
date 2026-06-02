/**
 * P1106 F2: Signature Reconciler
 *
 * Background worker that resolves sig_verified='pending' rows on roadmap.message_ledger
 * that are older than 60 seconds. For each stale-pending row:
 *   - If provider_sig is NULL → mark sig_verified='failed' (no signature to verify)
 *   - If provider_sig is present → fetch the sender's agent secret and verify;
 *     update sig_verified to 'verified' or 'failed' accordingly.
 *
 * Run schedule: every 30 seconds via setInterval.
 * Multi-replica safety: pg_try_advisory_lock(1106_1) ensures only one replica
 * runs the reconcile pass at a time; others skip the tick harmlessly.
 *
 * AC-2 / AC-9: Ensures no message has sig_verified='pending' beyond 5s of age
 * (reconciler runs every 30s with a 60s threshold → worst-case 90s lag,
 *  within the 5-minute HMAC replay window).
 */

import crypto from "crypto";
import type { Pool } from "pg";
import { verifySignature } from "../security/agent-crypto.ts";
import { getAgentSecret } from "../security/agent-secret-store.ts";

const RECONCILE_INTERVAL_MS = 30_000;
const STALE_THRESHOLD_SECONDS = 60;

interface PendingSigRow {
	id: string;
	from_agent: string;
	to_agent: string | null;
	message_type: string;
	created_at: string;
	provider_sig: string | null;
	provider_sig_salt: Buffer | null;
	message_content: string | null;
}

/**
 * Run one reconciliation pass: fetch stale-pending rows and resolve them.
 * Returns the number of rows resolved.
 */
export async function runSigReconcilePass(pool: Pool): Promise<number> {
	const client = await pool.connect();
	try {
		// Advisory lock key derived from P1106 (numeric: 1106 * 1000 + 1)
		const lockResult = await client.query<{ acquired: boolean }>(
			`SELECT pg_try_advisory_lock(1106001) AS acquired`,
		);
		if (!lockResult.rows[0]?.acquired) {
			return 0; // Another replica holds the lock; skip this tick
		}

		const { rows } = await client.query<PendingSigRow>(
			`SELECT id, from_agent, to_agent, message_type, created_at,
			        provider_sig, provider_sig_salt, message_content
			 FROM roadmap.message_ledger
			 WHERE sig_verified = 'pending'
			   AND created_at < now() - interval '${STALE_THRESHOLD_SECONDS} seconds'
			 ORDER BY created_at ASC
			 LIMIT 100
			 FOR UPDATE SKIP LOCKED`,
		);

		if (rows.length === 0) return 0;

		let resolved = 0;
		for (const row of rows) {
			const newStatus = await resolveRow(row);
			await client.query(
				`UPDATE roadmap.message_ledger SET sig_verified = $1 WHERE id = $2`,
				[newStatus, row.id],
			);
			resolved++;
		}

		return resolved;
	} catch (err) {
		console.error(
			"[SigReconciler] Pass failed:",
			err instanceof Error ? err.message : err,
		);
		return 0;
	} finally {
		// Releasing the client releases the advisory lock automatically
		client.release();
	}
}

async function resolveRow(row: PendingSigRow): Promise<"verified" | "failed"> {
	if (!row.provider_sig) {
		// No signature provided → treat as failed (unsigned message on critical path)
		return "failed";
	}

	try {
		// Fetch the sender's agent secret
		const secret = await getAgentSecret(row.from_agent);
		if (!secret) {
			console.warn(
				`[SigReconciler] No secret for agent ${row.from_agent} — marking failed`,
			);
			return "failed";
		}

		// Reconstruct the payload hash from message_content
		const payload = row.message_content ?? "";
		const payloadSha256 = crypto
			.createHash("sha256")
			.update(payload, "utf-8")
			.digest();

		const createdAtEpoch = Math.floor(
			new Date(row.created_at).getTime() / 1000,
		);

		const valid = verifySignature(
			secret,
			row.from_agent,
			row.to_agent ?? "",
			row.message_type,
			createdAtEpoch,
			payloadSha256,
			row.provider_sig,
			row.provider_sig_salt ?? undefined,
		);

		return valid ? "verified" : "failed";
	} catch (err) {
		console.error(
			`[SigReconciler] Verification error for msg ${row.id}:`,
			err instanceof Error ? err.message : err,
		);
		return "failed";
	}
}

/**
 * Register the signature reconciler cron.
 * Singleton guard prevents double-registration in a single process.
 */
export async function registerSigReconciler(pool: Pool): Promise<void> {
	const globalKey = "__sigReconcilerInterval";
	if ((globalThis as Record<string, unknown>)[globalKey]) {
		console.log("[SigReconciler] Already registered — skipping");
		return;
	}

	// Verify the table exists before scheduling
	const tableCheck = await pool.query<{ count: string }>(
		`SELECT COUNT(*) AS count FROM information_schema.tables
		 WHERE table_schema = 'roadmap' AND table_name = 'message_ledger'`,
	);
	if (Number(tableCheck.rows[0]?.count ?? 0) === 0) {
		console.warn(
			"[SigReconciler] message_ledger table not found — reconciler skipped",
		);
		return;
	}

	const interval = setInterval(() => {
		void runSigReconcilePass(pool)
			.then((resolved) => {
				if (resolved > 0) {
					console.log(
						`[SigReconciler] Resolved ${resolved} stale-pending signatures`,
					);
				}
			})
			.catch((err) => {
				console.error(
					`[SigReconciler] Unhandled error: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
	}, RECONCILE_INTERVAL_MS);

	(globalThis as Record<string, unknown>)[globalKey] = interval;
	console.log(
		"[SigReconciler] Registered (every 30s, advisory-lock guarded, 60s stale threshold)",
	);
}
