/**
 * P467/P475: Subagent stuck-detection and auto-escalation
 *
 * Implements:
 * - N-strikes error signature deduplication per spawn
 * - Forced progress checkpoints every M tool calls
 * - Hard-stop budget enforcement (max_tool_calls)
 * - request_assistance MCP action routing
 * - Proactive runaway detection (velocity, pattern, sequence)
 */

import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { query } from "../../postgres/pool.ts";

export interface StuckDetectionConfig {
  briefing_id: string;
  request_assistance_threshold: number; // default 3
  checkpoint_interval: number; // default 5
  max_tool_calls: number; // default 100
  low_confidence_strike_weight: number; // default 0.5
}

export interface ErrorSignature {
  tool_name: string;
  error_class: string;
  normalized_message: string;
}

export interface AssistancePayload {
  briefing_id: string;
  task_id: string;
  error_signature: string;
  error_history: Array<{
    tool: string;
    error_class: string;
    message: string;
    ts: number;
  }>;
  what_i_tried: string;
  what_i_think: string;
  what_might_help: string;
  current_state_summary: string;
  blocker_severity: "soft" | "hard";
}

export interface ProgressCheckpoint {
  briefing_id: string;
  summary: string;
  next_attempt: string;
  confidence: "low" | "med" | "high";
}

export interface SpawnStrikeRecord {
  briefing_id: string;
  error_signature: string;
  strike_count: number;
  first_occurrence_at: Date;
  last_occurrence_at: Date;
}

/**
 * Compute error signature: hash(tool_name, error_class, normalized_message)
 */
export function computeErrorSignature(error: ErrorSignature): string {
  const input = `${error.tool_name}::${error.error_class}::${error.normalized_message}`;
  return createHash("sha256").update(input).digest("hex").substring(0, 16);
}

/**
 * Check strike count for a given error signature within a spawn.
 * Returns the current strike count or 0 if not found.
 */
export async function getStrikeCount(
  briefing_id: string,
  error_signature: string
): Promise<number> {
  const result = await query<{ strike_count: number | string }>(
    `SELECT strike_count FROM roadmap.spawn_error_strike
     WHERE briefing_id = $1 AND error_signature = $2`,
    [briefing_id, error_signature]
  );
  const count = result.rows[0]?.strike_count;
  return typeof count === "string" ? parseInt(count, 10) : count ?? 0;
}

/**
 * Increment strike count for an error signature.
 * Returns the new strike count after increment.
 */
export async function incrementStrike(
  briefing_id: string,
  error_signature: string
): Promise<number> {
  // Upsert: increment if exists, insert with count=1 if new
  const result = await query<{ strike_count: number | string }>(
    `INSERT INTO roadmap.spawn_error_strike
      (briefing_id, error_signature, strike_count, last_occurrence_at, first_occurrence_at)
     VALUES ($1, $2, 1, now(), now())
     ON CONFLICT (briefing_id, error_signature) DO UPDATE
     SET strike_count = spawn_error_strike.strike_count + 1,
         last_occurrence_at = now()
     RETURNING strike_count`,
    [briefing_id, error_signature]
  );
  const count = result.rows[0]?.strike_count;
  return typeof count === "string" ? parseInt(count, 10) : count ?? 1;
}

/**
 * Record a progress checkpoint. Returns true if checkpoint was accepted,
 * false if one is already pending (not yet recorded via progress_note).
 */
export async function recordProgressCheckpoint(
  checkpoint: ProgressCheckpoint
): Promise<boolean> {
  const result = await query(
    `UPDATE roadmap.spawn_tool_call_counter
     SET calls_since_last_checkpoint = 0,
         last_checkpoint_at = now(),
         last_checkpoint_summary = $2,
         last_checkpoint_confidence = $3,
         updated_at = now()
     WHERE briefing_id = $1 AND last_checkpoint_at IS NULL
     RETURNING briefing_id`,
    [checkpoint.briefing_id, checkpoint.summary, checkpoint.confidence]
  );
  return result.rows.length > 0;
}

/**
 * Check if a checkpoint is due (tool calls since last checkpoint >= interval).
 */
export async function isCheckpointDue(
  briefing_id: string,
  config: StuckDetectionConfig
): Promise<boolean> {
  const result = await query<{ calls_since_last_checkpoint: number }>(
    `SELECT calls_since_last_checkpoint FROM roadmap.spawn_tool_call_counter
     WHERE briefing_id = $1`,
    [briefing_id]
  );
  const row = result.rows[0];
  if (!row) {
    // Initialize counter
    await query(
      `INSERT INTO roadmap.spawn_tool_call_counter
        (briefing_id, total_tool_calls_made, calls_since_last_checkpoint)
       VALUES ($1, 0, 0)
       ON CONFLICT (briefing_id) DO NOTHING`,
      [briefing_id]
    );
    return false;
  }
  return row.calls_since_last_checkpoint >= config.checkpoint_interval;
}

