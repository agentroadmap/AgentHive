/**
 * SDB Proposal Transition Tool
 * Updates proposal status directly in SpacetimeDB
 */
import { execSync } from 'child_process';
import path from 'path';
import { SDB_CONFIG } from '../../../constants/index.ts';

const SDB_URL = SDB_CONFIG.SDB_URL;
const DB_ID = SDB_CONFIG.DB_ID;

export async function transitionProposalInSDB(
  displayId: string,
  newStatus: string,
  agentId: string = 'agent',
  reason?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const reasonJson = reason ? `{"some": "${reason}"}` : 'null';
    const args = JSON.stringify([displayId, newStatus, agentId, JSON.parse(reasonJson)]);
    
    const cmd = `curl -s "${SDB_URL}/v1/database/${DB_ID}/call/transition_step" \\
      -H "Content-Type: application/json" \\
      --data-binary '${args}'`;
    
    const result = execSync(cmd, { encoding: 'utf8', timeout: 5000 });
    
    if (result.includes('fatal error') || result.includes('error')) {
      return { success: false, error: result.slice(0, 100) };
    }
    
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message?.slice(0, 100) };
  }
}
