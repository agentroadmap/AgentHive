/**
 * P467: request_assistance MCP action handler
 *
 * Subagent calls this when stuck. Inserts assistance_request record,
 * posts to rescue:<agency_id> channel, and notifies parent + liaison.
 */

import { query } from "../postgres/pool.ts";
import {
  recordAssistanceRequest,
  updateAssistanceRequest,
  type AssistancePayload,
} from "./stuck-detection.ts";
import { sendMessage } from "./liaison-message-service.ts";

export interface RequestAssistanceInput {
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
  // These come from briefing context:
  briefing_context?: {
    agency_id: string;
    agent_identity: string;
  };
}

export interface RequestAssistanceOutput {
  request_id: bigint;
  status: "open";
  message: string;
  lease_paused_at: string;
}

/**
 * Handler for the request_assistance MCP action.
 *
 * 1. Validate input
 * 2. Insert assistance_request record with status='open'
 * 3. Post notification to parent agent and liaison
 * 4. Post to rescue:<agency_id> channel (for watchdog)
 * 5. Pause child's lease (set lease state = 'awaiting-assistance')
 * 6. Return request_id to child (for tracking)
 */
export async function handleRequestAssistance(
  input: RequestAssistanceInput
): Promise<RequestAssistanceOutput> {
  // Validate required fields
  if (!input.briefing_id) throw new Error("briefing_id is required");
  if (!input.task_id) throw new Error("task_id is required");
  if (!input.briefing_context?.agency_id)
    throw new Error("agency_id (from briefing_context) is required");
  if (!input.briefing_context?.agent_identity)
    throw new Error("agent_identity (from briefing_context) is required");

  const payload: AssistancePayload = {
    briefing_id: input.briefing_id,
    task_id: input.task_id,
    error_signature: input.error_signature,
    error_history: input.error_history,
    what_i_tried: input.what_i_tried,
    what_i_think: input.what_i_think,
    what_might_help: input.what_might_help,
    current_state_summary: input.current_state_summary,
    blocker_severity: input.blocker_severity,
  };

  // Step 1: Record assistance request
  const request_id = await recordAssistanceRequest(
    input.briefing_context.agency_id,
    input.briefing_context.agent_identity,
    payload
  );

  // Step 2: Pause the child's lease
  // TODO(P468): Lookup claim_id from briefing_id and set lease state to 'awaiting-assistance'
  await pauseLease(input.briefing_id);

  // Step 3: Post notification message to liaison (via liaison_message table)
  await notifyLiaisonAndParent(
    input.briefing_context.agency_id,
    input.briefing_context.agent_identity,
    input.briefing_id,
    request_id,
    payload
  );

  // Step 4: Post to system:liaison:<agency_id> channel for watchdog
  await postToRescueChannel(input.briefing_context.agency_id, request_id, payload);

  return {
    request_id,
    status: "open",
    message: `Assistance request opened (ID: ${request_id}). Your lease is paused pending resolution.`,
    lease_paused_at: new Date().toISOString(),
  };
}

/**
 * Pause the lease associated with this briefing.
 * Extends expires_at by 24h so the reaper doesn't terminate the agent
 * while it is awaiting assistance resolution.
 */
async function pauseLease(briefing_id: string): Promise<void> {
  try {
    const result = await query(
      `UPDATE roadmap_proposal.proposal_lease pl
       SET expires_at = GREATEST(COALESCE(pl.expires_at, now()), now()) + interval '24 hours'
       WHERE pl.agent_identity = (
         SELECT agent_identity FROM roadmap.assistance_request
         WHERE briefing_id = $1::uuid
         ORDER BY opened_at DESC LIMIT 1
       )
       AND pl.released_at IS NULL`,
      [briefing_id]
    );
    if (process.env.DEBUG_P467) {
      console.log(`[P467] Paused lease for briefing ${briefing_id}: ${result.rowCount} rows updated`);
    }
  } catch (err) {
    // Non-fatal: assistance_request is already recorded; watchdog will handle escalation
    if (process.env.DEBUG_P467) {
      console.error(`[P467] Failed to pause lease for briefing ${briefing_id}:`, err);
    }
  }
}

/**
 * Notify liaison of the assistance request via liaison_message protocol.
 * Fires pg_notify('liaison_message_<agency_id>') → wakes LiaisonHub listener.
 */
async function notifyLiaisonAndParent(
  agency_id: string,
  agent_identity: string,
  briefing_id: string,
  request_id: bigint,
  payload: AssistancePayload
): Promise<void> {
  try {
    await sendMessage({
      agency_id,
      direction: "liaison->orchestrator",
      kind: "assistance_request",
      payload: {
        ...payload,
        request_id: String(request_id),
        agent_identity,
        briefing_id,
      },
    });
  } catch (err) {
    // Non-fatal: assistance_request is already recorded; hub will pick it up on next poll
    if (process.env.DEBUG_P467) {
      console.error(`[P467] Failed to notify liaison for request ${request_id}:`, err);
    }
  }
}

/**
 * Mirror to message_ledger on the liaison channel so watchdog/observers can track via A2A query.
 */
async function postToRescueChannel(
  agency_id: string,
  request_id: bigint,
  payload: AssistancePayload
): Promise<void> {
  try {
    // Generate a correlation_id for this assistance request
    const correlationId = `assistance:${request_id}`;

    await query(
      `INSERT INTO roadmap.message_ledger
          (from_agent, channel, message_content, message_type, metadata, correlation_id)
       VALUES ($1, $2, $3, 'notify', $4, $5)`,
      [
        agency_id,
        `system:liaison:${agency_id}`,
        `Assistance request ${request_id}: ${payload.error_signature ?? "unknown"}`,
        JSON.stringify({
          kind: "assistance_request",
          request_id: String(request_id),
          blocker_severity: payload.blocker_severity,
        }),
        correlationId,
      ]
    );
  } catch {
    // Non-critical
  }
}

/**
 * Resolve an assistance request with a directive from the liaison.
 * Marks the request resolved and sends a downlink directive to the subagent
 * via message_ledger → trig_a2a_message_notify → pg_notify a2a_msg_{agent}.
 */
export async function handleAssistanceResolve(input: {
  request_id: bigint;
  directive: string;
  try_directive?: Record<string, any>;
  correlationId?: string;
  replyToId?: number;
}): Promise<void> {
  // Look up agent_identity from the assistance_request record
  const { rows } = await query<{ agent_identity: string; agency_id: string }>(
    `SELECT agent_identity, agency_id FROM roadmap.assistance_request WHERE id = $1`,
    [input.request_id]
  );
  const record = rows[0];

  await updateAssistanceRequest(input.request_id, "resolved", {
    resolution_path: "operator_directive",
    directive: input.directive,
  });

  // Send directive downlink to the subagent if identity is known
  if (record?.agent_identity) {
    // Use provided correlation_id or generate one based on the request
    const correlationId = input.correlationId ?? `assistance:${input.request_id}`;

    await query(
      `INSERT INTO roadmap.message_ledger
          (from_agent, to_agent, message_content, message_type, metadata, correlation_id, reply_to)
       VALUES ('liaison', $1, $2, 'notify', $3, $4, $5)`,
      [
        record.agent_identity,
        input.directive,
        JSON.stringify({
          type: "directive",
          request_id: String(input.request_id),
          source: "operator",
          ...(input.try_directive ?? {}),
        }),
        correlationId,
        input.replyToId ?? null,
      ]
    );
  }
}
