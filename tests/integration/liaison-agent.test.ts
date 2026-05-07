/**
 * Tests for src/infra/agency/liaison-agent.ts
 *
 * Drives the module against the live hiveCentral DB. Asserts:
 *   1. Reply path preserves correlation_id and sets reply_to = original.id
 *      (mirrors handleMsgReply, NOT PgMessagingHandlers.sendMessage).
 *   2. Original message is marked read after reply.
 *   3. Pending message_timeout_tracking row is resolved when reply lands.
 *   4. protocol_ping receives protocol_pong with the same correlation/reply_to
 *      contract — no LLM invocation required.
 *   5. stop() ends the dedicated LISTEN client cleanly (no UNLISTEN errors,
 *      no pool-pollution since the client is dedicated).
 *   6. Channel name uses agentNotifyChannel() — LISTEN matches the trigger.
 *
 * Pre-req: P888 deployed (nonce column + fn_a2a_message_notify trigger).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { closePool, getPool, query } from "../../src/infra/postgres/pool.ts";
import {
	runLiaisonAgent,
	type LiaisonAgentHandle,
} from "../../src/infra/agency/liaison-agent.ts";
import { agentNotifyChannel } from "../../src/infra/messaging/a2a-access-control.ts";

const STAMP = Date.now();
const SENDER = `system:liaison-test-sender-${STAMP}`;
const LIAISON = `claude/liaison-test-${STAMP}`;

async function seedAgent(identity: string) {
	await query(
		`INSERT INTO roadmap_workforce.agent_registry
		   (agent_identity, agent_type, status)
		 VALUES ($1, 'tool', 'active')
		 ON CONFLICT (agent_identity) DO NOTHING`,
		[identity],
	);
}

async function seedAcl(from: string, to: string) {
	await query(
		`INSERT INTO roadmap.message_acl
		   (from_agent, to_agent, grant_type, granted_by)
		 VALUES ($1, $2, 'dm', 'system')
		 ON CONFLICT ON CONSTRAINT message_acl_pair_uq DO UPDATE
		   SET revoked_at = NULL, granted_at = now()`,
		[from, to],
	);
}

async function insertOriginal(opts: {
	from: string;
	to: string;
	type: string;
	correlationId?: string | null;
	content?: string;
}): Promise<number> {
	const { rows } = await query(
		`INSERT INTO roadmap.message_ledger
		    (from_agent, to_agent, message_type, message_content,
		     correlation_id, channel)
		 VALUES ($1, $2, $3, $4, $5, 'direct')
		 RETURNING id`,
		[
			opts.from,
			opts.to,
			opts.type,
			opts.content ?? "ping",
			opts.correlationId ?? null,
		],
	);
	return rows[0].id as number;
}

async function fetchReply(
	from: string,
	to: string,
	replyTo: number,
): Promise<{
	id: number;
	correlation_id: string | null;
	reply_to: number | null;
	message_content: string;
	message_type: string;
} | null> {
	const { rows } = await query(
		`SELECT id, correlation_id, reply_to, message_content, message_type
		   FROM roadmap.message_ledger
		  WHERE from_agent = $1 AND to_agent = $2 AND reply_to = $3
		  ORDER BY id DESC LIMIT 1`,
		[from, to, replyTo],
	);
	return rows[0] ?? null;
}

async function waitFor<T>(
	probe: () => Promise<T | null | undefined | false>,
	timeoutMs = 5000,
	stepMs = 50,
): Promise<T> {
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		const v = await probe();
		if (v) return v as T;
		await new Promise((r) => setTimeout(r, stepMs));
	}
	throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}

describe("liaison-agent", () => {
	let handle: LiaisonAgentHandle | null = null;
	let llmCalls: number = 0;

	beforeAll(async () => {
		await seedAgent(SENDER);
		await seedAgent(LIAISON);
		await seedAcl(SENDER, LIAISON);
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		llmCalls = 0;
	});

	afterAll(async () => {
		await query(
			`DELETE FROM roadmap.message_ledger
			  WHERE from_agent IN ($1, $2) OR to_agent IN ($1, $2)`,
			[SENDER, LIAISON],
		);
		await query(
			`DELETE FROM roadmap.message_acl
			  WHERE from_agent IN ($1, $2) OR to_agent IN ($1, $2)`,
			[SENDER, LIAISON],
		);
		await closePool();
	});

	it("LISTENs on the agentNotifyChannel-validated channel name", async () => {
		// agentNotifyChannel throws on bad identities and enforces 63-byte limit.
		// We validate by reaching into the started listener via a safe identity.
		const channel = agentNotifyChannel(LIAISON);
		expect(channel).toBe(`a2a_msg_${LIAISON}`);

		handle = await runLiaisonAgent({
			identity: LIAISON,
			invokeLlm: async () => "ok",
			loggerPrefix: "[Test]",
		});
		// The LISTEN itself is observable via pg_stat_activity; checking the
		// session-level state here would be flaky. Instead, prove it's wired
		// by sending a message and confirming the handler runs (next test).
		expect(handle).toBeTruthy();
	});

	it("invalid identity throws before any DB work", async () => {
		await expect(
			runLiaisonAgent({
				identity: "bad identity with spaces",
				invokeLlm: async () => "ok",
			}),
		).rejects.toThrow(/Invalid agent identity/);
	});

	it("text message → reply preserves correlation_id and sets reply_to", async () => {
		handle = await runLiaisonAgent({
			identity: LIAISON,
			invokeLlm: async (msg) => {
				llmCalls++;
				return `echo: ${msg.message_content}`;
			},
			loggerPrefix: "[Test:text]",
		});

		const correlationId = `liaison-test-${STAMP}`;
		const originalId = await insertOriginal({
			from: SENDER,
			to: LIAISON,
			type: "text",
			correlationId,
			content: "hello agency",
		});

		const reply = await waitFor(() => fetchReply(LIAISON, SENDER, originalId));

		expect(llmCalls).toBe(1);
		expect(reply.correlation_id).toBe(correlationId);
		expect(reply.reply_to).toBe(originalId);
		expect(reply.message_type).toBe("text");
		expect(reply.message_content).toContain("echo: hello agency");

		// Original is marked read.
		const { rows } = await query(
			`SELECT read_at FROM roadmap.message_ledger WHERE id = $1`,
			[originalId],
		);
		expect(rows[0].read_at).not.toBeNull();
	});

	it("protocol_ping → protocol_pong without LLM invocation", async () => {
		handle = await runLiaisonAgent({
			identity: LIAISON,
			invokeLlm: async () => {
				llmCalls++;
				return "should-not-be-called";
			},
			loggerPrefix: "[Test:ping]",
		});

		const correlationId = `liaison-ping-${STAMP}`;
		const originalId = await insertOriginal({
			from: SENDER,
			to: LIAISON,
			type: "protocol_ping",
			correlationId,
			content: "ping",
		});

		const pong = await waitFor(() => fetchReply(LIAISON, SENDER, originalId));

		expect(llmCalls).toBe(0); // fast-path skips LLM
		expect(pong.message_type).toBe("protocol_pong");
		expect(pong.message_content).toBe("pong");
		expect(pong.correlation_id).toBe(correlationId);
		expect(pong.reply_to).toBe(originalId);
	});

	it("resolves message_timeout_tracking on reply", async () => {
		handle = await runLiaisonAgent({
			identity: LIAISON,
			invokeLlm: async () => "answered",
			loggerPrefix: "[Test:timeout]",
		});

		const originalId = await insertOriginal({
			from: SENDER,
			to: LIAISON,
			type: "text",
			correlationId: `liaison-timeout-${STAMP}`,
		});

		// Seed a pending timeout-tracking row for the original.
		await query(
			`INSERT INTO roadmap.message_timeout_tracking
			    (message_id, timeout_at, escalation_recipient)
			 VALUES ($1, now() + interval '5 minutes', 'system:operator')
			 ON CONFLICT DO NOTHING`,
			[originalId],
		);

		await waitFor(() => fetchReply(LIAISON, SENDER, originalId));

		// Allow markReadAndResolveTimeout to flush.
		await waitFor(async () => {
			const { rows } = await query(
				`SELECT resolved_at FROM roadmap.message_timeout_tracking
				  WHERE message_id = $1`,
				[originalId],
			);
			return rows[0]?.resolved_at != null;
		});
	});

	it("stop() ends the dedicated LISTEN client cleanly", async () => {
		const localHandle = await runLiaisonAgent({
			identity: LIAISON,
			invokeLlm: async () => "x",
			loggerPrefix: "[Test:stop]",
		});

		// Just stop; no exception expected. The dedicated client should be
		// fully closed (not returned to a pool with leftover LISTEN state).
		await expect(localHandle.stop()).resolves.toBeUndefined();

		// Calling stop() twice should not throw — the inner UNLISTEN/end()
		// calls swallow already-closed errors.
		await expect(localHandle.stop()).resolves.toBeUndefined();
	});
});
