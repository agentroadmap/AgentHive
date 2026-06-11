/**
 * P836/P1097: A2A Cross-Host Delivery Worker
 *
 * Handles HTTP callback delivery of A2A messages with:
 * 1. SSRF prevention (validateCallbackUrl + DNS rebinding re-validation)
 * 2. HMAC-SHA256 delivery authentication with per-agent signing keys
 *    (P1097: signature now bound to actual request target, not hardcoded "/")
 * 3. Delivery deduplication via delivery_id_log (replay prevention)
 * 4. Retry with exponential backoff (1s, 2s, 4s)
 * 5. Audit trail in message_validity_log
 */

import crypto from "crypto";
import type { Pool } from "pg";
import { deriveSigningKey } from "../security/agent-crypto.ts";
import { getAgentSecret } from "../security/agent-secret-store.ts";
import {
	revalidateBeforeDelivery,
	validateCallbackUrl,
} from "../security/callback-url-validator.ts";

/**
 * Maximum number of delivery retry attempts (3 total: initial + 2 retries).
 */
const MAX_DELIVERY_ATTEMPTS = 3;

/**
 * Delivery timeout (5 seconds per attempt).
 */
const DELIVERY_TIMEOUT_MS = 5000;

/**
 * Result of a delivery attempt.
 */
export interface DeliveryResult {
	status: number;
	body: string;
}

/**
 * Post a message to a callback URL with HMAC delivery authentication.
 *
 * Steps:
 * 1. Re-validate callback URL against SSRF blocklist
 * 2. Generate deliveryId and timestamp
 * 3. Create signing input (POST\n<path>\n<headers>\n<body>)
 * 4. Resolve delivery signing secret (per-agent or env var)
 * 5. HMAC-SHA256 over signing input
 * 6. POST with headers: X-AgentHive-Signature, X-AgentHive-Delivery-Id, X-AgentHive-Timestamp,
 *    X-AgentHive-Agent-Id, X-AgentHive-Target-Host-Id (when targetHostId provided)
 * 7. Log to message_validity_log (delivery_attempted_at, delivery_status, delivery_response_code)
 * 8. Retry up to 3 times with exponential backoff on 5xx or network error
 * 9. On all failures: insert NACK into message_ledger
 *
 * F1 (P1106): targetHostId is included as a delimited field in the signing input to prevent
 * cross-host replay attacks. A message signed for host-A cannot be replayed to host-B.
 *
 * @param callbackUrl - HTTPS callback URL (pre-validated by registerCallbackUrl)
 * @param messageEnvelope - Message envelope object (will be JSON stringified and signed)
 * @param sendingAgentId - Agent identity sending this message
 * @param pool - Postgres connection pool for secret lookup and logging
 * @param messageId - Optional message_id from message_ledger (for audit trail)
 * @param targetHostId - Optional target host identifier bound into the HMAC scope (F1/AC-7)
 *
 * @returns { status, body } of final HTTP response
 * @throws {Error} if SSRF validation fails or all retry attempts exhausted
 */
