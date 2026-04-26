/**
 * P467: Tool call wrapper with stuck-detection enforcement
 *
 * Wraps subagent tool calls to enforce:
 * - N-strikes rule: block offending tool after N identical errors
 * - Forced progress checkpoints: reject next tool call if checkpoint due
 * - Hard-stop budget: auto-escalate when max_tool_calls exceeded
 */

import {
  computeErrorSignature,
  getStrikeCount,
  incrementStrike,
  isCheckpointDue,
  incrementToolCallCount,
  recordAssistanceRequest,
  getSpawnBriefingConfig,
  type ErrorSignature,
  type AssistancePayload,
  type StuckDetectionConfig,
} from "./stuck-detection.ts";

export interface ToolCallContext {
  briefing_id: string;
  agency_id: string;
  agent_identity: string;
  task_id: string;
}

export class ToolCallError extends Error {
  constructor(
    public code: string,
    message: string,
    public briefing_id: string
  ) {
    super(message);
    this.name = "ToolCallError";
  }
}

/**
 * Check if a checkpoint is required before allowing the next tool call.
 * Returns error if checkpoint is due and hasn't been recorded.
 */
export async function checkCheckpointRequired(
  config: StuckDetectionConfig
): Promise<{ required: boolean }> {
  const due = await isCheckpointDue(config.briefing_id, config);
  return { required: due };
}

/**
 * Check if an error signature exceeds the strike threshold.
 * If threshold is reached, triggers auto-escalation via request_assistance.
 */
export async function checkErrorStrikes(
  context: ToolCallContext,
  error: ErrorSignature,
  error_history: Array<{ tool: string; error_class: string; message: string; ts: number }>
): Promise<{
  blocked: boolean;
  strike_count: number;
  escalated: boolean;
  request_id?: bigint;
}> {
  const config = await getSpawnBriefingConfig(context.briefing_id);
  if (!config) {
    // Config not initialized; allow call but log warning
    console.warn(`[P467] No config found for briefing ${context.briefing_id}`);
    return { blocked: false, strike_count: 0, escalated: false };
  }

  const signature = computeErrorSignature(error);
  const current_strikes = await getStrikeCount(
    context.briefing_id,
    signature
  );

  // Check if already at threshold
  if (current_strikes >= config.request_assistance_threshold) {
    // Already escalated, block further calls with this error
    return { blocked: true, strike_count: current_strikes, escalated: false };
  }

  // Increment and check if we hit threshold
  const new_strikes = await incrementStrike(context.briefing_id, signature);

  if (new_strikes >= config.request_assistance_threshold) {
    // Trigger auto-escalation
    const payload: AssistancePayload = {
      briefing_id: context.briefing_id,
      task_id: context.task_id,
      error_signature: signature,
      error_history,
      what_i_tried: `Attempted ${new_strikes} times to call ${error.tool_name}`,
      what_i_think: `The tool ${error.tool_name} consistently fails with: ${error.error_class}`,
      what_might_help: "Try a different approach or request manual intervention",
      current_state_summary: `Hit strike threshold (${new_strikes}/${config.request_assistance_threshold}) on error signature ${signature}`,
      blocker_severity: "soft",
    };

    const request_id = await recordAssistanceRequest(
      context.agency_id,
      context.agent_identity,
      payload
    );

    return {
      blocked: true,
      strike_count: new_strikes,
      escalated: true,
      request_id,
    };
  }

  return { blocked: false, strike_count: new_strikes, escalated: false };
}

/**
 * Check if hard-stop budget (max_tool_calls) has been exceeded.
 * If exceeded, triggers immediate hard escalation.
 */
export async function checkHardStopBudget(
  context: ToolCallContext,
  error_history: Array<{ tool: string; error_class: string; message: string; ts: number }>
): Promise<{
  exceeded: boolean;
  current_count: number;
  escalated: boolean;
  request_id?: bigint;
}> {
  const config = await getSpawnBriefingConfig(context.briefing_id);
  if (!config) {
    return { exceeded: false, current_count: 0, escalated: false };
  }

  const { exceeded, current_count } = await incrementToolCallCount(
    context.briefing_id,
    config
  );

  if (exceeded) {
    const payload: AssistancePayload = {
      briefing_id: context.briefing_id,
      task_id: context.task_id,
      error_signature: "hard-stop-budget",
      error_history,
      what_i_tried: `Made ${current_count} tool calls total`,
      what_i_think: "Exceeded hard-stop tool call budget",
      what_might_help: "Re-scope the task or break into smaller steps",
      current_state_summary: `Hard-stop budget exceeded: ${current_count} >= ${config.max_tool_calls}`,
      blocker_severity: "hard",
    };

    const request_id = await recordAssistanceRequest(
      context.agency_id,
      context.agent_identity,
      payload
    );

    return {
      exceeded: true,
      current_count,
      escalated: true,
      request_id,
    };
  }

  return { exceeded: false, current_count, escalated: false };
}

/**
 * Wrapper function to check all stuck-detection rules before tool call.
 * Throws ToolCallError if call should be blocked.
 * Returns check results for caller to inspect.
 */
export async function validateToolCall(
  context: ToolCallContext,
  tool_name: string,
  tool_args: Record<string, any>,
  recent_errors: Array<{ error: ErrorSignature; ts: number }>
): Promise<{
  allowed: boolean;
  checkpoint_required: boolean;
  escalation_triggered: boolean;
  escalation_request_id?: bigint;
}> {
  const config = await getSpawnBriefingConfig(context.briefing_id);
  if (!config) {
    return {
      allowed: true,
      checkpoint_required: false,
      escalation_triggered: false,
    };
  }

  // Check 1: Hard-stop budget
  const budgetCheck = await checkHardStopBudget(
    context,
    recent_errors.map((e) => ({
      tool: e.error.tool_name,
      error_class: e.error.error_class,
      message: e.error.normalized_message,
      ts: e.ts,
    }))
  );

  if (budgetCheck.exceeded) {
    throw new ToolCallError(
      "HARD_STOP_BUDGET_EXCEEDED",
      `Tool call count (${budgetCheck.current_count}) exceeds max (${config.max_tool_calls}). Request assistance initiated.`,
      context.briefing_id
    );
  }

  // Check 2: Forced progress checkpoint
  const checkpointCheck = await checkCheckpointRequired(config);
  if (checkpointCheck.required) {
    throw new ToolCallError(
      "CHECKPOINT_REQUIRED",
      `Progress checkpoint required (${config.checkpoint_interval} calls since last checkpoint). Call progress_note() first.`,
      context.briefing_id
    );
  }

  // Check 3: N-strikes error filtering
  // Only check if this tool call recently failed
  const lastError = recent_errors.find((e) => e.error.tool_name === tool_name);
  if (lastError) {
    const strikeCheck = await checkErrorStrikes(
      context,
      lastError.error,
      recent_errors.map((e) => ({
        tool: e.error.tool_name,
        error_class: e.error.error_class,
        message: e.error.normalized_message,
        ts: e.ts,
      }))
    );

    if (strikeCheck.blocked) {
      throw new ToolCallError(
        "ERROR_STRIKE_THRESHOLD_EXCEEDED",
        `Error signature for ${tool_name} hit strike threshold (${strikeCheck.strike_count}/${config.request_assistance_threshold}). Escalated for assistance.`,
        context.briefing_id
      );
    }
  }

  return {
    allowed: true,
    checkpoint_required: checkpointCheck.required,
    escalation_triggered: budgetCheck.escalated,
    escalation_request_id: budgetCheck.request_id,
  };
}
