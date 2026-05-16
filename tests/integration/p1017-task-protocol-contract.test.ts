/**
 * P1017 AC-33: Transport-Level Task Response Contract
 *
 * AC-33: An agent that receives a row with message_type='task_request' and
 * matching to_agent MUST result in a task_ack row with the same correlation_id
 * being inserted within 10 seconds.
 *
 * This test verifies:
 * 1. The MCP HTTP endpoint sends correct JSON-RPC 2.0 envelope (not malformed envelope)
 * 2. The task dispatcher's handleTypedTaskRequest completes the round-trip
 * 3. A task_ack response appears with the correct correlation_id within 10s
 */

import assert from "node:assert";
import { describe, it, before, after, beforeEach } from "node:test";
import { randomUUID } from "node:crypto";
import { query } from "../../src/infra/postgres/pool.ts";
import { handleTypedTaskRequest, type TaskDispatcherHelpers } from "../../src/infra/agency/task-dispatcher.ts";
import type { IncomingMessage } from "../../src/infra/agency/liaison-agent.ts";

describe("P1017 AC-33: Task Protocol Transport Contract", () => {
	const testLiaisonIdentity = "test-liaison-12345";
	const testRequestorIdentity = "test-requestor-api";
	const testProposalId = "1017";

	before(async () => {
		// Set MCP URL for test environment
		process.env.MCP_URL = "http://127.0.0.1:6421";

		// Ensure agents exist in registry
		await query(
			`INSERT INTO roadmap.agent_registry (agent_identity, agent_type)
			 VALUES ($1, 'workforce'), ($2, 'llm')
			 ON CONFLICT (agent_identity) DO NOTHING`,
			[testLiaisonIdentity, testRequestorIdentity],
		);

		// Ensure message ACL exists for both agents
		await query(
			`INSERT INTO roadmap.message_acl (from_agent, to_agent, grant_type, granted_by)
			 VALUES
			   ($1, $2, 'dm', 'system'),
			   ($2, $1, 'dm', 'system')
			 ON CONFLICT DO NOTHING`,
			[testLiaisonIdentity, testRequestorIdentity],
		);

		// Ensure proposal exists for testing
		try {
			await query(
				`INSERT INTO roadmap_proposal.proposal (display_id, type, status, title, maturity)
				 VALUES ($1, 'task', 'Draft', 'P1017 Test Proposal', 'new')
				 ON CONFLICT (display_id) DO NOTHING`,
				[testProposalId],
			);
		} catch {
			// Proposal may already exist; skip
		}
	});

	afterEach(async () => {
		// Clean up test messages and rows after each test
		await query(
			`DELETE FROM roadmap.message_ledger
			 WHERE (from_agent = $1 OR to_agent = $1)
			   OR (from_agent = $2 OR to_agent = $2)`,
			[testLiaisonIdentity, testRequestorIdentity],
		);

		// Clean up liaison tracker rows by proposal_id
		await query(
			`DELETE FROM roadmap.liaison_task_tracker
			 WHERE proposal_id = $1`,
			[testProposalId],
		);
	});

	it("AC-33a: task_request triggers task_ack insertion within 10s", async () => {
		const correlationId = randomUUID();
		const taskRequestId = await insertTaskRequest({
			fromAgent: testRequestorIdentity,
			toAgent: testLiaisonIdentity,
			proposalId: testProposalId,
			correlationId,
		});

		// Build incoming message as liaison would receive it
		const msg: IncomingMessage = {
			id: taskRequestId,
			from_agent: testRequestorIdentity,
			to_agent: testLiaisonIdentity,
			message_type: "task_request",
			message_content: "Request to develop proposal 1017",
			correlation_id: correlationId,
			created_at: new Date(),
			metadata: {
				proposal_id: testProposalId,
			},
		} as IncomingMessage;

		// Mock helpers for the dispatcher
		const insertedReplies: Array<{
			messageType: string;
			correlationId: string | null;
		}> = [];

		const helpers: TaskDispatcherHelpers = {
			insertReply: async (args) => {
				insertedReplies.push({
					messageType: args.messageType,
					correlationId: args.correlationId,
				});
				// Simulate actual DB insert (in real flow, this writes to message_ledger)
				const result = await query(
					`INSERT INTO roadmap.message_ledger
					  (from_agent, to_agent, message_type, message_content, correlation_id, reply_to)
					 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
					[
						args.fromAgent,
						args.toAgent,
						args.messageType,
						args.content,
						args.correlationId,
						args.replyTo,
					],
				);
				return result.rows[0]?.id ?? 0;
			},
			markReadAndResolveTimeout: async () => {
				// No-op for test
			},
			bridgeTaskToOfferDispatch: async () => ({
				dispatchId: 999,
				statusPollMs: 500,
				statusTimeoutMs: 30000,
			}),
			monitorTaskDispatch: async () => {
				// No-op for test
			},
		};

		// Call the handler — simulates receiving task_request
		await handleTypedTaskRequest(msg, testLiaisonIdentity, "test-provider", helpers);

		// Verify task_ack was inserted synchronously
		assert.ok(
			insertedReplies.some((r) => r.messageType === "task_ack"),
			"task_ack must be inserted by handleTypedTaskRequest",
		);

		// Verify task_ack has correct correlation_id
		const ackReply = insertedReplies.find((r) => r.messageType === "task_ack");
		assert.strictEqual(
			ackReply?.correlationId,
			correlationId,
			"task_ack must have same correlation_id as task_request",
		);

		// Verify DB row appears within 10s (check via query)
		const maxWaitMs = 10000;
		const startTime = Date.now();
		let ackRow = null;

		while (Date.now() - startTime < maxWaitMs) {
			const { rows } = await query(
				`SELECT id, message_type, correlation_id FROM roadmap.message_ledger
				 WHERE message_type = 'task_ack' AND correlation_id = $1`,
				[correlationId],
			);
			if (rows.length > 0) {
				ackRow = rows[0];
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}

		assert.ok(ackRow, `task_ack row must exist in DB within ${maxWaitMs}ms`);
		assert.strictEqual(ackRow.correlation_id, correlationId, "DB row correlation_id must match");
	});

	it("AC-33b: MCP claim call uses correct JSON-RPC envelope", async () => {
		/**
		 * Verify that the JSON-RPC format sent to /mcp endpoint is valid.
		 * The http-compat handler expects: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments } }
		 * This test intercepts fetch calls and validates the body shape.
		 */

		const correlationId = randomUUID();
		const taskRequestId = await insertTaskRequest({
			fromAgent: testRequestorIdentity,
			toAgent: testLiaisonIdentity,
			proposalId: testProposalId,
			correlationId,
		});

		const msg: IncomingMessage = {
			id: taskRequestId,
			from_agent: testRequestorIdentity,
			to_agent: testLiaisonIdentity,
			message_type: "task_request",
			message_content: "Request to develop proposal 1017",
			correlation_id: correlationId,
			created_at: new Date(),
			metadata: {
				proposal_id: testProposalId,
			},
		} as IncomingMessage;

		let capturedMcpCalls: Array<{
			method: string;
			toolName?: string;
			bodyShape: unknown;
		}> = [];

		// Mock fetch to capture MCP calls
		const originalFetch = global.fetch as any;
		(global as any).fetch = async (
			url: string | URL,
			options?: RequestInit,
		) => {
			const urlStr = typeof url === "string" ? url : url.toString();
			if (urlStr.includes("/mcp")) {
				const body = JSON.parse(options?.body as string);
				capturedMcpCalls.push({
					method: body.method,
					toolName: body.params?.name,
					bodyShape: body,
				});
				// Return a fake JSON-RPC success response
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							content: [
								{
									type: "text",
									text: JSON.stringify({ lease_id: "fake-lease-123" }),
								},
							],
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return originalFetch(url, options);
		};

		try {
			const helpers: TaskDispatcherHelpers = {
				insertReply: async () => 0,
				markReadAndResolveTimeout: async () => {},
				bridgeTaskToOfferDispatch: async () => ({
					dispatchId: 999,
					statusPollMs: 500,
					statusTimeoutMs: 30000,
				}),
				monitorTaskDispatch: async () => {},
			};

			await handleTypedTaskRequest(msg, testLiaisonIdentity, "test-provider", helpers);

			// Verify prop_claim call was made with correct envelope
			const claimCall = capturedMcpCalls.find((c) => c.toolName === "prop_claim");
			assert.ok(claimCall, "prop_claim MCP call must be made");

			// Validate JSON-RPC structure
			const body = claimCall.bodyShape as Record<string, unknown>;
			assert.strictEqual(body.jsonrpc, "2.0", "Must use JSON-RPC 2.0");
			assert.strictEqual(body.method, "tools/call", "Method must be tools/call");
			assert.ok(body.params, "Must have params object");

			const params = body.params as Record<string, unknown>;
			assert.strictEqual(params.name, "prop_claim", "Tool name must be prop_claim");
			assert.ok(params.arguments, "Must have arguments object");

			const args = params.arguments as Record<string, unknown>;
			assert.strictEqual(args.id, testProposalId, "Arguments must include id");
			assert.ok(args.agent, "Arguments must include agent identity");
			assert.ok(args.durationMinutes, "Arguments must include durationMinutes");
		} finally {
			// Restore original fetch
			(global as any).fetch = originalFetch;
		}
	});
});

/**
 * Helper: Insert a task_request row and return its ID.
 */
async function insertTaskRequest(opts: {
	fromAgent: string;
	toAgent: string;
	proposalId: string;
	correlationId: string;
}): Promise<number> {
	const result = await query(
		`INSERT INTO roadmap.message_ledger
		  (from_agent, to_agent, message_type, message_content, correlation_id, metadata)
		 VALUES ($1, $2, 'task_request', $3, $4, $5)
		 RETURNING id`,
		[
			opts.fromAgent,
			opts.toAgent,
			`Task request for proposal ${opts.proposalId}`,
			opts.correlationId,
			JSON.stringify({ proposal_id: opts.proposalId }),
		],
	);
	return result.rows[0].id;
}
