/**
 * P466: Spawn Briefing Service
 *
 * Provides briefing assembly and loading for warm-boot spawns:
 * - briefing_assemble(task_context): fetch memory, MCP quirks, fallback playbook, fill budget, record briefing
 * - briefing_load(briefing_id): retrieve full briefing for child boot check
 * - spawn_summary_emit(briefing_id, outcome, findings): child completion notification
 *
 * P194: Project memory is loaded during briefing assembly and stored in
 * project_context + cache_control columns so dispatchers can inject a
 * stable, cacheable system-prompt prefix before every API call.
 */

import { v4 as uuidv4 } from "uuid";
import { query } from "../postgres/pool.js";
import type { Pool } from "pg";
import { MemoryService } from "../../memory/memory_service.ts";
import { buildContextPackage } from "./context_builder.ts";

export interface TaskContext {
  task_id: string;
  mission: string;
  success_criteria: string[];
  done_signal?: "ac-pass" | "verdict" | "pr-merged" | "custom";

  allowed_tools?: string[];
  forbidden_tools?: string[];
  budget?: {
    max_tokens?: number | null;
    max_minutes?: number | null;
    max_tool_calls?: number | null;
  };
  stop_conditions?: string[];

  parent_agent?: string;
  liaison_agent?: string;
  rescue_team_channel?: string;
  request_assistance_threshold?: number;

  topic_keywords?: string[]; // for memory search
  proposal_id?: bigint; // P230: if set, inject cached context package into briefing
  team_name?: string;   // P230: optional squad name for team memory injection
}

export interface SpawnBriefing {
  briefing_id: string;

  // Mission
  task_id: string;
  mission: string;
  success_criteria: string[];
  done_signal: string;

  // Constraints
  allowed_tools: string[];
  forbidden_tools: string[];
  budget: {
    max_tokens: number | null;
    max_minutes: number | null;
    max_tool_calls: number | null;
  };
  stop_conditions: string[];

  // Context
  inherited_memory: Array<{ key: string; body: string }>;
  mcp_quirks: Array<{ tool: string; canonical_args: Record<string, any>; gotchas: string[] }>;
  fallback_playbook: Array<{ error_signature: string; try: string; rationale: string }>;
  recent_findings: Array<{ date: string; summary: string; proposal?: string }>;

  // Escalation
  parent_agent: string | null;
  liaison_agent: string | null;
  rescue_team_channel: string | null;
  request_assistance_threshold: number;

  // Provenance
  briefed_by: string;
  briefed_at: string;

  // P194: project memory context injected at dispatch time
  project_context?: Record<string, Record<string, unknown>>;
  cache_control?: { type: "ephemeral" };
}

export interface SpawnSummaryPayload {
  briefing_id: string;
  outcome: "success" | "partial" | "failure" | "timeout" | "escalated";
  summary?: string;

  new_findings: Array<{ date: string; summary: string; proposal?: string }>;
  updated_quirks: Array<{ tool: string; canonical_args: Record<string, any>; gotchas: string[] }>;

  tool_calls_made?: number;
  tokens_used?: number;
  duration_seconds?: number;

  error_log?: Record<string, any>;
  state_snapshot?: Record<string, any>;

  emitted_by: string;
}

/**
 * Assemble a warm-boot briefing before spawn.
 *
 * Steps:
 * 1. Load relevant memory entries by topic keywords (default fallback: generic agency patterns)
 * 2. Fetch current MCP quirks from roadmap.mcp_tool_schema
 * 3. Pull top-5 fallback playbook entries (not obsolete, highest confidence)
 * 4. Fill budget from agency capacity envelope (TODO: P464 agency table lookup)
 * 5. Record briefing in roadmap.spawn_briefing, return briefing_id
 */
