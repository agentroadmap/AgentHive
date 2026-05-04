/**
 * P468: Lease renewal protocol for non-stuck agents needing more time.
 *
 * Max 3 renewals per briefing:
 *   - Renewals 1 & 2: auto-approved by Liaison (extends lease 30 min)
 *   - Renewal 3: forwarded to operator for manual approval
 */

import { query } from "../../postgres/pool.ts";
import { sendMessage } from "./liaison-message-service.ts";

export interface LeaseRenewalResult {
  renewal_id: bigint;
  approved: boolean;
  renewal_count: number;
  new_expires_at: string | null;
  message: string;
}

/**
 * Request a lease renewal for a non-stuck agent.
 * Called by the subagent via the `request_lease_renewal` MCP action.
 */
export async function requestLeaseRenewal(
  briefing_id: string,
  agency_id: string,
  reason: string,
  proposal_id?: bigint
): Promise<LeaseRenewalResult> {
  // Count prior renewals for this briefing
  const countResult = await query<{ cnt: string | number }>(
    `SELECT count(*) AS cnt FROM roadmap.proposal_lease_renewal
     WHERE briefing_id = $1 AND status IN ('approved', 'pending')`,
    [briefing_id]
  );
  const priorCount =
    typeof countResult.rows[0]?.cnt === "string"
      ? parseInt(countResult.rows[0].cnt, 10)
      : (countResult.rows[0]?.cnt ?? 0);

  const renewal_count = priorCount + 1;

  if (renewal_count > 3) {
    return {
      renewal_id: BigInt(0),
      approved: false,
      renewal_count: priorCount,
      new_expires_at: null,
      message: "Maximum renewal limit (3) reached. Operator intervention required.",
    };
  }

  // Auto-approve for renewals 1 & 2; forward to operator for renewal 3
  const autoApprove = renewal_count <= 2;
  const status = autoApprove ? "approved" : "pending";
  const approved_by = autoApprove ? "liaison" : null;
  const extension = autoApprove ? "interval '30 minutes'" : null;

  let new_expires_at: string | null = null;

  if (autoApprove) {
    // Extend the proposal_lease via agent_identity lookup through assistance_request,
    // or directly via proposal_id if provided.
    const updateResult = await query<{ expires_at: Date }>(
      proposal_id
        ? `UPDATE roadmap_proposal.proposal_lease
           SET expires_at = GREATEST(COALESCE(expires_at, now()), now()) + interval '30 minutes'
           WHERE proposal_id = $1 AND released_at IS NULL
           RETURNING expires_at`
        : `UPDATE roadmap_proposal.proposal_lease
           SET expires_at = GREATEST(COALESCE(expires_at, now()), now()) + interval '30 minutes'
           WHERE agent_identity = (
             SELECT agent_identity FROM roadmap.assistance_request
             WHERE briefing_id = $1::uuid
             ORDER BY opened_at DESC LIMIT 1
           )
           AND released_at IS NULL
           RETURNING expires_at`,
      [proposal_id ?? briefing_id]
    );
    new_expires_at = updateResult.rows[0]?.expires_at?.toISOString() ?? null;
  }

  // Insert renewal record
  const insertResult = await query<{ id: bigint; new_expires_at: Date | null }>(
    `INSERT INTO roadmap.proposal_lease_renewal
       (briefing_id, proposal_id, agency_id, renewal_count, reason, status, approved_by,
        resolved_at, new_expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7,
       CASE WHEN $6 = 'approved' THEN now() ELSE NULL END,
       $8)
     RETURNING id, new_expires_at`,
    [
      briefing_id,
      proposal_id ?? null,
      agency_id,
      renewal_count,
      reason,
      status,
      approved_by,
      new_expires_at,
    ]
  );

  const renewal_id = insertResult.rows[0]!.id;

  if (!autoApprove) {
    // Notify operator for manual decision
    await notifyOperatorForRenewal(agency_id, briefing_id, renewal_id, renewal_count, reason);
  }

  return {
    renewal_id,
    approved: autoApprove,
    renewal_count,
    new_expires_at,
    message: autoApprove
      ? `Lease renewed (${renewal_count}/3). New expiry: ${new_expires_at ?? "unchanged"}.`
      : `Renewal ${renewal_count}/3 requires operator approval. Request submitted (ID: ${renewal_id}).`,
  };
}

