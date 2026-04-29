/**
 * Postgres Agent Memory & Memory MCP Tools for AgentHive.
 *
 * Agent memory operations via the `agent_memory` table.
 * Implements the active 4-layer memory model in the roadmap schema:
 *
 * - `episodic`    — event memories
 * - `semantic`    — facts and durable knowledge
 * - `working`     — current task context
 * - `procedural`  — reusable skills and instructions
 *
 * All handler methods catch errors and return MCP text responses
 * instead of throwing, preventing tool call crashes.
 */

import { query } from "../../../../postgres/pool.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";

const MEMORY_LAYERS = [
	"episodic",
	"semantic",
	"working",
	"procedural",
] as const;

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

export class PgMemoryHandlers {
	constructor(private readonly server: McpServer) {}

	async setMemory(args: {
		agent_identity: string;
		layer: string;
		key: string;
		value: string;
		metadata?: string;
		ttl_seconds?: number;
	}): Promise<CallToolResult> {
		try {
			if (
				!MEMORY_LAYERS.includes(args.layer as (typeof MEMORY_LAYERS)[number])
			) {
				return {
					content: [
						{
							type: "text",
							text: `Invalid memory layer "${args.layer}". Use ${MEMORY_LAYERS.join(", ")}.`,
						},
					],
				};
			}

			const metadata =
				args.metadata === undefined ? undefined : JSON.parse(args.metadata);
			const { rows: existing } = await query<{ id: number }>(
				`SELECT id
         FROM agent_memory
         WHERE agent_identity = $1 AND layer = $2 AND key = $3
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`,
				[args.agent_identity, args.layer, args.key],
			);

			if (existing[0]) {
				const setClauses = ["value = $2", "updated_at = NOW()"];
				const params: Array<string | number | null> = [
					existing[0].id,
					args.value,
				];
				let nextParam = 3;

				if (args.metadata !== undefined) {
					setClauses.push(`metadata = $${nextParam}::jsonb`);
					params.push(metadata === null ? null : JSON.stringify(metadata));
					nextParam += 1;
				}

				if (args.ttl_seconds !== undefined) {
					setClauses.push(`ttl_seconds = $${nextParam}`);
					setClauses.push(
						`expires_at = CASE WHEN $${nextParam} IS NULL THEN NULL ELSE NOW() + ($${nextParam} * INTERVAL '1 second') END`,
					);
					params.push(args.ttl_seconds);
					nextParam += 1;
				}

				await query(
					`UPDATE agent_memory
           SET ${setClauses.join(", ")}
           WHERE id = $1`,
					params,
				);
			} else {
				await query(
					`INSERT INTO agent_memory (agent_identity, layer, key, value, metadata, ttl_seconds)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
					[
						args.agent_identity,
						args.layer,
						args.key,
						args.value,
						metadata === undefined ? null : JSON.stringify(metadata),
						args.ttl_seconds ?? null,
					],
				);
			}

			return {
				content: [
					{
						type: "text",
						text: `Memory set: ${args.agent_identity}/${args.layer}/${args.key}`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to set memory", err);
		}
	}

	async getMemory(args: {
		agent_identity: string;
		layer: string;
		key?: string;
	}): Promise<CallToolResult> {
		try {
			let sql = `SELECT key, value, metadata, expires_at, updated_at FROM v_active_memory
                  WHERE agent_identity = $1 AND layer = $2`;
			const params: any[] = [args.agent_identity, args.layer];

			if (args.key) {
				sql += ` AND key = $3`;
				params.push(args.key);
			}

			sql += ` ORDER BY updated_at DESC`;

			const { rows } = await query(sql, params);
			if (!rows.length) {
				return {
					content: [
						{
							type: "text",
							text: `No memory found for ${args.agent_identity}/${args.layer}${args.key ? `/${args.key}` : ""}`,
						},
					],
				};
			}

			const lines = rows.map(
				(r) =>
					`**${r.key}**: ${r.value}${r.expires_at ? ` _(expires: ${new Date(r.expires_at).toISOString()})_` : ""} _(updated: ${new Date(r.updated_at).toISOString()})_`,
			);
			return {
				content: [
					{ type: "text", text: `### ${args.layer}\n${lines.join("\n")}` },
				],
			};
		} catch (err) {
			return errorResult("Failed to get memory", err);
		}
	}

