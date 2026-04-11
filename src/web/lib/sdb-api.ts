/**
 * SpacetimeDB-backed API Client
 * Replaces HTTP API calls with direct SpacetimeDB queries
 */

import { execSync } from 'child_process';
import { querySdbSync } from '../../core/storage/sdb-client.ts';

const DB_NAME = process.env.SDB_NAME ?? "roadmap2";

// Helper to query SpacetimeDB
function queryDb(sql: string): any[] {
  return querySdbSync(sql);
}

// Helper to call SpacetimeDB reducer
function callReducer(name: string, args: string[]): boolean {
  try {
    const argsStr = args.map(a => `"${a}"`).join(' ');
    execSync(`spacetime call --server local ${DB_NAME} ${name} ${argsStr}`, {
      encoding: 'utf8',
      timeout: 10000,
      stdio: 'pipe'
    });
    return true;
  } catch {
    return false;
  }
}

// Proposal types
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
  claimedAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

// API Methods
export const sdbApi = {
  // Proposals
  async fetchProposals(): Promise<SdbProposal[]> {
    return queryDb('SELECT id, title, status, assignee, priority, labels, createdAt FROM step') as SdbProposal[];
  },

  async fetchProposal(id: string): Promise<SdbProposal | null> {
    const results = queryDb(`SELECT * FROM step WHERE id = '${id}'`);
    return results[0] as SdbProposal || null;
  },

  async createProposal(data: { title: string; body?: string; status?: string }): Promise<boolean> {
    const id = `STATE-${String(Date.now()).slice(-6)}`;
    return callReducer('create_step', [id, data.title, data.body || '']);
  },

  async completeProposal(id: string): Promise<boolean> {
    return callReducer('complete_proposal', [id, 'manual', Date.now().toString()]);
  },

  async updateStatus(id: string, status: string): Promise<boolean> {
    return callReducer('transition_step', [id, status, '']);
  },

  // Proposals (from SpacetimeDB 'prop' table)
  async fetchProposalsFromProp(): Promise<any[]> {
    return queryDb('SELECT propId, title, status, authorId, summary, votes FROM prop') || [];
  },

  // Agents
  async fetchAgents(): Promise<any[]> {
    return queryDb('SELECT id, name, role, status FROM agent');
  },

  // Channels/Messages
  async fetchChannels(): Promise<any[]> {
    return queryDb('SELECT id, name, type FROM chan');
  },

  async fetchMessages(channel?: string): Promise<any[]> {
    if (channel) {
      return queryDb(`SELECT msgId, fromAgentId, text, timestamp FROM msg WHERE chanId = '${channel}'`);
    }
    return queryDb('SELECT msgId, fromAgentId, text, chanId, timestamp FROM msg');
  }
};

export default sdbApi;
