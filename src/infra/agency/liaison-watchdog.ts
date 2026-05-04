/**
 * P467/P466/P475: Liaison watchdog — runaway detection, fallback playbook,
 * provider-aware termination, and operator escalation.
 */

import { query } from "../../postgres/pool.ts";
import {
  getOpenAssistanceRequests,
  updateAssistanceRequest,
  type AssistancePayload,
} from "./stuck-detection.ts";

// ─── Provider termination specs ───────────────────────────────────────────────

export interface ProviderTerminationSpec {
  signal: "SIGTERM" | "SIGKILL";
  grace_ms: number;
  respawn_strategy: "worktree" | "requeue" | "cooldown";
}

const PROVIDER_TERMINATION: Record<string, ProviderTerminationSpec> = {
  anthropic: { signal: "SIGTERM", grace_ms: 5000, respawn_strategy: "worktree" },
  openai:    { signal: "SIGKILL", grace_ms: 0,    respawn_strategy: "requeue"  },
  hermes:    { signal: "SIGTERM", grace_ms: 5000, respawn_strategy: "worktree" },
  gemini:    { signal: "SIGTERM", grace_ms: 5000, respawn_strategy: "cooldown" },
  copilot:   { signal: "SIGTERM", grace_ms: 5000, respawn_strategy: "cooldown" },
};

export function resolveTerminationSpec(provider: string): ProviderTerminationSpec {
  return PROVIDER_TERMINATION[provider.toLowerCase()] ?? PROVIDER_TERMINATION.anthropic!;
}

// ─── Fallback playbook ────────────────────────────────────────────────────────

export interface FallbackPlaybookEntry {
  error_signature: string;
  error_pattern: string;
  remediation_directive: string;
  confidence: number;
}

/**
 * Check the fallback playbook for automatic remediation.
 * Tries exact error_signature match first, then error_class match.
 * Agency-specific entries take precedence over global ones.
 */
export async function checkFallbackPlaybook(
  error_signature: string,
  error_class?: string,
  agency_id?: string
): Promise<FallbackPlaybookEntry | null> {
  const result = await query<{
    error_signature: string | null;
    error_class: string | null;
    directive: string;
    confidence: number | string;
  }>(
    `SELECT error_signature, error_class, directive, confidence
     FROM roadmap.fallback_playbook
     WHERE ($1::text IS NOT NULL AND error_signature = $1)
        OR ($2::text IS NOT NULL AND error_class = $2)
     ORDER BY
       (agency_id = $3 OR ($3::text IS NULL AND agency_id IS NULL)) DESC,
       (error_signature IS NOT NULL) DESC,
       confidence DESC
     LIMIT 1`,
    [error_signature, error_class ?? null, agency_id ?? null]
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    error_signature: row.error_signature ?? error_signature,
    error_pattern: row.error_class ?? "",
    remediation_directive: row.directive,
    confidence: typeof row.confidence === "string" ? parseFloat(row.confidence) : row.confidence,
  };
}

// ─── Operator notification ────────────────────────────────────────────────────

async function notifyOperator(
  agency_id: string,
  request_id: bigint,
  severity: "soft" | "hard" | "runaway",
  details: Record<string, any>
): Promise<void> {
  try {
    await query(
      `INSERT INTO roadmap.message_ledger
          (from_agent, channel, message_content, message_type, metadata)
       VALUES ($1, 'system:operator', $2, 'alert', $3)`,
      [
        agency_id,
        `Liaison escalation [${severity.toUpperCase()}]: request ${request_id} — ${details.task_id ?? "unknown task"}`,
        JSON.stringify({
          kind: "operator_escalation",
          request_id: String(request_id),
          severity,
          agency_id,
          ...details,
        }),
      ]
    );
  } catch {
    // Best-effort
  }

  const webhookUrl = process.env.OPERATOR_WEBHOOK_URL;
  if (webhookUrl) {
    fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "operator_escalation",
        agency_id,
        request_id: String(request_id),
        severity,
        ...details,
        ts: new Date().toISOString(),
      }),
    }).catch(() => undefined);
  }
}

// ─── WatchdogAction ───────────────────────────────────────────────────────────

export interface WatchdogAction {
  type: "auto_remediation" | "respawn" | "reassign" | "escalate" | "abandoned";
  request_id: bigint;
  description: string;
  details?: Record<string, any>;
}

// ─── Core processing ──────────────────────────────────────────────────────────

/**
 * Process a single assistance request.
 * Escalation ladder:
 *   1. checkFallbackPlaybook → auto_remediation if match
 *   2. hard severity → operator escalation immediately
 *   3. soft severity → operator escalation (respawn logic is P475 TODO)
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
    const errorClass = request.payload.error_history?.at(-1)?.error_class;
    const fallback = await checkFallbackPlaybook(
      request.error_signature,
      errorClass,
      agency_id
    );

    if (fallback) {
      await updateAssistanceRequest(request.id, "resolved", {
        resolution_path: "automatic_remediation",
        fallback_directive: fallback.remediation_directive,
        confidence: fallback.confidence,
      });

      return {
        type: "auto_remediation",
        request_id: request.id,
        description: `Applied fallback remediation for '${request.error_signature}'`,
        details: {
          directive: fallback.remediation_directive,
          confidence: fallback.confidence,
        },
      };
    }
  }

  // Step 2: No playbook match — escalate based on severity
  const severity = request.payload.blocker_severity;

  await updateAssistanceRequest(request.id, "escalated", {
    resolution_path: "operator_escalation",
    severity,
    reason: severity === "hard"
      ? "Hard-stop budget exceeded or unrecoverable error"
      : "No automatic remediation found; manual intervention needed",
  });

  await notifyOperator(agency_id, request.id, severity, {
    task_id: request.task_id,
    error_signature: request.error_signature,
    current_state: request.payload.current_state_summary,
    what_i_tried: request.payload.what_i_tried,
    what_might_help: request.payload.what_might_help,
  });

  return {
    type: "escalate",
    request_id: request.id,
    description: `Escalated ${severity} blocker to operator (no playbook match)`,
    details: {
      severity,
      error_signature: request.error_signature,
      task_id: request.task_id,
    },
  };
}

// ─── Watchdog loop ────────────────────────────────────────────────────────────

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
      console.error(`[Watchdog] Error processing assistance request ${request.id}:`, error);
      await updateAssistanceRequest(request.id, "abandoned", { error: String(error) });
      actions.push({
        type: "abandoned",
        request_id: request.id,
        description: `Processing error: ${String(error)}`,
      });
    }
  }

  return actions;
}

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
          console.log(`[Watchdog] ${agency_id}: processed ${actions.length} requests`);
          for (const action of actions) {
            console.log(`  - ${action.type}: ${action.description}`);
          }
        }
      } catch (error) {
        console.error(`[Watchdog] ${agency_id} cycle error:`, error);
      }
      await new Promise((resolve) => setTimeout(resolve, poll_interval_ms));
    }
  };

  void loop();
  return () => { running = false; };
}