/**
 * Increment tool call counter and check if max_tool_calls exceeded.
 * Returns { exceeded: boolean, current_count: number }
 */
export async function incrementToolCallCount(
  briefing_id: string,
  config: StuckDetectionConfig
): Promise<{ exceeded: boolean; current_count: number }> {
  // Ensure counter is initialized
  await query(
    `INSERT INTO roadmap.spawn_tool_call_counter
      (briefing_id, total_tool_calls_made, calls_since_last_checkpoint)
     VALUES ($1, 0, 0)
     ON CONFLICT (briefing_id) DO NOTHING`,
    [briefing_id]
  );

  const result = await query<{ total_tool_calls_made: number | string }>(
    `UPDATE roadmap.spawn_tool_call_counter
     SET total_tool_calls_made = total_tool_calls_made + 1,
         calls_since_last_checkpoint = calls_since_last_checkpoint + 1,
         updated_at = now()
     WHERE briefing_id = $1
     RETURNING total_tool_calls_made`,
    [briefing_id]
  );
  const count = result.rows[0]?.total_tool_calls_made;
  const numCount =
    typeof count === "string" ? parseInt(count, 10) : count ?? 0;
  return {
    exceeded: numCount > config.max_tool_calls,
    current_count: numCount,
  };
}

/**
 * Record an assistance request in the database.
 * Returns the assistance request ID.
 */
export async function recordAssistanceRequest(
  agency_id: string,
  agent_identity: string,
  payload: AssistancePayload
): Promise<bigint> {
  const result = await query<{ id: bigint }>(
    `INSERT INTO roadmap.assistance_request
      (briefing_id, task_id, agency_id, agent_identity, error_signature, payload, status, opened_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'open', now())
     RETURNING id`,
    [
      payload.briefing_id,
      payload.task_id,
      agency_id,
      agent_identity,
      payload.error_signature,
      JSON.stringify(payload),
    ]
  );
  return result.rows[0]!.id;
}

/**
 * Update assistance request status and resolution.
 */
export async function updateAssistanceRequest(
  request_id: bigint,
  status: "resolved" | "reassigned" | "escalated" | "abandoned",
  resolution?: Record<string, any>
): Promise<void> {
  await query(
    `UPDATE roadmap.assistance_request
     SET status = $1, resolution = $2, resolved_at = now()
     WHERE id = $3`,
    [status, resolution ? JSON.stringify(resolution) : null, request_id]
  );
}

/**
 * Fetch open assistance requests for an agency.
 */
export async function getOpenAssistanceRequests(
  agency_id: string
): Promise<
  Array<{
    id: bigint;
    briefing_id: string;
    task_id: string;
    error_signature: string;
    payload: AssistancePayload;
    opened_at: Date;
  }>
> {
  const result = await query<{
    id: bigint;
    briefing_id: string;
    task_id: string;
    error_signature: string;
    payload: AssistancePayload | string;
    opened_at: Date;
  }>(
    `SELECT id, briefing_id, task_id, error_signature, payload, opened_at
     FROM roadmap.assistance_request
     WHERE agency_id = $1 AND status = 'open'
     ORDER BY opened_at ASC`,
    [agency_id]
  );

  return result.rows.map((row) => ({
    ...row,
    payload:
      typeof row.payload === "string"
        ? (JSON.parse(row.payload) as AssistancePayload)
        : (row.payload as AssistancePayload),
  }));
}

/**
 * Initialize spawn briefing configuration if not present.
 */
export async function initSpawnBriefingConfig(
  briefing_id: string,
  overrides?: Partial<StuckDetectionConfig>
): Promise<StuckDetectionConfig> {
  const config: StuckDetectionConfig = {
    briefing_id,
    request_assistance_threshold: overrides?.request_assistance_threshold ?? 3,
    checkpoint_interval: overrides?.checkpoint_interval ?? 5,
    max_tool_calls: overrides?.max_tool_calls ?? 100,
    low_confidence_strike_weight: overrides?.low_confidence_strike_weight ?? 0.5,
  };

  await query(
    `INSERT INTO roadmap.spawn_briefing_config
      (briefing_id, request_assistance_threshold, checkpoint_interval, max_tool_calls, low_confidence_strike_weight)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (briefing_id) DO NOTHING`,
    [
      config.briefing_id,
      config.request_assistance_threshold,
      config.checkpoint_interval,
      config.max_tool_calls,
      config.low_confidence_strike_weight,
    ]
  );

  return config;
}

// ─── Runaway detection (P475) ─────────────────────────────────────────────────

export interface RunawaySignal {
  kind: "velocity_spike" | "repetitive_pattern" | "loop_sequence";
  description: string;
  details?: Record<string, unknown>;
}

/**
 * Log a single tool call for runaway analysis.
 * Writes to roadmap.tool_call_log (migration 100).
 */
