import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";

import { ObservabilityWriter } from "../../src/core/observability/observability-writer.ts";

// Captures every SQL call made by ObservabilityWriter without touching the real DB.
function makeMockQueryFn() {
	const calls: Array<{ sql: string; params: unknown[] }> = [];
	const queryFn = async (sql: string, params?: unknown[]) => {
		calls.push({ sql, params: params ?? [] });
		return { rows: [] };
	};
	return { queryFn, calls };
}

describe("ObservabilityWriter OTLP integration (mock collector)", () => {
	it("startSpan emits correct INSERT with trace_id, span_id, operation, service_did", async () => {
		const { queryFn, calls } = makeMockQueryFn();
		const writer = new ObservabilityWriter("operator:test", queryFn);
		const traceId = randomUUID();

		const { spanId } = await writer.startSpan({ traceId, operation: "agent.spawn" });

		assert.equal(calls.length, 1);
		const { sql, params } = calls[0];
		assert.ok(sql.includes("INSERT INTO roadmap.trace_span"), "must target trace_span table");
		assert.ok(sql.includes("trace_id"), "must include trace_id column");
		assert.ok(sql.includes("service_did"), "must include service_did column");
		assert.equal(params[0], traceId);
		assert.equal(params[1], spanId);
		assert.equal(params[3], "agent.spawn");
		assert.equal(params[4], "operator:test");
	});

	it("closeSpan emits UPDATE SET ended_at WHERE span_id", async () => {
		const { queryFn, calls } = makeMockQueryFn();
		const writer = new ObservabilityWriter("operator:test", queryFn);
		const spanId = randomUUID();

		await writer.closeSpan({ spanId, status: "ok" });

		assert.equal(calls.length, 1);
		const { sql, params } = calls[0];
		assert.ok(sql.includes("UPDATE roadmap.trace_span"), "must UPDATE trace_span");
		assert.ok(sql.includes("ended_at"), "must set ended_at");
		assert.equal(params[0], spanId);
		assert.equal(params[1], "ok");
	});

	it("writeAgentExecutionSpan emits INSERT with agency_id, agent_id, model_name", async () => {
		const { queryFn, calls } = makeMockQueryFn();
		const writer = new ObservabilityWriter("operator:agent-spawner", queryFn);
		const spanId = randomUUID();

		await writer.writeAgentExecutionSpan({
			spanId,
			agencyId: "openclaw-hermes",
			agentId: BigInt(99),
			proposalId: 604,
			modelName: "xiaomi/mimo-v2-pro",
			routeId: BigInt(3),
		});

		assert.equal(calls.length, 1);
		const { sql, params } = calls[0];
		assert.ok(sql.includes("INSERT INTO roadmap.agent_execution_span"), "must target agent_execution_span");
		assert.ok(sql.includes("agency_id"), "must include agency_id");
		assert.ok(sql.includes("agent_id"), "must include agent_id");
		assert.equal(params[0], spanId);
		assert.equal(params[1], "openclaw-hermes");
		assert.equal(String(params[2]), "99");
	});

	it("writeModelRoutingOutcome emits INSERT with trace_id, selected_route_id, candidate_routes", async () => {
		const { queryFn, calls } = makeMockQueryFn();
		const writer = new ObservabilityWriter("operator:agent-spawner", queryFn);
		const traceId = randomUUID();

		await writer.writeModelRoutingOutcome({
			traceId,
			selectedRouteId: BigInt(7),
			candidateRoutes: [{ routeId: "7", modelName: "xiaomi/mimo-v2-pro", selectionReason: "default_route" }],
			selectionReason: "default_route",
		});

		assert.equal(calls.length, 1);
		const { sql, params } = calls[0];
		assert.ok(sql.includes("INSERT INTO roadmap.model_routing_outcome"), "must target model_routing_outcome");
		assert.ok(sql.includes("trace_id"), "must use trace_id as key (not span_id)");
		assert.equal(params[0], traceId);
		assert.equal(String(params[1]), "7");
		assert.equal(params[3], "default_route");
	});

	it("writeDecisionExplainability emits INSERT with trace_id, inputs, rules_evaluated, outcome", async () => {
		const { queryFn, calls } = makeMockQueryFn();
		const writer = new ObservabilityWriter("operator:orchestrator", queryFn);
		const traceId = randomUUID();

		await writer.writeDecisionExplainability({
			traceId,
			decisionKind: "gate_advance",
			inputs: { proposal_id: 604, gate: "D3" },
			rulesEvaluated: { gate_rule: "maturity=mature" },
			outcome: { decision: "advance", to_stage: "merge" },
		});

		assert.equal(calls.length, 1);
		const { sql, params } = calls[0];
		assert.ok(sql.includes("INSERT INTO roadmap.decision_explainability"), "must target decision_explainability");
		assert.ok(sql.includes("trace_id"), "must use trace_id as key (not span_id)");
		assert.equal(params[0], traceId);
		assert.equal(params[1], "gate_advance");
		const outcome = JSON.parse(params[4] as string);
		assert.equal(outcome.decision, "advance");
	});

	it("never throws when queryFn rejects — error isolation contract", async () => {
		const throwingQueryFn = async () => { throw new Error("simulated DB failure"); };
		const writer = new ObservabilityWriter("operator:test", throwingQueryFn);
		const traceId = randomUUID();

		// None of these should throw
		const { spanId } = await writer.startSpan({ traceId, operation: "test" });
		await writer.closeSpan({ spanId, status: "error" });
		await writer.writeAgentExecutionSpan({ spanId, agencyId: "wt", agentId: BigInt(1) });
		await writer.writeModelRoutingOutcome({
			traceId,
			selectedRouteId: BigInt(1),
			candidateRoutes: [],
			selectionReason: "default_route",
		});
		await writer.writeDecisionExplainability({
			traceId,
			decisionKind: "gate_advance",
			inputs: {},
			rulesEvaluated: {},
			outcome: {},
		});
	});
});
