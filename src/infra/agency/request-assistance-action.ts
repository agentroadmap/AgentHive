/**
 * P467: request_assistance MCP action handler
 *
 * Subagent calls this when stuck. Inserts assistance_request record,
 * posts to rescue:<agency_id> channel, and notifies parent + liaison.
 */

import { query } from "../postgres/pool.ts";
import {
  recordAssistanceRequest,
  type AssistancePayload,
} from "./stuck-detection.ts";

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
  // TODO(P475): Wire message insertion to notify parent agent and liaison
  await notifyLiaisonAndParent(
    input.briefing_context.agency_id,
    input.briefing_id,
    request_id,
    payload
  );

  // Step 4: Post to rescue:<agency_id> channel for watchdog
  // TODO(P475): Wire channel message posting
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
 * Sets lease state to 'awaiting-assistance' so it doesn't consume window time
 * and reaper doesn't terminate it.
 */
async function pauseLease(briefing_id: string): Promise<void> {
  // TODO(P468): Implement lease pause lookup and state update
  // Placeholder for now
  if (process.env.DEBUG_P467) {
    console.log(`[P467] Paused lease for briefing ${briefing_id}`);
  }
}

/**
 * Notify parent agent and liaison of the assistance request.
 */
async function notifyLiaisonAndParent(
  agency_id: string,
  briefing_id: string,
  request_id: bigint,
  payload: AssistancePayload
): Promise<void> {
  // TODO(P475): Wire assistance_request message insertion to liaison_message
  // Message kind: "assistance_request" is already in the catalog
  if (process.env.DEBUG_P467) {
    console.log(
      `[P467] Notified liaison and parent of assistance request ${request_id}`
    );
  }
}

/**
 * Post to rescue:<agency_id> channel so watchdog picks it up.
 */
async function postToRescueChannel(
  agency_id: string,
  request_id: bigint,
  payload: AssistancePayload
): Promise<void> {
  // TODO(P475): Wire channel message posting for rescue:<agency_id>
  if (process.env.DEBUG_P467) {
    console.log(
      `[P467] Posted assistance request ${request_id} to rescue:${agency_id}`
    );
  }
}

/**
 * Resolve an assistance request with a directive from the liaison.
 * Called by liaison after auto-remediation or re-spawn decision.
 */
export async function handleAssistanceResolve(input: {
  request_id: bigint;
  directive: string;
  try_directive?: Record<string, any>;
}): Promise<void> {
  // TODO(P475): Implement assistance_resolve action
  // This sends back a directive to the child (e.g., "try with different params")
  if (process.env.DEBUG_P467) {
    console.log(`[P467] Resolved assistance request ${input.request_id}`);
  }
}