export async function postDeliveryWithAuth(
	callbackUrl: string,
	messageEnvelope: object,
	sendingAgentId: string,
	pool: Pool,
	messageId?: number,
	targetHostId?: string,
): Promise<DeliveryResult> {
	// Step 1: Re-validate callback URL before delivery (DNS rebinding protection)
	try {
		await revalidateBeforeDelivery(callbackUrl);
	} catch (err) {
		const errorMsg =
			err instanceof Error ? err.message : "SSRF validation failed";

		// Log as blocked
		if (messageId) {
			await logDeliveryAttempt(pool, messageId, "blocked", null, errorMsg);
		}

		throw new Error(`SSRF validation failed: ${errorMsg}`);
	}

	// Step 2: Generate delivery metadata
	const deliveryId = crypto.randomUUID();
	const timestamp = Math.floor(Date.now() / 1000);

	// Step 3: Serialize message envelope (this exact string is signed AND sent)
	const bodyJson = JSON.stringify(messageEnvelope);

	// Step 4: Resolve delivery signing secret
	let signingSecret: string;
	try {
		// Try per-agent signing key first
		const registryResult = await pool.query<{
			delivery_signing_key: string;
		}>(
			`SELECT delivery_signing_key FROM roadmap.agent_registry WHERE identity = $1 LIMIT 1`,
			[sendingAgentId],
		);

		if (
			registryResult.rows.length > 0 &&
			registryResult.rows[0].delivery_signing_key
		) {
			signingSecret = registryResult.rows[0].delivery_signing_key;
		} else {
			// Fall back to environment variable
			signingSecret = process.env.DELIVERY_SIGNING_SECRET || "";
			if (!signingSecret) {
				throw new Error(
					"No delivery signing secret configured (set DELIVERY_SIGNING_SECRET env var or agent delivery_signing_key)",
				);
			}
		}
	} catch (err) {
		const errorMsg =
			err instanceof Error ? err.message : "Failed to resolve signing secret";

		if (messageId) {
			await logDeliveryAttempt(pool, messageId, "blocked", null, errorMsg);
		}

		throw new Error(`Signing secret resolution failed: ${errorMsg}`);
	}

	// Step 5: Build signing input — F1 (P1106): targetHostId is a delimited field
	// in the signing scope to prevent cross-host replay. Format:
	//   POST\n<path>\n<target_host_id>\nX-AgentHive-Delivery-Id: <id>\n...\n<body>
	const url = new URL(callbackUrl);
	const pathAndSearch = url.pathname + (url.search || "");

	const targetHostField = targetHostId ? `\n${targetHostId}` : "";

	const signingInput = `POST\n${pathAndSearch}${targetHostField}\nX-AgentHive-Delivery-Id: ${deliveryId}\nX-AgentHive-Timestamp: ${timestamp}\nX-AgentHive-Agent-Id: ${sendingAgentId}\n${bodyJson}`;

	// Step 6: HMAC-SHA256 signature
	const signature = crypto
		.createHmac("sha256", Buffer.from(signingSecret, "hex"))
		.update(signingInput, "utf-8")
		.digest();

	const signatureHeader = `sha256=${signature.toString("hex")}`;

	// Step 7: Execute delivery with retry
	let lastError: Error | null = null;
	let finalStatus = 0;
	let finalBody = "";

	const deliveryHeaders: Record<string, string> = {
		"Content-Type": "application/json",
		"X-AgentHive-Signature": signatureHeader,
		"X-AgentHive-Delivery-Id": deliveryId,
		"X-AgentHive-Timestamp": String(timestamp),
		"X-AgentHive-Agent-Id": sendingAgentId,
	};
	if (targetHostId) {
		deliveryHeaders["X-AgentHive-Target-Host-Id"] = targetHostId;
	}

	for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) {
		try {
			const result = await fetchWithTimeout(callbackUrl, {
				method: "POST",
				headers: deliveryHeaders,
				body: bodyJson,
			});

			finalStatus = result.status;
			finalBody = result.body;

			// Success (2xx)
			if (finalStatus >= 200 && finalStatus < 300) {
				if (messageId) {
					await logDeliveryAttempt(pool, messageId, "success", finalStatus);
				}
				return { status: finalStatus, body: finalBody };
			}

			// 4xx error — don't retry
			if (finalStatus >= 400 && finalStatus < 500) {
				if (messageId) {
					await logDeliveryAttempt(pool, messageId, "4xx", finalStatus);
				}
				return { status: finalStatus, body: finalBody };
			}

			// 5xx error — retry
			if (finalStatus >= 500) {
				lastError = new Error(`Server error: ${finalStatus}`);
				// Continue to next attempt
			} else {
				// Other status code — treat as success to avoid loop
				if (messageId) {
					await logDeliveryAttempt(pool, messageId, "success", finalStatus);
				}
				return { status: finalStatus, body: finalBody };
			}
		} catch (err) {
			lastError =
				err instanceof Error ? err : new Error(`Network error: ${String(err)}`);
		}

		// Exponential backoff (1s, 2s, 4s)
		if (attempt < MAX_DELIVERY_ATTEMPTS - 1) {
			const backoffMs = 2 ** attempt * 1000;
			await new Promise((resolve) => setTimeout(resolve, backoffMs));
		}
	}

	// Step 8: All retries exhausted — log as 5xx failure
	if (messageId) {
		await logDeliveryAttempt(pool, messageId, "5xx", finalStatus || null);
	}

	// Step 9: Insert NACK into message_ledger
	if (messageId) {
		await insertDeliveryNack(
			pool,
			messageId,
			sendingAgentId,
			lastError?.message || "Unknown error",
		);
	}

	throw lastError || new Error("Delivery failed after all retries");
}

/**
 * Canonicalize and validate the request target (path + query).
 *
 * Rejects:
 * - Empty string
 * - Absolute URLs (e.g., 'http://host/path')
 * - Targets without leading '/'
 * - Targets with control characters (e.g., newlines, which could enable header injection)
 *
 * Returns the validated target unchanged, or throws an error with reason for audit logging.
 *
 * @param requestTarget - HTTP request target from req.url or req.originalUrl
 * @returns the validated request target
 * @throws {Error} with message formatted as `invalid_<reason>` for audit trail
 */
