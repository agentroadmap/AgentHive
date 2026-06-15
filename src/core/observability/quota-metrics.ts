/**
 * P3000 AC-8: Quota subsystem observability counters.
 *
 * Thin writer for roadmap_workforce.quota_metric_event (migration 276), in the
 * same spirit as observability-writer.ts: ALL emits swallow errors so the
 * (future) hot path can never be broken by a metric write, and the query
 * function is injectable for tests (no live DB).
 *
 * Distinct metric names (must match the CHECK constraint in migration 276):
 *   quota:denied_dispatch
 *   quota:reserved_headroom_granted
 *   quota:starvation_recovery
 *   quota:window_reset
 */

export type QuotaMetricName =
	| "quota:denied_dispatch"
	| "quota:reserved_headroom_granted"
	| "quota:starvation_recovery"
	| "quota:window_reset";

export interface QuotaMetricEvent {
	metricName: QuotaMetricName;
	agentIdentity?: string | null;
	value?: number;
	attributes?: Record<string, unknown>;
}

/** Emitter signature — injectable so the debt tracker can be tested with a spy. */
export type QuotaMetricEmitter = (event: QuotaMetricEvent) => void;

// biome-ignore lint/suspicious/noExplicitAny: pool query signature is generic
type QueryFn = (sql: string, params?: any[]) => Promise<{ rows: any[] }>;

let cachedQuery: QueryFn | null = null;

async function getDefaultQuery(): Promise<QueryFn> {
	if (!cachedQuery) {
		const { query } = await import("../../infra/postgres/pool.ts");
		cachedQuery = query as unknown as QueryFn;
	}
	return cachedQuery;
}

/**
 * Persist a quota metric event. Fire-and-forget: never throws, never blocks the
 * caller's logical result (errors are logged and swallowed, mirroring
 * ObservabilityWriter).
 */
export async function writeQuotaMetric(
	event: QuotaMetricEvent,
	queryFn?: QueryFn,
): Promise<void> {
	try {
		const run = queryFn ?? (await getDefaultQuery());
		await run(
			`INSERT INTO roadmap_workforce.quota_metric_event
			   (metric_name, agent_identity, value, attributes)
			 VALUES ($1, $2, $3, $4)`,
			[
				event.metricName,
				event.agentIdentity ?? null,
				event.value ?? 1,
				JSON.stringify(event.attributes ?? {}),
			],
		);
	} catch (err) {
		console.error("[quota-metrics] writeQuotaMetric failed:", err);
	}
}

/**
 * Synchronous-looking emit used by the pure-ish decision wrappers. Schedules the
 * async write and intentionally does not await it (fire-and-forget). The promise
 * rejection is swallowed inside writeQuotaMetric, so this never produces an
 * unhandled rejection.
 */
export const emitQuotaMetric: QuotaMetricEmitter = (event) => {
	void writeQuotaMetric(event);
};
