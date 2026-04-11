/**
 * Postgres proposal storage adapter for AgentHive.
 *
 * Mirrors the SDB proposal loader API but operates on the `proposal` and
 * `proposal_version` tables in the `agenthive` Postgres database.
 */
import { query } from './pool.ts';

export type ProposalRow = {
  id: number;
  display_id: string | null;
  parent_id: number | null;
  proposal_type: string;
  category: string | null;
  domain_id: string | null;
  title: string | null;
  body_markdown: string | null;
  body_embedding: string | null;
  process_logic: string | null;
  maturity_level: number;
  status: string;
  budget_limit_usd: number | null;
  tags: Record<string, any> | null;
  created_at: Date;
  updated_at: Date;
};

export type ProposalCreateInput = Omit<ProposalRow, 'id' | 'created_at' | 'updated_at'>;

/**
 * List proposals with optional filters.
 */
export async function listProposals(
  filters?: { status?: string; type?: string; domain_id?: string; maturity_min?: number },
): Promise<ProposalRow[]> {
  const clauses: string[] = [];
  const params: any[] = [];
  let idx = 1;

  if (filters?.status) {
    clauses.push(`status = $${idx++}`);
    params.push(filters.status);
  }
  if (filters?.type) {
    clauses.push(`proposal_type = $${idx++}`);
    params.push(filters.type);
  }
  if (filters?.domain_id) {
    clauses.push(`domain_id = $${idx++}`);
    params.push(filters.domain_id);
  }
  if (filters?.maturity_min !== undefined) {
    clauses.push(`maturity_level >= $${idx++}`);
    params.push(filters.maturity_min);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query<ProposalRow>(
    `SELECT * FROM proposal ${where} ORDER BY id ASC`,
    params,
  );
  return rows;
}

/**
 * Get a single proposal by ID or display_id.
 */
export async function getProposal(identifier: string | number): Promise<ProposalRow | null> {
  const { rows } = await query<ProposalRow>(
    `SELECT * FROM proposal WHERE id = $1 OR display_id = $1 LIMIT 1`,
    [typeof identifier === 'number' ? String(identifier) : identifier],
  );
  return rows[0] ?? null;
}

/**
 * Create a new proposal.
 */
export async function createProposal(input: ProposalCreateInput): Promise<ProposalRow> {
  const { rows } = await query<ProposalRow>(
    `INSERT INTO proposal (
      display_id, parent_id, proposal_type, category, domain_id,
      title, body_markdown, body_embedding, process_logic,
      maturity_level, status, budget_limit_usd, tags
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    RETURNING *`,
    [
      input.display_id,
      input.parent_id,
      input.proposal_type,
      input.category,
      input.domain_id,
      input.title,
      input.body_markdown,
      input.body_embedding,
      input.process_logic,
      input.maturity_level ?? 0,
      input.status ?? 'NEW',
      input.budget_limit_usd,
      input.tags ? JSON.stringify(input.tags) : null,
    ],
  );
  return rows[0];
}

/**
 * Update proposal fields.
 */
export async function updateProposal(
  id: number,
  updates: Partial<ProposalCreateInput>,
): Promise<ProposalRow | null> {
  const setClauses: string[] = [];
  const params: any[] = [];
  let idx = 1;

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      if (key === 'tags' && value) {
        setClauses.push(`${key} = $${idx}::jsonb`);
      } else {
        setClauses.push(`${key} = $${idx}`);
      }
      params.push(value);
      idx++;
    }
  }

  if (setClauses.length === 0) return null;

  setClauses.push(`updated_at = NOW()`);
  params.push(id);

  const { rows } = await query<ProposalRow>(
    `UPDATE proposal SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
    params,
  );
  return rows[0] ?? null;
}

/**
 * Transition proposal to a new status.
 */
export async function transitionProposal(
  id: number,
  newStatus: string,
  authorIdentity?: string,
  changeSummary?: string,
): Promise<ProposalRow | null> {
  return await query('BEGIN');
  try {
    const updated = await updateProposal(id, { status: newStatus });

    // Record version
    if (authorIdentity) {
      await query(
        `INSERT INTO proposal_version (proposal_id, author_identity, version_number, change_summary)
         SELECT $1, $2, COALESCE(MAX(version_number), 0) + 1, $3 FROM proposal_version WHERE proposal_id = $1`,
        [id, authorIdentity, changeSummary || `Status transitioned to ${newStatus}`],
      );
    }

    await query('COMMIT');
    return updated;
  } catch (err) {
    await query('ROLLBACK');
    throw err;
  }
}

/**
 * Delete a proposal and its versions.
 */
export async function deleteProposal(id: number): Promise<boolean> {
  await query('BEGIN');
  try {
    await query(`DELETE FROM proposal_version WHERE proposal_id = $1`, [id]);
    const { rowCount } = await query(`DELETE FROM proposal WHERE id = $1`, [id]);
    await query('COMMIT');
    return (rowCount ?? 0) > 0;
  } catch (err) {
    await query('ROLLBACK');
    throw err;
  }
}

/**
 * Search proposals by full-text against title + body_markdown.
 */
export async function searchProposals(queryText: string, limit?: number): Promise<ProposalRow[]> {
  const maxResults = limit ?? 10;
  const { rows } = await query<ProposalRow>(
    `SELECT * FROM proposal
     WHERE to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(body_markdown, ''))
           @@ plainto_tsquery('english', $1)
     ORDER BY maturity_level DESC, priority ASC, updated_at DESC
     LIMIT $2`,
    [queryText, maxResults],
  );
  return rows;
}

/**
 * Get proposal counts grouped by status.
 */
export async function proposalSummary(): Promise<{ status: string; count: number; total: number }[]> {
  const { rows } = await query<{ status: string; count: number }>(
    `SELECT status, COUNT(*)::int as count FROM proposal GROUP BY status ORDER BY status`,
  );
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  return rows.map(r => ({ ...r, total }));
}

/**
 * Get proposal versions (provenance trail).
 */
export async function getProposalVersions(proposalId: number): Promise<any[]> {
  const { rows } = await query(
    `SELECT * FROM proposal_version WHERE proposal_id = $1 ORDER BY version_number ASC`,
    [proposalId],
  );
  return rows;
}
