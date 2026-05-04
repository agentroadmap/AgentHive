/**
 * P836: A2A Cross-Host Delivery Worker
 *
 * Handles HTTP callback delivery of A2A messages with:
 * 1. SSRF prevention (validateCallbackUrl + DNS rebinding re-validation)
 * 2. HMAC-SHA256 delivery authentication with per-agent signing keys
 * 3. Delivery deduplication via delivery_id_log (replay prevention)
 * 4. Retry with exponential backoff (1s, 2s, 4s)
 * 5. Audit trail in message_validity_log
 */

import crypto from "crypto";
import { Pool } from "pg";
import {
	validateCallbackUrl,
	revalidateBeforeDelivery,
} from "../security/callback-url-validator.ts";
import { getAgentSecret } from "../security/agent-secret-store.ts";
import { deriveSigningKey } from "../security/agent-crypto.ts";

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
 * 6. POST with headers: X-AgentHive-Signature, X-AgentHive-Delivery-Id, X-AgentHive-Timestamp, X-AgentHive-Agent-Id
 * 7. Log to message_validity_log (delivery_attempted_at, delivery_status, delivery_response_code)
 * 8. Retry up to 3 times with exponential backoff on 5xx or network error
 * 9. On all failures: insert NACK into message_ledger
 *
 * @param callbackUrl - HTTPS callback URL (pre-validated by registerCallbackUrl)
 * @param messageEnvelope - Message envelope object (will be JSON stringified and signed)
 * @param sendingAgentId - Agent identity sending this message
 * @param pool - Postgres connection pool for secret lookup and logging
 * @param messageId - Optional message_id from message_ledger (for audit trail)
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
): Promise<DeliveryResult> {
	// Step 1: Re-validate callback URL before delivery (DNS rebinding protection)
	try {
		await revalidateBeforeDelivery(callbackUrl);
	} catch (err) {
		const errorMsg =
			err instanceof Error ? err.message : "SSRF validation failed";

		// Log as blocked
		if (messageId) {
			await logDeliveryAttempt(
				pool,
				messageId,
				"blocked",
				null,
				errorMsg,
			);
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
			await logDeliveryAttempt(
				pool,
				messageId,
				"blocked",
				null,
				errorMsg,
			);
		}

		throw new Error(`Signing secret resolution failed: ${errorMsg}`);
	}

	// Step 5: Build signing input
	const url = new URL(callbackUrl);
	const pathAndSearch = url.pathname + (url.search || "");

	const signingInput =
		`POST\n${pathAndSearch}\nX-AgentHive-Delivery-Id: ${deliveryId}\nX-AgentHive-Timestamp: ${timestamp}\nX-AgentHive-Agent-Id: ${sendingAgentId}\n${bodyJson}`;

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

	for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) {
		try {
			const result = await fetchWithTimeout(callbackUrl, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-AgentHive-Signature": signatureHeader,
					"X-AgentHive-Delivery-Id": deliveryId,
					"X-AgentHive-Timestamp": String(timestamp),
					"X-AgentHive-Agent-Id": sendingAgentId,
				},
				body: bodyJson,
			});

			finalStatus = result.status;
			finalBody = result.body;

			// Success (2xx)
			if (finalStatus >= 200 && finalStatus < 300) {
				if (messageId) {
					await logDeliveryAttempt(
						pool,
						messageId,
						"success",
						finalStatus,
					);
				}
				return { status: finalStatus, body: finalBody };
			}

			// 4xx error — don't retry
			if (finalStatus >= 400 && finalStatus < 500) {
				if (messageId) {
					await logDeliveryAttempt(
						pool,
						messageId,
						"4xx",
						finalStatus,
					);
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
					await logDeliveryAttempt(
						pool,
						messageId,
						"success",
						finalStatus,
					);
				}
				return { status: finalStatus, body: finalBody };
			}
		} catch (err) {
			lastError =
				err instanceof Error
					? err
					: new Error(`Network error: ${String(err)}`);
		}

		// Exponential backoff (1s, 2s, 4s)
		if (attempt < MAX_DELIVERY_ATTEMPTS - 1) {
			const backoffMs = Math.pow(2, attempt) * 1000;
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
 * Verify an incoming callback delivery signature.
 *
 * Steps:
 * 1. Extract headers: X-AgentHive-Signature, X-AgentHive-Delivery-Id, X-AgentHive-Timestamp, X-AgentHive-Agent-Id
 * 2. Reject if timestamp > 300 seconds old (5-minute replay window)
 * 3. Check delivery_id against delivery_id_log (INSERT ON CONFLICT DO NOTHING; rowCount=0 → duplicate)
 * 4. Rebuild signing input identically to sender
 * 5. crypto.timingSafeEqual comparison (NOT string ===)
 *
 * @param rawBody - Exact HTTP request body (as string or Buffer)
 * @param headers - HTTP request headers (case-insensitive keys acceptable)
 * @param signingSecret - HMAC secret (hex-encoded)
 * @param pool - Postgres connection pool for dedup check
 *
 * @returns true if signature is valid and not a duplicate, false otherwise
 */
export async function verifyDeliverySignature(
	rawBody: string | Buffer,
	headers: Record<string, string>,
	signingSecret: string,
	pool: Pool,
): Promise<boolean> {
	try {
		// Step 1: Extract headers (normalize keys to lowercase)
		const normalizedHeaders: Record<string, string> = {};
		for (const [key, value] of Object.entries(headers)) {
			normalizedHeaders[key.toLowerCase()] = value;
		}

		const signatureHeader =
			normalizedHeaders["x-agenthive-signature"] || "";
		const deliveryId = normalizedHeaders["x-agenthive-delivery-id"] || "";
		const timestampStr = normalizedHeaders["x-agenthive-timestamp"] || "";
		const agentId = normalizedHeaders["x-agenthive-agent-id"] || "";

		if (!signatureHeader || !deliveryId || !timestampStr || !agentId) {
			return false;
		}

		// Step 2: Validate timestamp (must be within 5 minutes)
		const timestamp = parseInt(timestampStr, 10);
		if (isNaN(timestamp)) {
			return false;
		}

		const nowEpoch = Math.floor(Date.now() / 1000);
		if (Math.abs(nowEpoch - timestamp) > 300) {
			return false; // Timestamp too old or in future
		}

		// Step 3: Check delivery_id against dedup log
		const isDuplicate = await checkAndLogDeliveryId(pool, deliveryId);
		if (isDuplicate) {
			return false; // Duplicate delivery
		}

		// Step 4: Rebuild signing input
		// Note: We assume path is "/" for the callback endpoint (adjust as needed)
		const pathAndSearch = "/"; // Callback endpoints typically use fixed path
		const bodyStr =
			rawBody instanceof Buffer ? rawBody.toString("utf-8") : rawBody;

		const signingInput =
			`POST\n${pathAndSearch}\nX-AgentHive-Delivery-Id: ${deliveryId}\nX-AgentHive-Timestamp: ${timestamp}\nX-AgentHive-Agent-Id: ${agentId}\n${bodyStr}`;

		// Step 5: Verify signature using constant-time comparison
		const expectedSignature = crypto
			.createHmac("sha256", Buffer.from(signingSecret, "hex"))
			.update(signingInput, "utf-8")
			.digest();

		// Extract signature value from header (e.g., "sha256=<hex>")
		const [scheme, providedSigHex] = signatureHeader.split("=");
		if (scheme !== "sha256" || !providedSigHex) {
			return false;
		}

		// Constant-time comparison
		try {
			return crypto.timingSafeEqual(
				expectedSignature,
				Buffer.from(providedSigHex, "hex"),
			);
		} catch {
			// timingSafeEqual throws if buffers are different lengths
			return false;
		}
	} catch {
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
	const timeoutId = setTimeout(
		() => controller.abort(),
		DELIVERY_TIMEOUT_MS,
	);

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
		await pool.query(
			`INSERT INTO roadmap.message_ledger
			  (from_agent, to_agent, message_type, message_content)
			 VALUES ($1, $2, 'nack', $3)`,
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
			],
		);
	} catch (err) {
		console.error("[P836] Failed to insert delivery NACK:", err);
	}
}

/**
 * Cleanup old delivery_id_log entries (older than 10 minutes).
 * Call this periodically (e.g., every 5 minutes) to prevent table growth.
 */
export async function cleanupDeliveryIdLog(pool: Pool): Promise<void> {
	try {
		const result = await pool.query(
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
	}
}
