/**
 * P230: Context Package Builder
 *
 * Builds a targeted, token-efficient context slice for a proposal dispatch:
 *   proposal header + pending ACs + team decisions + gate history
 *
 * Results are cached in roadmap_efficiency.context_packages and invalidated
 * automatically by DB triggers on proposals.status and acceptance_criteria.status.
 */

import { query } from "../postgres/pool.js";

export type PackageType =
  | "gate_review"
  | "code_gen"
  | "research"
  | "review"
  | "test_writing";

export interface ContextPackageRequest {
  proposal_id: bigint | number;
  package_type: PackageType;
  agent_id?: string;
  team_name?: string;
}

/**
 * Build (or return cached) a context package for a proposal.
 * Returns empty string and logs on error — never throws (non-fatal).
 */
export async function buildContextPackage(
  req: ContextPackageRequest,
): Promise<string> {
  try {
    return await _buildContextPackage(req);
  } catch (err) {
    console.warn(
      `[context_builder] buildContextPackage failed for proposal ${req.proposal_id}:`,
      err,
    );
    return "";
  }
}

async function _buildContextPackage(
  req: ContextPackageRequest,
): Promise<string> {
  const { rows: cached } = await query<{ context_text: string }>(
    `SELECT context_text
     FROM roadmap_efficiency.context_packages
     WHERE proposal_id = $1
       AND package_type = $2
       AND (expires_at IS NULL OR expires_at > now())`,
    [req.proposal_id, req.package_type],
  );

  if (cached.length) {
    await query(
      `UPDATE roadmap_efficiency.context_packages
       SET hit_count = hit_count + 1
       WHERE proposal_id = $1 AND package_type = $2`,
      [req.proposal_id, req.package_type],
    );
    return cached[0].context_text;
  }

  const parts: string[] = [];

  const { rows: proposals } = await query<{
    display_id: string;
    title: string;
    status: string;
    maturity: string;
    summary: string | null;
  }>(
    `SELECT display_id, title, status, maturity, summary
     FROM proposal
     WHERE id = $1`,
    [req.proposal_id],
  );

  if (proposals.length) {
    const p = proposals[0];
    parts.push(
      `# P${p.display_id}: ${p.title}\nStatus: ${p.status} | Maturity: ${p.maturity}${p.summary ? `\n${p.summary}` : ""}`,
    );
  }

  const { rows: acs } = await query<{ criterion_text: string }>(
    `SELECT criterion_text
     FROM proposal_acceptance_criteria
     WHERE proposal_id = $1
       AND status IN ('pending', 'blocked')
     ORDER BY item_number`,
    [req.proposal_id],
  );

  if (acs.length) {
    parts.push(
      `## Pending ACs\n${acs.map((r, i) => `AC-${i + 1}: ${r.criterion_text}`).join("\n")}`,
    );
  }

  if (req.team_name) {
    const { rows: tm } = await query<{
      memory_key: string;
      memory_value: unknown;
    }>(
      `SELECT memory_key, memory_value
       FROM roadmap_efficiency.team_memory
       WHERE team_name = $1
         AND (expires_at IS NULL OR expires_at > now())
       ORDER BY updated_at DESC
       LIMIT 5`,
      [req.team_name],
    );
    if (tm.length) {
      parts.push(
        `## Team Decisions\n${tm.map((r) => `- ${r.memory_key}: ${JSON.stringify(r.memory_value)}`).join("\n")}`,
      );
    }
  }

  const { rows: gates } = await query<{
    rationale: string | null;
    decided_by: string | null;
  }>(
    `SELECT rationale, decided_by
     FROM roadmap.gate_decision_log
     WHERE proposal_id = $1
     ORDER BY created_at DESC
     LIMIT 3`,
    [req.proposal_id],
  );

  if (gates.length) {
    parts.push(
      `## Gate History\n${gates.map((r) => `- ${r.decided_by ?? "unknown"}: ${r.rationale ?? ""}`).join("\n")}`,
    );
  }

  const MAX_CHARS = 8000; // ~2000 tokens @ 4 chars/token
  const rawContext = parts.join("\n\n");
  const context =
    rawContext.length > MAX_CHARS
      ? rawContext.slice(0, MAX_CHARS - 3) + "..."
      : rawContext;
  const tokenCount = Math.ceil(context.length / 4);

  await query(
    `INSERT INTO roadmap_efficiency.context_packages
       (proposal_id, package_type, context_text, token_count, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (proposal_id, package_type)
     DO UPDATE SET
       context_text = EXCLUDED.context_text,
       token_count  = EXCLUDED.token_count,
       hit_count    = 0,
       created_by   = EXCLUDED.created_by`,
    [
      req.proposal_id,
      req.package_type,
      context,
      tokenCount,
      req.agent_id ?? null,
    ],
  );

  return context;
}
