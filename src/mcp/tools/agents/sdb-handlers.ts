import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";
import { execSync } from "child_process";

export class SdbAgentHandlers {
  private core: McpServer;
  private projectRoot: string;

  constructor(core: McpServer, projectRoot: string) {
    this.core = core;
    this.projectRoot = projectRoot;
  }

  async listAgents(_args: {}): Promise<CallToolResult> {
    try {
      const agents = await this.querySql("SELECT id, name, role, status FROM agent");
      if (!agents || agents.length === 0) {
        return { content: [{ type: "text", text: "No agents registered yet." }] };
      }
      const lines = agents.map((a: any) => `- **${a.name}** (${a.role || 'unknown'}) — ${a.status || 'idle'}`).join("\n");
      return { content: [{ type: "text", text: `## Agents (${agents.length})\n\n${lines}` }] };
    } catch (error) {
      throw new Error(`Failed to list agents: ${(error as Error).message}`);
    }
  }

  async registerAgent(args: { name: string; role?: string; skills?: string[] }): Promise<CallToolResult> {
    try {
      await this.callReducer('register_agent', [
        args.name,                        // agent_id
        args.name,                        // name
        args.role || 'agent',             // role
        '1',                              // clearance_level (string for CLI)
        '0',                              // squad_id
        '',                               // workspace
        ''                                // api_key
      ]);
      return { content: [{ type: "text", text: `✅ Registered agent: ${args.name}` }] };
    } catch (error) {
      throw new Error(`Failed to register agent: ${(error as Error).message}`);
    }
  }

  async getWorkload(args: { agentId: string }): Promise<CallToolResult> {
    try {
      const claims = await this.querySql(`SELECT id, stepId FROM claim WHERE agentId = '${args.agentId}' AND active = true`);
      return {
        content: [{ type: "text", text: `**${args.agentId}** has ${claims?.length || 0} active claims.` }]
      };
    } catch (error) {
      throw new Error(`Failed to get workload: ${(error as Error).message}`);
    }
  }

  private async querySql(sql: string): Promise<any[]> {
    try {
      const result = execSync(`spacetime sql --server local ${process.env.SDB_NAME ?? "roadmap2"} "${sql}"`, { encoding: 'utf8', cwd: this.projectRoot });
      const lines = result.trim().split('\n').filter(l => !l.includes('WARNING'));
      if (lines.length < 2) return [];
      const headers = lines[0]!.split('|').map(h => h.trim()).filter(Boolean);
      return lines.slice(1).map(line => {
        const values = line.split('|').map(v => v.trim().replace(/"/g, ''));
        const obj: any = {};
        headers.forEach((h, i) => { obj[h] = values[i]!; });
        return obj;
      });
    } catch { return []; }
  }

  private async callReducer(name: string, args: string[]): Promise<void> {
    const argsStr = args.map(a => `"${a}"`).join(' ');
    execSync(`spacetime call --server local ${process.env.SDB_NAME ?? "roadmap2"} ${name} ${argsStr}`, { encoding: 'utf8', cwd: this.projectRoot, stdio: 'pipe' });
  }
}
