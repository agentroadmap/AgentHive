/**
 * P836 Integration Tests — Cross-Host Delivery
 *
 * Suite 3 of the A2A test plan (a2aTest session, 2026-05-05).
 *
 * Schema scope: `roadmap.delivery_id_log` was applied during this session
 * (just the table from migration 103 — the rest of 103 fails because
 * agent_registry is a view and message_validity_log doesn't exist; those are
 * out of scope for this suite).
 *
 * What is NOT tested here:
 *   - SSRF blocking by resolved IP. The validator does live DNS via
 *     dns/promises and the IP-check helpers (ipv4InRange/ipv6InRange/
 *     isAddressBlocked/normalizeIP) are not exported, so block-by-resolved-IP
 *     would need a dns module mock. Documented as a TODO; pre-DNS branches
 *     (URL parsing, scheme validation, dev-mode bypass) are covered.
 *   - postDeliveryWithAuth full flow. Its NACK branch INSERTs into
 *     message_ledger with `from_agent='system:cross-host-relay'` which both
 *     fails the `(direct|team|broadcast|system…)` channel CHECK on the
 *     ledger AND the agent_registry FK. Out of scope.
 *
 * What IS tested:
 *   - validateCallbackUrl pre-DNS branches (URL parsing, scheme rejection,
 *     dev-mode localhost bypass).
 *   - verifyDeliverySignature: happy path, tampered body, expired
 *     timestamp, duplicate delivery_id, missing headers, wrong scheme.
 *   - cleanupDeliveryIdLog: deletes rows older than 10 minutes, preserves
 *     recent rows.
 */

import assert from "node:assert";
import crypto from "node:crypto";
import { after, describe, it } from "node:test";
import { Pool } from "pg";
import {
	cleanupDeliveryIdLog,
	verifyDeliverySignature,
} from "../../src/infra/messaging/cross-host-relay.ts";
import { validateCallbackUrl } from "../../src/infra/security/callback-url-validator.ts";
import { closePool, query } from "../../src/infra/postgres/pool.ts";

const TS = Date.now();
const SIGNING_SECRET_HEX = crypto.randomBytes(32).toString("hex");
const AGENT_ID = `test/p836/sender-${TS}`;
const DEV_MODE = true;

// We need a `pg.Pool` for cross-host-relay; reuse the project's connection
// settings via env vars (PGHOST/PGUSER/etc are set by /etc/agenthive/env).
const pool = new Pool();

after(async () => {
	await query(
		`DELETE FROM roadmap.delivery_id_log WHERE delivery_id::text LIKE $1`,
		[`%`], // we'll use a more targeted cleanup per test instead
	);
	await pool.end();
	await closePool();
});

// ─── validateCallbackUrl (pre-DNS branches) ────────────────────────────────────

describe("validateCallbackUrl (pre-DNS)", () => {
	it("throws on invalid URL string", async () => {
		await assert.rejects(
			() => validateCallbackUrl("not a url at all", DEV_MODE),
			/Invalid callback URL/,
		);
	});

	it("throws on unsupported scheme", async () => {
		await assert.rejects(
			() => validateCallbackUrl("ftp://example.com/cb", DEV_MODE),
			/Invalid scheme/,
		);
	});

	it("rejects http:// when isDevMode=false", async () => {
		await assert.rejects(
			() => validateCallbackUrl("http://example.com/cb", false),
			/HTTP callback URLs not allowed in production/,
		);
	});

	it("dev-mode bypass: localhost is accepted without DNS resolution", async () => {
		await validateCallbackUrl("http://localhost:9999/cb", true);
		await validateCallbackUrl("http://127.0.0.1:9999/cb", true);
		// Reaching this point without throw is the assertion.
		assert.ok(true);
	});

	// TODO: SSRF block-by-resolved-IP test. Requires mocking dns/promises
	// (resolve4/resolve6) — IP-check helpers are not exported. Add when a
	// dns module mock is wired up.
});

// ─── verifyDeliverySignature ───────────────────────────────────────────────────

