import http from "node:http";
import { type Proposal } from "../../types/index.ts";
import { SDB_CONFIG } from "../../constants/index.ts";

const DB_ID = SDB_CONFIG.DB_ID;

/**
 * Unified Agent Orchestrator
 * 
 * Manages agent pool, resource allocation, and reporting.
 * Uses SpacetimeDB as the primary source of truth.
 */
export class Orchestrator {
  private dbUrl = 'http://127.0.0.1:3000';

  constructor() {}

  private async queryDB(query: string): Promise<any[]> {
    return new Promise((resolve) => {
      const req = http.request(`${this.dbUrl}/v1/database/${DB_ID}/sql`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' }
      }, (res: any) => {
        let data = '';
        res.on('data', (c: string) => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed[0]?.rows || []);
          } catch { resolve([]); }
        });
      });
      req.on('error', () => resolve([]));
      req.write(query);
      req.end();
    });
  }

  async getProposalCount(): Promise<number> {
    const rows = await this.queryDB('SELECT id FROM step');
    return rows.length;
  }

  async getProposalsByStatus(status: string): Promise<string[]> {
    const rows = await this.queryDB(`SELECT id FROM step WHERE status = '${status}'`);
    return rows.map(r => r[0]);
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
      // In a real SDB implementation, this would be a transaction (reducer)
      console.log(`[Orchestrator] Assigning ${proposalId} to ${agentId}`);
      return true;
  }
}
