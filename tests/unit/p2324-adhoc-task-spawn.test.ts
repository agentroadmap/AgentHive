import assert from "node:assert";
import { describe, it, afterEach } from "node:test";
import {
	handleTypedTaskRequest,
	type TaskDispatcherHelpers,
} from "../../src/infra/agency/task-dispatcher.ts";

/**
 * P2324: a task_request WITHOUT a proposal_id is an ad-hoc delegation.
 * - With AGENTHIVE_ADHOC_PROPOSAL_ID set → spawn an ephemeral worker via the
 *   bridge under the sentinel proposal (no reject, task_ack reply).
 * - Unset → strict reject (task_error "missing proposal_id"), no spawn.
 */

function makeMsg(overrides: Record<string, unknown> = {}) {
	return {
		id: 4242,
		from_agent: "agenthive/agency-orchestrator",
		to_agent: "gemini",
		message_content: "[Cleanup handover: revert host self-provisioning]",
		message_type: "task_request",
		proposal_id: null,
		project_id: 1,
		metadata: {},
		correlation_id: null,
		read_at: null,
		...overrides,
	} as any;
}

type Call = { name: string; args: any };

function makeHelpers(calls: Call[]): TaskDispatcherHelpers {
	return {
		insertReply: async (args) => {
			calls.push({ name: "insertReply", args });
			return 1;
		},
		markReadAndResolveTimeout: async (messageId) => {
			calls.push({ name: "markRead", args: { messageId } });
		},
		bridgeTaskToOfferDispatch: async (args) => {
			calls.push({ name: "bridge", args });
			return { dispatchId: 999, statusPollMs: 10, statusTimeoutMs: 100 };
		},
		monitorTaskDispatch: async (args) => {
			calls.push({ name: "monitor", args });
		},
		// P2326 AC-10: inject the inflight gauge so the cap check stays DB-free.
		// 0 inflight → always under cap → spawn path unchanged for these P2324 cases.
		countAdHocInflight: async () => 0,
	};
}

describe("P2324 ad-hoc task_request (no proposal_id)", () => {
	afterEach(() => {
		delete process.env.AGENTHIVE_ADHOC_PROPOSAL_ID;
	});

	it("spawns under the sentinel when AGENTHIVE_ADHOC_PROPOSAL_ID is set", async () => {
		process.env.AGENTHIVE_ADHOC_PROPOSAL_ID = "2326";
		const calls: Call[] = [];
		await handleTypedTaskRequest(
			makeMsg(),
			"gemini",
			"gemini",
			makeHelpers(calls),
		);

		const bridge = calls.find((c) => c.name === "bridge");
		assert.ok(bridge, "bridge must be called (worker spawned)");
		assert.equal(
			bridge!.args.msg.metadata.proposal_id,
			2326,
			"sentinel proposal id injected into bridge metadata",
		);
		assert.equal(bridge!.args.msg.message_type, "task");
		// task content is carried through for the worker brief
		assert.equal(
			bridge!.args.msg.message_content,
			"[Cleanup handover: revert host self-provisioning]",
		);

		const reply = calls.find((c) => c.name === "insertReply");
		assert.equal(reply!.args.messageType, "task_ack", "acks, does not reject");
		assert.ok(reply!.args.metadata?.adhoc === true);

		assert.ok(calls.some((c) => c.name === "markRead"));
		assert.ok(calls.some((c) => c.name === "monitor"), "monitoring started");
		assert.ok(
			!calls.some(
				(c) =>
					c.name === "insertReply" && c.args.messageType === "task_error",
			),
			"no task_error when ad-hoc is enabled",
		);
	});

	it("rejects (task_error) when AGENTHIVE_ADHOC_PROPOSAL_ID is unset", async () => {
		delete process.env.AGENTHIVE_ADHOC_PROPOSAL_ID;
		const calls: Call[] = [];
		await handleTypedTaskRequest(
			makeMsg(),
			"gemini",
			"gemini",
			makeHelpers(calls),
		);

		assert.ok(
			!calls.some((c) => c.name === "bridge"),
			"no spawn when ad-hoc disabled",
		);
		const reply = calls.find((c) => c.name === "insertReply");
		assert.equal(reply!.args.messageType, "task_error");
		assert.match(reply!.args.content, /missing proposal_id/);
		assert.ok(calls.some((c) => c.name === "markRead"));
	});

	it("ignores an invalid AGENTHIVE_ADHOC_PROPOSAL_ID and rejects", async () => {
		process.env.AGENTHIVE_ADHOC_PROPOSAL_ID = "not-a-number";
		const calls: Call[] = [];
		await handleTypedTaskRequest(
			makeMsg(),
			"gemini",
			"gemini",
			makeHelpers(calls),
		);
		assert.ok(!calls.some((c) => c.name === "bridge"));
		const reply = calls.find((c) => c.name === "insertReply");
		assert.equal(reply!.args.messageType, "task_error");
	});

	it("AC-4: monitorTaskDispatch is called for ad-hoc tasks to surface completion", async () => {
		process.env.AGENTHIVE_ADHOC_PROPOSAL_ID = "2326";
		const calls: Call[] = [];
		await handleTypedTaskRequest(
			makeMsg({
				correlation_id: "test-corr-ac4",
			}),
			"gemini",
			"gemini",
			makeHelpers(calls),
		);

		// Verify monitorTaskDispatch was called with correct args
		const monitor = calls.find((c) => c.name === "monitor");
		assert.ok(monitor, "monitorTaskDispatch must be called");
		assert.equal(monitor!.args.identity, "gemini", "liaison identity passed");
		assert.equal(monitor!.args.requestor, "agenthive/agency-orchestrator", "original requestor passed");
		assert.equal(monitor!.args.originalMessageId, 4242, "original message ID preserved");
		assert.equal(monitor!.args.correlationId, "test-corr-ac4", "correlation_id preserved");
		assert.equal(monitor!.args.dispatchId, 999, "dispatch ID from bridge result");

		// monitorTaskDispatch polls squad_dispatch and sends task_result or task_error
		// replies back to the requestor when the dispatch completes. This is verified
		// in the actual liaison-agent runtime tests. Here we verify the contract:
		// - monitorTaskDispatch is async and runs in the background (void call)
		// - it receives the original message context (identity, requestor, message ID, correlationId)
		// - it has access to dispatchId to monitor via squad_dispatch table
	});
});
