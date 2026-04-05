/**
 * Postgres-backed Proposal CRUD MCP Tools for AgentHive.
 *
 * Implements basic proposal management on the universal `proposal` table.
 * Covers create, read, update, delete, list, and search operations.
 *
 * Matches live schema on agenthive DB (verified 2026-04-04):
 * - proposal (26 columns, universal entity, workflow_name FK)
 * - proposal_valid_transitions (state machine rules)
 */
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";
import { query } from "../../../postgres/pool.ts";

function errorResult(msg: string, err: unknown): CallToolResult {
  return {
    content: [{
      type: "text",
      text: `⚠️ ${msg}: ${err instanceof Error ? err.message : String(err)}`
    }]
  };
}

/** Generate next display_id (e.g., P033) */
async function nextDisplayId(): Promise<string> {
  const { rows } = await query(
    "SELECT COALESCE(MAX(CAST(SUBSTRING(display_id FROM 2) AS integer)), 0) as max_id FROM proposal"
  );
  const next = (rows[0].max_id || 0) + 1;
  return `P${String(next).padStart(3, '0')}`;
}

// ─── CREATE ─────────────────────────────────────────────────────────────────

export async function createProposal(args: {
  title: string;
  proposal_type?: string;
  category?: string;
  domain_id?: string;
  body_markdown?: string;
  parent_id?: string;
  workflow_name?: string;
  priority?: number;
  tags?: string[];
  created_by?: string;
}): Promise<CallToolResult> {
  try {
    const displayId = await nextDisplayId();
    const proposalType = args.proposal_type || 'RFC';
    const workflowName = args.workflow_name || 'RFC 5-Stage';
    const priority = args.priority ?? 5;

    const { rows } = await query(
      `INSERT INTO proposal (display_id, title, proposal_type, category, domain_id,
         body_markdown, parent_id, workflow_name, priority, status, maturity_level,
         created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6,
         (SELECT id FROM proposal WHERE display_id = $7), $8, $9, 'DRAFT', 0,
         NOW(), NOW())
       RETURNING id, display_id`,
      [displayId, args.title, proposalType, args.category || null, args.domain_id || null,
       args.body_markdown || null, args.parent_id || null, workflowName, priority]
    );

    let result = `✅ Created ${displayId}: "${args.title}"\nType: ${proposalType} | Workflow: ${workflowName} | Priority: ${priority}`;
    if (args.created_by) {
      result += `\nBy: ${args.created_by}`;
    }

    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    return errorResult("Failed to create proposal", err);
  }
}

// ─── READ ───────────────────────────────────────────────────────────────────

export async function getProposal(args: {
  proposal_id: string;
}): Promise<CallToolResult> {
  try {
    const { rows } = await query(
      `SELECT display_id, title, proposal_type, category, domain_id,
              body_markdown, status, maturity_level, priority, workflow_name,
              parent_id, budget_limit_usd, tags,
              accepted_criteria_count, required_criteria_count, blocked_by_dependencies,
              created_at, updated_at
       FROM proposal
       WHERE display_id = $1 OR id = $1::bigint`,
      [args.proposal_id]
    );

    if (!rows.length) {
      return { content: [{ type: "text", text: `Proposal "${args.proposal_id}" not found.` }] };
    }

    const p = rows[0];
    const maturityNames = ['New', 'Active', 'Mature', 'Obsolete'];

    let details = `### ${p.display_id}: ${p.title}\n`;
    details += `- **Type**: ${p.proposal_type} | **Status**: ${p.status} | **Maturity**: ${p.maturity_level} (${maturityNames[p.maturity_level] || '?'})\n`;
    details += `- **Priority**: ${p.priority} | **Workflow**: ${p.workflow_name}\n`;
    if (p.category) details += `- **Category**: ${p.category}\n`;
    if (p.domain_id) details += `- **Domain**: ${p.domain_id}\n`;
    if (p.parent_id) details += `- **Parent**: proposal ID ${p.parent_id}\n`;
    if (p.budget_limit_usd) details += `- **Budget**: $${p.budget_limit_usd}\n`;
    if (p.tags) details += `- **Tags**: ${JSON.stringify(p.tags)}\n`;
    details += `- **AC**: ${p.accepted_criteria_count || 0}/${p.required_criteria_count || 0} accepted`;
    if (p.blocked_by_dependencies) details += ` | ⛔ blocked by deps`;
    details += `\n- **Created**: ${p.created_at?.toISOString?.() || p.created_at} | **Updated**: ${p.updated_at?.toISOString?.() || p.updated_at}\n`;
    if (p.body_markdown) {
      details += `\n---\n${p.body_markdown.substring(0, 2000)}${p.body_markdown.length > 2000 ? '\n... (truncated)' : ''}`;
    }

    return { content: [{ type: "text", text: details }] };
  } catch (err) {
    return errorResult("Failed to get proposal", err);
  }
}