	async deleteMemory(args: {
		agent_identity: string;
		layer: string;
		key?: string;
	}): Promise<CallToolResult> {
		try {
			let sql = `DELETE FROM agent_memory WHERE agent_identity = $1 AND layer = $2`;
			const params: any[] = [args.agent_identity, args.layer];

			if (args.key) {
				sql += ` AND key = $3`;
				params.push(args.key);
			}

			const { rowCount } = await query(sql, params);
			return {
				content: [
					{
						type: "text",
						text: `✅ Deleted ${rowCount} memory entries from ${args.agent_identity}/${args.layer}${args.key ? `/${args.key}` : ""}`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to delete memory", err);
		}
	}

	/**
	 * Semantic search across agent memory using pgvector cosine similarity.
	 * Caller provides a 1536-dimension embedding vector for the query.
	 * Returns memories whose body_vector is most similar to the query.
	 */
	async searchMemory(args: {
		agent_identity?: string;
		layer?: string;
		embedding: number[]; // 1536-dim query embedding
		top_k?: number; // max results (default 10)
		threshold?: number; // min similarity score (default 0.5)
	}): Promise<CallToolResult> {
		try {
			const limit = Math.min(args.top_k ?? 10, 100);
			const threshold = args.threshold ?? 0.5;

			const clauses: string[] = ["body_vector IS NOT NULL"];
			const params: any[] = [];
			let idx = 1;

			if (args.agent_identity) {
				clauses.push(`agent_identity = $${idx++}`);
				params.push(args.agent_identity);
			}
			if (args.layer) {
				clauses.push(`layer = $${idx++}`);
				params.push(args.layer);
			}

			const vecIdx = idx;
			params.push(args.embedding);
			const simClause = `1 - (body_vector <=> $${idx}::vector(1536)) >= ${threshold}`;
			clauses.push(simClause);

			const where = clauses.join(" AND ");

			const { rows } = await query(
				`SELECT id, agent_identity, layer, key, value,
                1 - (body_vector <=> $${vecIdx}::vector(1536)) AS similarity
         FROM v_active_memory
         WHERE ${where}
         ORDER BY similarity DESC
         LIMIT ${limit}`,
				params,
			);

			if (!rows.length) {
				return {
					content: [
						{
							type: "text",
							text: `No matching memories found (threshold: ${threshold}, top: ${limit})`,
						},
					],
				};
			}

			const lines = rows.map(
				(r) =>
					`[${Number(r.similarity).toFixed(3)}] **${r.agent_identity}/${r.layer}/${r.key}**: ${r.value}`,
			);
			return {
				content: [
					{
						type: "text",
						text: `### Semantic Search Results\n${lines.join("\n")}`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to search memory", err);
		}
	}

	async memoryList(args: {
		agent_identity?: string;
		layer?: string;
		proposal_id?: number;
	}): Promise<CallToolResult> {
		try {
			let sql =
				"SELECT agent_identity, layer, key, value, created_at, expires_at FROM v_active_memory";
			const params: any[] = [];
			const conditions: string[] = [];
			let paramIdx = 1;
			if (args.agent_identity) {
				conditions.push(`agent_identity = $${paramIdx++}`);
				params.push(args.agent_identity);
			}
			if (args.layer) {
				conditions.push(`layer = $${paramIdx++}`);
				params.push(args.layer);
			}
			// AC#14: filter to agents currently working on a specific proposal
			if (args.proposal_id !== undefined) {
				conditions.push(
					`agent_identity IN (SELECT agent_identity FROM roadmap_workforce.agent_health WHERE current_proposal = $${paramIdx++})`,
				);
				params.push(args.proposal_id);
			}
			if (conditions.length) {
				sql += ` WHERE ${conditions.join(" AND ")}`;
			}
			sql += " ORDER BY agent_identity, layer, key LIMIT 50";
			const { rows } = await query(sql, params);
			if (!rows || rows.length === 0) {
				return {
					content: [{ type: "text", text: "No memory entries found." }],
				};
			}
			const lines = rows.map(
				(r: any) =>
					`[${r.agent_identity}|${r.layer}] ${r.key}: ${r.value}${r.expires_at ? ` (expires ${new Date(r.expires_at).toISOString()})` : ""}`,
			);
			return {
				content: [
					{
						type: "text",
						text: `${rows.length} entries:\n${lines.join("\n")}`,
					},
				],
			};
		} catch (err) {
			return errorResult("Failed to list memory", err);
		}
	}

	async memorySummary(args: {
		agent_identity?: string;
		layer?: string;
		token_budget?: number;
	}): Promise<CallToolResult> {
		try {
			const clauses: string[] = [];
			const params: any[] = [];
			let idx = 1;

			if (args.agent_identity) {
				clauses.push(`agent_identity = $${idx++}`);
				params.push(args.agent_identity);
			}
			if (args.layer) {
				clauses.push(`layer = $${idx++}`);
				params.push(args.layer);
			}

			const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

			if (args.token_budget !== undefined && args.token_budget > 0) {
				// AC#13: token-budget mode — fetch actual entries and compress to fit
				const { rows } = await query(
					`SELECT agent_identity, layer, key, value, updated_at
           FROM v_active_memory ${where}
           ORDER BY agent_identity, layer, updated_at DESC`,
					params,
				);

				if (!rows.length) {
					return { content: [{ type: "text", text: "No memory entries found." }] };
				}

				const budgetChars = args.token_budget * 4; // 1 token ≈ 4 chars
				const lines: string[] = [];
				let usedChars = 0;
				let truncated = false;

				for (const r of rows) {
					const line = `[${r.agent_identity}|${r.layer}] ${r.key}: ${r.value}`;
					if (usedChars + line.length > budgetChars) {
						truncated = true;
						const remaining = budgetChars - usedChars;
						if (remaining > 20) {
							lines.push(line.substring(0, remaining - 3) + "...");
						}
						break;
					}
					lines.push(line);
					usedChars += line.length + 1; // +1 for newline
				}

				const suffix = truncated ? `\n(truncated to fit ${args.token_budget}-token budget)` : "";
				return { content: [{ type: "text", text: lines.join("\n") + suffix }] };
			}

			// Default: count-only summary grouped by agent/layer
			const { rows } = await query(
				`SELECT agent_identity, layer, COUNT(*) as count, MAX(updated_at) as last_updated
         FROM v_active_memory ${where}
         GROUP BY agent_identity, layer
         ORDER BY agent_identity, layer`,
				params,
			);

			if (!rows.length) {
				return {
					content: [{ type: "text", text: "No memory entries found." }],
				};
			}

			const lines = rows.map(
				(r) =>
					`**${r.agent_identity}/${r.layer}**: ${r.count} entries (last: ${new Date(r.last_updated).toISOString()})`,
			);
			return { content: [{ type: "text", text: lines.join("\n") }] };
		} catch (err) {
			return errorResult("Failed to get memory summary", err);
		}
	}
}
