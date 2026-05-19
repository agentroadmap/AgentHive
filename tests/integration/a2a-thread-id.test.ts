/**
 * P907 AC1: A2A Threading — thread_id Column and Trigger
 *
 * AC#1: thread_id BIGINT NOT NULL added to roadmap.message_ledger.
 * AC#1: Populated by BEFORE INSERT trigger that walks reply_to to find the root.
 */

import assert from "node:assert";
import { describe, it, before, after } from "node:test";
import { query } from "../../src/infra/postgres/pool.ts";

describe("P907 AC1: A2A Threading (thread_id)", () => {
	let rootId: number;
	let childId: number;
	let grandChildId: number;

	it("Case 1: Root message sets thread_id = id", async () => {
		const { rows } = await query(
			`INSERT INTO roadmap.message_ledger (from_agent, to_agent, message_content, channel)
			 VALUES ($1, $2, $3, $4) RETURNING id, thread_id`,
			["agent-a", "agent-b", "Root message", "direct"]
		);
		
		rootId = Number(rows[0].id);
		assert.strictEqual(String(rows[0].thread_id), String(rootId), "Root thread_id must equal id");
	});

	it("Case 2: Reply message inherits thread_id from parent", async () => {
		const { rows } = await query(
			`INSERT INTO roadmap.message_ledger (from_agent, to_agent, message_content, channel, reply_to)
			 VALUES ($1, $2, $3, $4, $5) RETURNING id, thread_id`,
			["agent-b", "agent-a", "First reply", "direct", rootId]
		);
		
		childId = Number(rows[0].id);
		assert.strictEqual(String(rows[0].thread_id), String(rootId), "Reply thread_id must match parent's thread_id");
	});

	it("Case 3: Nested reply inherits thread_id from original root", async () => {
		const { rows } = await query(
			`INSERT INTO roadmap.message_ledger (from_agent, to_agent, message_content, channel, reply_to)
			 VALUES ($1, $2, $3, $4, $5) RETURNING id, thread_id`,
			["agent-a", "agent-b", "Second reply", "direct", childId]
		);
		
		grandChildId = Number(rows[0].id);
		assert.strictEqual(String(rows[0].thread_id), String(rootId), "Nested reply thread_id must match root id");
	});

	it("Case 4: Independent threads stay separate", async () => {
		const { rows: rows2 } = await query(
			`INSERT INTO roadmap.message_ledger (from_agent, to_agent, message_content, channel)
			 VALUES ($1, $2, $3, $4) RETURNING id, thread_id`,
			["agent-a", "agent-b", "New root", "direct"]
		);
		const root2Id = Number(rows2[0].id);
		
		const { rows: rows2Reply } = await query(
			`INSERT INTO roadmap.message_ledger (from_agent, to_agent, message_content, channel, reply_to)
			 VALUES ($1, $2, $3, $4, $5) RETURNING id, thread_id`,
			["agent-b", "agent-a", "New reply", "direct", root2Id]
		);
		
		assert.notStrictEqual(String(rows2[0].thread_id), String(rootId), "Different threads must have different thread_id");
		assert.strictEqual(String(rows2Reply[0].thread_id), String(root2Id), "Second thread reply must match its own root");
	});

	it("Case 5: Trigger returns early if thread_id is pre-set", async () => {
		const manualThreadId = 999999;
		const { rows } = await query(
			`INSERT INTO roadmap.message_ledger (from_agent, to_agent, message_content, channel, thread_id)
			 VALUES ($1, $2, $3, $4, $5) RETURNING id, thread_id`,
			["agent-a", "agent-b", "Manual thread", "direct", manualThreadId]
		);
		
		assert.strictEqual(String(rows[0].thread_id), String(manualThreadId), "Trigger must not overwrite pre-set thread_id");
	});

	it("Case 6: Recursive walk when parent has no thread_id (legacy/null fallback)", async () => {
		const fakeParentId = 888888;
		const { rows } = await query(
			`INSERT INTO roadmap.message_ledger (from_agent, to_agent, message_content, channel, reply_to)
			 VALUES ($1, $2, $3, $4, $5) RETURNING id, thread_id`,
			["agent-a", "agent-b", "Orphan reply", "direct", fakeParentId]
		);
		
		assert.strictEqual(String(rows[0].thread_id), String(fakeParentId), "If parent not found, thread_id should fall back to reply_to");
	});


	it("Case 7: Broadcast messages also have thread_id", async () => {
		const { rows } = await query(
			`INSERT INTO roadmap.message_ledger (from_agent, channel, message_content)
			 VALUES ($1, $2, $3) RETURNING id, thread_id`,
			["agent-a", "broadcast", "Global announcement"]
		);
		
		assert.strictEqual(rows[0].thread_id, rows[0].id, "Broadcast root must have thread_id = id");
	});

	it("Case 8: Replies in broadcast channels maintain thread_id", async () => {
		const { rows: rootRows } = await query(
			`INSERT INTO roadmap.message_ledger (from_agent, channel, message_content)
			 VALUES ($1, $2, $3) RETURNING id, thread_id`,
			["agent-a", "broadcast", "Threaded broadcast"]
		);
		const bRootId = rootRows[0].id;

		const { rows: replyRows } = await query(
			`INSERT INTO roadmap.message_ledger (from_agent, channel, message_content, reply_to)
			 VALUES ($1, $2, $3, $4) RETURNING id, thread_id`,
			["agent-b", "broadcast", "Broadcast reply", bRootId]
		);
		
		assert.strictEqual(replyRows[0].thread_id, bRootId, "Broadcast reply must match broadcast root");
	});

	it("Case 9: Mixed DM and Channel threading works", async () => {
		// DM root
		const { rows: dmRoot } = await query(
			`INSERT INTO roadmap.message_ledger (from_agent, to_agent, message_content, channel)
			 VALUES ($1, $2, $3, $4) RETURNING id, thread_id`,
			["agent-a", "agent-b", "DM Root", "direct"]
		);
		
		// Channel reply (not usual but schema allows)
		const { rows: chanReply } = await query(
			`INSERT INTO roadmap.message_ledger (from_agent, channel, message_content, reply_to)
			 VALUES ($1, $2, $3, $4) RETURNING id, thread_id`,
			["agent-b", "team:dev", "Cross-channel reply", dmRoot[0].id]
		);
		
		assert.strictEqual(chanReply[0].thread_id, dmRoot[0].id, "Threading must work across channels if reply_to is set");
	});

	it("Case 10: Performance/Depth check (10-level thread)", async () => {
		let currentParentId = rootId;
		for (let i = 0; i < 7; i++) { // already have 3 levels
			const { rows } = await query(
				`INSERT INTO roadmap.message_ledger (from_agent, to_agent, message_content, channel, reply_to)
				 VALUES ($1, $2, $3, $4, $5) RETURNING id, thread_id`,
				["agent-a", "agent-b", `Level ${i+4}`, "direct", currentParentId]
			);
			assert.strictEqual(String(rows[0].thread_id), String(rootId), `Level ${i+4} must still point to root`);
			currentParentId = Number(rows[0].id);
		}
	});
});
