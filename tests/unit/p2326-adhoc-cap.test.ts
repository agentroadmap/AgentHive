import assert from "node:assert";
import { describe, it, afterEach } from "node:test";
import {
	handleTypedTaskRequest,
	type TaskDispatcherHelpers,
} from "../../src/infra/agency/task-dispatcher.ts";

/**
 * P2326 AC-9/10/11: ad-hoc (no-proposal) task_request bucket + inflight cap.
 *
 * AC-9 (drift reconcile): the live gate is the env var AGENTHIVE_ADHOC_PROPOSAL_ID
 *   (the sentinel id; unset/invalid → strict reject). The cap adds a second var
 *   AGENTHIVE_ADHOC_MAX_INFLIGHT (default 3). Neither is the older
 *   AGENTHIVE_ADHOC_TASKS_ENABLED boolean named in stale AC text.
 * AC-10 (cap): before spawning, count non-terminal squad_dispatch rows under the
 *   sentinel proposal; at/over the cap → task_error, no spawn.
 * AC-11 (tests): this file. The DB/spawn boundary is mocked via injected helpers
 *   (countAdHocInflight + bridgeTaskToOfferDispatch) — NO live tables are touched.
 */

function makeMsg(overrides: Record<string, unknown> = {}) {
	return {
		id: 7777,
		from_agent: "agenthive/agency-orchestrator",
		to_agent: "gemini",
		message_content: "[Ad-hoc: sweep stale worktrees]",
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

/**
 * @param calls   sink for observed helper invocations
 * @param inflight value the injected countAdHocInflight returns (the gauge)
 */
function makeHelpers(calls: Call[], inflight = 0): TaskDispatcherHelpers {
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
		countAdHocInflight: async (sentinelProposalId: number) => {
			calls.push({ name: "count", args: { sentinelProposalId } });
			return inflight;
		},
	};
}

describe("P2326 ad-hoc inflight cap (AC-10) + drift reconcile (AC-9)", () => {
	afterEach(() => {
		delete process.env.AGENTHIVE_ADHOC_PROPOSAL_ID;
		delete process.env.AGENTHIVE_ADHOC_MAX_INFLIGHT;
	});

	it("AC-9: unset AGENTHIVE_ADHOC_PROPOSAL_ID → strict reject, no spawn, no count", async () => {
		delete process.env.AGENTHIVE_ADHOC_PROPOSAL_ID;
		const calls: Call[] = [];
		await handleTypedTaskRequest(makeMsg(), "gemini", "gemini", makeHelpers(calls));

		assert.ok(!calls.some((c) => c.name === "bridge"), "no spawn when disabled");
		assert.ok(
			!calls.some((c) => c.name === "count"),
			"cap not even consulted when sentinel unset",
		);
		const reply = calls.find((c) => c.name === "insertReply");
		assert.equal(reply!.args.messageType, "task_error");
		assert.match(reply!.args.content, /missing proposal_id/);
	});

	it("AC-10: spawns under sentinel WITHOUT claimProposal when under cap", async () => {
		process.env.AGENTHIVE_ADHOC_PROPOSAL_ID = "2326";
		const calls: Call[] = [];
		// inflight=2, default cap=3 → under cap → spawn
		await handleTypedTaskRequest(makeMsg(), "gemini", "gemini", makeHelpers(calls, 2));

		const count = calls.find((c) => c.name === "count");
		assert.ok(count, "inflight gauge consulted before spawn");
		assert.equal(count!.args.sentinelProposalId, 2326, "counted under sentinel");

		const bridge = calls.find((c) => c.name === "bridge");
		assert.ok(bridge, "bridge called (worker spawned) when under cap");
		assert.equal(bridge!.args.msg.metadata.proposal_id, 2326);

		const reply = calls.find((c) => c.name === "insertReply");
		assert.equal(reply!.args.messageType, "task_ack", "acks, not reject");
		// The ad-hoc path never claims the proposal — it only buckets under the
		// sentinel FK. handleTypedTaskRequest's claim path (claimProposal) is
		// only reached when a real proposal_id is present; here proposal_id=null.
		assert.ok(calls.some((c) => c.name === "monitor"), "monitoring started");
		assert.ok(
			!calls.some(
				(c) => c.name === "insertReply" && c.args.messageType === "task_error",
			),
			"no task_error under cap",
		);
	});

	it("AC-10: at the cap → task_error, no spawn (N+1th request rejected)", async () => {
		process.env.AGENTHIVE_ADHOC_PROPOSAL_ID = "2326";
		const calls: Call[] = [];
		// inflight=3 == default cap 3 → reject the (N+1)th
		await handleTypedTaskRequest(makeMsg(), "gemini", "gemini", makeHelpers(calls, 3));

		assert.ok(
			!calls.some((c) => c.name === "bridge"),
			"no worker spawned at the cap",
		);
		assert.ok(
			!calls.some((c) => c.name === "monitor"),
			"no monitoring when rejected",
		);
		const reply = calls.find((c) => c.name === "insertReply");
		assert.ok(reply, "a reply is sent");
		assert.equal(reply!.args.messageType, "task_error", "cap reject is a task_error");
		assert.match(reply!.args.content, /cap reached \(3\/3\)/);
		assert.equal(reply!.args.metadata?.cap_rejected, true);
		assert.equal(reply!.args.metadata?.inflight, 3);
		assert.equal(reply!.args.metadata?.max_inflight, 3);
		assert.ok(calls.some((c) => c.name === "markRead"), "message resolved");
	});

	it("AC-10: over the cap → reject (inflight strictly greater than cap)", async () => {
		process.env.AGENTHIVE_ADHOC_PROPOSAL_ID = "2326";
		const calls: Call[] = [];
		await handleTypedTaskRequest(makeMsg(), "gemini", "gemini", makeHelpers(calls, 9));

		assert.ok(!calls.some((c) => c.name === "bridge"));
		const reply = calls.find((c) => c.name === "insertReply");
		assert.equal(reply!.args.messageType, "task_error");
		assert.match(reply!.args.content, /cap reached \(9\/3\)/);
	});

	it("AC-10: AGENTHIVE_ADHOC_MAX_INFLIGHT overrides the default cap", async () => {
		process.env.AGENTHIVE_ADHOC_PROPOSAL_ID = "2326";
		process.env.AGENTHIVE_ADHOC_MAX_INFLIGHT = "5";
		const calls: Call[] = [];
		// inflight=4 < 5 → spawn (would have been rejected under default 3)
		await handleTypedTaskRequest(makeMsg(), "gemini", "gemini", makeHelpers(calls, 4));

		assert.ok(calls.some((c) => c.name === "bridge"), "spawns: 4 < custom cap 5");
		assert.ok(
			!calls.some(
				(c) => c.name === "insertReply" && c.args.messageType === "task_error",
			),
		);
	});

	it("AC-10: invalid AGENTHIVE_ADHOC_MAX_INFLIGHT falls back to default 3 (fails safe, not open)", async () => {
		process.env.AGENTHIVE_ADHOC_PROPOSAL_ID = "2326";
		process.env.AGENTHIVE_ADHOC_MAX_INFLIGHT = "not-a-number";
		const calls: Call[] = [];
		// inflight=3 → default cap 3 still enforced → reject
		await handleTypedTaskRequest(makeMsg(), "gemini", "gemini", makeHelpers(calls, 3));

		assert.ok(!calls.some((c) => c.name === "bridge"), "garbage cap does not disable the valve");
		const reply = calls.find((c) => c.name === "insertReply");
		assert.equal(reply!.args.messageType, "task_error");
		assert.match(reply!.args.content, /cap reached \(3\/3\)/);
	});

	it("AC-10: count failure fails closed (task_error, no spawn)", async () => {
		process.env.AGENTHIVE_ADHOC_PROPOSAL_ID = "2326";
		const calls: Call[] = [];
		const helpers = makeHelpers(calls);
		helpers.countAdHocInflight = async () => {
			throw new Error("db unreachable");
		};
		await handleTypedTaskRequest(makeMsg(), "gemini", "gemini", helpers);

		assert.ok(!calls.some((c) => c.name === "bridge"), "no spawn when capacity unknown");
		const reply = calls.find((c) => c.name === "insertReply");
		assert.equal(reply!.args.messageType, "task_error");
		assert.match(reply!.args.content, /unable to verify inflight capacity/);
	});
});
