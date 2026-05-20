/**
 * Postgres-backed Spending & Model MCP Tools for AgentHive.
 *
 * Handles budget guardrails and LLM model metadata.
 * All handler methods catch errors and return MCP text responses instead of throwing.
 */

import { query } from "../../../../postgres/pool.ts";
import { resolveProposalId } from "../../../../infra/postgres/proposal-storage-v2.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";

function hasMissingRelation(err: unknown, relationName: string): boolean {
	return (
		err instanceof Error &&
		(err.message.includes(`relation "${relationName}" does not exist`) ||
			err.message.includes(`relation "metrics.${relationName}" does not exist`))
	);
}

function isTokenEfficiencyUnavailable(err: unknown): boolean {
	return (
		hasMissingRelation(err, "token_efficiency") ||
		hasMissingRelation(err, "v_weekly_efficiency") ||
		(err instanceof Error &&
			err.message.includes("permission denied for schema metrics"))
	);
}

function errorResult(msg: string, err: unknown): CallToolResult {
	return {
		content: [
			{
				type: "text",
				text: `⚠️ ${msg}: ${err instanceof Error ? err.message : String(err)}`,
			},
		],
	};
}

let perMillionModelPricingPromise: Promise<boolean> | undefined;
let modelTierSupportPromise: Promise<boolean> | undefined;

async function supportsModelTier(): Promise<boolean> {
	if (!modelTierSupportPromise) {
		modelTierSupportPromise = query<{ column_name: string }>(
			`SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'roadmap'
         AND table_name = 'model_metadata'
         AND column_name = 'tier'`,
			[],
		).then(({ rows }) => rows.length > 0);
	}
	return modelTierSupportPromise;
}

async function supportsPerMillionModelPricing(): Promise<boolean> {
	if (!perMillionModelPricingPromise) {
		perMillionModelPricingPromise = query<{ column_name: string }>(
			`SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'roadmap'
         AND table_name = 'model_metadata'
         AND column_name = ANY($1::text[])`,
			[
				[
					"cost_per_million_input",
					"cost_per_million_output",
					"cost_per_million_cache_write",
					"cost_per_million_cache_hit",
				],
			],
		).then(({ rows }) => rows.length > 0);
	}
	return perMillionModelPricingPromise;
}

function parseOptionalNumber(value?: string): number | null {
	if (value === undefined || value.trim() === "") {
		return null;
	}
	const parsed = Number(value);
	if (Number.isNaN(parsed)) {
		throw new Error(`Invalid numeric value "${value}"`);
	}
	return parsed;
}

function perMillionFromPer1k(
	value: string | number | null | undefined,
): number | null {
	if (value === null || value === undefined) return null;
	const numeric = typeof value === "number" ? value : Number(value);
	return Number.isNaN(numeric) ? null : numeric * 1000;
}

function per1kFromPerMillion(
	value: string | number | null | undefined,
): number | null {
	if (value === null || value === undefined) return null;
	const numeric = typeof value === "number" ? value : Number(value);
	return Number.isNaN(numeric) ? null : numeric / 1000;
}

function formatMillionCost(value: number | null | undefined): string {
	return value === null || value === undefined
		? "?"
		: `$${value.toFixed(6)}/1M`;
}

type ModelMetadataRow = {
	model_name: string;
	provider: string;
	cost_per_1k_input: string | null;
	cost_per_1k_output: string | null;
	cost_per_million_input?: string | null;
	cost_per_million_output?: string | null;
	cost_per_million_cache_write?: string | null;
	cost_per_million_cache_hit?: string | null;
	max_tokens: number | null;
	context_window: number | null;
	capabilities: Record<string, boolean> | null;
	rating: number | null;
	is_active: boolean;
};

// P797: Row type for the model_metadata JOIN model_routes query
type ModelRouteRow = {
	model_name: string;
	provider: string;
	tier?: string | null;
	cost_per_million_input: string | null;
	context_window: number | null;
	capabilities: Record<string, boolean> | null;
	rating: number | null;
	is_active: boolean;
	route_provider: string;
	priority: number;
};

// P797: 2-second stale-while-revalidate in-memory cache for model_list
type ModelListCacheEntry = {
	rows: ModelRouteRow[];
	fetchedAt: number;
	revalidating: boolean;
};
const MODEL_LIST_CACHE_TTL_MS = 2_000;
const modelListCache = new Map<string, ModelListCacheEntry>();
let _cacheHitTotal = 0;
let _listCallsTotal = 0;
let _noRouteErrorsTotal = 0;
type ModelQueryFn = <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;

function modelListCacheKey(args: {
	provider?: string;
	tier?: string;
	project_id?: number;
	active_only?: boolean;
}): string {
	return JSON.stringify({
		provider: args.provider ?? null,
		tier: args.tier ?? null,
		project_id: args.project_id ?? null,
		active_only: args.active_only !== false,
	});
}

