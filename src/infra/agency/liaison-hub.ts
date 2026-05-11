/**
 * Liaison Message Hub — bidirectional A2A communication dispatcher.
 *
 * Architecture:
 *   Uplink:   subagent → liaison_message (pg_notify) → LiaisonHub → orchestrator
 *   Downlink: orchestrator/hub → message_ledger (pg_notify a2a_msg_*) → subagent
 *   Cross-project: hub → message_ledger channel=system:hiveCentral → observers
 *
 * Liaison is the agency-wide authority: liveness = agency liveness.
 * One hub runs per agency. Start with startLiaisonHub(agencyId).
 */

import { listenForMessages, receiveLiaisonPong } from "./liaison-message-service.ts";
import { processAssistanceRequest } from "./liaison-watchdog.ts";
import { handleOfferDispatch } from "./offer-dispatch-handler.ts";
import { query } from "../postgres/pool.ts";
import type { LiaisonMessage } from "./liaison-message-types.ts";

// ─── Downlink: direct message to subagent ────────────────────────────────────

/**
 * Write a directive to the subagent via message_ledger.
 * trig_a2a_message_notify fires pg_notify('a2a_msg_{agentIdentity}')
 * which unblocks the agent's msg_read wait_ms call.
 */
export async function sendDirectiveToAgent(
  agentIdentity: string,
  directive: string,
  details?: Record<string, any>,
  correlationId?: string,
  replyTo?: string | number
): Promise<void> {
  await query(
    `INSERT INTO roadmap.message_ledger
        (from_agent, to_agent, message_content, message_type, metadata, correlation_id, reply_to)
     VALUES ('liaison', $1, $2, 'notify', $3, $4, $5)`,
    [
      agentIdentity,
      directive,
      JSON.stringify({ type: "directive", ...details }),
      correlationId ?? null,
      replyTo ?? null,
    ]
  );
}

// ─── Cross-project broadcast ──────────────────────────────────────────────────

/**
 * Broadcast a system event to the hiveCentral channel.
 * Listeners on a2a_chan_system:hiveCentral (e.g. orchestrators, monitors) receive it.
 */
export async function broadcastToHiveCentral(
  fromAgencyId: string,
  content: string,
  metadata?: Record<string, any>,
  correlationId?: string,
  replyTo?: string | number
): Promise<void> {
  await query(
    `INSERT INTO roadmap.message_ledger
        (from_agent, channel, message_content, message_type, metadata, correlation_id, reply_to)
     VALUES ($1, 'system:hiveCentral', $2, 'event', $3, $4, $5)`,
    [
      fromAgencyId,
      content,
      JSON.stringify(metadata ?? {}),
      correlationId ?? null,
      replyTo ?? null,
    ]
  );
}

// ─── Heartbeat liveness propagation ──────────────────────────────────────────

/**
 * Propagate a heartbeat event to the liaison channel and hiveCentral.
 * Called after liaisonHeartbeat() succeeds so orchestrators can react via pg_notify.
 */
export async function propagateHeartbeat(
  agencyId: string,
  status: string,
  dispatchable: boolean,
  correlationId?: string,
  replyTo?: string | number
): Promise<void> {
  try {
    await query(
      `INSERT INTO roadmap.message_ledger
          (from_agent, channel, message_content, message_type, metadata, correlation_id, reply_to)
       VALUES ($1, $2, 'heartbeat', 'event', $3, $4, $5)`,
      [
        agencyId,
        `system:liaison:${agencyId}`,
        JSON.stringify({ status, dispatchable, ts: new Date().toISOString() }),
        correlationId ?? null,
        replyTo ?? null,
      ]
    );
  } catch {
    // Non-critical — heartbeat DB update is authoritative; ledger mirror is advisory
  }
}

// ─── Message dispatch ─────────────────────────────────────────────────────────

async function dispatchMessage(msg: LiaisonMessage, agencyId: string): Promise<void> {
  switch (msg.kind) {
    case "assistance_request": {
      const p = msg.payload as Record<string, any>;
      const request = {
        id: BigInt(p.request_id ?? 0),
        briefing_id: String(p.briefing_id ?? ""),
        task_id: String(p.task_id ?? ""),
        error_signature: String(p.error_signature ?? ""),
        payload: p as any,
        opened_at: msg.created_at ? new Date(msg.created_at) : new Date(),
      };

      const action = await processAssistanceRequest(request, agencyId);

      // Auto-remediation → send directive downlink immediately
      if (
        action.type === "auto_remediation" &&
        p.agent_identity &&
        action.details?.directive
      ) {
        await sendDirectiveToAgent(
          String(p.agent_identity),
          String(action.details.directive),
          { request_id: String(request.id), source: "auto_remediation" }
        );
      }

      // Escalation → notify hiveCentral so cross-project observers can react
      if (action.type === "escalate") {
        await broadcastToHiveCentral(agencyId, `Assistance escalated: ${action.description}`, {
          request_id: String(request.id),
          severity: action.details?.severity,
          task_id: request.task_id,
        }).catch(() => undefined);
      }
      break;
    }

    case "liaison_pong":
      await receiveLiaisonPong(agencyId, String((msg.payload as any).nonce ?? ""));
      break;

    case "heartbeat":
      // Heartbeat from liaison itself — no hub action needed
      break;

    case "offer_dispatch":
      // P299-D: Orchestrator dispatched an offer to this agency. Fork the
      // CLI subprocess via spawnAgent and report the outcome via claim_status
      // uplink. The orchestrator owns the offer lifecycle (renewal +
      // completion); this handler only spawns and reports.
      await handleOfferDispatch(agencyId, msg);
      break;

    default:
      if (process.env.DEBUG_LIAISON_HUB) {
        console.log(`[LiaisonHub] ${agencyId}: unhandled kind='${msg.kind}' seq=${msg.sequence}`);
      }
  }
}

// ─── Hub lifecycle ───────────────────────────────────────────────────────────

/**
 * Start the liaison message dispatch loop for an agency.
 *
 * Listens on pg_notify channel 'liaison_message_<agencyId>' (fired by
 * trig_liaison_notify_new_message on liaison_message INSERT). Routes each
 * arriving message by kind to the appropriate handler.
 *
 * One hub per agency; call stop() on shutdown or agency de-registration.
 */
export function startLiaisonHub(agencyId: string): { stop: () => void } {
  const controller = new AbortController();
  let running = false;

  const run = async () => {
    running = true;
    if (process.env.DEBUG_LIAISON_HUB) {
      console.log(`[LiaisonHub] ${agencyId}: started`);
    }

    try {
      for await (const msg of listenForMessages(agencyId, controller.signal)) {
        try {
          await dispatchMessage(msg, agencyId);
        } catch (err) {
          console.error(`[LiaisonHub] ${agencyId}: dispatch error kind='${msg.kind}':`, err);
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        console.error(`[LiaisonHub] ${agencyId}: listener error:`, err);
      }
    } finally {
      running = false;
      if (process.env.DEBUG_LIAISON_HUB) {
        console.log(`[LiaisonHub] ${agencyId}: stopped`);
      }
    }
  };

  void run();

  return {
    stop: () => {
      controller.abort();
    },
  };
}
