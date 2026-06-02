/**
 * P194: MemoryService — structured context for LLM cache optimization.
 *
 * Two memory planes:
 *   - project_memory  : shared, stable platform context (cacheable system-prompt prefix)
 *   - agent_memory    : per-agent episodic/semantic/working/procedural context with TTL
 *
 * project_memory lives in roadmap.project_memory.
 * agent_memory lives in roadmap_efficiency.agent_memory, exposed via roadmap.v_active_memory.
 */

import { query } from "../infra/postgres/pool.ts";

// ── Types ──────────────────────────────────────────────────────────────────────

export type MemoryLayer = "episodic" | "semantic" | "working" | "procedural";

export interface ProjectMemoryEntry {
  key: string;
  category: string;
  content: Record<string, unknown>;
  version: number;
  is_cached: boolean;
  updated_at: Date;
}

export interface AgentMemoryEntry {
  key: string;
  layer: MemoryLayer;
  value: unknown;
  expires_at: Date | null;
  updated_at: Date;
}

// ── MemoryService ──────────────────────────────────────────────────────────────

export class MemoryService {
  // ── Project Memory ───────────────────────────────────────────────────────────

  /** Return the parsed content for a project_memory key, or null if not found. */
  async getProjectMemory(key: string): Promise<Record<string, unknown> | null> {
    const { rows } = await query<{ content: Record<string, unknown> }>(
      `SELECT content FROM roadmap.project_memory WHERE key = $1`,
      [key],
    );
    return rows[0]?.content ?? null;
  }

  /** Return all project_memory entries for a category. */
  async getProjectMemoryByCategory(
    category: string,
  ): Promise<ProjectMemoryEntry[]> {
    const { rows } = await query<ProjectMemoryEntry>(
      `SELECT key, category, content, version, is_cached, updated_at
       FROM roadmap.project_memory
       WHERE category = $1
       ORDER BY key`,
      [category],
    );
    return rows;
  }

  /** Return all project_memory entries, keyed by their key field. */
  async getAllProjectMemory(): Promise<Record<string, Record<string, unknown>>> {
    const { rows } = await query<{ key: string; content: Record<string, unknown> }>(
      `SELECT key, content FROM roadmap.project_memory ORDER BY key`,
    );
    const result: Record<string, Record<string, unknown>> = {};
    for (const row of rows) {
      result[row.key] = row.content;
    }
    return result;
  }

  /** Upsert a project_memory entry. */
  async setProjectMemory(
    key: string,
    category: string,
    content: Record<string, unknown>,
    updatedBy?: string,
  ): Promise<void> {
    await query(
      `INSERT INTO roadmap.project_memory (key, category, content, updated_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET
         content    = EXCLUDED.content,
         category   = EXCLUDED.category,
         version    = roadmap.project_memory.version + 1,
         updated_at = now(),
         updated_by = EXCLUDED.updated_by`,
      [key, category, JSON.stringify(content), updatedBy ?? null],
    );
  }

  // ── Agent Memory ─────────────────────────────────────────────────────────────

  /**
   * Store a per-agent memory entry, optionally with a TTL.
   * Upserts on (agent_identity, key, layer).
   */
  async setAgentMemory(
    agentIdentity: string,
    layer: MemoryLayer,
    key: string,
    value: unknown,
    ttlSeconds?: number,
  ): Promise<void> {
    const serialized = JSON.stringify(value);
    const ttl = ttlSeconds ?? null;

    // Single UPSERT on the (agent_identity, key, layer) unique constraint.
    // INSERT path: trg_set_memory_expires handles expires_at from ttl_seconds+created_at.
    // UPDATE path: recompute expires_at explicitly since the INSERT trigger doesn't fire.
    await query(
      `INSERT INTO agent_memory (agent_identity, layer, key, value, ttl_seconds)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (agent_identity, key, layer) DO UPDATE SET
         value       = EXCLUDED.value,
         ttl_seconds = EXCLUDED.ttl_seconds,
         expires_at  = CASE
                         WHEN EXCLUDED.ttl_seconds IS NULL THEN NULL
                         ELSE NOW() + (EXCLUDED.ttl_seconds * INTERVAL '1 second')
                       END,
         updated_at  = NOW()`,
      [agentIdentity, layer, key, serialized, ttl],
    );
  }