async function fetchModelRouteRows(args: {
	provider?: string;
	tier?: string;
	project_id?: number;
	active_only?: boolean;
	_queryFn?: ModelQueryFn;
}): Promise<ModelRouteRow[]> {
	const activeOnly = args.active_only !== false;
	const provider = args.provider ?? null;
	const tier = args.tier ?? null;
	const queryFn: ModelQueryFn = args._queryFn ?? (query as unknown as ModelQueryFn);
	const projectId = args.project_id ?? null;
	const { rows } = await queryFn<ModelRouteRow>(
		`SELECT v.model_name, v.provider, v.tier, v.cost_per_million_input,
		        v.context_window, v.capabilities, v.rating, v.is_active,
		        v.route_provider, v.priority
		 FROM   roadmap.model_route_view v
		 WHERE  v.is_enabled = true
		   AND  ($1::boolean IS FALSE OR COALESCE(v.is_active, true) = true)
		   AND  ($2::text IS NULL OR v.route_provider = $2)
		   AND  ($3::text IS NULL OR v.tier = $3)
		   AND  (
		       $4::bigint IS NULL
		       OR NOT EXISTS (
		           SELECT 1 FROM roadmap.project_route_policy p
		           WHERE p.project_id = $4
		       )
		       OR EXISTS (
		           SELECT 1 FROM roadmap.project_route_policy p
		           WHERE p.project_id = $4
		             AND (
		                 array_length(p.allowed_route_providers, 1) IS NULL
		                 OR v.route_provider = ANY(p.allowed_route_providers)
		             )
		             AND NOT (
		                 v.route_provider = ANY(COALESCE(p.forbidden_route_providers, '{}'))
		             )
		       )
		   )
		 ORDER BY v.rating DESC NULLS LAST, v.priority ASC`,
		[activeOnly, provider, tier, projectId],
	);
	return rows;
}

function getCachedModelRows(key: string): ModelRouteRow[] | null {
	const entry = modelListCache.get(key);
	if (!entry) return null;
	const age = Date.now() - entry.fetchedAt;
	if (age > MODEL_LIST_CACHE_TTL_MS && !entry.revalidating) {
		// Stale — kick off background revalidation
		entry.revalidating = true;
	}
	// Return stale data immediately while revalidation is in flight
	return entry.rows;
}

async function getModelRouteRows(args: {
	provider?: string;
	tier?: string;
	project_id?: number;
	active_only?: boolean;
	_queryFn?: ModelQueryFn;
}): Promise<ModelRouteRow[]> {
	const key = modelListCacheKey(args);
	const cached = getCachedModelRows(key);

	if (cached) {
		_cacheHitTotal++;
		const entry = modelListCache.get(key)!;
		if (entry.revalidating) {
			// Background revalidate without awaiting
			fetchModelRouteRows(args)
				.then((fresh) => {
					modelListCache.set(key, { rows: fresh, fetchedAt: Date.now(), revalidating: false });
				})
				.catch(() => {
					entry.revalidating = false;
				});
		}
		return cached;
	}

	// Cold miss — fetch synchronously
	const rows = await fetchModelRouteRows(args);
	modelListCache.set(key, { rows, fetchedAt: Date.now(), revalidating: false });
	return rows;
}

/**
 * P797: Validate that a model has at least one enabled route in roadmap.model_routes.
 * Returns structured error payload if no route is found.
 */
export async function validateModelForDispatch(
	modelName: string,
	projectId?: number,
	queryFnOverride?: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>,
): Promise<{ valid: boolean; reason?: string; error?: string; provider?: string; model?: string }> {
	void projectId;
	const queryFn = queryFnOverride ?? query;
	const { rows } = await queryFn<{ route_provider: string }>(
		`SELECT route_provider
		 FROM   roadmap.model_routes
		 WHERE  model_name = $1 AND is_enabled = true
		 LIMIT  1`,
		[modelName],
	);
	if (rows.length === 0) {
		return {
			valid: false,
			reason: "No enabled route found for model",
			error: "NO_ENABLED_ROUTE",
			model: modelName,
		};
	}
	return { valid: true };
}

export class PgSpendingHandlers {
	constructor(
		readonly _core: McpServer,
		readonly _projectRoot: string,
	) {}