export async function briefingAssemble(
  task: TaskContext,
  briefed_by: string
): Promise<SpawnBriefing> {
  const briefing_id = uuidv4();

  // Step 1: Fetch relevant memory entries by topic
  const inherited_memory = await fetchInheritedMemory(task.topic_keywords || []);

  // Step 2: Fetch MCP quirks (all non-obsolete, or constrain by allowed_tools)
  const mcp_quirks = await fetchMcpQuirks(task.allowed_tools);

  // Step 3: Fetch top-N fallback playbook entries
  const fallback_playbook = await fetchFallbackPlaybook(5);

  // Step 4: Fill budget (TODO: resolve from P464 agency capacity)
  const budget: SpawnBriefing["budget"] = {
    max_tokens: task.budget?.max_tokens ?? null,
    max_minutes: task.budget?.max_minutes ?? null,
    max_tool_calls: task.budget?.max_tool_calls ?? null,
  };

  // Step 5: P194 — Load project memory and agent semantic context before dispatch.
  // Injecting these into the briefing lets the dispatcher prepend a stable,
  // cacheable system-prompt prefix, reducing repeated token spend across the fleet.
  const memoryService = new MemoryService();
  let project_context: Record<string, Record<string, unknown>> | undefined;
  const cache_control: { type: "ephemeral" } = { type: "ephemeral" };

  try {
    const agentMemoryPromise = task.liaison_agent
      ? memoryService.getAgentMemory(task.liaison_agent, "semantic")
      : Promise.resolve({} as Record<string, unknown>);

    const [architecture, workflow, conventions, agentSemantic] = await Promise.all([
      memoryService.getProjectMemory("architecture"),
      memoryService.getProjectMemory("workflow_states"),
      memoryService.getProjectMemory("conventions"),
      agentMemoryPromise,
    ]);

    project_context = {};
    if (architecture) project_context["architecture"] = architecture;
    if (workflow) project_context["workflow_states"] = workflow;
    if (conventions) project_context["conventions"] = conventions;

    // Surface project memory entries into inherited_memory so the
    // briefing_load consumer can include them in the system-prompt prefix.
    for (const [pmKey, pmContent] of Object.entries(project_context)) {
      inherited_memory.push({
        key: `project_memory:${pmKey}`,
        body: JSON.stringify(pmContent),
      });
    }

    // Surface agent semantic memory entries (per-agent durable knowledge).
    for (const [smKey, smValue] of Object.entries(agentSemantic)) {
      inherited_memory.push({
        key: `agent_memory:semantic:${smKey}`,
        body: typeof smValue === "string" ? smValue : JSON.stringify(smValue),
      });
    }
  } catch {
    // Non-fatal: memory tables may not exist yet (pre-migration).
    // Proceed without injecting memory context.
  }

  // Step 5b: P230 — inject proposal context package when proposal_id is provided.
  // Saves ~500 tokens vs dumping full CLAUDE.md; cache is invalidated on status/AC change.
  if (task.proposal_id !== undefined) {
    try {
      const pkg = await buildContextPackage({
        proposal_id: task.proposal_id,
        package_type: "code_gen",
        team_name: task.team_name,
        agent_identity: briefed_by,
      });
      inherited_memory.push({
        key: `proposal_context:${task.proposal_id}`,
        body: pkg.context_text,
      });
    } catch {
      // Non-fatal: context_packages table may not exist yet.
    }
  }

  // Step 6: Record briefing
  const briefing: SpawnBriefing = {
    briefing_id,
    task_id: task.task_id,
    mission: task.mission,
    success_criteria: task.success_criteria,
    done_signal: task.done_signal || "ac-pass",

    allowed_tools: task.allowed_tools || [],
    forbidden_tools: task.forbidden_tools || [],
    budget,
    stop_conditions: task.stop_conditions || [],

    inherited_memory,
    mcp_quirks,
    fallback_playbook,
    recent_findings: [],

    parent_agent: task.parent_agent || null,
    liaison_agent: task.liaison_agent || null,
    rescue_team_channel: task.rescue_team_channel || null,
    request_assistance_threshold: task.request_assistance_threshold || 3,

    briefed_by,
    briefed_at: new Date().toISOString(),

    project_context,
    cache_control,
  };

  // Record in DB
  await query(
    `
    INSERT INTO roadmap.spawn_briefing (
      briefing_id,
      task_id,
      mission,
      success_criteria,
      done_signal,
      allowed_tools,
      forbidden_tools,
      budget,
      stop_conditions,
      inherited_memory,
      mcp_quirks,
      fallback_playbook,
      recent_findings,
      parent_agent,
      liaison_agent,
      rescue_team_channel,
      request_assistance_threshold,
      briefed_by,
      project_context,
      cache_control
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
    `,
    [
      briefing_id,
      task.task_id,
      task.mission,
      JSON.stringify(task.success_criteria),
      task.done_signal || "ac-pass",
      JSON.stringify(task.allowed_tools || []),
      JSON.stringify(task.forbidden_tools || []),
      JSON.stringify(budget),
      JSON.stringify(task.stop_conditions || []),
      JSON.stringify(inherited_memory),
      JSON.stringify(mcp_quirks),
      JSON.stringify(fallback_playbook),
      JSON.stringify([]),
      task.parent_agent || null,
      task.liaison_agent || null,
      task.rescue_team_channel || null,
      task.request_assistance_threshold || 3,
      briefed_by,
      project_context ? JSON.stringify(project_context) : null,
      JSON.stringify(cache_control),
    ]
  );

  return briefing;
}

