import { query } from "../../infra/postgres/pool.ts";

/**
 * Unified Agent Orchestrator
 * 
 * Manages agent pool, resource allocation, and reporting.
 * Uses Postgres as the primary source of truth.
 */
export class Orchestrator {
  constructor() {}

  async getProposalCount(): Promise<number> {
    const { rows } = await query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM roadmap_proposal.proposal',
    );
    return rows[0]?.count ?? 0;
  }

  async getProposalsByStatus(status: string): Promise<string[]> {
    const { rows } = await query<{ display_id: string | null; id: number }>(
      'SELECT id, display_id FROM roadmap_proposal.proposal WHERE status = $1 ORDER BY id',
      [status],
    );
    return rows.map((row) => row.display_id ?? String(row.id));
  }

  async generateReport(): Promise<string> {
    const total = await this.getProposalCount();
    const active = await this.getProposalsByStatus('Active');
    const complete = await this.getProposalsByStatus('Complete');

    return `📊 **ORCHESTRATION REPORT** - ${new Date().toLocaleTimeString()}\n` +
           `📝 Total proposals: ${total}\n` +
           `🚀 Active: ${active.length}\n` +
           `✅ Complete: ${complete.length}\n` +
           `🤖 System status: Operational`;
  }

  async assignTask(proposalId: string, agentId: string): Promise<boolean> {
      console.log(`[Orchestrator] Assigning ${proposalId} to ${agentId}`);
      return true;
  }
}
