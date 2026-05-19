/**
 * P994 / P993 AC-8: E2E integration test for the typed A2A task protocol.
 *
 * Exercises the live message-routing path:
 *   task_request → task_ack → 2× task_status → task_complete
 *
 * Uses real DB; stubs MCP HTTP calls and bridgeTaskToOfferDispatch via vi.fn().
 */

import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from "vitest";
import { closePool, query } from "../../src/infra/postgres/pool.ts";
import {
	handleTypedTaskRequest,
	handleWorkerReport,
	type TaskDispatcherHelpers,
} from "../../src/infra/agency/task-dispatcher.ts";
import type { IncomingMessage } from "../../src/infra/agency/liaison-agent.ts";

// Stub global fetch to intercept MCP HTTP calls
const fetchSpy = vi.fn();
vi.stubGlobal("fetch", fetchSpy);

// Minimal MCP response stubs
function mockFetchFor(action: string): void {
	fetchSpy.mockImplementation(async (_url: string, opts?: RequestInit) => {
		const body = JSON.parse((opts?.body as string) ?? "{}") as Record<string, unknown>;
		if (body.action === "prop_claim") {
			return new Response(JSON.stringify({ lease_id: "test-lease-uuid-0001" }), { status: 200 });
		}
		if (body.action === "list_ac") {
			return new Response(JSON.stringify({
				items: [
					{ item_number: 1, label: "AC-1", status: "pending" },
					{ item_number: 2, label: "AC-2", status: "pass" },
				],
			}), { status: 200 });
		}
		if (body.action === "verify_ac") {
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		}
		if (body.action === "release") {
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		}
		return new Response(JSON.stringify({ ok: true }), { status: 200 });
	});
}

const TEST_PROPOSAL_ID = "P9993-e2e-test";
const TEST_REQUESTOR = "test-requestor-agent";
const TEST_LIAISON = "test-liaison-agent";
const FAKE_DISPATCH_ID = 9001;

function makeHelpers(correlationIdOverride?: string): TaskDispatcherHelpers {
	return {
		insertReply: async (args) => {
			const { rows } = await query(
				`INSERT INTO roadmap.message_ledger
				    (from_agent, to_agent, message_type, message_content,
				     correlation_id, reply_to, metadata)
				 VALUES ($1, $2, $3, $4, $5, $6, $7)
				 RETURNING id`,
				[
					args.fromAgent,
					args.toAgent,
					args.messageType,
					args.content,
					args.correlationId,
					args.replyTo,
					JSON.stringify(args.metadata ?? {}),
				],
			);
			return (rows[0] as any).id as number;
		},
		markReadAndResolveTimeout: async (_id) => {},
		bridgeTaskToOfferDispatch: vi.fn().mockResolvedValue({
			dispatchId: FAKE_DISPATCH_ID,
			statusPollMs: 999999,
			statusTimeoutMs: 999999,
		}),
		monitorTaskDispatch: vi.fn().mockResolvedValue(undefined),
	};
}

async function seedTaskRequest(correlationId: string): Promise<number> {
	const { rows } = await query(
		`INSERT INTO roadmap.message_ledger
		    (from_agent, to_agent, message_type, message_content,
		     correlation_id, reply_to, metadata)
		 VALUES ($1, $2, $3, $4, $5, 0, $6)
		 RETURNING id`,
		[
			TEST_REQUESTOR,
			TEST_LIAISON,
			"task_request",
			"Implement P993 task protocol",
			correlationId,
			JSON.stringify({ proposal_id: TEST_PROPOSAL_ID, action: "develop" }),
		],
	);
	return (rows[0] as any).id as number;
}

function makeIncomingMsg(
	id: number,
	messageType: string,
	correlationId: string,
	replyTo: number,
	metadata?: Record<string, unknown>,
): IncomingMessage {
	return {
		id,
		from_agent: TEST_REQUESTOR,
		to_agent: TEST_LIAISON,
		message_type: messageType,
		message_content: `${messageType} from worker`,
		correlation_id: correlationId,
		reply_to: replyTo,
		metadata: metadata ?? { proposal_id: TEST_PROPOSAL_ID },
		created_at: new Date().toISOString(),
		read_at: null,
	} as unknown as IncomingMessage;
}