/**
 * Load a briefing by ID. Child boot check calls this and fails if not found.
 */
export async function briefingLoad(briefing_id: string): Promise<SpawnBriefing> {
  const result = await query(
    `
    SELECT
      briefing_id,
      task_id,
      mission,
      success_criteria,
      done_signal,
      allowed_tools,
      forbidden_tools,
      budget,
      stop_conditions,
      inherited_memory,
      mcp_quirks,
      fallback_playbook,
      recent_findings,
      parent_agent,
      liaison_agent,
      rescue_team_channel,
      request_assistance_threshold,
      briefed_by,
      briefed_at,
      project_context,
      cache_control
    FROM roadmap.spawn_briefing
    WHERE briefing_id = $1
    `,
    [briefing_id]
  );

  if (result.rows.length === 0) {
    throw new Error(`Briefing ${briefing_id} not found. Child boot check failed (fail-closed).`);
  }

  const row = result.rows[0];
  return {
    briefing_id: row.briefing_id,
    task_id: row.task_id,
    mission: row.mission,
    success_criteria: row.success_criteria,
    done_signal: row.done_signal,

    allowed_tools: row.allowed_tools,
    forbidden_tools: row.forbidden_tools,
    budget: row.budget,
    stop_conditions: row.stop_conditions,

    inherited_memory: row.inherited_memory,
    mcp_quirks: row.mcp_quirks,
    fallback_playbook: row.fallback_playbook,
    recent_findings: row.recent_findings,

    parent_agent: row.parent_agent,
    liaison_agent: row.liaison_agent,
    rescue_team_channel: row.rescue_team_channel,
    request_assistance_threshold: row.request_assistance_threshold,

    briefed_by: row.briefed_by,
    briefed_at: row.briefed_at,

    project_context: row.project_context ?? undefined,
    cache_control: row.cache_control ?? undefined,
  };
}

/**
 * Fetch relevant memory entries by topic keywords.
 * Default fallback: fetch generic agency patterns and memory write-back contract notes.
 */
async function fetchInheritedMemory(topic_keywords: string[]): Promise<Array<{ key: string; body: string }>> {
  // TODO: extend to fuzzy search on keywords if roadmap.knowledge_entries has search capability
  // For now, fetch entries with matching tags or related_proposals

  if (topic_keywords.length === 0) {
    // Default: fetch generic agency patterns
    topic_keywords = ["agency", "spawn", "briefing"];
  }

  const result = await query(
    `
    SELECT
      id as key,
      content as body
    FROM roadmap.knowledge_entries
    WHERE
      (keywords @> $1::jsonb
       OR tags @> $2::jsonb)
      AND confidence >= 60
    LIMIT 10
    `,
    [JSON.stringify(topic_keywords), JSON.stringify(topic_keywords)]
  );

  return result.rows || [];
}

