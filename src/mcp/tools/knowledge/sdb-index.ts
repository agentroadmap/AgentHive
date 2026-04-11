import type { McpServer } from "../../server.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import type { JsonSchema } from "../../validation/validators.ts";
import { execSync } from "child_process";

export function registerSdbKnowledgeTools(server: McpServer, projectRoot: string): void {
  server.addTool(createSimpleValidatedTool(
    { name: "knowledge_search", description: "Search knowledge base", inputSchema: { type: "object", properties: { query: { type: "string", description: "Search query" } }, required: ["query"] } },
    { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async (input) => {
      const args = input as { query: string };
      try {
        const results = await querySql(`SELECT id, key, value FROM mem WHERE key LIKE '%${args.query}%' OR value LIKE '%${args.query}%'`);
        if (!results || results.length === 0) {
          return { content: [{ type: "text", text: `No results for "${args.query}"` }] };
        }
        const lines = results.map((r: any) => `- **${r.key}**: ${r.value?.substring(0, 100) || ''}`).join("\n");
        return { content: [{ type: "text", text: `## Search Results (${results.length})\n\n${lines}` }] };
      } catch { return { content: [{ type: "text", text: "Knowledge base not yet available." }] }; }
    }
  ));

  server.addTool(createSimpleValidatedTool(
    { name: "knowledge_add", description: "Add knowledge entry", inputSchema: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"] } },
    { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"] },
    async (input) => {
      const args = input as { key: string; value: string };
      try {
        execSync(`spacetime call --server local ${process.env.SDB_NAME ?? "roadmap2"} memorize "system" "${args.key}" "${args.value.replace(/"/g, '\\"')}"`, { encoding: 'utf8', cwd: projectRoot, stdio: 'pipe' });
        return { content: [{ type: "text", text: `✅ Added: ${args.key}` }] };
      } catch (error) {
        throw new Error(`Failed: ${(error as Error).message}`);
      }
    }
  ));

  console.log('[Knowledge] Registered 2 SDB tools');
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