function buildHeaders(opts: {
	deliveryId: string;
	timestamp: number;
	agentId: string;
	body: string;
	secretHex: string;
	schemePrefix?: string; // for malformed-scheme tests
	targetHostId?: string; // F1: included in HMAC scope to prevent cross-host replay
}): Record<string, string> {
	const targetHostId = opts.targetHostId ?? "";
	const signingInput =
		`POST\n/\nX-AgentHive-Delivery-Id: ${opts.deliveryId}\nX-AgentHive-Timestamp: ${opts.timestamp}\nX-AgentHive-Agent-Id: ${opts.agentId}\nX-AgentHive-Target-Host-Id: ${targetHostId}\n${opts.body}`;
	const sig = crypto
		.createHmac("sha256", Buffer.from(opts.secretHex, "hex"))
		.update(signingInput, "utf-8")
		.digest("hex");
	return {
		"x-agenthive-signature": `${opts.schemePrefix ?? "sha256"}=${sig}`,
		"x-agenthive-delivery-id": opts.deliveryId,
		"x-agenthive-timestamp": String(opts.timestamp),
		"x-agenthive-agent-id": opts.agentId,
		"x-agenthive-target-host-id": targetHostId,
	};
}

describe("verifyDeliverySignature", () => {
	it("accepts a valid signature with fresh timestamp and unseen delivery_id", async () => {
		const body = JSON.stringify({ hello: "world" });
		const deliveryId = crypto.randomUUID();
		const headers = buildHeaders({
			deliveryId,
			timestamp: Math.floor(Date.now() / 1000),
			agentId: AGENT_ID,
			body,
			secretHex: SIGNING_SECRET_HEX,
		});
		const ok = await verifyDeliverySignature(body, headers, SIGNING_SECRET_HEX, pool);
		assert.equal(ok, true);

		// Cleanup
		await query(`DELETE FROM roadmap.delivery_id_log WHERE delivery_id = $1`, [deliveryId]);
	});

	it("rejects when body is tampered after signing", async () => {
		const body = JSON.stringify({ hello: "world" });
		const deliveryId = crypto.randomUUID();
		const headers = buildHeaders({
			deliveryId,
			timestamp: Math.floor(Date.now() / 1000),
			agentId: AGENT_ID,
			body,
			secretHex: SIGNING_SECRET_HEX,
		});
		const ok = await verifyDeliverySignature(
			JSON.stringify({ hello: "WORLD" }), // tampered
			headers,
			SIGNING_SECRET_HEX,
			pool,
		);
		assert.equal(ok, false);
		await query(`DELETE FROM roadmap.delivery_id_log WHERE delivery_id = $1`, [deliveryId]);
	});

	it("rejects expired timestamp (older than 5 minutes)", async () => {
		const body = "{}";
		const deliveryId = crypto.randomUUID();
		const oldTs = Math.floor(Date.now() / 1000) - 600; // 10 min ago
		const headers = buildHeaders({
			deliveryId,
			timestamp: oldTs,
			agentId: AGENT_ID,
			body,
			secretHex: SIGNING_SECRET_HEX,
		});
		const ok = await verifyDeliverySignature(body, headers, SIGNING_SECRET_HEX, pool);
		assert.equal(ok, false);
	});

	it("rejects far-future timestamp (skew > 5 minutes)", async () => {
		const body = "{}";
		const deliveryId = crypto.randomUUID();
		const futureTs = Math.floor(Date.now() / 1000) + 600;
		const headers = buildHeaders({
			deliveryId,
			timestamp: futureTs,
			agentId: AGENT_ID,
			body,
			secretHex: SIGNING_SECRET_HEX,
		});
		const ok = await verifyDeliverySignature(body, headers, SIGNING_SECRET_HEX, pool);
		assert.equal(ok, false);
	});

	it("rejects duplicate delivery_id (replay protection)", async () => {
		const body = "{}";
		const deliveryId = crypto.randomUUID();
		const ts = Math.floor(Date.now() / 1000);
		const headers = buildHeaders({
			deliveryId,
			timestamp: ts,
			agentId: AGENT_ID,
			body,
			secretHex: SIGNING_SECRET_HEX,
		});
		const first = await verifyDeliverySignature(body, headers, SIGNING_SECRET_HEX, pool);
		assert.equal(first, true, "first delivery should pass");

		// Replay the exact same headers/body — should be rejected because the
		// delivery_id is now in delivery_id_log.
		const replay = await verifyDeliverySignature(body, headers, SIGNING_SECRET_HEX, pool);
		assert.equal(replay, false, "second delivery with same delivery_id must fail");

		await query(`DELETE FROM roadmap.delivery_id_log WHERE delivery_id = $1`, [deliveryId]);
	});

	it("rejects when any required header is missing", async () => {
		const body = "{}";
		const ts = Math.floor(Date.now() / 1000);
		const deliveryId = crypto.randomUUID();
		const full = buildHeaders({
			deliveryId,
			timestamp: ts,
			agentId: AGENT_ID,
			body,
			secretHex: SIGNING_SECRET_HEX,
		});

		for (const drop of [
			"x-agenthive-signature",
			"x-agenthive-delivery-id",
			"x-agenthive-timestamp",
			"x-agenthive-agent-id",
		]) {
			const partial = { ...full };
			delete (partial as Record<string, string>)[drop];
			const ok = await verifyDeliverySignature(body, partial, SIGNING_SECRET_HEX, pool);
			assert.equal(ok, false, `must reject when ${drop} is missing`);
		}
	});

	it("rejects when signature scheme is not 'sha256='", async () => {
		const body = "{}";
		const deliveryId = crypto.randomUUID();
		const ts = Math.floor(Date.now() / 1000);
		const headers = buildHeaders({
			deliveryId,
			timestamp: ts,
			agentId: AGENT_ID,
			body,
			secretHex: SIGNING_SECRET_HEX,
			schemePrefix: "md5",
		});
		const ok = await verifyDeliverySignature(body, headers, SIGNING_SECRET_HEX, pool);
		assert.equal(ok, false);
	});

	it("rejects when signature length differs from expected (timingSafeEqual length guard)", async () => {
		const body = "{}";
		const deliveryId = crypto.randomUUID();
		const ts = Math.floor(Date.now() / 1000);
		const headers = buildHeaders({
			deliveryId,
			timestamp: ts,
			agentId: AGENT_ID,
			body,
			secretHex: SIGNING_SECRET_HEX,
		});
		// Truncate the hex signature to a different length
		headers["x-agenthive-signature"] = "sha256=deadbeef";
		const ok = await verifyDeliverySignature(body, headers, SIGNING_SECRET_HEX, pool);
		assert.equal(ok, false);

		await query(`DELETE FROM roadmap.delivery_id_log WHERE delivery_id = $1`, [deliveryId]);
	});
});

// ─── cleanupDeliveryIdLog ──────────────────────────────────────────────────────

describe("cleanupDeliveryIdLog", () => {
	it("deletes rows older than 10 minutes and preserves recent rows", async () => {
		const oldId = crypto.randomUUID();
		const recentId = crypto.randomUUID();

		await query(
			`INSERT INTO roadmap.delivery_id_log (delivery_id, received_at)
			 VALUES ($1, now() - interval '15 minutes'),
			        ($2, now() - interval '1 minute')`,
			[oldId, recentId],
		);

		await cleanupDeliveryIdLog(pool);

		const oldR = await query(
			`SELECT 1 FROM roadmap.delivery_id_log WHERE delivery_id = $1`,
			[oldId],
		);
		const recentR = await query(
			`SELECT 1 FROM roadmap.delivery_id_log WHERE delivery_id = $1`,
			[recentId],
		);
		assert.equal(oldR.rows.length, 0, "stale row must be cleaned");
		assert.equal(recentR.rows.length, 1, "recent row must remain");

		// Cleanup
		await query(`DELETE FROM roadmap.delivery_id_log WHERE delivery_id = $1`, [recentId]);
	});
});