/**
 * Operator or Liaison resolves a pending renewal request.
 */
export async function resolveLeaseRenewal(
  renewal_id: bigint,
  approved: boolean,
  operator: string
): Promise<void> {
  if (!approved) {
    await query(
      `UPDATE roadmap.proposal_lease_renewal
       SET status = 'denied', approved_by = $1, resolved_at = now()
       WHERE id = $2 AND status = 'pending'`,
      [operator, renewal_id]
    );
    return;
  }

  // Look up the briefing to extend the lease
  const renewalResult = await query<{
    briefing_id: string;
    proposal_id: bigint | null;
    agency_id: string;
  }>(
    `SELECT briefing_id, proposal_id, agency_id
     FROM roadmap.proposal_lease_renewal WHERE id = $1`,
    [renewal_id]
  );
  const renewal = renewalResult.rows[0];
  if (!renewal) return;

  const updateResult = await query<{ expires_at: Date }>(
    renewal.proposal_id
      ? `UPDATE roadmap_proposal.proposal_lease
         SET expires_at = GREATEST(COALESCE(expires_at, now()), now()) + interval '30 minutes'
         WHERE proposal_id = $1 AND released_at IS NULL
         RETURNING expires_at`
      : `UPDATE roadmap_proposal.proposal_lease
         SET expires_at = GREATEST(COALESCE(expires_at, now()), now()) + interval '30 minutes'
         WHERE agent_identity = (
           SELECT agent_identity FROM roadmap.assistance_request
           WHERE briefing_id = $1::uuid
           ORDER BY opened_at DESC LIMIT 1
         )
         AND released_at IS NULL
         RETURNING expires_at`,
    [renewal.proposal_id ?? renewal.briefing_id]
  );

  const new_expires_at = updateResult.rows[0]?.expires_at?.toISOString() ?? null;

  await query(
    `UPDATE roadmap.proposal_lease_renewal
     SET status = 'approved', approved_by = $1, resolved_at = now(), new_expires_at = $2
     WHERE id = $3 AND status = 'pending'`,
    [operator, new_expires_at, renewal_id]
  );

  // Notify agent that renewal was approved
  try {
    await sendMessage({
      agency_id: renewal.agency_id,
      direction: "liaison->orchestrator",
      kind: "lease_renewal_approved",
      payload: {
        renewal_id: String(renewal_id),
        briefing_id: renewal.briefing_id,
        new_expires_at,
        approved_by: operator,
      },
    });
  } catch {
    // Best-effort
  }
}

async function notifyOperatorForRenewal(
  agency_id: string,
  briefing_id: string,
  renewal_id: bigint,
  renewal_count: number,
  reason: string
): Promise<void> {
  try {
    await query(
      `INSERT INTO roadmap.message_ledger
          (from_agent, channel, message_content, message_type, metadata)
       VALUES ($1, 'system:operator', $2, 'alert', $3)`,
      [
        agency_id,
        `Lease renewal request ${renewal_count}/3 for briefing ${briefing_id}: ${reason}`,
        JSON.stringify({
          kind: "lease_renewal_request",
          renewal_id: String(renewal_id),
          briefing_id,
          renewal_count,
          reason,
          agency_id,
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
        type: "lease_renewal_request",
        renewal_id: String(renewal_id),
        briefing_id,
        renewal_count,
        agency_id,
        reason,
        ts: new Date().toISOString(),
      }),
    }).catch(() => undefined);
  }
}