// ─── LIST ───────────────────────────────────────────────────────────────────

export async function listProposals(args: {
  status?: string;
  proposal_type?: string;
  workflow_name?: string;
  maturity_level?: number;
  limit?: number;
  offset?: number;
}): Promise<CallToolResult> {
  try {
    const limit = args.limit ?? 20;
    const offset = args.offset ?? 0;

    let sql = `SELECT display_id, title, proposal_type, status, maturity_level, priority, workflow_name, created_at
               FROM proposal WHERE 1=1`;
    const params: any[] = [];
    let paramIdx = 1;

    if (args.status) {
      sql += ` AND status = $${paramIdx++}`;
      params.push(args.status.toUpperCase());
    }
    if (args.proposal_type) {
      sql += ` AND proposal_type = $${paramIdx++}`;
      params.push(args.proposal_type);
    }
    if (args.workflow_name) {
      sql += ` AND workflow_name = $${paramIdx++}`;
      params.push(args.workflow_name);
    }
    if (args.maturity_level !== undefined) {
      sql += ` AND maturity_level = $${paramIdx++}`;
      params.push(args.maturity_level);
    }

    sql += ` ORDER BY maturity_level DESC, priority ASC, created_at DESC`;
    sql += ` LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
    params.push(limit, offset);

    const { rows } = await query(sql, params);

    if (!rows.length) {
      return { content: [{ type: "text", text: `No proposals found${args.status ? ` with status ${args.status}` : ''}.` }] };
    }

    const maturityNames = ['New', 'Active', 'Mature', 'Obsolete'];
    const lines = rows.map((r) =>
      `| **${r.display_id}** | ${r.title} | ${r.status} | M${r.maturity_level} (${maturityNames[r.maturity_level] || '?'}) | P${r.priority} | ${r.workflow_name} |`
    );

    let result = `### Proposals (${rows.length} shown, offset ${offset})\n\n`;
    result += `| ID | Title | Status | Maturity | Priority | Workflow |\n`;
    result += `|----|-------|--------|----------|----------|----------|\n`;
    result += lines.join('\n');

    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    return errorResult("Failed to list proposals", err);
  }
}

// ─── UPDATE ─────────────────────────────────────────────────────────────────

export async function updateProposal(args: {
  proposal_id: string;
  title?: string;
  body_markdown?: string;
  category?: string;
  domain_id?: string;
  priority?: number;
  budget_limit_usd?: number;
  tags?: string[];
}): Promise<CallToolResult> {
  try {
    // Resolve proposal_id to both display_id and bigint id
    const { rows } = await query(
      "SELECT id, display_id FROM proposal WHERE display_id = $1 OR id = $1::bigint",
      [args.proposal_id]
    );
    if (!rows.length) {
      return { content: [{ type: "text", text: `Proposal "${args.proposal_id}" not found.` }] };
    }
    const proposalId = rows[0].id;
    const displayId = rows[0].display_id;

    const updates: string[] = [];
    const values: any[] = [];
    let paramIdx = 1;

    if (args.title !== undefined) {
      updates.push(`title = $${paramIdx++}`);
      values.push(args.title);
    }
    if (args.body_markdown !== undefined) {
      updates.push(`body_markdown = $${paramIdx++}`);
      values.push(args.body_markdown);
    }
    if (args.category !== undefined) {
      updates.push(`category = $${paramIdx++}`);
      values.push(args.category);
    }
    if (args.domain_id !== undefined) {
      updates.push(`domain_id = $${paramIdx++}`);
      values.push(args.domain_id);
    }
    if (args.priority !== undefined) {
      updates.push(`priority = $${paramIdx++}`);
      values.push(args.priority);
    }
    if (args.budget_limit_usd !== undefined) {
      updates.push(`budget_limit_usd = $${paramIdx++}`);
      values.push(args.budget_limit_usd);
    }
    if (args.tags !== undefined) {
      updates.push(`tags = $${paramIdx++}`);
      values.push(args.tags ? JSON.stringify(args.tags) : null);
    }

    if (updates.length === 0) {
      return { content: [{ type: "text", text: `⚠️ No fields to update for ${displayId}.` }] };
    }

    updates.push(`updated_at = NOW()`);
    values.push(proposalId);

    await query(
      `UPDATE proposal SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
      values
    );

    return { content: [{ type: "text", text: `✅ Updated ${displayId}: ${updates.filter(u => !u.startsWith('updated_at')).join(', ').replace(/\$\d+/g, '...')}` }] };
  } catch (err) {
    return errorResult("Failed to update proposal", err);
  }
}

// ─── SEARCH ─────────────────────────────────────────────────────────────────

export async function searchProposals(args: {
  query_text: string;
  limit?: number;
}): Promise<CallToolResult> {
  try {
    const limit = args.limit ?? 10;

    // Text search on title + body_markdown
    const { rows } = await query(
      `SELECT display_id, title, proposal_type, status, maturity_level, priority,
              LEFT(body_markdown, 200) as preview
       FROM proposal
       WHERE to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(body_markdown, ''))
             @@ plainto_tsquery('english', $1)
       ORDER BY maturity_level DESC, priority ASC
       LIMIT $2`,
      [args.query_text, limit]
    );

    if (!rows.length) {
      return { content: [{ type: "text", text: `No proposals match "${args.query_text}".` }] };
    }

    const lines = rows.map((r) =>
      `- **${r.display_id}**: ${r.title} [${r.status}, M${r.maturity_level}, P${r.priority}]\n  ${r.preview || ''}`
    );

    return { content: [{ type: "text", text: `### Search: "${args.query_text}"\n\n${lines.join('\n\n')}` }] };
  } catch (err) {
    return errorResult("Failed to search proposals", err);
  }
}

