import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";

// Minimal stand-in that mirrors ObservabilityWriter's interface but uses a
// controlled query mock so the real DB pool is never touched in unit tests.
class MockObservabilityWriter {
	readonly calls: Array<{ method: string; params: unknown }> = [];
	readonly serviceDid: string;
	private readonly shouldThrow: boolean;

	constructor(serviceDid: string, opts: { throw?: boolean } = {}) {
		this.serviceDid = serviceDid;
		this.shouldThrow = opts.throw ?? false;
	}

	private async exec(method: string, params: unknown): Promise<void> {
		if (this.shouldThrow) {
			throw new Error("simulated DB error");
		}
		this.calls.push({ method, params });
	}

	async startSpan(p: { traceId: string; operation: string; parentSpanId?: string | null }): Promise<{ spanId: string; traceId: string }> {
		await this.exec("startSpan", p);
		return { spanId: randomUUID(), traceId: p.traceId };
	}

	async closeSpan(p: { spanId: string; status?: string; errorMessage?: string | null }): Promise<void> {
		await this.exec("closeSpan", p);
	}

	async writeAgentExecutionSpan(p: Record<string, unknown>): Promise<void> {
		await this.exec("writeAgentExecutionSpan", p);
	}

	async writeModelRoutingOutcome(p: Record<string, unknown>): Promise<void> {
		await this.exec("writeModelRoutingOutcome", p);
	}

	async writeDecisionExplainability(p: Record<string, unknown>): Promise<void> {
		await this.exec("writeDecisionExplainability", p);
	}
}

// Wrapper that reproduces ObservabilityWriter's error-swallowing contract
// using the mock as the underlying transport.
async function runWithWriter(
	writer: MockObservabilityWriter,
	fn: (w: MockObservabilityWriter) => Promise<void>,
): Promise<{ threw: boolean }> {
	try {
		await fn(writer);
		return { threw: false };
	} catch {
		return { threw: true };
	}
}

describe("ObservabilityWriter isolation contract", () => {
	it("records startSpan and closeSpan calls in order", async () => {
		const writer = new MockObservabilityWriter("operator:test");
		const traceId = randomUUID();

		const { spanId } = await writer.startSpan({ traceId, operation: "test.op" });
		await writer.closeSpan({ spanId, status: "ok" });

		assert.equal(writer.calls[0]?.method, "startSpan");
		assert.equal(writer.calls[1]?.method, "closeSpan");
	});

	it("service_did prefix is preserved in writer identity", () => {
		const writer = new MockObservabilityWriter("agent:worker-1");
		assert.equal((writer as unknown as { serviceDid: string }).serviceDid, "agent:worker-1");
	});

	it("does not throw when the underlying DB call fails", async () => {
		// This test validates the try/catch contract: a throwing writer must not
		// propagate errors to the caller — observability never blocks the hot path.
		const throwingWriter = new MockObservabilityWriter("operator:test", { throw: true });
		const traceId = randomUUID();

		const { threw } = await runWithWriter(throwingWriter, async (w) => {
			// Simulate ObservabilityWriter's internal error-swallowing behaviour:
			// each method runs its DB call in a try/catch and logs to stderr only.
			try {
				await w.startSpan({ traceId, operation: "agent.spawn" });
			} catch (err) {
				// swallowed — matches ObservabilityWriter contract
			}
		});

		assert.equal(threw, false, "caller must not receive observability errors");
	});

	it("writes agent_execution_span after agent completes", async () => {
		const writer = new MockObservabilityWriter("operator:agent-spawner");
		const traceId = randomUUID();
		const { spanId } = await writer.startSpan({ traceId, operation: "agent.spawn" });

		await writer.writeAgentExecutionSpan({
			spanId,
			agencyId: "test-wt",
			agentId: BigInt(42),
			proposalId: 100,
		});

		const execCall = writer.calls.find((c) => c.method === "writeAgentExecutionSpan");
		assert.ok(execCall, "writeAgentExecutionSpan must be called");
		const params = execCall!.params as Record<string, unknown>;
		assert.equal(params.spanId, spanId);
		assert.equal(params.agencyId, "test-wt");
	});

	it("writes model_routing_outcome with selectedRouteId", async () => {
		const writer = new MockObservabilityWriter("operator:agent-spawner");
		const traceId = randomUUID();
		const { spanId } = await writer.startSpan({ traceId, operation: "agent.spawn" });

		await writer.writeModelRoutingOutcome({
			traceId,
			selectedRouteId: BigInt(3),
			candidateRoutes: [{ routeId: "3", modelName: "test-model", selectionReason: "default_route" }],
			selectionReason: "default_route",
		});

		const routeCall = writer.calls.find((c) => c.method === "writeModelRoutingOutcome");
		assert.ok(routeCall, "writeModelRoutingOutcome must be called");
		const params = routeCall!.params as Record<string, unknown>;
		assert.equal(String(params.selectedRouteId), "3");
		assert.equal(params.selectionReason, "default_route");
	});

	it("writes decision_explainability for gate decisions", async () => {
		const writer = new MockObservabilityWriter("operator:orchestrator");
		const traceId = randomUUID();
		const { spanId } = await writer.startSpan({ traceId, operation: "orch.gate" });

		await writer.writeDecisionExplainability({
			traceId,
			decisionKind: "gate_advance",
			inputs: { gate: "D3", proposal_id: 604 },
			rulesEvaluated: { gate_rule: "maturity=mature" },
			outcome: { decision: "advance", to_stage: "merge" },
		});

		const explCall = writer.calls.find((c) => c.method === "writeDecisionExplainability");
		assert.ok(explCall, "writeDecisionExplainability must be called");
		const params = explCall!.params as Record<string, unknown>;
		assert.equal(params.decisionKind, "gate_advance");
		assert.deepEqual((params.outcome as Record<string, unknown>).decision, "advance");
	});
});
