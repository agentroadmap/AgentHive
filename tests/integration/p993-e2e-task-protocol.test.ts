/**
 * P994 / P993 AC-8: E2E integration test for the typed A2A task protocol.
 *
 * Exercises the live message-routing path:
 *   task_request → task_ack → 2× task_status → task_complete
 *
 * Uses real DB; stubs MCP HTTP calls and bridgeTaskToOfferDispatch via vi.fn().
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { IncomingMessage } from "../../src/infra/agency/liaison-agent.ts";
import {
	claimLiaisonTaskTracker,
	handleTypedTaskRequest,
	handleWorkerReport,
	reconcileStaleLiaisonTaskTrackers,
	type TaskDispatcherHelpers,
} from "../../src/infra/agency/task-dispatcher.ts";
import { closePool, query } from "../../src/infra/postgres/pool.ts";

// Stub global fetch to intercept MCP HTTP calls
const fetchSpy = vi.fn();
vi.stubGlobal("fetch", fetchSpy);

// Minimal MCP response stubs
function mockFetchFor(action: string): void {
	fetchSpy.mockImplementation(async (_url: string, opts?: RequestInit) => {
		const body = JSON.parse((opts?.body as string) ?? "{}") as Record<
			string,
			unknown
		>;
		const params = body.params as { name?: string } | undefined;
		const toolName = params?.name ?? body.action;
		if (toolName === "prop_claim") {
			return new Response(
				JSON.stringify({
					result: {
						content: [
							{
								text: JSON.stringify({ lease_id: "test-lease-uuid-0001" }),
							},
						],
					},
				}),
				{ status: 200 },
			);
		}
		if (toolName === "list_ac") {
			return new Response(
				JSON.stringify({
					result: {
						content: [
							{
								text: JSON.stringify({
									items: [
										{ item_number: 1, label: "AC-1", status: "pending" },
										{ item_number: 2, label: "AC-2", status: "pass" },
									],
								}),
							},
						],
					},
				}),
				{ status: 200 },
			);
		}
		if (toolName === "verify_ac") {
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		}
		if (toolName === "release") {
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
			`DELETE FROM roadmap_workforce.squad_dispatch
				  WHERE proposal_id = 3315
				     OR (agency_identity = $1 AND squad_name = 'liaison-task')`,
			[TEST_LIAISON],
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

	it("P3315 regression: blank task_request is rejected before claim, tracker, or bridge", async () => {
		const { rows: ids } = await query(`SELECT gen_random_uuid() AS id`);
		const blankCorrelationId = (ids[0] as any).id as string;
		const msgId = await seedTaskRequest(blankCorrelationId);
		const msg = makeIncomingMsg(msgId, "task_request", blankCorrelationId, 0, {
			proposal_id: TEST_PROPOSAL_ID,
		});
		msg.message_content = "   ";
		msg.metadata = { proposal_id: TEST_PROPOSAL_ID };
		const helpers = makeHelpers(blankCorrelationId);
		fetchSpy.mockClear();

		await handleTypedTaskRequest(msg, TEST_LIAISON, "anthropic", helpers);

		expect(fetchSpy).not.toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				body: expect.stringContaining("prop_claim"),
			}),
		);
		expect(helpers.bridgeTaskToOfferDispatch).not.toHaveBeenCalled();

		const { rows: trackerRows } = await query(
			`SELECT 1 FROM roadmap.liaison_task_tracker WHERE proposal_id = $1`,
			[TEST_PROPOSAL_ID],
		);
		expect(trackerRows).toHaveLength(0);

		const { rows: replies } = await query(
			`SELECT message_type, message_content
			   FROM roadmap.message_ledger
			  WHERE correlation_id = $1 AND to_agent = $2`,
			[blankCorrelationId, TEST_REQUESTOR],
		);
		expect(replies).toHaveLength(1);
		expect((replies[0] as any).message_type).toBe("task_error");
		expect((replies[0] as any).message_content).toContain("blank task brief");
	});

	it("P3315: retry reclaims a stale tracker row instead of tracker initialization error", async () => {
		const { rows: ids } = await query(
			`SELECT gen_random_uuid() AS old_id, gen_random_uuid() AS new_id`,
		);
		const oldCorrelationId = (ids[0] as any).old_id as string;
		const newCorrelationId = (ids[0] as any).new_id as string;
		await query(
			`INSERT INTO roadmap.liaison_task_tracker
				    (correlation_id, proposal_id, requestor_id, liaison_id, status, dispatch_id, worker_identity)
				 VALUES ($1, $2, $3, $4, 'spawned', $5, $4)`,
			[
				oldCorrelationId,
				TEST_PROPOSAL_ID,
				TEST_REQUESTOR,
				TEST_LIAISON,
				FAKE_DISPATCH_ID,
			],
		);

		const msgId = await seedTaskRequest(newCorrelationId);
		const msg = makeIncomingMsg(msgId, "task_request", newCorrelationId, 0, {
			proposal_id: TEST_PROPOSAL_ID,
		});
		const helpers = makeHelpers(newCorrelationId);

		await handleTypedTaskRequest(msg, TEST_LIAISON, "anthropic", helpers);

		const { rows: trackerRows } = await query(
			`SELECT correlation_id, status, dispatch_id, spawn_count
				   FROM roadmap.liaison_task_tracker
				  WHERE proposal_id = $1`,
			[TEST_PROPOSAL_ID],
		);
		expect(trackerRows).toHaveLength(1);
		expect((trackerRows[0] as any).correlation_id).toBe(newCorrelationId);
		expect((trackerRows[0] as any).status).toBe("spawned");
		expect((trackerRows[0] as any).dispatch_id).toBe(FAKE_DISPATCH_ID);
		expect(Number((trackerRows[0] as any).spawn_count)).toBe(1);

		const { rows: replies } = await query(
			`SELECT message_type, message_content
				   FROM roadmap.message_ledger
				  WHERE correlation_id = $1
				    AND to_agent = $2
				  ORDER BY id`,
			[newCorrelationId, TEST_REQUESTOR],
		);
		expect(replies.some((r: any) => r.message_type === "task_ack")).toBe(true);
		expect(
			replies.some(
				(r: any) =>
					r.message_type === "task_error" &&
					String(r.message_content).includes("tracker initialization error"),
			),
		).toBe(false);
	});

	it("P3315: stale tracker reaper fails rows whose dispatch reverted open/open", async () => {
		const { rows: ids } = await query(`SELECT gen_random_uuid() AS id`);
		const stuckCorrelationId = (ids[0] as any).id as string;
		const { rows: dispatchRows } = await query(
			`INSERT INTO roadmap_workforce.squad_dispatch
				    (proposal_id, project_id, squad_name, dispatch_role, dispatch_status,
				     offer_status, agency_identity, metadata, required_capabilities)
				 VALUES (3315, 1, 'liaison-task', 'developer', 'open',
				         'open', $1, '{}'::jsonb, '["developer"]'::jsonb)
				 RETURNING id`,
			[TEST_LIAISON],
		);
		const dispatchId = Number((dispatchRows[0] as any).id);
		await query(
			`INSERT INTO roadmap.liaison_task_tracker
				    (correlation_id, proposal_id, requestor_id, liaison_id, status, dispatch_id, worker_identity)
				 VALUES ($1, $2, $3, $4, 'spawned', $5, $4)`,
			[
				stuckCorrelationId,
				TEST_PROPOSAL_ID,
				TEST_REQUESTOR,
				TEST_LIAISON,
				dispatchId,
			],
		);

		const cleared = await reconcileStaleLiaisonTaskTrackers();
		expect(cleared).toBeGreaterThanOrEqual(1);

		const { rows: trackerRows } = await query(
			`SELECT status, completed_at
				   FROM roadmap.liaison_task_tracker
				  WHERE correlation_id = $1`,
			[stuckCorrelationId],
		);
		expect((trackerRows[0] as any).status).toBe("failed");
		expect((trackerRows[0] as any).completed_at).not.toBeNull();
	});

	it("P3315: direct stale tracker claim resets the active row", async () => {
		const { rows: ids } = await query(
			`SELECT gen_random_uuid() AS old_id, gen_random_uuid() AS new_id`,
		);
		const oldCorrelationId = (ids[0] as any).old_id as string;
		const newCorrelationId = (ids[0] as any).new_id as string;
		await query(
			`INSERT INTO roadmap.liaison_task_tracker
				    (correlation_id, proposal_id, requestor_id, liaison_id, status, dispatch_id, worker_identity)
				 VALUES ($1, $2, $3, $4, 'spawned', $5, $4)`,
			[
				oldCorrelationId,
				TEST_PROPOSAL_ID,
				TEST_REQUESTOR,
				TEST_LIAISON,
				FAKE_DISPATCH_ID,
			],
		);

		const result = await claimLiaisonTaskTracker({
			correlationId: newCorrelationId,
			proposalId: TEST_PROPOSAL_ID,
			requestorId: TEST_REQUESTOR,
			liaisonId: TEST_LIAISON,
		});

		expect(result).toEqual({ ok: true, reused: true });
		const { rows: trackerRows } = await query(
			`SELECT correlation_id, status, dispatch_id, worker_identity, spawn_count
				   FROM roadmap.liaison_task_tracker
				  WHERE proposal_id = $1`,
			[TEST_PROPOSAL_ID],
		);
		expect((trackerRows[0] as any).correlation_id).toBe(newCorrelationId);
		expect((trackerRows[0] as any).status).toBe("claimed");
		expect((trackerRows[0] as any).dispatch_id).toBeNull();
		expect((trackerRows[0] as any).worker_identity).toBeNull();
		expect(Number((trackerRows[0] as any).spawn_count)).toBe(1);
	});

	it("task_status × 2 → tracker status=in_progress, relay messages appear", async () => {
		// Seed tracker directly
		await query(
			`INSERT INTO roadmap.liaison_task_tracker
			    (correlation_id, proposal_id, requestor_id, liaison_id, status, dispatch_id)
			 VALUES ($1, $2, $3, $4, 'spawned', $5)`,
			[
				correlationId,
				TEST_PROPOSAL_ID,
				TEST_REQUESTOR,
				TEST_LIAISON,
				FAKE_DISPATCH_ID,
			],
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
					[
						TEST_REQUESTOR,
						TEST_LIAISON,
						`progress note ${i + 1}`,
						correlationId,
						ackId,
					],
				);
				return (rows[0] as any).id as number;
			})();
			const statusMsg = makeIncomingMsg(
				statusMsgId,
				"task_status",
				correlationId,
				ackId,
			);
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
			[
				correlationId,
				TEST_PROPOSAL_ID,
				TEST_REQUESTOR,
				TEST_LIAISON,
				FAKE_DISPATCH_ID,
			],
		);

		const { rows: prevMsg } = await query(
			`INSERT INTO roadmap.message_ledger
			    (from_agent, to_agent, message_type, message_content, correlation_id, reply_to, metadata)
			 VALUES ($1, $2, 'task_status', 'done', $3, 0, '{}')
			 RETURNING id`,
			[TEST_REQUESTOR, TEST_LIAISON, correlationId],
		);
		const prevId = (prevMsg[0] as any).id as number;

		const completeMsg = makeIncomingMsg(
			900_993,
			"task_complete",
			correlationId,
			prevId,
			{ commit: "abc123" },
		);
		const helpers = makeHelpers(correlationId);
		await handleWorkerReport(completeMsg, TEST_LIAISON, helpers);

		// Tracker should be complete
		const { rows: trackerRows } = await query(
			`SELECT status, completed_at FROM roadmap.liaison_task_tracker WHERE proposal_id = $1`,
			[TEST_PROPOSAL_ID],
		);
		expect((trackerRows[0] as any).status).toBe("complete");
		expect((trackerRows[0] as any).completed_at).not.toBeNull();

		// Outbound completion status should carry acs_verified.
		const { rows: outRows } = await query(
			`SELECT metadata FROM roadmap.message_ledger
			  WHERE correlation_id = $1 AND message_type = 'task_status'
			  AND to_agent = $2`,
			[correlationId, TEST_REQUESTOR],
		);
		expect(outRows).toHaveLength(1);
		const meta = (outRows[0] as any).metadata as Record<string, unknown>;
		expect(Array.isArray(meta.acs_verified)).toBe(true);
		expect((meta.acs_verified as string[]).length).toBeGreaterThan(0);
	});
});
