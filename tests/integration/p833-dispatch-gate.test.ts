/**
 * P833 Integration Tests — Dispatch Gate (msg_ack / msg_reply / msg_wait_reply)
 *
 * Suite 1 of the A2A test plan (a2aTest session, 2026-05-05).
 *
 * Tests live against `agenthive.roadmap.message_ledger`. Migration 101 was
 * fixed and applied earlier in this session (the original `ADD CONSTRAINT
 * IF NOT EXISTS` was invalid PostgreSQL); message_type_contract was seeded
 * by hand because Phase 2/3 of 101 stops at agent_registry being a view.
 *
 * Regression anchors (documented bugs intentionally exercised):
 *   - msg-wait-reply.ts:156 — `Date.now() - Date.now() >= timeoutMs` is
 *     always false, so `message_timeout_tracking` INSERT after a poll
 *     timeout is dead code. The test below asserts the BUG (no row inserted).
 *     Fix in a separate proposal; flip the assertion when fixed.
 *
 * FK setup:
 *   message_ledger.from_agent / to_agent → roadmap_workforce.agent_registry
 *   (roadmap.agent_registry is a view over that table).
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { handleMsgAck } from "../../src/apps/mcp-server/tools/messages/msg-ack.ts";
import { handleMsgReply } from "../../src/apps/mcp-server/tools/messages/msg-reply.ts";
import { handleMsgWaitReply } from "../../src/apps/mcp-server/tools/messages/msg-wait-reply.ts";
import { closePool, query } from "../../src/infra/postgres/pool.ts";

const TS = Date.now();
const SENDER = `test/p833/sender-${TS}`;
const RECIPIENT = `test/p833/recipient-${TS}`;

// ─── Setup / Teardown ──────────────────────────────────────────────────────────

async function ensureAgent(identity: string) {
	await query(
		`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, status, trust_tier)
		 VALUES ($1, 'tool', 'active', 'known')
		 ON CONFLICT (agent_identity) DO NOTHING`,
		[identity],
	);
}

async function insertMessage(opts: {
	from: string;
	to: string;
	type: string;
	correlation?: string;
	content?: string;
}): Promise<number> {
	const r = await query(
		`INSERT INTO roadmap.message_ledger (from_agent, to_agent, message_type, message_content, correlation_id)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id`,
		[opts.from, opts.to, opts.type, opts.content ?? "test message", opts.correlation ?? null],
	);
	return r.rows[0].id;
}

before(async () => {
	await ensureAgent(SENDER);
	await ensureAgent(RECIPIENT);
});

after(async () => {
	// Clean up our test rows; agent_registry rows can stay (cheap, harmless).
	await query(
		`DELETE FROM roadmap.message_ledger WHERE from_agent IN ($1,$2) OR to_agent IN ($1,$2)`,
		[SENDER, RECIPIENT],
	);
	await closePool();
});

const getText = (r: { content: { type: string; text: string }[] }) => r.content[0]?.text ?? "";

// ─── msg_ack ───────────────────────────────────────────────────────────────────

describe("msg_ack", () => {
	it("sets acked_at + ack_outcome atomically on first call", async () => {
		const id = await insertMessage({ from: SENDER, to: RECIPIENT, type: "task" });
		// Insert a pending timeout entry to be cancelled on ack
		await query(
			`INSERT INTO roadmap.message_timeout_tracking (message_id, timeout_at, escalation_recipient)
			 VALUES ($1, now() + interval '5 minutes', 'liaison_hub')`,
			[id],
		);

		const r = await handleMsgAck({ message_id: id, outcome: "ok", reason: "test" });
		assert.match(getText(r), /acked with outcome: ok/);

		const row = await query(
			`SELECT acked_at, ack_outcome FROM roadmap.message_ledger WHERE id = $1`,
			[id],
		);
		assert.ok(row.rows[0].acked_at instanceof Date, "acked_at must be a timestamp");
		assert.equal(row.rows[0].ack_outcome, "ok");
	});

	it("is idempotent: a second ack returns the original outcome", async () => {
		// NOTE: live message_ledger_type_check restricts type to (text,task,notify,ack,error,event)
		// even though message_type_contract carries directive/request_assistance/etc. P833 drift.
		const id = await insertMessage({ from: SENDER, to: RECIPIENT, type: "task" });
		await handleMsgAck({ message_id: id, outcome: "reject" });
		const r2 = await handleMsgAck({ message_id: id, outcome: "ok" });
		assert.match(getText(r2), /already acked with outcome: reject/);

		const row = await query(
			`SELECT ack_outcome FROM roadmap.message_ledger WHERE id = $1`,
			[id],
		);
		assert.equal(row.rows[0].ack_outcome, "reject", "outcome must not be overwritten");
	});

	it("cancels pending timeout escalation by setting escalated_at = now()", async () => {
		const id = await insertMessage({ from: SENDER, to: RECIPIENT, type: "task" });
		await query(
			`INSERT INTO roadmap.message_timeout_tracking (message_id, timeout_at, escalation_recipient)
			 VALUES ($1, now() + interval '5 minutes', 'liaison_hub')`,
			[id],
		);

		await handleMsgAck({ message_id: id, outcome: "ok" });

		const t = await query(
			`SELECT escalated_at FROM roadmap.message_timeout_tracking WHERE message_id = $1`,
			[id],
		);
		assert.equal(t.rows.length, 1);
		assert.ok(t.rows[0].escalated_at instanceof Date, "escalated_at must be set after ack");
	});

	it("DB enforces ack_consistency CHECK: cannot have acked_at without ack_outcome", async () => {
		const id = await insertMessage({ from: SENDER, to: RECIPIENT, type: "task" });
		await assert.rejects(
			() =>
				query(
					`UPDATE roadmap.message_ledger SET acked_at = now(), ack_outcome = NULL WHERE id = $1`,
					[id],
				),
			/ack_consistency/,
		);
	});

	it("returns error when message_id is unknown", async () => {
		const r = await handleMsgAck({ message_id: 9_999_999_999, outcome: "ok" });
		assert.match(getText(r), /not found/i);
	});
});

// ─── msg_reply ─────────────────────────────────────────────────────────────────

describe("msg_reply", () => {
	it("inserts reply row carrying the same correlation_id", async () => {
		const corr = crypto.randomUUID();
		const id = await insertMessage({
			from: SENDER,
			to: RECIPIENT,
			type: "task",
			correlation: corr,
		});

		const r = await handleMsgReply({
			correlation_id: corr,
			content: "reply body",
			from_agent: RECIPIENT,
			message_type: "ack",
		});
		const replyText = getText(r);
		assert.match(replyText, /Reply sent/);

		const replies = await query(
			`SELECT id, from_agent, to_agent, correlation_id, message_type
			 FROM roadmap.message_ledger
			 WHERE correlation_id = $1 AND id <> $2`,
			[corr, id],
		);
		assert.equal(replies.rows.length, 1);
		assert.equal(replies.rows[0].from_agent, RECIPIENT);
		assert.equal(replies.rows[0].to_agent, SENDER);
		assert.equal(replies.rows[0].correlation_id, corr);
		assert.equal(replies.rows[0].message_type, "ack");
	});

	it("sets read_at on the original (NOT acked_at — verifies actual handler behaviour)", async () => {
		const corr = crypto.randomUUID();
		const id = await insertMessage({
			from: SENDER,
			to: RECIPIENT,
			type: "task",
			correlation: corr,
		});

		await handleMsgReply({
			correlation_id: corr,
			content: "x",
			from_agent: RECIPIENT,
		});

		const row = await query(
			`SELECT read_at, acked_at FROM roadmap.message_ledger WHERE id = $1`,
			[id],
		);
		assert.ok(row.rows[0].read_at instanceof Date, "read_at must be set by msg_reply");
		assert.equal(
			row.rows[0].acked_at,
			null,
			"acked_at must NOT be touched by msg_reply (only msg_ack writes it)",
		);
	});

	it("sets resolved_at on the original's pending timeout entry", async () => {
		const corr = crypto.randomUUID();
		const id = await insertMessage({
			from: SENDER,
			to: RECIPIENT,
			type: "task",
			correlation: corr,
		});
		await query(
			`INSERT INTO roadmap.message_timeout_tracking (message_id, timeout_at, escalation_recipient)
			 VALUES ($1, now() + interval '5 minutes', 'liaison_hub')`,
			[id],
		);

		await handleMsgReply({
			correlation_id: corr,
			content: "x",
			from_agent: RECIPIENT,
		});

		const t = await query(
			`SELECT resolved_at FROM roadmap.message_timeout_tracking WHERE message_id = $1`,
			[id],
		);
		assert.ok(t.rows[0].resolved_at instanceof Date, "resolved_at must be set after reply");
	});

	it("returns error when correlation_id is unknown for the agent", async () => {
		const r = await handleMsgReply({
			correlation_id: crypto.randomUUID(),
			content: "x",
			from_agent: RECIPIENT,
		});
		assert.match(getText(r), /No original message found/);
	});
});

// ─── msg_wait_reply ────────────────────────────────────────────────────────────

describe("msg_wait_reply (poll path)", () => {
	it("returns reply_message_id when a correlated, acked reply already exists", async () => {
		const corr = crypto.randomUUID();
		const origId = await insertMessage({
			from: SENDER,
			to: RECIPIENT,
			type: "task",
			correlation: corr,
		});
		// Insert a pre-existing reply that is already acked — the poll predicate
		// is `correlation_id = $1 AND (to_agent = $2 OR channel IS NOT NULL) AND acked_at IS NOT NULL`
		const replyId = await insertMessage({
			from: RECIPIENT,
			to: SENDER,
			type: "ack",
			correlation: corr,
		});
		await query(
			`UPDATE roadmap.message_ledger
			 SET acked_at = now(), ack_outcome = 'ok'
			 WHERE id = $1`,
			[replyId],
		);

		const r = await handleMsgWaitReply({
			message_id: origId,
			timeout_ms: 100, // small — poll loop checks once at start, then sleeps
			agent: SENDER,
		});
		assert.match(getText(r), new RegExp(`Reply received: message_id ${replyId}`));
	});

	it("REGRESSION ANCHOR: poll-timeout INSERT to message_timeout_tracking is dead code (bug at msg-wait-reply.ts:156)", async () => {
		// `const timedOut = Date.now() - Date.now() >= timeoutMs` is always false,
		// so the conditional INSERT into message_timeout_tracking never fires after
		// a real poll timeout. Test asserts the buggy behaviour to anchor the fix.
		const corr = crypto.randomUUID();
		const origId = await insertMessage({
			from: SENDER,
			to: RECIPIENT,
			type: "task",
			correlation: corr,
		});

		// No reply present — pollForReply will exhaust timeout_ms.
		// Use small timeout so the test is fast (poll interval is 5s, capped at remaining time).
		const r = await handleMsgWaitReply({
			message_id: origId,
			timeout_ms: 50,
			agent: SENDER,
		});
		assert.match(getText(r), /No reply received/);
		assert.match(getText(r), /timed_out: false/, "buggy timedOut expression always evaluates false");

		const t = await query(
			`SELECT 1 FROM roadmap.message_timeout_tracking WHERE message_id = $1`,
			[origId],
		);
		assert.equal(
			t.rows.length,
			0,
			"BUG: timeout tracking row not inserted because the timedOut check is broken",
		);
	});

	it("returns error when the message has no correlation_id", async () => {
		const id = await insertMessage({ from: SENDER, to: RECIPIENT, type: "task" });
		const r = await handleMsgWaitReply({
			message_id: id,
			timeout_ms: 50,
			agent: SENDER,
		});
		assert.match(getText(r), /no correlation_id/);
	});

	it("returns error when message_id is unknown", async () => {
		const r = await handleMsgWaitReply({
			message_id: 9_999_999_999,
			timeout_ms: 50,
			agent: SENDER,
		});
		assert.match(getText(r), /not found/i);
	});
});

// ─── sig_verified state machine ────────────────────────────────────────────────

describe("sig_verified state machine", () => {
	it("defaults to 'pending' on a freshly inserted row", async () => {
		const id = await insertMessage({ from: SENDER, to: RECIPIENT, type: "task" });
		const row = await query(
			`SELECT sig_verified FROM roadmap.message_ledger WHERE id = $1`,
			[id],
		);
		assert.equal(row.rows[0].sig_verified, "pending");
	});

	it("accepts UPDATE to 'verified' or 'failed'", async () => {
		const id = await insertMessage({ from: SENDER, to: RECIPIENT, type: "task" });
		await query(
			`UPDATE roadmap.message_ledger SET sig_verified = 'verified' WHERE id = $1`,
			[id],
		);
		const r1 = await query(
			`SELECT sig_verified FROM roadmap.message_ledger WHERE id = $1`,
			[id],
		);
		assert.equal(r1.rows[0].sig_verified, "verified");

		await query(
			`UPDATE roadmap.message_ledger SET sig_verified = 'failed' WHERE id = $1`,
			[id],
		);
		const r2 = await query(
			`SELECT sig_verified FROM roadmap.message_ledger WHERE id = $1`,
			[id],
		);
		assert.equal(r2.rows[0].sig_verified, "failed");
	});

	it("CHECK constraint rejects values outside the allowed set", async () => {
		const id = await insertMessage({ from: SENDER, to: RECIPIENT, type: "task" });
		await assert.rejects(
			() =>
				query(
					`UPDATE roadmap.message_ledger SET sig_verified = 'unknown_state' WHERE id = $1`,
					[id],
				),
			/sig_verified_check/,
		);
	});
});

// ─── message_type_contract ─────────────────────────────────────────────────────

describe("message_type_contract", () => {
	it("ack-required types match the P833 spec", async () => {
		const r = await query(
			`SELECT message_type, ack_required FROM roadmap.message_type_contract
			 WHERE message_type = ANY($1) ORDER BY message_type`,
			[["task", "directive", "request_assistance", "query", "progress_note", "ack", "error", "event"]],
		);
		const map = Object.fromEntries(r.rows.map((row) => [row.message_type, row.ack_required]));
		assert.equal(map.task, true);
		assert.equal(map.directive, true);
		assert.equal(map.request_assistance, true);
		assert.equal(map.query, false);
		assert.equal(map.progress_note, false);
		assert.equal(map.ack, false);
		assert.equal(map.error, false);
		assert.equal(map.event, false);
	});

	it("timeout_seconds and escalation_recipient match the spec for ack-required types", async () => {
		const r = await query(
			`SELECT message_type, timeout_seconds, escalation_recipient FROM roadmap.message_type_contract
			 WHERE message_type = ANY($1) ORDER BY message_type`,
			[["task", "directive", "request_assistance"]],
		);
		const map = Object.fromEntries(
			r.rows.map((row) => [
				row.message_type,
				{ timeout: row.timeout_seconds, esc: row.escalation_recipient },
			]),
		);
		assert.deepEqual(map.task, { timeout: 300, esc: "liaison_hub" });
		assert.deepEqual(map.directive, { timeout: 60, esc: "liaison_hub" });
		assert.deepEqual(map.request_assistance, { timeout: 120, esc: "liaison_hub" });
	});

	it("message_timeout_tracking has UNIQUE on message_id (no duplicate timeouts)", async () => {
		const id = await insertMessage({ from: SENDER, to: RECIPIENT, type: "task" });
		await query(
			`INSERT INTO roadmap.message_timeout_tracking (message_id, timeout_at, escalation_recipient)
			 VALUES ($1, now() + interval '5 minutes', 'liaison_hub')`,
			[id],
		);
		await assert.rejects(
			() =>
				query(
					`INSERT INTO roadmap.message_timeout_tracking (message_id, timeout_at, escalation_recipient)
					 VALUES ($1, now() + interval '5 minutes', 'liaison_hub')`,
					[id],
				),
			/duplicate key|message_id/i,
		);
	});
});