export function canonicalizeRequestTarget(requestTarget: string): string {
	// Reject empty string
	if (!requestTarget || requestTarget.length === 0) {
		throw new Error("invalid_request_target:empty");
	}

	// Reject absolute URLs (contains "://")
	if (requestTarget.includes("://")) {
		throw new Error("invalid_request_target:absolute_url");
	}

	// Reject targets without leading slash
	if (!requestTarget.startsWith("/")) {
		throw new Error("invalid_request_target:no_leading_slash");
	}

	// Reject targets containing control characters (newline, carriage return, null, etc.)
	// This prevents header injection via request target manipulation
	if (/[\x00-\x1f\x7f]/.test(requestTarget)) {
		throw new Error("invalid_request_target:control_char");
	}

	return requestTarget;
}

/**
 * Log a signature verification failure to the audit trail.
 *
 * Uses agent_lifecycle_log with event_type='sig_verify_failed' and reason in details.
 * This is sparse but sufficient for post-incident analysis of replay attacks.
 *
 * @param pool - Postgres connection pool
 * @param deliveryId - X-AgentHive-Delivery-Id header value
 * @param agentId - X-AgentHive-Agent-Id header value
 * @param reason - one of: invalid_signature, timestamp_expired, duplicate_id, invalid_request_target
 */
