/**
 * P230: Context Package Builder
 *
 * Assembles a proposal-scoped context package for agent dispatch.
 * Caches the result in roadmap_efficiency.context_packages; invalidated
 * automatically by DB triggers when the proposal status or any AC changes.
 *
 * Saves ~500 tokens per dispatch vs injecting the full CLAUDE.md every time.
 */

import { query } from "../postgres/pool.ts";

export type PackageType =
  | "gate_review"
  | "code_gen"
  | "research"
  | "review"
  | "test_writing";

export interface ContextPackageRequest {
  proposal_id: bigint;
  package_type: PackageType;
  team_name?: string;
  agent_identity?: string;
}

export interface ContextPackage {
  proposal_id: bigint;
  package_type: PackageType;
  context_text: string;
  token_count: number;
  from_cache: boolean;
}

/**
 * Build (or return cached) context package for the given proposal.
 * Fetches: proposal summary+design, pending ACs, team decisions, and
 * optional team memory. Stores result in context_packages for reuse.
 */
export async function buildContextPackage(
  req: ContextPackageRequest,
): Promise<ContextPackage> {
  // Try cache first (triggers handle invalidation on status/AC change)
  const { rows: cached } = await query<{
    context_text: string;
    token_count: number;
  }>(
    `UPDATE roadmap_efficiency.context_packages
     SET hit_count = hit_count + 1
     WHERE proposal_id = $1
       AND package_type = $2
       AND (expires_at IS NULL OR expires_at > now())
     RETURNING context_text, token_count`,
    [req.proposal_id, req.package_type],
  );

  if (cached[0]) {
    return {
      proposal_id: req.proposal_id,
      package_type: req.package_type,
      context_text: cached[0].context_text,
      token_count: cached[0].token_count ?? 0,
      from_cache: true,
    };
  }

  // Build fresh package
  const parts: string[] = [];

  // 1. Proposal header
  const { rows: propRows } = await query<{
    title: string;
    status: string;
    summary: string | null;
    design: string | null;
  }>(
    `SELECT title, status, summary, design
     FROM roadmap_proposal.proposal
     WHERE id = $1`,
    [req.proposal_id],
  );

  if (propRows[0]) {
    const p = propRows[0];
    parts.push(`## Proposal P${req.proposal_id}: ${p.title}`);
    parts.push(`**Status:** ${p.status}`);
    if (p.summary) parts.push(`**Summary:** ${p.summary}`);
    if (p.design) parts.push(`### Design\n${p.design}`);
  }

  // 2. Pending acceptance criteria
  const { rows: acRows } = await query<{
    item_number: number;
    criterion_text: string;
    status: string;
  }>(
    `SELECT item_number, criterion_text, status
     FROM roadmap_proposal.proposal_acceptance_criteria
     WHERE proposal_id = $1
       AND status NOT IN ('pass', 'waived')
     ORDER BY item_number`,
    [req.proposal_id],
  );

  if (acRows.length) {
    const acLines = acRows.map(
      (ac) => `- AC-${ac.item_number} [${ac.status}]: ${ac.criterion_text}`,
    );
    parts.push(`### Pending Acceptance Criteria\n${acLines.join("\n")}`);
  }

  // 3. Team decisions (if team_name supplied)
  if (req.team_name) {
    const { rows: teamRows } = await query<{
      memory_key: string;
      memory_value: unknown;
    }>(
      `SELECT memory_key, memory_value
       FROM roadmap_efficiency.team_memory
       WHERE team_name = $1
         AND (expires_at IS NULL OR expires_at > now())
       ORDER BY updated_at DESC
       LIMIT 10`,
      [req.team_name],
    );

    if (teamRows.length) {
      const teamLines = teamRows.map(
        (r) => `- ${r.memory_key}: ${JSON.stringify(r.memory_value)}`,
      );
      parts.push(`### Team Decisions (${req.team_name})\n${teamLines.join("\n")}`);
    }
  }

  const context_text = parts.join("\n\n");
  // Rough estimate: 1 token ≈ 4 chars
  const token_count = Math.ceil(context_text.length / 4);

  // Upsert into cache
  await query(
    `INSERT INTO roadmap_efficiency.context_packages
       (proposal_id, package_type, context_text, token_count, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (proposal_id, package_type)
     DO UPDATE SET
       context_text = EXCLUDED.context_text,
       token_count  = EXCLUDED.token_count,
       created_by   = EXCLUDED.created_by,
       hit_count    = roadmap_efficiency.context_packages.hit_count + 1,
       created_at   = now()`,
    [
      req.proposal_id,
      req.package_type,
      context_text,
      token_count,
      req.agent_identity ?? "system",
    ],
  );

  return {
    proposal_id: req.proposal_id,
    package_type: req.package_type,
    context_text,
    token_count,
    from_cache: false,
  };
}