export async function logToolCall(
  briefing_id: string,
  tool_name: string,
  args_hash?: string
): Promise<void> {
  await query(
    `INSERT INTO roadmap.tool_call_log (briefing_id, tool_name, args_hash)
     VALUES ($1, $2, $3)`,
    [briefing_id, tool_name, args_hash ?? null]
  );
}

/**
 * Detect if the last N tool names form a repeated sequence.
 * Returns true when the first half of the array equals the second half.
 * Requires an even-length array of at least 6 calls.
 */
function detectSequenceLoop(toolNames: string[]): boolean {
  const len = toolNames.length;
  if (len < 6 || len % 2 !== 0) return false;
  const half = len / 2;
  for (let i = 0; i < half; i++) {
    if (toolNames[i] !== toolNames[i + half]) return false;
  }
  return true;
}

/**
 * Run all three runaway detectors against recent tool_call_log rows:
 *   1. Velocity spike: >15 calls in the last minute
 *   2. Repetitive pattern: same (tool_name, args_hash) ≥3 times in last 10 calls
 *   3. Loop sequence: same tool-name sequence repeated in last 20 calls
 *
 * Returns the first signal found, or null if none.
 */
export async function detectRunaway(
  briefing_id: string
): Promise<RunawaySignal | null> {
  // Velocity check
  const velocityResult = await query<{ cnt: string | number }>(
    `SELECT count(*) AS cnt FROM roadmap.tool_call_log
     WHERE briefing_id = $1 AND called_at > now() - interval '1 minute'`,
    [briefing_id]
  );
  const velocity =
    typeof velocityResult.rows[0]?.cnt === "string"
      ? parseInt(velocityResult.rows[0].cnt, 10)
      : (velocityResult.rows[0]?.cnt ?? 0);
  if (velocity > 15) {
    return {
      kind: "velocity_spike",
      description: `${velocity} tool calls in the last minute (threshold: 15)`,
      details: { call_count: velocity },
    };
  }

  // Repetitive pattern check (last 10 calls)
  const patternResult = await query<{
    tool_name: string;
    args_hash: string | null;
    cnt: string | number;
  }>(
    `SELECT tool_name, args_hash, count(*) AS cnt
     FROM (
       SELECT tool_name, args_hash
       FROM roadmap.tool_call_log
       WHERE briefing_id = $1
       ORDER BY called_at DESC
       LIMIT 10
     ) recent
     GROUP BY tool_name, args_hash
     HAVING count(*) >= 3`,
    [briefing_id]
  );
  if (patternResult.rows.length > 0) {
    const row = patternResult.rows[0]!;
    const cnt =
      typeof row.cnt === "string" ? parseInt(row.cnt, 10) : row.cnt;
    return {
      kind: "repetitive_pattern",
      description: `Tool '${row.tool_name}' called ${cnt} times with same args in last 10 calls`,
      details: { tool_name: row.tool_name, args_hash: row.args_hash, count: cnt },
    };
  }

  // Loop sequence check (last 20 tool names)
  const seqResult = await query<{ tool_name: string }>(
    `SELECT tool_name
     FROM roadmap.tool_call_log
     WHERE briefing_id = $1
     ORDER BY called_at DESC
     LIMIT 20`,
    [briefing_id]
  );
  const toolNames = seqResult.rows.map((r) => r.tool_name).reverse();
  if (detectSequenceLoop(toolNames)) {
    return {
      kind: "loop_sequence",
      description: `Tool call sequence is repeating (last ${toolNames.length} calls form a loop)`,
      details: { sequence: toolNames.slice(0, toolNames.length / 2) },
    };
  }

  return null;
}

/**
 * Get spawn briefing configuration.
 */
export async function getSpawnBriefingConfig(
  briefing_id: string
): Promise<StuckDetectionConfig | null> {
  const result = await query<{
    briefing_id: string;
    request_assistance_threshold: number | string;
    checkpoint_interval: number | string;
    max_tool_calls: number | string;
    low_confidence_strike_weight: number | string;
  }>(
    `SELECT briefing_id, request_assistance_threshold, checkpoint_interval,
            max_tool_calls, low_confidence_strike_weight
     FROM roadmap.spawn_briefing_config
     WHERE briefing_id = $1`,
    [briefing_id]
  );
  const row = result.rows[0];
  if (!row) return null;

  return {
    briefing_id: row.briefing_id,
    request_assistance_threshold:
      typeof row.request_assistance_threshold === "string"
        ? parseInt(row.request_assistance_threshold, 10)
        : row.request_assistance_threshold,
    checkpoint_interval:
      typeof row.checkpoint_interval === "string"
        ? parseInt(row.checkpoint_interval, 10)
        : row.checkpoint_interval,
    max_tool_calls:
      typeof row.max_tool_calls === "string"
        ? parseInt(row.max_tool_calls, 10)
        : row.max_tool_calls,
    low_confidence_strike_weight:
      typeof row.low_confidence_strike_weight === "string"
        ? parseFloat(row.low_confidence_strike_weight)
        : row.low_confidence_strike_weight,
  };
}