async function auditSignatureFailure(
	pool: Pool,
	deliveryId: string,
	agentId: string,
	reason: "invalid_signature" | "timestamp_expired" | "duplicate_id" | "invalid_request_target",
): Promise<void> {
	try {
		await pool.query(
			`INSERT INTO roadmap.agent_lifecycle_log
			 (agency_id, event_type, details)
			 VALUES ($1, 'sig_verify_failed', $2)`,
			[agentId, JSON.stringify({ delivery_id: deliveryId, reason })],
		);
	} catch (err) {
		console.error(
			`[P1097] Failed to audit signature verification failure: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}
}

/**
 * Verify an incoming callback delivery signature.
 *
 * Steps:
 * 1. Extract headers: X-AgentHive-Signature, X-AgentHive-Delivery-Id, X-AgentHive-Timestamp, X-AgentHive-Agent-Id
 * 2. Validate request target (AC-9: reject unsafe targets)
 * 3. Reject if timestamp > 300 seconds old (5-minute replay window)
 * 4. Check delivery_id against delivery_id_log (INSERT ON CONFLICT DO NOTHING; rowCount=0 → duplicate)
 * 5. Rebuild signing input identically to sender, using the actual request target
 * 6. crypto.timingSafeEqual comparison (NOT string ===)
 *
 * F1 (P1106): targetHostId is included as a delimited field in the reconstructed signing input.
 * This binds the signature to a specific target host and prevents cross-host replay attacks.
 * targetHostId can be passed either as a parameter or extracted from X-AgentHive-Target-Host-Id header;
 * parameter takes precedence (for test flexibility).
 *
 * @param rawBody - Exact HTTP request body (as string or Buffer)
 * @param headers - HTTP request headers (case-insensitive keys acceptable)
 * @param signingSecret - HMAC secret (hex-encoded)
 * @param pool - Postgres connection pool for dedup check
 * @param requestTarget - HTTP request target (path + query, e.g., '/webhook/msg?tenant=agenthive&v=1').
 *                        Must start with '/', no control chars, no absolute URLs. AC-1: This is required (no default).
 * @param targetHostId - Optional target host identifier (AC-29: prevents cross-host replay when included in HMAC scope)
 *
 * @returns true if signature is valid and not a duplicate, false otherwise
 */
export async function verifyDeliverySignature(
	rawBody: string | Buffer,
	headers: Record<string, string>,
	signingSecret: string,
	pool: Pool,
	requestTarget?: string,
	targetHostId?: string,
): Promise<boolean> {
	try {
		// Step 1: Extract headers (normalize keys to lowercase)
		const normalizedHeaders: Record<string, string> = {};
		for (const [key, value] of Object.entries(headers)) {
			normalizedHeaders[key.toLowerCase()] = value;
		}

		const signatureHeader = normalizedHeaders["x-agenthive-signature"] || "";
		const deliveryId = normalizedHeaders["x-agenthive-delivery-id"] || "";
		const timestampStr = normalizedHeaders["x-agenthive-timestamp"] || "";
		const agentId = normalizedHeaders["x-agenthive-agent-id"] || "";
		// F1: include target_host_id in signing input reconstruction if present
		// Parameter targetHostId takes precedence over header (for test flexibility and future flexibility)
		const resolvedTargetHostId = targetHostId || normalizedHeaders["x-agenthive-target-host-id"] || "";

		if (!signatureHeader || !deliveryId || !timestampStr || !agentId) {
			return false;
		}

		// Step 2: Validate and canonicalize request target (AC-9: reject unsafe targets early)
		let pathAndSearch: string;
		try {
			pathAndSearch = canonicalizeRequestTarget(requestTarget);
		} catch (err) {
			// Extract reason from error message (e.g., "invalid_request_target:empty" → "invalid_request_target")
			const reason = "invalid_request_target";
			await auditSignatureFailure(pool, deliveryId, agentId, reason);
			return false;
		}

		// Step 3: Validate timestamp (must be within 5 minutes)
		const timestamp = parseInt(timestampStr, 10);
		if (isNaN(timestamp)) {
			return false;
		}

		const nowEpoch = Math.floor(Date.now() / 1000);
		if (Math.abs(nowEpoch - timestamp) > 300) {
			await auditSignatureFailure(pool, deliveryId, agentId, "timestamp_expired");
			return false; // Timestamp too old or in future
		}

		// Step 4: Check delivery_id against dedup log
		const isDuplicate = await checkAndLogDeliveryId(pool, deliveryId);
		if (isDuplicate) {
			await auditSignatureFailure(pool, deliveryId, agentId, "duplicate_id");
			return false; // Duplicate delivery
		}

		// Step 5: Rebuild signing input using the actual request target (P1097 fix)
		const bodyStr =
			rawBody instanceof Buffer ? rawBody.toString("utf-8") : rawBody;

		const targetHostField = resolvedTargetHostId ? `\n${resolvedTargetHostId}` : "";

		const signingInput = `POST\n${pathAndSearch}${targetHostField}\nX-AgentHive-Delivery-Id: ${deliveryId}\nX-AgentHive-Timestamp: ${timestamp}\nX-AgentHive-Agent-Id: ${agentId}\n${bodyStr}`;

		// Step 6: Verify signature using constant-time comparison
		const expectedSignature = crypto
			.createHmac("sha256", Buffer.from(signingSecret, "hex"))
			.update(signingInput, "utf-8")
			.digest();

		// Extract signature value from header (e.g., "sha256=<hex>")
		const [scheme, providedSigHex] = signatureHeader.split("=");
		if (scheme !== "sha256" || !providedSigHex) {
			await auditSignatureFailure(pool, deliveryId, agentId, "invalid_signature");
			return false;
		}

		// Constant-time comparison (AC-9: don't call timingSafeEqual if target was invalid)
		try {
			const isValid = crypto.timingSafeEqual(
				expectedSignature,
				Buffer.from(providedSigHex, "hex"),
			);
			if (!isValid) {
				await auditSignatureFailure(pool, deliveryId, agentId, "invalid_signature");
			}
			return isValid;
		} catch {
			// timingSafeEqual throws if buffers are different lengths
			await auditSignatureFailure(pool, deliveryId, agentId, "invalid_signature");
			return false;
		}
	} catch (err) {
		// Catch unexpected errors and fail safely
		return false;
	}
}

/**
 * Fetch with timeout support.
 * Returns { status, body }.
 *
 * @throws {Error} on network error or timeout
 */
async function fetchWithTimeout(
	url: string,
	options: {
		method: string;
		headers: Record<string, string>;
		body: string;
	},
): Promise<{ status: number; body: string }> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

	try {
		const response = await fetch(url, {
			method: options.method,
			headers: options.headers,
			body: options.body,
			signal: controller.signal,
		});

		const body = await response.text();
		return { status: response.status, body };
	} finally {
		clearTimeout(timeoutId);
	}
}

/**
 * Log a delivery attempt to message_validity_log.
 */
async function logDeliveryAttempt(
	pool: Pool,
	messageId: number,
	status: "pending" | "success" | "4xx" | "5xx" | "blocked",
	responseCode: number | null,
	errorMsg?: string,
): Promise<void> {
	try {
		await pool.query(
			`INSERT INTO roadmap.message_validity_log
			  (message_id, delivery_attempted_at, delivery_status, delivery_response_code)
			 VALUES ($1, now(), $2, $3)`,
			[messageId, status, responseCode],
		);
	} catch (err) {
		console.error("[P836] Failed to log delivery attempt:", err);
	}
}

/**
 * Check and log a delivery_id to prevent replays.
 * Returns true if this delivery_id was already seen (duplicate).
 */
async function checkAndLogDeliveryId(
	pool: Pool,
	deliveryId: string,
): Promise<boolean> {
	try {
		const result = await pool.query(
			`INSERT INTO roadmap.delivery_id_log (delivery_id) VALUES ($1)
			 ON CONFLICT DO NOTHING
			 RETURNING delivery_id`,
			[deliveryId],
		);

		// If no rows returned, it was a duplicate
		return result.rows.length === 0;
	} catch (err) {
		console.error("[P836] Failed to check delivery_id:", err);
		// On error, treat as duplicate to be safe
		return true;
	}
}

/**
 * Insert a NACK message for failed delivery.
 */
async function insertDeliveryNack(
	pool: Pool,
	messageId: number,
	originalSender: string,
	failureReason: string,
): Promise<void> {
	try {
		// Fetch correlation_id from original message
		const { rows: original } = await pool.query(
			`SELECT correlation_id FROM roadmap.message_ledger WHERE id = $1`,
			[messageId],
		);
		const correlationId = original[0]?.correlation_id;

		await pool.query(
			`INSERT INTO roadmap.message_ledger
			  (from_agent, to_agent, message_type, message_content, correlation_id, reply_to)
			 VALUES ($1, $2, 'nack', $3, $4, $5)`,
			[
				"system:cross-host-relay",
				originalSender,
				JSON.stringify({
					original_message_id: messageId,
					failure_reason: "delivery_failed_all_retries",
					retriable: true,
					details: failureReason,
					timestamp: new Date().toISOString(),
				}),
				correlationId,
				messageId,
			],
		);
	} catch (err) {
		console.error("[P836] Failed to insert delivery NACK:", err);
	}
}

/**
 * Cleanup old delivery_id_log entries (older than 10 minutes).
 * Uses pg_try_advisory_lock(836836) so only one replica runs the DELETE at a time;
 * other replicas skip the tick harmlessly. Advisory lock auto-releases on connection return.
 */
export async function cleanupDeliveryIdLog(pool: Pool): Promise<void> {
	const client = await pool.connect();
	try {
		// Advisory lock key 836836 (unique to P836 cleanup). Returns false if another
		// replica holds the lock — skip this tick rather than running concurrent deletes.
		const lockResult = await client.query<{ acquired: boolean }>(
			`SELECT pg_try_advisory_lock(836836) AS acquired`,
		);
		if (!lockResult.rows[0]?.acquired) {
			return;
		}

		const result = await client.query(
			`DELETE FROM roadmap.delivery_id_log
			 WHERE received_at < now() - interval '10 minutes'`,
		);

		if ((result.rowCount || 0) > 0) {
			console.log(
				`[P836] Cleaned up ${result.rowCount} old delivery_id entries`,
			);
		}
	} catch (err) {
		console.error("[P836] Failed to cleanup delivery_id_log:", err);
	} finally {
		// Releasing the client back to the pool releases the advisory lock automatically.
		client.release();
	}
}

/**
 * Register the delivery_id_log cleanup cron to run every 5 minutes.
 * Singleton guard prevents double-registration in a single process.
 * Multi-replica safety is provided by pg_try_advisory_lock inside cleanupDeliveryIdLog.
 */
export async function registerDeliveryIdLogCleanup(pool: Pool): Promise<void> {
	const globalKey = "__deliveryIdLogCleanupInterval";
	if ((globalThis as Record<string, unknown>)[globalKey]) {
		console.log("[P836] Delivery ID log cleanup already registered — skipping");
		return;
	}

	// Check table exists before scheduling
	const tableCheck = await pool.query<{ count: string }>(
		`SELECT COUNT(*) AS count FROM information_schema.tables
		 WHERE table_schema = 'roadmap' AND table_name = 'delivery_id_log'`,
	);
	if (Number(tableCheck.rows[0]?.count ?? 0) === 0) {
		console.warn(
			"[P836] delivery_id_log table not found — cleanup cron skipped",
		);
		return;
	}

	const interval = setInterval(
		() => {
			void cleanupDeliveryIdLog(pool).catch((err) => {
				console.error(
					`[P836] Unhandled error in delivery ID log cleanup: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			});
		},
		5 * 60 * 1000,
	); // 5 minutes

	(globalThis as Record<string, unknown>)[globalKey] = interval;
	console.log(
		"[P836] Delivery ID log cleanup cron registered (every 5 minutes, advisory-lock guarded)",
	);
}
