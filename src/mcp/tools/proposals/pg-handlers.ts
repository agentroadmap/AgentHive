/**
 * Postgres-backed Proposal MCP Tools
 *
 * Replaces sdb-handlers.ts — same tool interface, uses pg adapter instead of
 * SpacetimeDB CLI queries. All errors are caught and returned as MCP text
 * responses rather than thrown, preventing tool call crashes.
 */
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";
import * as pg from "../../../postgres/proposal-storage.ts";

function errorResult(msg: string, err: unknown): CallToolResult {
  return { content: [{ type: "text", text: `⚠️ ${msg}: ${err instanceof Error ? err.message : String(err)}` }] };
}

export class PgProposalHandlers {
  private core: McpServer;
  private projectRoot: string;

  constructor(core: McpServer, projectRoot: string) {
    this.core = core;
    this.projectRoot = projectRoot;
  }

  async listProposals(
    args: { status?: string; type?: string; domain_id?: string; maturity_min?: number },
  ): Promise<CallToolResult> {
    try {
      const proposals = await pg.listProposals(args);
      if (!proposals || proposals.length === 0) {
        return { content: [{ type: "text", text: "No proposals found." }] };
      }
      const lines = proposals.map((p) => {
        const did = p.display_id ?? `#${p.id}`;
        return `[${did}] ${p.title || "(no title)"} — status: ${p.status}, type: ${p.proposal_type}, maturity: ${p.maturity_level}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return errorResult("Failed to list proposals", err);
    }
  }

  async getProposal(args: { id: string }): Promise<CallToolResult> {
    try {
      const identifier = parseInt(args.id, 10) || args.id;
      const proposal = await pg.getProposal(identifier);
      if (!proposal) {
        return { content: [{ type: "text", text: `Proposal ${args.id} not found.` }] };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(proposal, null, 2),
          },
        ],
      };
    } catch (err) {
      return errorResult("Failed to get proposal", err);
    }
  }

  async createProposal(args: {
    title: string;
    proposal_type: string;
    category?: string;
    domain_id?: string;
    display_id?: string;
    parent_id?: string;
    body_markdown?: string;
    status?: string;
    tags?: string;
  }): Promise<CallToolResult> {
    try {
      const created = await pg.createProposal({
        title: args.title,
        proposal_type: args.proposal_type,
        category: args.category || null,
        domain_id: args.domain_id || null,
        display_id: args.display_id || null,
        parent_id: args.parent_id ? parseInt(args.parent_id, 10) : null,
        body_markdown: args.body_markdown || null,
        body_embedding: null,
        process_logic: null,
        maturity_level: 0,
        status: args.status || "NEW",
        budget_limit_usd: null,
        tags: args.tags ? JSON.parse(args.tags) : null,
      });
      return {
        content: [
          {
            type: "text",
            text: `Created proposal: [${created.display_id ?? created.id}] ${created.title}`,
          },
        ],
      };
    } catch (err) {
      return errorResult("Failed to create proposal", err);
    }
  }

  async updateProposal(args: {
    id: string;
    title?: string;
    status?: string;
    category?: string;
    body_markdown?: string;
    tags?: string;
  }): Promise<CallToolResult> {
    try {
      const id = parseInt(args.id, 10);
      const updates: Record<string, any> = {};
      if (args.title) updates.title = args.title;
      if (args.status) updates.status = args.status;
      if (args.category) updates.category = args.category;
      if (args.body_markdown) updates.body_markdown = args.body_markdown;
      if (args.tags) updates.tags = JSON.parse(args.tags);

      const updated = await pg.updateProposal(id, updates);
      if (!updated) {
        return { content: [{ type: "text", text: `Proposal ${args.id} not found.` }] };
      }
      return {
        content: [
          {
            type: "text",
            text: `Updated proposal: [${updated.display_id ?? updated.id}]`,
          },
        ],
      };
    } catch (err) {
      return errorResult("Failed to update proposal", err);
    }
  }

  async transitionProposal(args: {
    id: string;
    status: string;
    author?: string;
    summary?: string;
  }): Promise<CallToolResult> {
    try {
      const id = parseInt(args.id, 10);
      const updated = await pg.transitionProposal(id, args.status, args.author, args.summary);
      if (!updated) {
        return { content: [{ type: "text", text: `Proposal ${args.id} not found.` }] };
      }
      return {
        content: [
          {
            type: "text",
            text: `Transitioned proposal ${args.id} → ${args.status}`,
          },
        ],
      };
    } catch (err) {
      return errorResult("Failed to transition proposal", err);
    }
  }

  async deleteProposal(args: { id: string }): Promise<CallToolResult> {
    try {
      const id = parseInt(args.id, 10);
      const ok = await pg.deleteProposal(id);
      if (!ok) {
        return { content: [{ type: "text", text: `Proposal ${args.id} not found.` }] };
      }
      return { content: [{ type: "text", text: `Deleted proposal ${args.id}.` }] };
    } catch (err) {
      return errorResult("Failed to delete proposal", err);
    }
  }

  async getVersions(args: { id: string }): Promise<CallToolResult> {
    try {
      const id = parseInt(args.id, 10);
      const versions = await pg.getProposalVersions(id);
      if (!versions || versions.length === 0) {
        return { content: [{ type: "text", text: `No versions found for proposal ${args.id}.` }] };
      }
      const lines = versions.map(
        (v: any) => `v${v.version_number} — ${v.author_identity || "unknown"} at ${v.created_at}: ${v.change_summary || "(no summary)"}`,
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return errorResult("Failed to get versions", err);
    }
  }

  async searchProposals(args: { query: string; limit?: number }): Promise<CallToolResult> {
    try {
      const proposals = await pg.searchProposals(args.query, args.limit ?? 10);
      if (!proposals || proposals.length === 0) {
        return { content: [{ type: "text", text: `No proposals match "${args.query}".` }] };
      }
      const lines = proposals.map((p) => {
        const did = p.display_id ?? `#${p.id}`;
        return `[${did}] ${p.title || "(no title)"} — status: ${p.status}, maturity: ${p.maturity_level}\n  ${p.body_markdown ? p.body_markdown.substring(0, 150) : ""}`;
      });
      return { content: [{ type: "text", text: `### Search: "${args.query}"\n\n${lines.join("\n\n")}` }] };
    } catch (err) {
      return errorResult("Failed to search proposals", err);
    }
  }

  async summary(args: Record<string, never>): Promise<CallToolResult> {
    try {
      const rows = await pg.proposalSummary();
      const total = rows.length > 0 ? rows[0].total : 0;
      const lines = rows.map((r) => `- **${r.status}**: ${r.count}`);
      return { content: [{ type: "text", text: `### Proposal Summary\n\n**Total**: ${total}\n\n${lines.join("\n")}` }] };
    } catch (err) {
      return errorResult("Failed to get proposal summary", err);
    }
  }
}
