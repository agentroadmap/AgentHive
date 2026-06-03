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
import { buildContextPackage, type PackageType } from "./context_builder.js";

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

  // P230: proposal-scoped context injection
  proposal_id?: bigint | number;
  team_name?: string;
  context_package_type?: PackageType;
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

type SpawnSummaryRow = {
  id: number;
  briefing_id: string;
  outcome: SpawnSummaryPayload["outcome"];
  summary: string | null;
  new_findings: Array<{ date?: string; summary: string; proposal?: string }>;
  updated_quirks: Array<{
    tool: string;
    canonical_args?: Record<string, any>;
    gotchas?: string[];
  }>;
  error_log: Record<string, any> | null;
  emitted_by: string | null;
  task_id: string | null;
  mission: string | null;
  harvested_into_memory: boolean;
};

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
    const [architecture, workflow, conventions] = await Promise.all([
      memoryService.getProjectMemory("architecture"),
      memoryService.getProjectMemory("workflow_states"),
      memoryService.getProjectMemory("conventions"),
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
  } catch {
    // Non-fatal: project_memory table may not exist yet (pre-migration).
    // Proceed without injecting project context.
  }

  // P230 Step 5b: inject proposal-scoped context package when proposal_id is set.
  if (task.proposal_id != null) {
    try {
      const proposalContext = await buildContextPackage({
        proposal_id: task.proposal_id,
        package_type: task.context_package_type ?? "code_gen",
        agent_id: briefed_by,
        team_name: task.team_name,
      });
      if (proposalContext) {
        inherited_memory.push({
          key: "proposal_context",
          body: proposalContext,
        });
      }
    } catch {
      // Non-fatal: proceed without proposal context.
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
  const insertResult = await query(
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
    RETURNING id
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

  const summaryId = insertResult.rows[0]?.id as number | undefined;
  if (summaryId) {
    await harvestSpawnSummary(summaryId);
  }
}

/**
 * Harvester function: merge a spawn_summary into memory and fallback_playbook.
 * Verifies findings against current code state before merging (staleness protection).
 *
 * TODO(P###): Implement git commit verification logic.
 */
export async function harvestSpawnSummary(summary_id: bigint): Promise<void> {
  const result = await query(
    `
    SELECT
      ss.id,
      ss.briefing_id,
      ss.outcome,
      ss.summary,
      ss.new_findings,
      ss.updated_quirks,
      ss.error_log,
      ss.emitted_by,
      ss.harvested_into_memory,
      sb.task_id,
      sb.mission
    FROM roadmap.spawn_summary ss
    LEFT JOIN roadmap.spawn_briefing sb ON sb.briefing_id = ss.briefing_id
    WHERE ss.id = $1
    `,
    [summary_id]
  );

  if (result.rowCount === 0) {
    throw new Error(`spawn_summary ${summary_id.toString()} not found`);
  }

  const summary = result.rows[0] as SpawnSummaryRow;
  if (summary.harvested_into_memory) {
    return;
  }

  const summaryIdText = String(summary.id);
  const verifiedAt = new Date().toISOString();

  for (const finding of summary.new_findings || []) {
    const proposalId =
      typeof finding.proposal === "string" && finding.proposal.trim().length > 0
        ? finding.proposal.trim()
        : undefined;
    const findingDate =
      typeof finding.date === "string" && finding.date.trim().length > 0
        ? finding.date
        : verifiedAt;

    await query(
      `
      INSERT INTO roadmap.knowledge_entries (
        id,
        type,
        title,
        content,
        keywords,
        related_proposals,
        source_proposal_id,
        author,
        confidence,
        helpful_count,
        reference_count,
        tags,
        created_at,
        updated_at,
        metadata
      ) VALUES (
        $1, 'learned', $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, 0, 0, $9::jsonb, $10, $10, $11::jsonb
      )
      ON CONFLICT (id) DO NOTHING
      `,
      [
        `KB-HARVEST-${summaryIdText}-${Buffer.from(finding.summary).toString("base64url").slice(0, 12)}`,
        truncateForTitle(finding.summary),
        [
          `Spawn summary outcome: ${summary.outcome}`,
          summary.mission ? `Mission: ${summary.mission}` : null,
          summary.summary ? `Summary: ${summary.summary}` : null,
          `Finding: ${finding.summary}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
        JSON.stringify(buildKeywordSet(summary, finding.summary)),
        JSON.stringify(proposalId ? [proposalId] : []),
        proposalId ?? null,
        summary.emitted_by ?? "spawn-summary-harvester",
        summary.outcome === "success" ? 85 : 75,
        JSON.stringify(["spawn-summary", "retirement", "knowledge-transfer", "learned"]),
        findingDate,
        JSON.stringify({
          harvested_from_spawn_summary_id: summary.id,
          harvested_from_briefing_id: summary.briefing_id,
          task_id: summary.task_id,
          outcome: summary.outcome,
        }),
      ]
    );
  }

  for (const quirk of summary.updated_quirks || []) {
    if (!quirk.tool?.trim()) continue;

    await query(
      `
      INSERT INTO roadmap.mcp_tool_schema (
        tool_name,
        mcp_server,
        canonical_args,
        known_gotchas,
        verified_at
      ) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
      ON CONFLICT (tool_name) DO UPDATE SET
        canonical_args = CASE
          WHEN EXCLUDED.canonical_args = '{}'::jsonb
            THEN roadmap.mcp_tool_schema.canonical_args
          ELSE EXCLUDED.canonical_args
        END,
        known_gotchas = CASE
          WHEN jsonb_array_length(EXCLUDED.known_gotchas) = 0
            THEN roadmap.mcp_tool_schema.known_gotchas
          ELSE EXCLUDED.known_gotchas
        END,
        verified_at = EXCLUDED.verified_at,
        last_discovered_at = now()
      `,
      [
        quirk.tool.trim(),
        "agenthive",
        JSON.stringify(quirk.canonical_args ?? {}),
        JSON.stringify(
          (quirk.gotchas ?? []).map((issue) => ({
            issue,
            workaround: "",
          }))
        ),
        verifiedAt,
      ]
    );
  }

  const errorSignature = normalizeErrorSignature(summary.error_log);
  if (errorSignature) {
    const toolName =
      typeof summary.error_log?.tool === "string" && summary.error_log.tool.trim().length > 0
        ? summary.error_log.tool.trim()
        : null;

    await query(
      `
      INSERT INTO roadmap.fallback_playbook (
        error_signature,
        tool_name,
        error_class,
        try_action,
        rationale,
        source_proposal,
        harvested_from_spawn_id,
        confidence,
        verified_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT DO NOTHING
      `,
      [
        errorSignature,
        toolName,
        typeof summary.error_log?.error_class === "string"
          ? summary.error_log.error_class
          : "SpawnSummaryError",
        summarizeFallbackAction(summary),
        summary.summary ?? summary.mission ?? "Harvested from spawn summary",
        extractFirstProposal(summary.new_findings),
        summary.briefing_id,
        0.75,
        verifiedAt,
      ]
    );
  }

  await query(
    `
    UPDATE roadmap.spawn_summary
    SET harvested_into_memory = true,
        harvested_at = $2
    WHERE id = $1
    `,
    [summary.id, verifiedAt]
  );
}

function truncateForTitle(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length <= 120) return trimmed;
  return `${trimmed.slice(0, 117)}...`;
}

function buildKeywordSet(summary: SpawnSummaryRow, findingSummary: string): string[] {
  const rawTokens = [
    summary.task_id,
    summary.outcome,
    summary.emitted_by,
    ...findingSummary.split(/\W+/),
    ...(summary.mission ? summary.mission.split(/\W+/) : []),
  ];
  return Array.from(
    new Set(
      rawTokens
        .filter((token): token is string => Boolean(token && token.trim()))
        .map((token) => token.toLowerCase())
        .filter((token) => token.length >= 3)
    )
  ).slice(0, 24);
}

function extractFirstProposal(
  findings: Array<{ proposal?: string }> | undefined
): string | null {
  for (const finding of findings || []) {
    if (typeof finding.proposal === "string" && finding.proposal.trim().length > 0) {
      return finding.proposal.trim();
    }
  }
  return null;
}

function normalizeErrorSignature(errorLog: Record<string, any> | null): string | null {
  if (!errorLog) return null;
  if (typeof errorLog.error_signature === "string" && errorLog.error_signature.trim().length > 0) {
    return errorLog.error_signature.trim();
  }

  const toolPrefix =
    typeof errorLog.tool === "string" && errorLog.tool.trim().length > 0
      ? errorLog.tool.trim().toLowerCase()
      : "spawn";
  const message =
    typeof errorLog.error_message === "string"
      ? errorLog.error_message
      : typeof errorLog.error === "string"
        ? errorLog.error
        : "";
  if (!message.trim()) return null;

  const normalizedMessage = message
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return `${toolPrefix}_${normalizedMessage}`;
}

function summarizeFallbackAction(summary: SpawnSummaryRow): string {
  for (const quirk of summary.updated_quirks || []) {
    if (quirk.gotchas && quirk.gotchas.length > 0) {
      return quirk.gotchas.join("; ");
    }
  }
  if (summary.summary?.trim()) {
    return summary.summary.trim();
  }
  return "Review the emitted spawn summary and retry with corrected MCP arguments.";
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
