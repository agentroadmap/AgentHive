import type { McpServer } from "../../server.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import type { JsonSchema } from "../../validation/validators.ts";
import { execSync } from "child_process";

const directiveListSchema: JsonSchema = { type: "object", properties: {}, required: [] };
const directiveCreateSchema: JsonSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Directive ID (e.g., M-1)" },
    name: { type: "string", description: "Directive name" },
    dueDate: { type: "string", description: "Due date (ISO format)" },
  },
  required: ["id", "name"],
};

export function registerSdbMilestoneTools(server: McpServer, projectRoot: string): void {
  server.addTool(createSimpleValidatedTool(
    { name: "directive_list", description: "List directives", inputSchema: directiveListSchema },
    directiveListSchema,
    async () => {
      const goals = await querySql("SELECT id, title, status FROM goal");
      if (!goals || goals.length === 0) {
        return { content: [{ type: "text", text: "No directives yet." }] };
      }
      const lines = goals.map((g: any) => `- **${g.id}**: ${g.title} [${g.status}]`).join("\n");
      return { content: [{ type: "text", text: `## Directives (${goals.length})\n\n${lines}` }] };
    }
  ));

  server.addTool(createSimpleValidatedTool(
    { name: "directive_create", description: "Create directive (goal)", inputSchema: directiveCreateSchema },
    directiveCreateSchema,
    async (input) => {
      const args = input as { id: string; name: string; dueDate?: string };
      try {
        execSync(`spacetime call --server local ${process.env.SDB_NAME ?? "roadmap2"} create_step "${args.id}" "${args.name}" ""`, { encoding: 'utf8', cwd: projectRoot, stdio: 'pipe' });
        return { content: [{ type: "text", text: `✅ Created directive: ${args.id}` }] };
      } catch (error) {
        throw new Error(`Failed: ${(error as Error).message}`);
      }
    }
  ));

  console.log('[Directives] Registered 2 SDB tools: directive_list, directive_create');
}

async function querySql(sql: string): Promise<any[]> {
  try {
    const result = execSync(`spacetime sql --server local ${process.env.SDB_NAME ?? "roadmap2"} "${sql}"`, { encoding: 'utf8' });
    const lines = result.trim().split('\n').filter(l => !l.includes('WARNING'));
    if (lines.length < 2) return [];
    const headers = lines[0].split('|').map(h => h.trim()).filter(Boolean);
    return lines.slice(1).map(line => {
      const values = line.split('|').map(v => v.trim().replace(/"/g, ''));
      const obj: any = {};
      headers.forEach((h, i) => { obj[h] = values[i]; });
      return obj;
    });
  } catch { return []; }
}