describe("P993 AC-8 — E2E typed task protocol via message_ledger", () => {
	let correlationId: string;

	beforeAll(async () => {
		// getMcpUrl() reads this env var; stub fetch intercepts all actual HTTP
		process.env.AGENTHIVE_MCP_URL = "http://127.0.0.1:6421";

		const { rows } = await query(`SELECT gen_random_uuid() AS id`);
		correlationId = (rows[0] as any).id as string;
		mockFetchFor("all");

		// Register test agents (FK on message_ledger.from_agent / to_agent)
		await query(
			`INSERT INTO roadmap_workforce.agent_registry (agent_identity, agent_type, role)
			 VALUES ($1, 'llm', 'tester'), ($2, 'llm', 'tester')
			 ON CONFLICT (agent_identity) DO NOTHING`,
			[TEST_REQUESTOR, TEST_LIAISON],
		);
	});

	afterEach(async () => {
		await query(
			`DELETE FROM roadmap.liaison_task_tracker WHERE proposal_id = $1`,
			[TEST_PROPOSAL_ID],
		);
		await query(
			`DELETE FROM roadmap.message_ledger
			  WHERE correlation_id = $1 OR from_agent = $2 OR to_agent = $2`,
			[correlationId, TEST_LIAISON],
		);
	});

	afterAll(async () => {
		await closePool();
	});

	it("task_request → task_ack: tracker inserted, ack has structured metadata", async () => {
		const msgId = await seedTaskRequest(correlationId);
		const msg = makeIncomingMsg(msgId, "task_request", correlationId, 0, {
			proposal_id: TEST_PROPOSAL_ID,
		});
		const helpers = makeHelpers(correlationId);

		await handleTypedTaskRequest(msg, TEST_LIAISON, "anthropic", helpers);

		// Tracker row should exist with status spawned
		const { rows: trackerRows } = await query(
			`SELECT status, dispatch_id, liaison_id FROM roadmap.liaison_task_tracker
			  WHERE proposal_id = $1`,
			[TEST_PROPOSAL_ID],
		);
		expect(trackerRows).toHaveLength(1);
		expect((trackerRows[0] as any).status).toBe("spawned");
		expect((trackerRows[0] as any).dispatch_id).toBe(FAKE_DISPATCH_ID);

		// task_ack message should be in ledger with structured metadata
		const { rows: ackRows } = await query(
			`SELECT message_type, metadata FROM roadmap.message_ledger
			  WHERE correlation_id = $1 AND message_type = 'task_ack'`,
			[correlationId],
		);
		expect(ackRows).toHaveLength(1);
		const ackMeta = (ackRows[0] as any).metadata as Record<string, unknown>;
		expect(ackMeta.worker_identity).toBeDefined();
		expect(ackMeta.lease_id).toBe("test-lease-uuid-0001");
		expect(ackMeta.estimated_completion).toBeDefined();
		expect(ackMeta.proposal_id).toBe(TEST_PROPOSAL_ID);
	});

	it("task_status × 2 → tracker status=in_progress, relay messages appear", async () => {
		// Seed tracker directly
		await query(
			`INSERT INTO roadmap.liaison_task_tracker
			    (correlation_id, proposal_id, requestor_id, liaison_id, status, dispatch_id)
			 VALUES ($1, $2, $3, $4, 'spawned', $5)`,
			[correlationId, TEST_PROPOSAL_ID, TEST_REQUESTOR, TEST_LIAISON, FAKE_DISPATCH_ID],
		);

		// Seed a fake task_ack to reply_to
		const { rows: ackSeed } = await query(
			`INSERT INTO roadmap.message_ledger
			    (from_agent, to_agent, message_type, message_content, correlation_id, reply_to, metadata)
			 VALUES ($1, $2, 'task_ack', 'ack', $3, 0, '{}')
			 RETURNING id`,
			[TEST_LIAISON, TEST_REQUESTOR, correlationId],
		);
		const ackId = (ackSeed[0] as any).id as number;

		const helpers = makeHelpers(correlationId);

		for (let i = 0; i < 2; i++) {
			const statusMsgId = await (async () => {
				const { rows } = await query(
					`INSERT INTO roadmap.message_ledger
					    (from_agent, to_agent, message_type, message_content, correlation_id, reply_to, metadata)
					 VALUES ($1, $2, 'task_status', $3, $4, $5, '{}')
					 RETURNING id`,
					[TEST_REQUESTOR, TEST_LIAISON, `progress note ${i + 1}`, correlationId, ackId],
				);
				return (rows[0] as any).id as number;
			})();
			const statusMsg = makeIncomingMsg(statusMsgId, "task_status", correlationId, ackId);
			await handleWorkerReport(statusMsg, TEST_LIAISON, helpers);
		}

		const { rows: trackerRows } = await query(
			`SELECT status FROM roadmap.liaison_task_tracker WHERE proposal_id = $1`,
			[TEST_PROPOSAL_ID],
		);
		expect((trackerRows[0] as any).status).toBe("in_progress");

		const { rows: relayRows } = await query(
			`SELECT message_type FROM roadmap.message_ledger
			  WHERE correlation_id = $1 AND message_type = 'task_status'
			  AND to_agent = $2`,
			[correlationId, TEST_REQUESTOR],
		);
		expect(relayRows.length).toBeGreaterThanOrEqual(2);
	});

	it("task_complete → tracker status=complete, acs_verified in outbound message", async () => {
		// Seed tracker
		await query(
			`INSERT INTO roadmap.liaison_task_tracker
			    (correlation_id, proposal_id, requestor_id, liaison_id, status, dispatch_id)
			 VALUES ($1, $2, $3, $4, 'in_progress', $5)`,
			[correlationId, TEST_PROPOSAL_ID, TEST_REQUESTOR, TEST_LIAISON, FAKE_DISPATCH_ID],
		);

		const { rows: prevMsg } = await query(
			`INSERT INTO roadmap.message_ledger
			    (from_agent, to_agent, message_type, message_content, correlation_id, reply_to, metadata)
			 VALUES ($1, $2, 'task_status', 'done', $3, 0, '{}')
			 RETURNING id`,
			[TEST_REQUESTOR, TEST_LIAISON, correlationId],
		);
		const prevId = (prevMsg[0] as any).id as number;

		const completeMsgId = await (async () => {
			const { rows } = await query(
				`INSERT INTO roadmap.message_ledger
				    (from_agent, to_agent, message_type, message_content, correlation_id, reply_to, metadata)
				 VALUES ($1, $2, 'task_complete', 'work done', $3, $4, $5)
				 RETURNING id`,
				[TEST_REQUESTOR, TEST_LIAISON, correlationId, prevId, JSON.stringify({ commit: "abc123" })],
			);
			return (rows[0] as any).id as number;
		})();

		const completeMsg = makeIncomingMsg(completeMsgId, "task_complete", correlationId, prevId, { commit: "abc123" });
		const helpers = makeHelpers(correlationId);
		await handleWorkerReport(completeMsg, TEST_LIAISON, helpers);

		// Tracker should be complete
		const { rows: trackerRows } = await query(
			`SELECT status, completed_at FROM roadmap.liaison_task_tracker WHERE proposal_id = $1`,
			[TEST_PROPOSAL_ID],
		);
		expect((trackerRows[0] as any).status).toBe("complete");
		expect((trackerRows[0] as any).completed_at).not.toBeNull();

		// Outbound task_complete should carry acs_verified
		const { rows: outRows } = await query(
			`SELECT metadata FROM roadmap.message_ledger
			  WHERE correlation_id = $1 AND message_type = 'task_complete'
			  AND to_agent = $2`,
			[correlationId, TEST_REQUESTOR],
		);
		expect(outRows).toHaveLength(1);
		const meta = (outRows[0] as any).metadata as Record<string, unknown>;
		expect(Array.isArray(meta.acs_verified)).toBe(true);
		expect((meta.acs_verified as string[]).length).toBeGreaterThan(0);
	});
});