	async setSpendingCap(args: {
		agent_identity: string;
		daily_limit_usd: string;
		monthly_limit_usd?: string;
		is_frozen?: boolean;
		frozen_reason?: string;
	}): Promise<CallToolResult> {
		try {
			const { rows } = await query(
				`INSERT INTO spending_caps (agent_identity, daily_limit_usd, monthly_limit_usd, is_frozen, frozen_reason)
         VALUES ($1, $2, $3, COALESCE($4, false), $5)
         ON CONFLICT ON CONSTRAINT spending_caps_pkey
         DO UPDATE SET
           daily_limit_usd = EXCLUDED.daily_limit_usd,
           monthly_limit_usd = COALESCE(EXCLUDED.monthly_limit_usd, spending_caps.monthly_limit_usd),
           is_frozen = COALESCE($4, spending_caps.is_frozen),
           frozen_reason = CASE
             WHEN $4 = false THEN NULL
             ELSE COALESCE($5, spending_caps.frozen_reason)
           END,
           updated_at = NOW()
         RETURNING *`,
				[
					args.agent_identity,
					parseFloat(args.daily_limit_usd),
					args.monthly_limit_usd ? parseFloat(args.monthly_limit_usd) : null,
					args.is_frozen ?? null,
					args.frozen_reason ?? null,
				],
			);
			return {
				content: [
					{
						type: "text",
						text: `Cap set for ${rows[0].agent_identity}: $${rows[0].daily_limit_usd ?? "∞"}/day, $${rows[0].monthly_limit_usd ?? "∞"}/month${rows[0].is_frozen ? " (frozen)" : ""}`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to set spending cap", err);
		}
	}

	async logSpending(args: {
		agent_identity: string;
		proposal_id?: string;
		cost_usd: string;
		model_name?: string;
		token_count?: string;
		run_id?: string;
		budget_id?: string;
		session_id?: string;
		agent_role?: string;
		task_type?: string;
		input_tokens?: string;
		output_tokens?: string;
		cache_write_tokens?: string;
		cache_read_tokens?: string;
	}): Promise<CallToolResult> {
		try {
			const { rows: capRows } = await query<{
				is_frozen: boolean;
				frozen_reason: string | null;
			}>(
				`SELECT is_frozen, frozen_reason
         FROM spending_caps
         WHERE agent_identity = $1`,
				[args.agent_identity],
			);

			if (capRows[0]?.is_frozen) {
				return {
					content: [
						{
							type: "text",
							text: `⚠️ ${args.agent_identity} is frozen${capRows[0].frozen_reason ? `: ${capRows[0].frozen_reason}` : ""}`,
						},
					],
				};
			}

			const proposalId = args.proposal_id
				? await resolveProposalId(args.proposal_id)
				: null;
			if (args.proposal_id && proposalId === null) {
				return {
					content: [
						{ type: "text", text: `Proposal ${args.proposal_id} not found.` },
					],
				};
			}

			if (args.run_id) {
				const { rows: runRows } = await query<{ run_id: string }>(
					`SELECT run_id
           FROM run_log
           WHERE run_id = $1
           LIMIT 1`,
					[args.run_id],
				);
				if (!runRows[0]) {
					return {
						content: [
							{
								type: "text",
								text: `Run ${args.run_id} not found. Insert into run_log before recording spend.`,
							},
						],
					};
				}
			}

			await query(
				`INSERT INTO spending_log (agent_identity, proposal_id, model_name, cost_usd, token_count, run_id, budget_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
				[
					args.agent_identity,
					proposalId,
					args.model_name ?? null,
					parseFloat(args.cost_usd),
					args.token_count ? parseInt(args.token_count, 10) : null,
					args.run_id ?? null,
					args.budget_id ? parseInt(args.budget_id, 10) : null,
				],
			);

			let efficiencyNote = "";
			if (this.hasTokenEfficiencyPayload(args)) {
				try {
					await this.recordTokenEfficiency(args);
					efficiencyNote = " Token efficiency metrics recorded.";
				} catch (err) {
					if (isTokenEfficiencyUnavailable(err)) {
						efficiencyNote =
							" Token efficiency metrics skipped; apply migration 014 first.";
					} else {
						throw err;
					}
				}
			}

			const snapshot = await this.getSpendingSnapshot(args.agent_identity);
			if (!snapshot) {
				return {
					content: [
						{
							type: "text",
							text: `Logged $${args.cost_usd} for ${args.agent_identity}.${efficiencyNote}`,
						},
					],
				};
			}

			const dailySpent = Number(snapshot.total_spent_today_usd);
			const dailyLimit =
				snapshot.daily_limit_usd !== null
					? Number(snapshot.daily_limit_usd)
					: null;

			// AC#6: auto-freeze when daily budget is exhausted
			if (dailyLimit !== null && dailySpent >= dailyLimit) {
				await query(
					`UPDATE spending_caps
					 SET is_frozen = true, frozen_reason = 'Daily budget exhausted', updated_at = NOW()
					 WHERE agent_identity = $1 AND NOT COALESCE(is_frozen, false)`,
					[args.agent_identity],
				);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: "budget_exhausted",
								agent: args.agent_identity,
								daily_spent_usd: dailySpent,
								daily_limit_usd: dailyLimit,
								message: `Daily budget of $${dailyLimit} exhausted. Agent ${args.agent_identity} frozen.`,
							}),
						},
					],
				};
			}

			// AC#5: warn when 80% of daily budget consumed
			if (dailyLimit !== null && dailySpent >= 0.8 * dailyLimit) {
				const pct = Math.round((dailySpent / dailyLimit) * 100);
				const remainingUsd = (dailyLimit - dailySpent).toFixed(6);
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								warning: "budget_warning_80pct",
								agent: args.agent_identity,
								daily_spent_usd: dailySpent,
								daily_limit_usd: dailyLimit,
								remaining_usd: Number(remainingUsd),
								pct_used: pct,
								message: `Warning: ${args.agent_identity} has used ${pct}% of daily budget ($${remainingUsd} remaining).${efficiencyNote}`,
							}),
						},
					],
				};
			}

			if (snapshot.is_frozen) {
				return {
					content: [
						{
							type: "text",
							text: `⚠️ Spending cap exceeded! ${args.agent_identity} frozen at $${snapshot.total_spent_today_usd}/$${snapshot.daily_limit_usd ?? "∞"} today.${efficiencyNote}`,
						},
					],
				};
			}
			return {
				content: [
					{
						type: "text",
						text: `Logged $${args.cost_usd} for ${args.agent_identity} ($${snapshot.total_spent_today_usd}/$${snapshot.daily_limit_usd ?? "∞"} today, $${snapshot.total_spent_month_usd}/$${snapshot.monthly_limit_usd ?? "∞"} month).${efficiencyNote}`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to log spending", err);
		}
	}

	async getSpendingReport(args: {
		agent_identity?: string;
	}): Promise<CallToolResult> {
		try {
			const rows = await this.getSpendingSnapshots(args.agent_identity);
			if (!rows.length) {
				return { content: [{ type: "text", text: "No spending data found." }] };
			}
			const lines = rows.map(
				(r) =>
					`${r.agent_identity}: today $${r.total_spent_today_usd}/$${r.daily_limit_usd ?? "∞"}, month $${r.total_spent_month_usd}/$${r.monthly_limit_usd ?? "∞"}${r.is_frozen ? ` 🔒 FROZEN${r.frozen_reason ? ` (${r.frozen_reason})` : ""}` : " ✅ OK"}`,
			);
			return { content: [{ type: "text", text: lines.join("\n") }] };
		} catch (err) {
			return errorResult("Failed to get spending report", err);
		}
	}

	async getTokenEfficiencyReport(args: {
		agent_role?: string;
		agent_identity?: string;
		model?: string;
		model_name?: string;
		granularity?: "daily" | "weekly";
	}): Promise<CallToolResult> {
		try {
			// AC-7: support daily granularity; default weekly for backward compat
			const granularity = args.granularity ?? "weekly";
			const agentFilter = args.agent_identity ?? args.agent_role ?? null;
			const modelFilter = args.model_name ?? args.model ?? null;

			if (granularity === "daily") {
				const { rows } = await query<{
					day: string;
					agent_identity: string | null;
					model_name: string;
					invocations: number;
					total_input_tokens: string;
					total_output_tokens: string;
					total_cache_read_tokens: string;
					cache_hit_rate_pct: string;
					total_cost_usd: string;
					cost_per_1k_tokens: string;
				}>(
					`SELECT
             day::text,
             agent_identity,
             model_name,
             invocations,
             total_input_tokens::text,
             total_output_tokens::text,
             total_cache_read_tokens::text,
             cache_hit_rate_pct::text,
             total_cost_usd::text,
             cost_per_1k_tokens::text
           FROM metrics.v_daily_efficiency
           WHERE ($1::text IS NULL OR agent_identity = $1)
             AND ($2::text IS NULL OR model_name = $2)
           ORDER BY day DESC, invocations DESC
           LIMIT 30`,
					[agentFilter, modelFilter],
				);
				if (!rows.length) {
					return {
						content: [
							{ type: "text", text: "No daily token efficiency data found." },
						],
					};
				}
				const lines = rows.map(
					(row) =>
						`${row.day} | ${row.agent_identity ?? "unknown"} | ${row.model_name} | invocations=${row.invocations} | in=${row.total_input_tokens} | out=${row.total_output_tokens} | cache_read=${row.total_cache_read_tokens} | cache_hit_pct=${row.cache_hit_rate_pct}% | cost_usd=${row.total_cost_usd} | cost_per_1k=${row.cost_per_1k_tokens}`,
				);
				return { content: [{ type: "text", text: lines.join("\n") }] };
			}

			// weekly (default)
			const { rows } = await query<{
				week_start: string;
				agent_identity: string | null;
				model_name: string;
				invocations: number;
				total_input_tokens: string;
				total_output_tokens: string;
				total_cache_read_tokens: string;
				cache_hit_rate_pct: string;
				total_cost_usd: string;
				cost_per_1k_tokens: string;
			}>(
				`SELECT
           week_start::text,
           agent_identity,
           model_name,
           invocations,
           total_input_tokens::text,
           total_output_tokens::text,
           total_cache_read_tokens::text,
           cache_hit_rate_pct::text,
           total_cost_usd::text,
           cost_per_1k_tokens::text
         FROM metrics.v_weekly_efficiency
         WHERE ($1::text IS NULL OR agent_identity = $1)
           AND ($2::text IS NULL OR model_name = $2)
         ORDER BY week_start DESC, invocations DESC
         LIMIT 20`,
				[agentFilter, modelFilter],
			);
			if (!rows.length) {
				return {
					content: [{ type: "text", text: "No token efficiency data found." }],
				};
			}
			const lines = rows.map(
				(row) =>
					`${row.week_start} | ${row.agent_identity ?? "unknown"} | ${row.model_name} | invocations=${row.invocations} | in=${row.total_input_tokens} | out=${row.total_output_tokens} | cache_read=${row.total_cache_read_tokens} | cache_hit_pct=${row.cache_hit_rate_pct}% | cost_usd=${row.total_cost_usd} | cost_per_1k=${row.cost_per_1k_tokens}`,
			);
			return { content: [{ type: "text", text: lines.join("\n") }] };
		} catch (err) {
			if (isTokenEfficiencyUnavailable(err)) {
				return {
					content: [
						{
							type: "text",
							text: "Token efficiency metrics are unavailable. Apply migration 014 first.",
						},
					],
				};
			}
			return errorResult("Failed to get token efficiency report", err);
		}
	}

	private async getSpendingSnapshot(agentIdentity: string) {
		const rows = await this.getSpendingSnapshots(agentIdentity);
		return rows[0] ?? null;
	}

	private async getSpendingSnapshots(agentIdentity?: string) {
		const { rows } = await query<{
			agent_identity: string;
			daily_limit_usd: string | null;
			monthly_limit_usd: string | null;
			is_frozen: boolean | null;
			frozen_reason: string | null;
			total_spent_today_usd: string;
			event_count_today: number;
			total_spent_month_usd: string;
		}>(
			`WITH agents AS (
         SELECT agent_identity FROM spending_caps
         UNION
         SELECT agent_identity FROM spending_log
       ),
       daily AS (
         SELECT agent_identity, total_usd, event_count
         FROM v_daily_spend
         WHERE spend_date = CURRENT_DATE
       ),
       monthly AS (
         SELECT agent_identity, SUM(cost_usd)::numeric(14,6) AS total_usd
         FROM spending_log
         WHERE created_at >= date_trunc('month', now())
         GROUP BY agent_identity
       )
       SELECT
         a.agent_identity,
         sc.daily_limit_usd::text AS daily_limit_usd,
         sc.monthly_limit_usd::text AS monthly_limit_usd,
         sc.is_frozen,
         sc.frozen_reason,
         COALESCE(d.total_usd, 0)::text AS total_spent_today_usd,
         COALESCE(d.event_count, 0)::int AS event_count_today,
         COALESCE(m.total_usd, 0)::text AS total_spent_month_usd
       FROM agents a
       LEFT JOIN spending_caps sc ON sc.agent_identity = a.agent_identity
       LEFT JOIN daily d ON d.agent_identity = a.agent_identity
       LEFT JOIN monthly m ON m.agent_identity = a.agent_identity
       WHERE $1::text IS NULL OR a.agent_identity = $1
       ORDER BY a.agent_identity`,
			[agentIdentity ?? null],
		);
		return rows;
	}

	private hasTokenEfficiencyPayload(args: {
		session_id?: string;
		agent_role?: string;
		task_type?: string;
		input_tokens?: string;
		output_tokens?: string;
		cache_write_tokens?: string;
		cache_read_tokens?: string;
		model_name?: string;
	}): boolean {
		return [
			args.session_id,
			args.agent_role,
			args.task_type,
			args.input_tokens,
			args.output_tokens,
			args.cache_write_tokens,
			args.cache_read_tokens,
			args.model_name,
		].some((value) => typeof value === "string" && value.length > 0);
	}

	private async recordTokenEfficiency(args: {
		agent_identity: string;
		proposal_id?: string;
		cost_usd: string;
		model_name?: string;
		session_id?: string;
		agent_role?: string;
		task_type?: string;
		input_tokens?: string;
		output_tokens?: string;
		cache_write_tokens?: string;
		cache_read_tokens?: string;
	}): Promise<void> {
		const costMicrodollars = Math.round(parseFloat(args.cost_usd) * 1_000_000);
		await query(
			`INSERT INTO metrics.token_efficiency (
         session_id,
         agent_role,
         model,
         task_type,
         proposal_id,
         input_tokens,
         output_tokens,
         cache_write_tokens,
         cache_read_tokens,
         cost_microdollars
       ) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
			[
				args.session_id ?? null,
				args.agent_role ?? args.agent_identity,
				args.model_name ?? "unknown",
				args.task_type ?? null,
				args.proposal_id ?? null,
				args.input_tokens ? parseInt(args.input_tokens, 10) : 0,
				args.output_tokens ? parseInt(args.output_tokens, 10) : 0,
				args.cache_write_tokens ? parseInt(args.cache_write_tokens, 10) : 0,
				args.cache_read_tokens ? parseInt(args.cache_read_tokens, 10) : 0,
				costMicrodollars,
			],
		);
	}
}

export class PgModelHandlers {
	constructor(
		readonly _core: McpServer,
		readonly _projectRoot: string,
		readonly _queryFn?: ModelQueryFn,
	) {}

	// P797: Rewritten with model_routes JOIN, provider/tier/project_id filtering, and SWR cache
	async listModels(args: {
		capability?: string;
		max_cost_per_million_input?: string;
		max_cost_per_1k_input?: string;
		active_only?: boolean;
		// P797: new filters
		provider?: string;
		tier?: string;
		project_id?: number;
	}): Promise<CallToolResult> {
		try {
			_listCallsTotal++;
			const maxCostPerMillion =
				parseOptionalNumber(args.max_cost_per_million_input) ??
				perMillionFromPer1k(args.max_cost_per_1k_input);

			// P797: Fetch rows via JOIN on model_routes with 2s stale-while-revalidate cache
			const rows = await getModelRouteRows({
				provider: args.provider,
				tier: args.tier,
				project_id: args.project_id,
				active_only: args.active_only,
				_queryFn: this._queryFn,
			});

			if (rows.length === 0) {
				// P797: Return structured error when no enabled routes exist
				_noRouteErrorsTotal++;
				const filterDesc = [
					args.provider ? `provider=${args.provider}` : null,
					args.tier ? `tier=${args.tier}` : null,
				].filter(Boolean).join(", ");
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({
								error: "NO_ENABLED_ROUTE",
								provider: args.provider ?? null,
								tier: args.tier ?? null,
								message: filterDesc
									? `No models with enabled routes found for: ${filterDesc}`
									: "No models with enabled routes found.",
							}),
						},
					],
				};
			}

			const filteredRows = rows.filter((row) => {
				if (args.capability) {
					const [key, value] = args.capability.split("=");
					if (key) {
						const expected = value?.trim() ?? "true";
						if (row.capabilities?.[key.trim()] !== (expected === "true")) {
							return false;
						}
					}
				}
				if (maxCostPerMillion === null) {
					return true;
				}
				const costPerMillion = parseOptionalNumber(row.cost_per_million_input ?? undefined);
				return costPerMillion !== null && costPerMillion <= maxCostPerMillion;
			});

			if (!filteredRows.length) {
				return {
					content: [
						{ type: "text", text: "No models found matching criteria." },
					],
				};
			}

				const lines = filteredRows.map((r) => {
				const caps = r.capabilities
					? Object.keys(r.capabilities)
							.filter((k: string) => (r.capabilities as Record<string, boolean>)[k])
							.join(", ")
					: "none";
				const inputCost = parseOptionalNumber(r.cost_per_million_input ?? undefined);
				return [
					`${r.model_name} (${r.provider})`,
					`route: ${r.route_provider}`,
					r.tier ? `tier: ${r.tier}` : null,
					`priority: ${r.priority}`,
					`rating: ${r.rating ?? "?"}/5`,
					`input: ${formatMillionCost(inputCost)}`,
					`ctx: ${r.context_window || "?"}`,
					`caps: [${caps}]`,
					r.is_active === false ? "[INACTIVE]" : null,
				].filter(Boolean).join(", ");
			});
			return { content: [{ type: "text", text: lines.join("\n") }] };
		} catch (err) {
			return errorResult("Failed to list models", err);
		}
	}

	// P059/P798: Enhanced addModel with is_active, context_window, and tier support
	async addModel(args: {
		model_name: string;
		provider?: string;
		tier?: string;
		cost_per_million_input?: string;
		cost_per_million_output?: string;
		cost_per_million_cache_write?: string;
		cost_per_million_cache_hit?: string;
		cost_per_1k_input?: string;
		cost_per_1k_output?: string;
		max_tokens?: string;
		context_window?: string;
		capabilities?: string;
		rating?: string;
		is_active?: string;
	}): Promise<CallToolResult> {
		try {
			const [perMillionPricing, tierSupported] = await Promise.all([
				supportsPerMillionModelPricing(),
				supportsModelTier(),
			]);
			const inputPerMillion =
				parseOptionalNumber(args.cost_per_million_input) ??
				perMillionFromPer1k(args.cost_per_1k_input);
			const outputPerMillion =
				parseOptionalNumber(args.cost_per_million_output) ??
				perMillionFromPer1k(args.cost_per_1k_output);
			const cacheWritePerMillion = parseOptionalNumber(
				args.cost_per_million_cache_write,
			);
			const cacheHitPerMillion = parseOptionalNumber(
				args.cost_per_million_cache_hit,
			);
			const inputPer1k = per1kFromPerMillion(inputPerMillion);
			const outputPer1k = per1kFromPerMillion(outputPerMillion);
			const tier = args.tier ?? null;

			const { rows } = perMillionPricing
				? tierSupported
					? await query(
							`INSERT INTO model_metadata (
								model_name, provider, tier,
								cost_per_1k_input, cost_per_1k_output,
								cost_per_million_input, cost_per_million_output,
								cost_per_million_cache_write, cost_per_million_cache_hit,
								max_tokens, context_window, capabilities, rating, is_active
							)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)
          ON CONFLICT ON CONSTRAINT model_metadata_model_name_key
          DO UPDATE SET
            provider = EXCLUDED.provider,
            tier = COALESCE(EXCLUDED.tier, model_metadata.tier),
            cost_per_1k_input = COALESCE(EXCLUDED.cost_per_1k_input, model_metadata.cost_per_1k_input),
            cost_per_1k_output = COALESCE(EXCLUDED.cost_per_1k_output, model_metadata.cost_per_1k_output),
            cost_per_million_input = COALESCE(EXCLUDED.cost_per_million_input, model_metadata.cost_per_million_input),
            cost_per_million_output = COALESCE(EXCLUDED.cost_per_million_output, model_metadata.cost_per_million_output),
            cost_per_million_cache_write = COALESCE(EXCLUDED.cost_per_million_cache_write, model_metadata.cost_per_million_cache_write),
            cost_per_million_cache_hit = COALESCE(EXCLUDED.cost_per_million_cache_hit, model_metadata.cost_per_million_cache_hit),
            max_tokens = COALESCE(EXCLUDED.max_tokens, model_metadata.max_tokens),
            context_window = COALESCE(EXCLUDED.context_window, model_metadata.context_window),
            capabilities = COALESCE(EXCLUDED.capabilities, model_metadata.capabilities),
            rating = COALESCE(EXCLUDED.rating, model_metadata.rating),
            is_active = COALESCE(EXCLUDED.is_active, model_metadata.is_active)
          RETURNING model_name, tier, rating, COALESCE(is_active, true) AS is_active`,
							[
								args.model_name,
								args.provider || null,
								tier,
								inputPer1k,
								outputPer1k,
								inputPerMillion,
								outputPerMillion,
								cacheWritePerMillion,
								cacheHitPerMillion,
								args.max_tokens ? parseInt(args.max_tokens, 10) : null,
								args.context_window ? parseInt(args.context_window, 10) : null,
								args.capabilities ? JSON.parse(args.capabilities) : null,
								args.rating ? parseInt(args.rating, 10) : null,
								args.is_active !== undefined ? args.is_active === "true" : null,
							],
						)
					: await query(
							`INSERT INTO model_metadata (
								model_name, provider,
								cost_per_1k_input, cost_per_1k_output,
								cost_per_million_input, cost_per_million_output,
								cost_per_million_cache_write, cost_per_million_cache_hit,
								max_tokens, context_window, capabilities, rating, is_active
							)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
          ON CONFLICT ON CONSTRAINT model_metadata_model_name_key
          DO UPDATE SET
            provider = EXCLUDED.provider,
            cost_per_1k_input = COALESCE(EXCLUDED.cost_per_1k_input, model_metadata.cost_per_1k_input),
            cost_per_1k_output = COALESCE(EXCLUDED.cost_per_1k_output, model_metadata.cost_per_1k_output),
            cost_per_million_input = COALESCE(EXCLUDED.cost_per_million_input, model_metadata.cost_per_million_input),
            cost_per_million_output = COALESCE(EXCLUDED.cost_per_million_output, model_metadata.cost_per_million_output),
            cost_per_million_cache_write = COALESCE(EXCLUDED.cost_per_million_cache_write, model_metadata.cost_per_million_cache_write),
            cost_per_million_cache_hit = COALESCE(EXCLUDED.cost_per_million_cache_hit, model_metadata.cost_per_million_cache_hit),
            max_tokens = COALESCE(EXCLUDED.max_tokens, model_metadata.max_tokens),
            context_window = COALESCE(EXCLUDED.context_window, model_metadata.context_window),
            capabilities = COALESCE(EXCLUDED.capabilities, model_metadata.capabilities),
            rating = COALESCE(EXCLUDED.rating, model_metadata.rating),
            is_active = COALESCE(EXCLUDED.is_active, model_metadata.is_active)
          RETURNING model_name, rating, COALESCE(is_active, true) AS is_active`,
							[
								args.model_name,
								args.provider || null,
								inputPer1k,
								outputPer1k,
								inputPerMillion,
								outputPerMillion,
								cacheWritePerMillion,
								cacheHitPerMillion,
								args.max_tokens ? parseInt(args.max_tokens, 10) : null,
								args.context_window ? parseInt(args.context_window, 10) : null,
								args.capabilities ? JSON.parse(args.capabilities) : null,
								args.rating ? parseInt(args.rating, 10) : null,
								args.is_active !== undefined ? args.is_active === "true" : null,
							],
						)
				: await query(
						`INSERT INTO model_metadata (model_name, provider, cost_per_1k_input, cost_per_1k_output,
						                              max_tokens, context_window, capabilities, rating, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
         ON CONFLICT ON CONSTRAINT model_metadata_model_name_key
         DO UPDATE SET
           provider = EXCLUDED.provider,
           cost_per_1k_input = COALESCE(EXCLUDED.cost_per_1k_input, model_metadata.cost_per_1k_input),
           cost_per_1k_output = COALESCE(EXCLUDED.cost_per_1k_output, model_metadata.cost_per_1k_output),
           max_tokens = COALESCE(EXCLUDED.max_tokens, model_metadata.max_tokens),
           context_window = COALESCE(EXCLUDED.context_window, model_metadata.context_window),
           capabilities = COALESCE(EXCLUDED.capabilities, model_metadata.capabilities),
           rating = COALESCE(EXCLUDED.rating, model_metadata.rating),
           is_active = COALESCE(EXCLUDED.is_active, model_metadata.is_active)
         RETURNING model_name, rating, COALESCE(is_active, true) AS is_active`,
						[
							args.model_name,
							args.provider || null,
							inputPer1k,
							outputPer1k,
							args.max_tokens ? parseInt(args.max_tokens, 10) : null,
							args.context_window ? parseInt(args.context_window, 10) : null,
							args.capabilities ? JSON.parse(args.capabilities) : null,
							args.rating ? parseInt(args.rating, 10) : null,
							args.is_active !== undefined ? args.is_active === "true" : null,
						],
					);
			const r = rows[0] as { model_name: string; tier?: string | null; rating: number | null; is_active: boolean };
			return {
				content: [
					{
						type: "text",
						text: `Model ${r.is_active ? "added" : "deactivated"}: ${r.model_name}${r.tier ? ` (tier: ${r.tier})` : ""} (rating: ${r.rating}, active: ${r.is_active})`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to add model", err);
		}
	}
}

export function getModelListMetrics(): { cache_hit_total: number; list_calls_total: number; no_route_errors_total: number } {
	return { cache_hit_total: _cacheHitTotal, list_calls_total: _listCallsTotal, no_route_errors_total: _noRouteErrorsTotal };
}

export function resetModelListCacheForTest(): void {
	modelListCache.clear();
	_cacheHitTotal = 0;
	_listCallsTotal = 0;
	_noRouteErrorsTotal = 0;
}

// ─── P1004: Agent usage snapshot ─────────────────────────────────────────────

export interface UsageSnapshot {
	provider: string;
	agent_identity: string;
	model_name?: string | null;
	session_id: string | null;
	tokens_in: number | null;
	tokens_out: number | null;
	cache_creation_tokens: number;
	cache_read_tokens: number;
	quota_remaining: number | null;
	quota_limit: number | null;
	quota_reset_at: Date | null;
	cost_usd_estimate: number | null;
	raw_headers: Record<string, unknown> | null;
}

/**
 * P1004 AC3: Returns the latest quota snapshot for the given provider,
 * or null if no snapshot exists. Used by agent-spawner pre-spawn check.
 */
export async function getLatestQuotaSnapshot(
	provider: string,
): Promise<Pick<UsageSnapshot, "provider" | "quota_remaining" | "quota_limit" | "quota_reset_at"> | null> {
	const { rows } = await query<{
		provider: string;
		quota_remaining: number | null;
		quota_limit: number | null;
		quota_reset_at: Date | null;
	}>(
		`SELECT provider, quota_remaining, quota_limit, quota_reset_at
		 FROM   roadmap_workforce.agent_usage_snapshot
		 WHERE  provider = $1
		   AND  quota_remaining IS NOT NULL
		 ORDER  BY recorded_at DESC
		 LIMIT  1`,
		[provider],
	);
	return rows[0] ?? null;
}

/**
 * P1004: Report a usage snapshot from an agent subprocess.
 * Inserts into agent_usage_snapshot; the AFTER INSERT trigger handles pg_notify.
 */
export async function reportAgentUsage(args: {
	provider: string;
	agent_identity: string;
	model_name?: string;
	session_id?: string;
	tokens_in?: number;
	tokens_out?: number;
	cache_creation_tokens?: number;
	cache_read_tokens?: number;
	quota_remaining?: number;
	quota_limit?: number;
	quota_reset_at?: string;
	cost_usd_estimate?: number;
	raw_headers?: Record<string, unknown>;
}): Promise<CallToolResult> {
	try {
		// If the agent did not supply a cost estimate but provided token counts
		// and a model_name, attempt to compute a best-effort estimate from
		// model_metadata.cost_per_million_* pricing. This helps CLIs like
		// 'gh copilot' which do not return billing headers.
		let computedCost: number | null = args.cost_usd_estimate ?? null;
		try {
			if (
				computedCost === null &&
				(args.tokens_in || args.tokens_out || args.cache_creation_tokens || args.cache_read_tokens) &&
				args.model_name
			) {
				const { rows: metaRows } = await query<{
					cost_per_million_input: string | null;
					cost_per_million_output: string | null;
					cost_per_million_cache_write: string | null;
					cost_per_million_cache_hit: string | null;
				}>(
					`SELECT cost_per_million_input, cost_per_million_output,
					        cost_per_million_cache_write, cost_per_million_cache_hit
					 FROM   model_metadata
					 WHERE  model_name = $1
					 LIMIT  1`,
					[args.model_name],
				);
				const meta = metaRows[0];
				if (meta) {
					const inPrice = meta.cost_per_million_input ? Number(meta.cost_per_million_input) : 0;
					const outPrice = meta.cost_per_million_output ? Number(meta.cost_per_million_output) : 0;
					const cacheWrite = meta.cost_per_million_cache_write ? Number(meta.cost_per_million_cache_write) : 0;
					const cacheHit = meta.cost_per_million_cache_hit ? Number(meta.cost_per_million_cache_hit) : 0;
					const tokensIn = args.tokens_in ?? 0;
					const tokensOut = args.tokens_out ?? 0;
					const cacheCreate = args.cache_creation_tokens ?? 0;
					const cacheRead = args.cache_read_tokens ?? 0;
					const cost = (tokensIn / 1_000_000) * inPrice
						+ (tokensOut / 1_000_000) * outPrice
						+ (cacheCreate / 1_000_000) * cacheWrite
						+ (cacheRead / 1_000_000) * cacheHit;
					computedCost = Number(cost.toFixed(6));
				}
			}
		} catch (err) {
			// Non-fatal: if metadata lookup fails, proceed without computed cost.
			computedCost = args.cost_usd_estimate ?? null;
		}

		const { rows } = await query<{ id: string; quota_remaining: number | null; quota_limit: number | null }>(
			`INSERT INTO roadmap_workforce.agent_usage_snapshot
			   (provider, agent_identity, session_id,
			    tokens_in, tokens_out,
			    cache_creation_tokens, cache_read_tokens,
			    quota_remaining, quota_limit, quota_reset_at,
			    cost_usd_estimate, raw_headers)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11,$12::jsonb)
			 RETURNING id::text, quota_remaining, quota_limit`,
			[
				args.provider,
				args.agent_identity,
				args.session_id ?? null,
				args.tokens_in ?? null,
				args.tokens_out ?? null,
				args.cache_creation_tokens ?? 0,
				args.cache_read_tokens ?? 0,
				args.quota_remaining ?? null,
				args.quota_limit ?? null,
				args.quota_reset_at ?? null,
				computedCost ?? null,
				args.raw_headers ? JSON.stringify(args.raw_headers) : null,
			],
		);

		const row = rows[0];
		const parts: string[] = [`Usage snapshot #${row.id} recorded (${args.provider})`];
		if (row.quota_remaining !== null && row.quota_limit !== null && row.quota_limit > 0) {
			const pct = Math.round((row.quota_remaining / row.quota_limit) * 100);
			parts.push(`quota: ${row.quota_remaining}/${row.quota_limit} (${pct}% remaining)`);
			if (pct < 20) parts.push("⚠️ budget_alert emitted");
		}
		if (args.cache_read_tokens) {
			const total = (args.tokens_in ?? 0) + (args.cache_creation_tokens ?? 0) + (args.cache_read_tokens ?? 0);
			const hitPct = total > 0 ? Math.round((args.cache_read_tokens / total) * 100) : 0;
			parts.push(`cache_hit_ratio: ${hitPct}%`);
		}
		if (computedCost !== null) {
			parts.push(`cost_usd_estimate: $${computedCost.toFixed(6)}${args.cost_usd_estimate == null ? ' (computed from model metadata)' : ''}`);
		}

		return { content: [{ type: "text", text: parts.join(" | ") }] };
	} catch (err) {
		return errorResult("Failed to record usage snapshot", err);
	}
}
