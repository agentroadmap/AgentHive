import { randomUUID } from "node:crypto";
import { query as defaultQuery } from "../../infra/postgres/pool.ts";

export interface SpanHandle {
	spanId: string;
	traceId: string;
}

// biome-ignore lint/suspicious/noExplicitAny: pool query signature is generic
type QueryFn = (sql: string, params?: any[]) => Promise<{ rows: any[] }>;

/**
 * Thin DB writer for P604 observability tables.
 * All methods swallow errors — observability must never break the hot path.
 * Accepts an optional queryFn for testing (defaults to the shared pool).
 */
export class ObservabilityWriter {
	private readonly serviceDid: string;
	private readonly query: QueryFn;

	constructor(
		serviceDid: string,
		queryFn?: QueryFn,
	) {
		this.serviceDid = serviceDid;
		this.query = queryFn ?? (defaultQuery as unknown as QueryFn);
	}

	async startSpan(params: {
		traceId: string;
		operation: string;
		parentSpanId?: string | null;
		attributes?: Record<string, unknown>;
	}): Promise<SpanHandle> {
		const spanId = randomUUID();
		try {
			await this.query(
				`INSERT INTO roadmap.trace_span
				   (trace_id, span_id, parent_span_id, operation, service_did, attributes)
				 VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)`,
				[
					params.traceId,
					spanId,
					params.parentSpanId ?? null,
					params.operation,
					this.serviceDid,
					JSON.stringify(params.attributes ?? {}),
				],
			);
		} catch (err) {
			console.error("[ObservabilityWriter] startSpan failed:", err);
		}
		return { spanId, traceId: params.traceId };
	}

	async closeSpan(params: {
		spanId: string;
		status?: "ok" | "error" | "cancelled";
		errorMessage?: string | null;
	}): Promise<void> {
		try {
			await this.query(
				`UPDATE roadmap.trace_span
				    SET ended_at = now(),
				        status = $2,
				        error_message = $3
				  WHERE span_id = $1::uuid`,
				[params.spanId, params.status ?? "ok", params.errorMessage ?? null],
			);
		} catch (err) {
			console.error("[ObservabilityWriter] closeSpan failed:", err);
		}
	}

	async writeAgentExecutionSpan(params: {
		spanId: string;
		agencyId: string;
		agentId: number | bigint;
		proposalId?: number | null;
		modelName?: string | null;
		routeId?: bigint | null;
		inputTokens?: number | null;
		outputTokens?: number | null;
		costUsd?: number | null;
		briefingId?: string | null;
	}): Promise<void> {
		try {
			await this.query(
				`INSERT INTO roadmap.agent_execution_span
				   (span_id, agency_id, agent_id, proposal_id, model_name, route_id,
				    input_tokens, output_tokens, cost_usd, briefing_id)
				 VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid)`,
				[
					params.spanId,
					params.agencyId,
					BigInt(params.agentId),
					params.proposalId ?? null,
					params.modelName ?? null,
					params.routeId ?? null,
					params.inputTokens ?? null,
					params.outputTokens ?? null,
					params.costUsd ?? null,
					params.briefingId ?? null,
				],
			);
		} catch (err) {
			console.error("[ObservabilityWriter] writeAgentExecutionSpan failed:", err);
		}
	}

	async writeModelRoutingOutcome(params: {
		traceId: string;
		selectedRouteId: bigint;
		candidateRoutes: unknown[];
		selectionReason: string;
	}): Promise<void> {
		try {
			await this.query(
				`INSERT INTO roadmap.model_routing_outcome
				   (trace_id, selected_route_id, candidate_routes, selection_reason)
				 VALUES ($1::uuid, $2, $3, $4)`,
				[
					params.traceId,
					params.selectedRouteId,
					JSON.stringify(params.candidateRoutes),
					params.selectionReason,
				],
			);
		} catch (err) {
			console.error("[ObservabilityWriter] writeModelRoutingOutcome failed:", err);
		}
	}

	async writeDecisionExplainability(params: {
		traceId: string;
		decisionKind: "gate_advance" | "agent_assignment" | "budget_block" | "grant_check";
		inputs: Record<string, unknown>;
		rulesEvaluated: Record<string, unknown>;
		outcome: Record<string, unknown>;
		rulesetId?: string | null;
	}): Promise<void> {
		try {
			await this.query(
				`INSERT INTO roadmap.decision_explainability
				   (trace_id, decision_kind, inputs, rules_evaluated, outcome, ruleset_id)
				 VALUES ($1::uuid, $2, $3, $4, $5, $6)`,
				[
					params.traceId,
					params.decisionKind,
					JSON.stringify(params.inputs),
					JSON.stringify(params.rulesEvaluated),
					JSON.stringify(params.outcome),
					params.rulesetId ?? null,
				],
			);
		} catch (err) {
			console.error("[ObservabilityWriter] writeDecisionExplainability failed:", err);
		}
	}

	/**
	 * P3000: Emit a quota observability metric to quota_metric_event.
	 *
	 * Metric names (enforced by DB CHECK):
	 *   quota:denied_dispatch          — offer refused due to budget exhaustion
	 *   quota:reserved_headroom_granted — starvation recovery slot granted
	 *   quota:starvation_recovery       — agent cleared starvation threshold
	 *   quota:window_reset              — quota window rolled over and balance refreshed
	 *
	 * All methods are fire-and-forget; errors are logged but never propagated.
	 */
	async writeQuotaMetric(params: {
		metricName:
			| "quota:denied_dispatch"
			| "quota:reserved_headroom_granted"
			| "quota:starvation_recovery"
			| "quota:window_reset";
		agentIdentity?: string | null;
		/** Numeric magnitude; defaults to 1 (event counter). */
		value?: number;
		attributes?: Record<string, unknown>;
	}): Promise<void> {
		try {
			await this.query(
				`INSERT INTO roadmap_workforce.quota_metric_event
				   (metric_name, agent_identity, value, attributes)
				 VALUES ($1, $2, $3, $4)`,
				[
					params.metricName,
					params.agentIdentity ?? null,
					params.value ?? 1,
					JSON.stringify(params.attributes ?? {}),
				],
			);
		} catch (err) {
			console.error("[ObservabilityWriter] writeQuotaMetric failed:", err);
		}
	}
}
