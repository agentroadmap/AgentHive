/**
 * Postgres-backed Spending & Model MCP Tools for AgentHive.
 *
 * Handles budget guardrails and LLM model metadata.
 * All handler methods catch errors and return MCP text responses instead of throwing.
 */

import { query } from "../../../../postgres/pool.ts";
import { resolveProposalId } from "../../../../postgres/proposal-storage-v2.ts";
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

export class PgSpendingHandlers {
	constructor(
		private readonly core: McpServer,
		private readonly projectRoot: string,
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
			if (
				err instanceof Error &&
				err.message.includes('record "new" has no field "id"')
			) {
				return {
					content: [
						{
							type: "text",
							text: "⚠️ Failed to set spending cap: roadmap.audit trigger on spending_caps expects an id column, so cap rows cannot be written until the database trigger is fixed.",
						},
					],
				};
			}
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
					return { content: [{ type: "text", text: "No daily token efficiency data found." }] };
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
					content: [
						{ type: "text", text: "No token efficiency data found." },
					],
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
		private readonly core: McpServer,
		private readonly projectRoot: string,
	) {}

	// P059: Enhanced model listing with capability filtering and is_active support
	async listModels(args: {
		capability?: string;
		max_cost_per_1k_input?: string;
		active_only?: boolean;
	}): Promise<CallToolResult> {
		try {
			const conditions: string[] = [];
			const params: unknown[] = [];
			let paramIdx = 1;

			// Filter by active status (default: active only)
			if (args.active_only !== false) {
				conditions.push(`COALESCE(is_active, true) = true`);
			}

			// Filter by capability (e.g. "tool_use=true")
			if (args.capability) {
				const [key, value] = args.capability.split("=");
				if (key) {
					conditions.push(`capabilities->>$${paramIdx} = $${paramIdx + 1}`);
					params.push(key.trim(), value?.trim() ?? "true");
					paramIdx += 2;
				}
			}

			// Filter by max input cost
			if (args.max_cost_per_1k_input) {
				conditions.push(`cost_per_1k_input <= $${paramIdx}`);
				params.push(parseFloat(args.max_cost_per_1k_input));
				paramIdx += 1;
			}

			const whereClause =
				conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

			const { rows } = await query(
				`SELECT model_name, provider, cost_per_1k_input, cost_per_1k_output,
				        max_tokens, context_window, capabilities, rating, is_active
				 FROM model_metadata ${whereClause}
				 ORDER BY rating DESC, cost_per_1k_input ASC`,
				params,
			);
			if (!rows.length) {
				return { content: [{ type: "text", text: "No models found matching criteria." }] };
			}
			const lines = rows.map(
				(r: any) => {
					const caps = r.capabilities ? Object.keys(r.capabilities).filter((k: string) => r.capabilities[k]).join(", ") : "none";
					return `${r.model_name} (${r.provider}) — rating: ${r.rating}/5, input: $${r.cost_per_1k_input || "?"}/1k, output: $${r.cost_per_1k_output || "?"}/1k, ctx: ${r.context_window || "?"}, caps: [${caps}]${r.is_active === false ? " [INACTIVE]" : ""}`;
				},
			);
			return { content: [{ type: "text", text: lines.join("\n") }] };
		} catch (err) {
			return errorResult("Failed to list models", err);
		}
	}

	// P059: Enhanced addModel with is_active support and full upsert
	async addModel(args: {
		model_name: string;
		provider?: string;
		cost_per_1k_input?: string;
		cost_per_1k_output?: string;
		max_tokens?: string;
		context_window?: string;
		capabilities?: string;
		rating?: string;
		is_active?: string;
	}): Promise<CallToolResult> {
		try {
			const { rows } = await query(
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
					args.cost_per_1k_input ? parseFloat(args.cost_per_1k_input) : null,
					args.cost_per_1k_output ? parseFloat(args.cost_per_1k_output) : null,
					args.max_tokens ? parseInt(args.max_tokens, 10) : null,
					args.context_window ? parseInt(args.context_window, 10) : null,
					args.capabilities ? JSON.parse(args.capabilities) : null,
					args.rating ? parseInt(args.rating, 10) : null,
					args.is_active !== undefined ? args.is_active === "true" : null,
				],
			);
			const r = rows[0];
			return {
				content: [
					{
						type: "text",
						text: `Model ${r.is_active ? "added" : "deactivated"}: ${r.model_name} (rating: ${r.rating}, active: ${r.is_active})`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to add model", err);
		}
	}
}
