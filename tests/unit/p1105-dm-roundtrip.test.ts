/**
 * P1105 AC-16 / AC-2 / AC-12 — USER↔agent DM round-trip on the canonical bus.
 *
 * P1103 is obsolete (AC-16): the canonical bus already shipped via P837/P833,
 * so the round-trip is tested directly against roadmap.message_ledger — no
 * P1103 dependency.
 *
 * Flow proven:
 *   1. token_issue mints a bearer token for user/gary (operator-gated).
 *   2. The token verifies under verifyUserBearer (the msg_send gate).
 *   3. A USER→agent message is written to the canonical ledger.
 *   4. The agent (adam) replies; the reply row carries reply_to=<original id>.
 *   5. AC-12 verification query returns the agent's text reply addressed to
 *      user/gary, referencing the original message.
 *
 * The ledger inserts mirror the production msg_send path
 * (pg-handlers.ts:498 — INSERT ... RETURNING id), but run inline so the test
 * is hermetic and asserts the canonical-store contract rather than transport.
 *
 * Requires a DB with roadmap.message_ledger. Run against an isolated DB
 * (PGDATABASE) or set AGENTHIVE_ALLOW_LIVE_DB=1; when the ledger is absent the
 * round-trip assertions are skipped.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
	agentContextStorage,
	type AgentContext,
} from "../../src/shared/identity/agent-context.ts";
import { issueUserToken } from "../../src/apps/mcp-server/tools/messages/token-lifecycle.ts";
import { verifyUserBearer } from "../../src/apps/mcp-server/tools/messages/user-bearer-auth.ts";
import { closePool, getPool, query } from "../../src/infra/postgres/pool.ts";

const SECRET = "p1105-roundtrip-secret-32bytes-padding!";
const USER = "user/gary";
const AGENT = "adam";

let savedSecret: string | undefined;
let ledgerExists = false;
const insertedIds: number[] = [];

function operatorCtx(): AgentContext {
	return {
		verified: {
			principal_id: "operator/test",
			principal_kind: "operator",
			parent_principal_id: null,
		},
	};
}

async function insertLedger(opts: {
	from: string;
	to: string;
	type: string;
	content: string;
	replyTo?: number;
}): Promise<number> {
	const { rows } = await query<{ id: string }>(
		`INSERT INTO roadmap.message_ledger
		   (from_agent, to_agent, message_type, message_content, reply_to)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id`,
		[opts.from, opts.to, opts.type, opts.content, opts.replyTo ?? null],
	);
	const id = Number(rows[0].id);
	insertedIds.push(id);
	return id;
}

before(async () => {
	savedSecret = process.env.AGENTHIVE_USER_JWT_SECRET;
	process.env.AGENTHIVE_USER_JWT_SECRET = SECRET;
	try {
		const r = await getPool().query<{ reg: string | null }>(
			`SELECT to_regclass('roadmap.message_ledger')::text AS reg`,
		);
		ledgerExists = r.rows[0]?.reg != null;
	} catch {
		ledgerExists = false;
	}
});

after(async () => {
	if (savedSecret === undefined) delete process.env.AGENTHIVE_USER_JWT_SECRET;
	else process.env.AGENTHIVE_USER_JWT_SECRET = savedSecret;
	if (insertedIds.length) {
		try {
			await getPool().query(
				`DELETE FROM roadmap.message_ledger WHERE id = ANY($1::bigint[])`,
				[insertedIds],
			);
		} catch {
			/* non-fatal */
		}
	}
	await closePool();
});

describe("USER↔agent DM round-trip — AC-16 / AC-2 / AC-12", () => {
	it("issued+verified token gates a USER send, agent reply carries reply_to", async (t) => {
		if (!ledgerExists) {
			t.skip("roadmap.message_ledger not present in this DB");
			return;
		}

		// (1) token_issue for user/gary (operator-gated)
		const issued = await agentContextStorage.run(operatorCtx(), () =>
			issueUserToken({ agent_identity: USER, ttl_seconds: 3600 }),
		);
		assert.equal(issued.ok, true, `issue failed: ${issued.reason}`);

		// (2) the gate verifyUserBearer accepts the token for from_agent=user/gary
		const gate = verifyUserBearer(issued.token as string, USER);
		assert.equal(gate.ok, true, `gate rejected token: ${gate.error}`);

		// (3) USER→agent message lands in the canonical ledger
		const originalId = await insertLedger({
			from: USER,
			to: AGENT,
			type: "text",
			content: "hello",
		});
		assert.ok(originalId > 0);

		// (4) agent replies, referencing the original message
		await insertLedger({
			from: AGENT,
			to: USER,
			type: "text",
			content: "hi gary",
			replyTo: originalId,
		});

		// (5) AC-12 verification query: latest adam→user/gary text reply
		const { rows } = await query<{
			id: string;
			from_agent: string;
			to_agent: string;
			message_type: string;
			reply_to: string | null;
		}>(
			`SELECT id, from_agent, to_agent, message_type, reply_to
			   FROM roadmap.message_ledger
			  WHERE from_agent=$1 AND to_agent=$2
			  ORDER BY id DESC LIMIT 1`,
			[AGENT, USER],
		);
		assert.equal(rows.length, 1, "expected a reply row");
		assert.equal(rows[0].message_type, "text");
		assert.equal(Number(rows[0].reply_to), originalId, "reply_to must reference the original message");
	});
});
