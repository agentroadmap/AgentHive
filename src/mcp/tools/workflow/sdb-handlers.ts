import { triggerExport } from "../../../core/proposal/proposal-change-hook.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";
import { execSync } from "child_process";

export class SdbWorkflowHandlers {
  private projectRoot: string;

  constructor(core: McpServer, projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  async claimStep(args: { stepId: string; agentId: string }): Promise<CallToolResult> {
    try {
      await this.callReducer('claim_step', [args.stepId, args.agentId]);
      triggerExport();
      return { content: [{ type: "text", text: `✅ ${args.agentId} claimed ${args.stepId}` }] };
    } catch (error) {
      throw new Error(`Failed to claim: ${(error as Error).message}`);
    }
  }

  async transitionStep(args: { stepId: string; toStatus: string; reason?: string }): Promise<CallToolResult> {
    try {
      await this.callReducer('transition_step', [args.stepId, args.toStatus, args.reason || '']);
      return { content: [{ type: "text", text: `✅ ${args.stepId} → ${args.toStatus}` }] };
    } catch (error) {
      throw new Error(`Failed to transition: ${(error as Error).message}`);
    }
  }

  async reviewStep(args: { stepId: string; outcome: string }): Promise<CallToolResult> {
    try {
      await this.callReducer('review_step', [args.stepId, args.outcome]);
      return { content: [{ type: "text", text: `✅ ${args.stepId} reviewed: ${args.outcome}` }] };
    } catch (error) {
      throw new Error(`Failed to review: ${(error as Error).message}`);
    }
  }

  async getReadyWork(_args: {}): Promise<CallToolResult> {
    try {
      const steps = await this.querySql("SELECT id, title, priority FROM step WHERE status = 'active' AND claimedBy = ''");
      if (!steps || steps.length === 0) {
        return { content: [{ type: "text", text: "No unclaimed work available." }] };
      }
      const lines = steps.map((s: any) => `- **${s.id}**: ${s.title} [${s.priority || 'medium'}]`).join("\n");
      return { content: [{ type: "text", text: `## Ready Work (${steps.length})\n\n${lines}` }] };
    } catch (error) {
      throw new Error(`Failed to get ready work: ${(error as Error).message}`);
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
        headers.forEach((h, i) => { obj[h] = values[i]; });
        return obj;
      });
    } catch { return []; }
  }

  private async callReducer(name: string, args: string[]): Promise<void> {
    const argsStr = args.map(a => `"${a}"`).join(' ');
    execSync(`spacetime call --server local ${process.env.SDB_NAME ?? "roadmap2"} ${name} ${argsStr}`, { encoding: 'utf8', cwd: this.projectRoot, stdio: 'pipe' });
  }
}
