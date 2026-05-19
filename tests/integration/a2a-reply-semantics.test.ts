/**
 * P907 AC3: A2A Reply Semantics — Multi-component Fixes
 *
 * AC#3: Fix reply-semantics gaps across msg_send, msg_reply, timeout-cron,
 * A2AMessenger, liaison-hub, liaison-watchdog, cross-host-relay.
 */

import assert from "node:assert";
import { describe, it, before, after } from "node:test";
import { query, getPool } from "../../src/infra/postgres/pool.ts";
import { PgMessagingHandlers } from "../../src/apps/mcp-server/tools/messages/pg-handlers.ts";
import { handleMsgReply } from "../../src/apps/mcp-server/tools/messages/msg-reply.ts";
import { runTimeoutSweep } from "../../src/infra/messaging/timeout-cron.ts";
import { A2AMessenger } from "../../src/core/runtime/a2a-messenger.ts";

describe("P907 AC3: A2A Reply Semantics", () => {
	const pgHandlers = new PgMessagingHandlers(null as any, process.cwd());

	before(async () => {
		// Ensure agents and system identities exist and have ACL grants
		await query(`INSERT INTO roadmap.agent_registry (agent_identity, agent_type) 
		             VALUES ('agent-a', 'llm'), ('agent-b', 'llm'), 
					        ('system:timeout-escalator', 'workforce'), ('system:timeout-reminder', 'workforce'),
							('liaison_hub', 'workforce') 
					 ON CONFLICT (agent_identity) DO NOTHING`);
		await query(`INSERT INTO roadmap.message_acl (from_agent, to_agent, grant_type, granted_by) 
		             VALUES ('agent-a', 'agent-b', 'dm', 'system'), ('agent-b', 'agent-a', 'dm', 'system'), ('agent-a', '*', 'channel_post', 'system'),
					        ('system:timeout-escalator', '*', 'dm', 'system'), ('system:timeout-reminder', '*', 'dm', 'system')
					 ON CONFLICT DO NOTHING`);
	});

	it("Describe 1: msg_send with correlation_id", async () => {
		const correlationId = crypto.randomUUID();
		await pgHandlers.sendMessage({
			from_agent: "agent-a",
			to_agent: "agent-b",
			message_content: "Test correlation",
			correlation_id: correlationId
		});

		const { rows } = await query(
			`SELECT correlation_id FROM roadmap.message_ledger 
			 WHERE from_agent = 'agent-a' AND correlation_id = $1`,
			[correlationId]
		);
		
		assert.ok(rows.length > 0, "Message must be found");
		assert.strictEqual(rows[0].correlation_id, correlationId, "correlation_id must be stored");
	});

	it("Describe 2: msg_reply propagates thread/correlation", async () => {
		const correlationId = crypto.randomUUID();
		const rootResult = await query(
			`INSERT INTO roadmap.message_ledger (from_agent, to_agent, message_content, correlation_id)
			 VALUES ($1, $2, $3, $4) RETURNING id`,
			["agent-a", "agent-b", "Root for reply", correlationId]
		);
		const rootId = rootResult.rows[0].id;

		await handleMsgReply({
			correlation_id: correlationId,
			from_agent: "agent-b",
			content: "I reply to you"
		});

		const { rows } = await query(
			`SELECT correlation_id, reply_to FROM roadmap.message_ledger 
			 WHERE from_agent = 'agent-b' AND message_content = 'I reply to you'
			 ORDER BY created_at DESC LIMIT 1`
		);
		
		assert.strictEqual(rows[0].correlation_id, correlationId, "Reply must maintain correlation_id");
		assert.strictEqual(String(rows[0].reply_to), String(rootId), "Reply must set reply_to the original message");
	});

	it("Describe 3: timeout-cron escalation notice has semantics", async () => {
		const correlationId = crypto.randomUUID();
		// Create message that will time out
		const msgResult = await query(
			`INSERT INTO roadmap.message_ledger (from_agent, to_agent, message_type, message_content, correlation_id)
			 VALUES ($1, $2, 'task', $3, $4) RETURNING id`,
			["agent-a", "agent-b", "Task to time out", correlationId]
		);
		const msgId = msgResult.rows[0].id;

		// Add to tracking with past timeout
		await query(
			`INSERT INTO roadmap.message_timeout_tracking (message_id, timeout_at)
			 VALUES ($1, now() - interval '1 minute')`,
			[msgId]
		);

		// Run escalation pass
		const pool = getPool();
		await runTimeoutSweep(pool);

		// Check escalation notice
		const { rows } = await query(
			`SELECT correlation_id, reply_to FROM roadmap.message_ledger 
			 WHERE message_type = 'notify' AND reply_to = $1 AND from_agent = 'system:timeout-escalator'`,
			[msgId]
		);
		
		assert.ok(rows.length > 0, "Escalation notice must be created");
		assert.strictEqual(rows[0].correlation_id, correlationId, "Escalation notice must maintain correlation_id");
		assert.strictEqual(String(rows[0].reply_to), String(msgId), "Escalation notice must set reply_to the original message");
	});

	it("Describe 4: timeout-cron reminder has semantics", async () => {
		const correlationId = crypto.randomUUID();
		// Create message approaching timeout
		const msgResult = await query(
			`INSERT INTO roadmap.message_ledger (from_agent, to_agent, message_type, message_content, correlation_id)
			 VALUES ($1, $2, 'task', $3, $4) RETURNING id`,
			["agent-a", "agent-b", "Task for reminder", correlationId]
		);
		const msgId = msgResult.rows[0].id;

		// Add to tracking with near-future timeout (approaching 50% mark)
		// created_at is now, timeout_at = now + 10s. Sweep will see it if it's past created_at + 5s.
		await query(
			`INSERT INTO roadmap.message_timeout_tracking (message_id, timeout_at)
			 VALUES ($1, now() + interval '10 seconds')`,
			[msgId]
		);
        // Wait 6 seconds to trigger reminder window (50% of 10s = 5s)
        await new Promise(r => setTimeout(r, 6000));

		const pool = getPool();
		await runTimeoutSweep(pool);

		// Check reminder
		const { rows } = await query(
			`SELECT correlation_id, reply_to FROM roadmap.message_ledger 
			 WHERE message_type = 'notify' AND reply_to = $1 AND from_agent = 'system:timeout-reminder'`,
			[msgId]
		);
		
		assert.ok(rows.length > 0, "Reminder must be created");
		assert.strictEqual(rows[0].correlation_id, correlationId, "Reminder must maintain correlation_id");
		assert.strictEqual(String(rows[0].reply_to), String(msgId), "Reminder must set reply_to the original message");
	}, { timeout: 10000 });

	it("Describe 5: A2AMessenger.send supports replyToId", async () => {
		const messenger = new A2AMessenger("agent-a");
		const rootId = 12345;
		
		const msgId = await messenger.send("agent-b", { type: "text", content: "Messenger test" }, {
			replyToId: rootId
		});

		const { rows } = await query(
			`SELECT reply_to FROM roadmap.message_ledger WHERE id = $1`,
			[msgId]
		);
		
		assert.strictEqual(String(rows[0].reply_to), String(rootId), "A2AMessenger.send must set reply_to");
	});

	it("Describe 6: A2AMessenger.broadcast supports replyToId", async () => {
		const messenger = new A2AMessenger("agent-a");
		const rootId = 54321;
		
		const msgId = await messenger.broadcast("team:test", { type: "text", content: "Broadcast test" }, {
			replyToId: rootId
		});

		const { rows } = await query(
			`SELECT reply_to FROM roadmap.message_ledger WHERE id = $1`,
			[msgId]
		);
		
		assert.strictEqual(String(rows[0].reply_to), String(rootId), "A2AMessenger.broadcast must set reply_to");
	});
});