/**
 * Fetch MCP tool quirks from roadmap.mcp_tool_schema.
 * Constrain by allowed_tools if provided; otherwise return all non-obsolete.
 */
async function fetchMcpQuirks(
  allowed_tools?: string[]
): Promise<Array<{ tool: string; canonical_args: Record<string, any>; gotchas: string[] }>> {
  let sql = `
    SELECT
      tool_name,
      canonical_args,
      known_gotchas
    FROM roadmap.mcp_tool_schema
    WHERE verified_at IS NOT NULL
  `;

  const params: any[] = [];

  if (allowed_tools && allowed_tools.length > 0) {
    sql += ` AND tool_name = ANY($1::text[])`;
    params.push(allowed_tools);
  }

  sql += ` ORDER BY verified_at DESC`;

  const result = await query(sql, params);

  return (result.rows || []).map((row) => ({
    tool: row.tool_name,
    canonical_args: row.canonical_args || {},
    gotchas: row.known_gotchas || [],
  }));
}

/**
 * Fetch top-N fallback playbook entries (not obsolete, highest confidence first).
 */
async function fetchFallbackPlaybook(
  limit: number = 5
): Promise<Array<{ error_signature: string; try: string; rationale: string }>> {
  const result = await query(
    `
    SELECT
      error_signature,
      try_action,
      rationale
    FROM roadmap.fallback_playbook
    WHERE is_obsolete = false
    ORDER BY confidence DESC
    LIMIT $1
    `,
    [limit]
  );

  return (result.rows || []).map((row) => ({
    error_signature: row.error_signature,
    try: row.try_action,
    rationale: row.rationale || "",
  }));
}

/**
 * Emit spawn summary on child completion (success or failure).
 * Records outcome, new findings, and quirks update for harvester processing.
 */
export async function emitSpawnSummary(payload: SpawnSummaryPayload): Promise<void> {
  await query(
    `
    INSERT INTO roadmap.spawn_summary (
      briefing_id,
      outcome,
      summary,
      new_findings,
      updated_quirks,
      tool_calls_made,
      tokens_used,
      duration_seconds,
      error_log,
      state_snapshot,
      emitted_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `,
    [
      payload.briefing_id,
      payload.outcome,
      payload.summary || null,
      JSON.stringify(payload.new_findings),
      JSON.stringify(payload.updated_quirks),
      payload.tool_calls_made || null,
      payload.tokens_used || null,
      payload.duration_seconds || null,
      payload.error_log ? JSON.stringify(payload.error_log) : null,
      payload.state_snapshot ? JSON.stringify(payload.state_snapshot) : null,
      payload.emitted_by,
    ]
  );
}

/**
 * Harvester function: merge a spawn_summary into memory and fallback_playbook.
 * Verifies findings against current code state before merging (staleness protection).
 *
 * TODO(P###): Implement git commit verification logic.
 */
export async function harvestSpawnSummary(summary_id: bigint): Promise<void> {
  // TODO: fetch summary, verify quirks/findings against current HEAD commit,
  // merge into roadmap.knowledge_entries and roadmap.fallback_playbook,
  // mark summary as harvested_into_memory = true
}

/**
 * Child boot check: load briefing and verify it exists.
 * Called at spawn time; fails closed if briefing_id is missing or not found.
 */
export async function childBootCheckBriefing(briefing_id: string | undefined): Promise<SpawnBriefing> {
  if (!briefing_id || !briefing_id.trim()) {
    throw new Error(
      "briefing_id is required at spawn time. Child boot check failed: no warm-boot payload. " +
        "Parent must call briefing_assemble() before spawn."
    );
  }

  return await briefingLoad(briefing_id);
}
