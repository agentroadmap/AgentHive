/**
 * P467: Liaison watchdog loop
 *
 * Subscribes to rescue:<agency_id> channels and processes assistance requests.
 * Implements auto-remediation, re-spawn, reassignment, and escalation logic.
 */

import { query } from "../../postgres/pool.ts";
import {
  getOpenAssistanceRequests,
  updateAssistanceRequest,
  type AssistancePayload,
} from "./stuck-detection.ts";

export interface FallbackPlaybookEntry {
  error_signature: string;
  error_pattern: string;
  remediation_directive: string;
  confidence: number;
}

export interface WatchdogAction {
  type: "auto_remediation" | "respawn" | "reassign" | "escalate" | "abandoned";
  request_id: bigint;
  description: string;
  details?: Record<string, any>;
}

/**
 * Check fallback playbook for automatic remediation of an error signature.
 * Returns matching entry if found, null otherwise.
 */
export async function checkFallbackPlaybook(
  error_signature: string
): Promise<FallbackPlaybookEntry | null> {
  // TODO(P466): Implement fallback_playbook table integration
  // For now, return null to fall through to manual remediation
  return null;
}

/**
 * Process a single assistance request.
 * Attempts automatic remediation; if not found, escalates to operator.
 */
export async function processAssistanceRequest(
  request: {
    id: bigint;
    briefing_id: string;
    task_id: string;
    error_signature: string;
    payload: AssistancePayload;
    opened_at: Date;
  },
  agency_id: string
): Promise<WatchdogAction> {
  // Step 1: Try automatic remediation via fallback_playbook
  if (request.error_signature && request.error_signature !== "hard-stop-budget") {
    const fallback = await checkFallbackPlaybook(request.error_signature);
    if (fallback) {
      // TODO(P475): Wire MCP action to send assistance_resolve directive
      await updateAssistanceRequest(request.id, "resolved", {
        resolution_path: "automatic_remediation",
        fallback_directive: fallback.remediation_directive,
        confidence: fallback.confidence,
      });

      return {
        type: "auto_remediation",
        request_id: request.id,
        description: `Applied fallback remediation for error signature ${request.error_signature}`,
        details: {
          directive: fallback.remediation_directive,
          confidence: fallback.confidence,
        },
      };
    }
  }

  // Step 2: Hard-stop budget or no automatic match → escalate
  const blocker_severity = request.payload.blocker_severity;

  if (blocker_severity === "hard") {
    // Hard-stop: escalate to operator immediately
    // TODO(P475): Wire MCP action to post to operator channel
    await updateAssistanceRequest(request.id, "escalated", {
      resolution_path: "operator_escalation",
      severity: "hard",
      reason: "Hard-stop budget exceeded",
    });

    return {
      type: "escalate",
      request_id: request.id,
      description: `Escalated hard-stop budget violation to operator`,
      details: {
        severity: "hard",
        task_id: request.task_id,
        current_state: request.payload.current_state_summary,
      },
    };
  }

  // Soft blocker: attempt re-spawn with updated briefing or reassign
  // TODO(P475): Implement re-spawn with model switch / memory augmentation
  // For now, escalate to operator
  await updateAssistanceRequest(request.id, "escalated", {
    resolution_path: "operator_escalation",
    severity: "soft",
    reason: "Automatic remediation not found; manual intervention needed",
  });

  return {
    type: "escalate",
    request_id: request.id,
    description: `Escalated soft blocker (error signature not in playbook) to operator`,
    details: {
      severity: "soft",
      error_signature: request.error_signature,
      task_id: request.task_id,
    },
  };
}

/**
 * Watchdog loop: poll for open assistance requests and process them.
 * Returns array of actions taken.
 */
export async function runWatchdogCycle(
  agency_id: string
): Promise<WatchdogAction[]> {
  const openRequests = await getOpenAssistanceRequests(agency_id);

  const actions: WatchdogAction[] = [];
  for (const request of openRequests) {
    try {
      const action = await processAssistanceRequest(request, agency_id);
      actions.push(action);
    } catch (error) {
      console.error(
        `[Watchdog] Error processing assistance request ${request.id}:`,
        error
      );
      // Mark as abandoned on processing error
      await updateAssistanceRequest(request.id, "abandoned", {
        error: String(error),
      });
      actions.push({
        type: "abandoned",
        request_id: request.id,
        description: `Processing error: ${String(error)}`,
      });
    }
  }

  return actions;
}

/**
 * Start watchdog loop for an agency (runs continuously in background).
 * Polls every poll_interval_ms and calls runWatchdogCycle.
 */
export function startWatchdogLoop(
  agency_id: string,
  poll_interval_ms: number = 5000
): () => void {
  let running = true;

  const loop = async () => {
    while (running) {
      try {
        const actions = await runWatchdogCycle(agency_id);
        if (actions.length > 0 && process.env.DEBUG_WATCHDOG) {
          console.log(
            `[Watchdog] ${agency_id}: Processed ${actions.length} assistance requests`
          );
          for (const action of actions) {
            console.log(`  - ${action.type}: ${action.description}`);
          }
        }
      } catch (error) {
        console.error(`[Watchdog] ${agency_id} cycle error:`, error);
      }

      // Sleep until next cycle
      await new Promise((resolve) => setTimeout(resolve, poll_interval_ms));
    }
  };

  // Start loop in background
  void loop();

  // Return stop function
  return () => {
    running = false;
  };
}
