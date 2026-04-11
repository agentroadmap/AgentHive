/**
 * SpacetimeDB-backed Proposal Handlers
 * Replaces file-based proposal operations with stdb queries
 */

import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";
import { execSync } from "child_process";

export interface SdbProposal {
  id: string;
  title: string;
  body?: string;
  status?: string;
  assignee?: string;
  priority?: string;
  directive?: string;
  labels?: string;
  dependencies?: string;
  claimedBy?: string;
  claimedAt?: bigint;
  createdAt?: bigint;
  updatedAt?: bigint;
}

export class SdbProposalHandlers {
  private core: McpServer;
  private projectRoot: string;

  constructor(core: McpServer, projectRoot: string) {
    this.core = core;
    this.projectRoot = projectRoot;
  }

  async listProposals(args: { status?: string; assignee?: string; limit?: number }): Promise<CallToolResult> {
    try {
      let query = "SELECT id, display_id, title, status, proposal_type, maturity_level FROM proposal";
      const conditions: string[] = [];
      
      if (args.status) conditions.push(`status = '${args.status}'`);
      
      if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ");
      }
      
      const proposals = await this.querySql(query);
      
      if (!proposals || proposals.length === 0) {
        return { content: [{ type: "text", text: "No proposals found." }] };
      }

      const lines = proposals.map((p: any) => 
        `- **${p.display_id}**: ${p.title} [${p.status}] (${p.proposal_type}) M${p.maturity_level || 0}`
      ).join("\n");

      return {
        content: [{ type: "text", text: `## Proposals (${proposals.length})\n\n${lines}` }]
      };
    } catch (error) {
      throw new Error(`Failed to list proposals: ${(error as Error).message}`);
    }
  }

  async getProposal(args: { proposalId: string }): Promise<CallToolResult> {
    try {
      const proposals = await this.querySql(`SELECT * FROM proposal WHERE display_id = '${args.proposalId}' OR id = '${args.proposalId}'`);
      
      if (!proposals || proposals.length === 0) {
        return { content: [{ type: "text", text: `Proposal ${args.proposalId} not found.` }] };
      }

      const p = proposals[0];
      const output = [
        `## ${p.display_id}: ${p.title}`,
        ``,
        `**Type:** ${p.proposal_type}`,
        `**Category:** ${p.category}`,
        `**Domain:** ${p.domain_id}`,
        `**Status:** ${p.status}`,
        `**Priority:** ${p.priority}`,
        `**Maturity:** ${p.maturity_level || 0}`,
        p.parent_id ? `**Parent:** ${p.parent_id}` : '',
        ``,
        p.body_markdown ? `### Description\n${p.body_markdown}` : '',
      ].filter(Boolean).join("\n");

      return { content: [{ type: "text", text: output }] };
    } catch (error) {
      throw new Error(`Failed to get proposal: ${(error as Error).message}`);
    }
  }

  async createProposal(args: {
    title: string;
    proposal_type?: string;
    category?: string;
    domain_id?: string;
    description?: string;
    priority?: string;
    parent_id?: number;
    budget_limit_usd?: number;
  }): Promise<CallToolResult> {
    try {
      const proposal_type = args.proposal_type || "TECHNICAL";
      const category = args.category || "FEATURE";
      const domain_id = args.domain_id || "GENERAL";
      const title = args.title;
      const priority = args.priority || "Medium";
      const body_markdown = args.description || "";
      const parent_id = args.parent_id ? args.parent_id.toString() : "";
      const budget_limit_usd = args.budget_limit_usd || 0;
      
      await this.callReducer('create_proposal', [
        proposal_type, category, domain_id, title, priority, body_markdown, parent_id, budget_limit_usd.toString()
      ]);
      
      return {
        content: [{ type: "text", text: `✅ Created proposal: ${title}` }]
      };
    } catch (error) {
      throw new Error(`Failed to create proposal: ${(error as Error).message}`);
    }
  }

  async completeProposal(args: { proposalId: string }): Promise<CallToolResult> {
    try {
      await this.callReducer('complete_proposal', [args.proposalId, 'manual', Date.now().toString()]);
      
      return {
        content: [{ type: "text", text: `✅ ${args.proposalId} marked as complete` }]
      };
    } catch (error) {
      throw new Error(`Failed to complete proposal: ${(error as Error).message}`);
    }
  }

  // Helper to query SpacetimeDB SQL
  private async querySql(sql: string): Promise<any[]> {
    try {
      const result = execSync(
        `spacetime sql --server local ${process.env.SDB_NAME ?? "roadmap2"} "${sql}"`,
        { encoding: 'utf8', cwd: this.projectRoot }
      );
      const lines = result.trim().split('\n').filter(l => !l.includes('WARNING'));
      if (lines.length < 2) return [];
      
      const headers = lines[0]!.split('|').map(h => h.trim()).filter(Boolean);
      return lines.slice(1).map(line => {
        const values = line.split('|').map(v => v.trim().replace(/"/g, ''));
        const obj: any = {};
        headers.forEach((h, i) => { obj[h] = values[i]; });
        return obj;
      });
    } catch {
      return [];
    }
  }

  async updateProposal(args: {
    proposalId: string;
    title?: string;
    body_markdown?: string;
    priority?: string;
    maturity_level?: number;
    tags?: string;
    change_summary: string;
  }): Promise<CallToolResult> {
    try {
      const proposalId = args.proposalId;
      const title = args.title || "";
      const body_markdown = args.body_markdown || "";
      const priority = args.priority || "";
      const maturity_level = args.maturity_level !== undefined ? args.maturity_level.toString() : "";
      const tags = args.tags || "";
      const change_summary = args.change_summary;
      
      await this.callReducer('update_proposal', [
        proposalId, title, body_markdown, priority, maturity_level, tags, change_summary
      ]);
      
      return {
        content: [{ type: "text", text: `✅ Updated proposal ${proposalId}` }]
      };
    } catch (error) {
      throw new Error(`Failed to update proposal: ${(error as Error).message}`);
    }
  }

  async transitionProposal(args: { proposalId: string; new_status: string; change_summary: string }): Promise<CallToolResult> {
    try {
      await this.callReducer('transition_proposal', [
        args.proposalId,
        args.new_status,
        args.change_summary
      ]);
      
      return {
        content: [{ type: "text", text: `✅ Transitioned proposal ${args.proposalId} to ${args.new_status}` }]
      };
    } catch (error) {
      throw new Error(`Failed to transition proposal: ${(error as Error).message}`);
    }
  }

  async addCriteria(args: { proposalId: string; description: string }): Promise<CallToolResult> {
    try {
      await this.callReducer('add_criteria', [
        args.proposalId,
        args.description
      ]);
      
      return {
        content: [{ type: "text", text: `✅ Added acceptance criteria to proposal ${args.proposalId}` }]
      };
    } catch (error) {
      throw new Error(`Failed to add criteria: ${(error as Error).message}`);
    }
  }

  async checkCriteria(args: { proposalId: string; criteriaId: number }): Promise<CallToolResult> {
    try {
      await this.callReducer('check_criteria', [
        args.proposalId,
        args.criteriaId.toString()
      ]);
      
      return {
        content: [{ type: "text", text: `✅ Marked criteria ${args.criteriaId} as verified` }]
      };
    } catch (error) {
      throw new Error(`Failed to check criteria: ${(error as Error).message}`);
    }
  }

  async removeCriteria(args: { criteriaId: number }): Promise<CallToolResult> {
    try {
      await this.callReducer('remove_criteria', [
        args.criteriaId.toString()
      ]);
      
      return {
        content: [{ type: "text", text: `✅ Removed criteria ${args.criteriaId}` }]
      };
    } catch (error) {
      throw new Error(`Failed to remove criteria: ${(error as Error).message}`);
    }
  }

  async claimProposal(args: { proposalId: string; agent_identity: string; cost_estimate_usd: number }): Promise<CallToolResult> {
    try {
      await this.callReducer('claim_proposal', [
        args.proposalId,
        args.agent_identity,
        args.cost_estimate_usd.toString()
      ]);
      
      return {
        content: [{ type: "text", text: `✅ Claimed proposal ${args.proposalId} (budget: $${args.cost_estimate_usd})` }]
      };
    } catch (error) {
      throw new Error(`Failed to claim proposal: ${(error as Error).message}`);
    }
  }

  async releaseProposal(args: { proposalId: string }): Promise<CallToolResult> {
    try {
      await this.callReducer('transition_proposal', [
        args.proposalId,
        "New",
        "Released by agent"
      ]);
      
      return {
        content: [{ type: "text", text: `✅ Released proposal ${args.proposalId}` }]
      };
    } catch (error) {
      throw new Error(`Failed to release proposal: ${(error as Error).message}`);
    }
  }

  async deleteProposal(args: { proposalId: string }): Promise<CallToolResult> {
    try {
      await this.callReducer('delete_proposal', [
        args.proposalId
      ]);
      
      return {
        content: [{ type: "text", text: `✅ Deleted proposal ${args.proposalId}` }]
      };
    } catch (error) {
      throw new Error(`Failed to delete proposal: ${(error as Error).message}`);
    }
  }

  // Helper to call SpacetimeDB reducer
  private async callReducer(name: string, args: string[]): Promise<void> {
    const argsStr = args.map(a => `"${a}"`).join(' ');
    execSync(
      `spacetime call --server local ${process.env.SDB_NAME ?? "roadmap2"} ${name} ${argsStr}`,
      { encoding: 'utf8', cwd: this.projectRoot, stdio: 'pipe' }
    );
  }
}
