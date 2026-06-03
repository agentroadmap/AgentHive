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

import { listenForMessages, receiveLiaisonPong, getUnackedMessages, acknowledgeMessage } from "./liaison-message-service.ts";
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

    case "progress_note":
      // AC-5: Structured progress update from an in-flight agent. Orchestrator
      // is mechanical — we record it as a hiveCentral event so monitors can
      // observe it, but no dispatch decision is made from it.
      broadcastToHiveCentral(agencyId, "progress_note", {
        briefing_id: (msg.payload as any).briefing_id,
        confidence: (msg.payload as any).confidence,
        summary_length: String((msg.payload as any).summary ?? "").length,
      }).catch(() => undefined);
      break;

    case "spawn_failure":
      // AC-5: Child process failed to start. Lifecycle is already governed by
      // fn_complete_work_offer('failed') in OfferDispatchHandler; we log it to
      // hiveCentral so operators can observe without grepping liaison logs.
      broadcastToHiveCentral(agencyId, "spawn_failure", {
        dispatch_id: (msg.payload as any).dispatch_id,
        offer_id: (msg.payload as any).offer_id,
        role: (msg.payload as any).role,
        error_message: (msg.payload as any).error_message,
      }).catch(() => undefined);
      break;

    case "capacity_alert":
      // AC-5: Back-pressure signal. No routing action here — provider_registry
      // throttle_count and in-flight capacity in resolveAgency() are the
      // authoritative back-pressure controls.
      broadcastToHiveCentral(agencyId, "capacity_alert", {
        in_flight_count: (msg.payload as any).in_flight_count,
        max_in_flight: (msg.payload as any).max_in_flight,
        utilization_pct: (msg.payload as any).utilization_pct,
        severity: (msg.payload as any).severity,
      }).catch(() => undefined);
      break;

    case "task_status":
    case "task_complete":
    case "task_error":
      // P993: Worker reporting back to liaison — update tracker and relay to requestor
      // These arrive via the liaison_message table from worker agents
      if (process.env.DEBUG_LIAISON_HUB) {
        console.log(`[LiaisonHub] ${agencyId}: worker report kind='${msg.kind}'`);
      }
      // No-op for now — handleWorkerReport is triggered via message_ledger listener
      break;

    default:
      if (process.env.DEBUG_LIAISON_HUB) {
        console.log(`[LiaisonHub] ${agencyId}: unhandled kind='${msg.kind}' seq=${msg.sequence}`);
      }
  }
}

// ─── Hub lifecycle ───────────────────────────────────────────────────────────

/**
 * Broadcast a heartbeat event to hiveCentral so orchestrators and monitors
 * can observe agency liveness without polling v_agency_status.
 */
export async function propagateHeartbeat(
  agencyId: string,
  agencyStatus: string,
  dispatchable: boolean,
): Promise<void> {
  await broadcastToHiveCentral(agencyId, "agency_heartbeat", {
    status: agencyStatus,
    dispatchable,
  }).catch(() => undefined);
}

/**
 * Start the liaison message dispatch loop for an agency.
 *
 * Listens on pg_notify channel 'msg_<agencyId>' (fired by
 * trig_liaison_notify_new_message on liaison_message INSERT). Routes each
 * arriving message by kind to the appropriate handler.
 *
 * One hub per agency; call stop() on shutdown or agency de-registration.
 */
export function startLiaisonHub(agencyId: string): { stop: () => void } {
  const controller = new AbortController();
  const processedIds = new Set<string>();

  const run = async () => {
    if (process.env.DEBUG_LIAISON_HUB) {
      console.log(`[LiaisonHub] ${agencyId}: started`);
    }

    // Boot-time replay: process any unacked messages missed while hub was down.
    try {
      const replayWindowHours = parseInt(
        process.env.LIAISON_REPLAY_WINDOW_HOURS ?? '6', 10
      );
      const createdAfter = new Date(Date.now() - replayWindowHours * 60 * 60 * 1000);
      const unacked = await getUnackedMessages(agencyId, undefined, createdAfter);
      if (unacked.length > 0) {
        console.log(`[LiaisonHub] ${agencyId}: replaying ${unacked.length} unacked message(s) (window=${replayWindowHours}h)`);
        for (const msg of unacked) {
          if (controller.signal.aborted) break;
          if (processedIds.has(msg.message_id)) continue;
          processedIds.add(msg.message_id);

          try {
            await dispatchMessage(msg, agencyId);
            await acknowledgeMessage(msg.message_id, 'ok');
          } catch (err) {
            console.error(`[LiaisonHub] ${agencyId}: replay error kind='${msg.kind}':`, err);
            await acknowledgeMessage(msg.message_id, 'reject', String(err)).catch(() => undefined);
          }
        }
      }
    } catch (err) {
      console.error(`[LiaisonHub] ${agencyId}: boot replay failed:`, err);
    }

    try {
      for await (const msg of listenForMessages(agencyId, controller.signal)) {
        if (processedIds.has(msg.message_id)) continue;
        processedIds.add(msg.message_id);

        // Skip already-acked messages (guard against replay+listen race window)
        if (msg.acked_at) continue;
        try {
          await dispatchMessage(msg, agencyId);
          await acknowledgeMessage(msg.message_id, 'ok');
        } catch (err) {
          console.error(`[LiaisonHub] ${agencyId}: dispatch error kind='${msg.kind}':`, err);
          await acknowledgeMessage(msg.message_id, 'reject', String(err)).catch(() => undefined);
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        console.error(`[LiaisonHub] ${agencyId}: listener error:`, err);
      }
    } finally {
      processedIds.clear();
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