// ─── COUNT / SUMMARY ────────────────────────────────────────────────────────

export async function proposalSummary(args: Record<string, never>): Promise<CallToolResult> {
  try {
    const { rows } = await query(
      `SELECT status, COUNT(*) as count
       FROM proposal
       GROUP BY status
       ORDER BY status`
    );

    const { rows: totalRow } = await query("SELECT COUNT(*) as total FROM proposal");
    const total = totalRow[0].total;

    const lines = rows.map((r) => `- **${r.status}**: ${r.count}`);

    return { content: [{ type: "text", text: `### Proposal Summary\n\n**Total**: ${total}\n\n${lines.join('\n')}` }] };
  } catch (err) {
    return errorResult("Failed to get proposal summary", err);
  }
}

// ─── REGISTER TOOLS ─────────────────────────────────────────────────────────

export class ProposalHandlers {
  private server: McpServer;

  constructor(server: McpServer) {
    this.server = server;
  }

  register(): void {
    this.server.addTool({
      name: "proposal_create",
      description: "Create a new proposal in the universal proposal table",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          proposal_type: { type: "string", enum: ["RFC", "FEATURE", "DIRECTIVE", "CAPABILITY", "BUG"], default: "RFC" },
          category: { type: "string" },
          domain_id: { type: "string" },
          body_markdown: { type: "string" },
          parent_id: { type: "string" },
          workflow_name: { type: "string", default: "RFC 5-Stage" },
          priority: { type: "number", minimum: 1, maximum: 9, default: 5 },
          tags: { type: "array", items: { type: "string" } },
          created_by: { type: "string" },
        },
        required: ["title"],
      },
      handler: (args: any) => createProposal(args),
    });

    this.server.addTool({
      name: "proposal_get",
      description: "Get full details of a proposal by display_id or id",
      inputSchema: {
        type: "object",
        properties: {
          proposal_id: { type: "string" },
        },
        required: ["proposal_id"],
      },
      handler: (args: any) => getProposal(args),
    });

    this.server.addTool({
      name: "proposal_list",
      description: "List proposals with optional filters (status, type, workflow, maturity)",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string" },
          proposal_type: { type: "string" },
          workflow_name: { type: "string" },
          maturity_level: { type: "number", minimum: 0, maximum: 3 },
          limit: { type: "number", default: 20 },
          offset: { type: "number", default: 0 },
        },
        required: [],
      },
      handler: (args: any) => listProposals(args),
    });

    this.server.addTool({
      name: "proposal_update",
      description: "Update editable fields on a proposal",
      inputSchema: {
        type: "object",
        properties: {
          proposal_id: { type: "string" },
          title: { type: "string" },
          body_markdown: { type: "string" },
          category: { type: "string" },
          domain_id: { type: "string" },
          priority: { type: "number", minimum: 1, maximum: 9 },
          budget_limit_usd: { type: "number" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["proposal_id"],
      },
      handler: (args: any) => updateProposal(args),
    });

    this.server.addTool({
      name: "proposal_search",
      description: "Full-text search proposals by title and body content",
      inputSchema: {
        type: "object",
        properties: {
          query_text: { type: "string" },
          limit: { type: "number", default: 10 },
        },
        required: ["query_text"],
      },
      handler: (args: any) => searchProposals(args),
    });

    this.server.addTool({
      name: "proposal_summary",
      description: "Get proposal counts by status",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
      handler: (args: any) => proposalSummary(args),
    });

    // eslint-disable-next-line no-console
    console.log("[MCP] Registered 6 proposal CRUD tools (create, get, list, update, search, summary)");
  }
}
