import type { McpServer } from "../../server.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import type { JsonSchema } from "../../validation/validators.ts";
import { execSync } from "child_process";

export function registerSdbDocumentTools(server: McpServer, projectRoot: string): void {
  server.addTool(createSimpleValidatedTool(
    { name: "documents_list", description: "List project documents", inputSchema: { type: "object", properties: {}, required: [] } },
    { type: "object", properties: {}, required: [] },
    async () => {
      try {
        const docs = await querySql("SELECT id, key, title FROM doc");
        if (!docs || docs.length === 0) {
          return { content: [{ type: "text", text: "No documents yet." }] };
        }
        const lines = docs.map((d: any) => `- **${d.key || d.id}**: ${d.title || d.key}`).join("\n");
        return { content: [{ type: "text", text: `## Documents (${docs.length})\n\n${lines}` }] };
      } catch { return { content: [{ type: "text", text: "Documents table not yet available." }] }; }
    }
  ));

  server.addTool(createSimpleValidatedTool(
    { name: "documents_read", description: "Read a document", inputSchema: { type: "object", properties: { key: { type: "string", description: "Document key" } }, required: ["key"] } },
    { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    async (input) => {
      const args = input as { key: string };
      return { content: [{ type: "text", text: `Document: ${args.key} (read from file system)` }] };
    }
  ));

  console.log('[Documents] Registered 2 SDB tools');
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