  /**
   * Return all non-expired memory entries for an agent+layer, keyed by key.
   * Uses the v_active_memory view which filters expired rows.
   */
  async getAgentMemory(
    agentIdentity: string,
    layer: MemoryLayer,
  ): Promise<Record<string, unknown>> {
    const { rows } = await query<{ key: string; value: string }>(
      `SELECT key, value
       FROM v_active_memory
       WHERE agent_identity = $1 AND layer = $2
       ORDER BY updated_at DESC`,
      [agentIdentity, layer],
    );

    const result: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        result[row.key] = JSON.parse(row.value);
      } catch {
        result[row.key] = row.value;
      }
    }
    return result;
  }

  /**
   * Return all non-expired memory entries for an agent across all layers.
   * Grouped by layer name.
   */
  async getAllAgentMemory(
    agentIdentity: string,
  ): Promise<Record<MemoryLayer, Record<string, unknown>>> {
    const { rows } = await query<{ key: string; layer: string; value: string }>(
      `SELECT layer, key, value
       FROM v_active_memory
       WHERE agent_identity = $1
       ORDER BY layer, updated_at DESC`,
      [agentIdentity],
    );

    const result = {
      episodic: {} as Record<string, unknown>,
      semantic: {} as Record<string, unknown>,
      working: {} as Record<string, unknown>,
      procedural: {} as Record<string, unknown>,
    };

    for (const row of rows) {
      const layer = row.layer as MemoryLayer;
      if (layer in result) {
        try {
          result[layer][row.key] = JSON.parse(row.value);
        } catch {
          result[layer][row.key] = row.value;
        }
      }
    }
    return result;
  }

  /** Delete a specific memory entry (or all entries in a layer if key omitted). */
  async deleteAgentMemory(
    agentIdentity: string,
    layer: MemoryLayer,
    key?: string,
  ): Promise<number> {
    let sql = `DELETE FROM agent_memory WHERE agent_identity = $1 AND layer = $2`;
    const params: unknown[] = [agentIdentity, layer];
    if (key !== undefined) {
      sql += ` AND key = $3`;
      params.push(key);
    }
    const { rowCount } = await query(sql, params);
    return rowCount ?? 0;
  }

  // ── Dispatch Context Builder ─────────────────────────────────────────────────

  /**
   * Build the project-memory prefix for an agent system prompt.
   * Loads architecture, workflow_states, and conventions from project_memory.
   * Returns the serialized text block plus a cache_control hint.
   */
  async buildDispatchContext(agentIdentity: string): Promise<{
    projectContext: Record<string, Record<string, unknown>>;
    agentContext: { semantic: Record<string, unknown>; working: Record<string, unknown> };
    systemPromptPrefix: string;
    cacheControl: { type: "ephemeral" };
  }> {
    const [architecture, workflow, conventions, semantic, working] =
      await Promise.all([
        this.getProjectMemory("architecture"),
        this.getProjectMemory("workflow_states"),
        this.getProjectMemory("conventions"),
        this.getAgentMemory(agentIdentity, "semantic"),
        this.getAgentMemory(agentIdentity, "working"),
      ]);

    const projectContext: Record<string, Record<string, unknown>> = {};
    if (architecture) projectContext["architecture"] = architecture;
    if (workflow) projectContext["workflow_states"] = workflow;
    if (conventions) projectContext["conventions"] = conventions;

    const agentContext = { semantic, working };

    const parts: string[] = [
      "## Platform Context (cached)",
      `### Architecture\n${JSON.stringify(architecture ?? {}, null, 2)}`,
      `### Workflow States\n${JSON.stringify(workflow ?? {}, null, 2)}`,
      `### Conventions\n${JSON.stringify(conventions ?? {}, null, 2)}`,
    ];

    if (Object.keys(semantic).length > 0) {
      parts.push(`### Agent Semantic Memory\n${JSON.stringify(semantic, null, 2)}`);
    }

    return {
      projectContext,
      agentContext,
      systemPromptPrefix: parts.join("\n\n"),
      cacheControl: { type: "ephemeral" },
    };
  }
}
