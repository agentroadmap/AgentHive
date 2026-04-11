import type { McpServer } from "../../server.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import type { JsonSchema } from "../../validation/validators.ts";
import { execSync } from "child_process";

const teamListSchema: JsonSchema = { type: "object", properties: {}, required: [] };
const teamCreateSchema: JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string", description: "Team name" },
    mission: { type: "string", description: "Team mission" },
  },
  required: ["name"],
};
const teamAddMemberSchema: JsonSchema = {
  type: "object",
  properties: {
    teamId: { type: "string", description: "Team ID" },
    agentId: { type: "string", description: "Agent to add" },
    role: { type: "string", description: "Role in team" },
  },
  required: ["teamId", "agentId"],
};

export function registerSdbTeamTools(server: McpServer, projectRoot: string): void {
  server.addTool(createSimpleValidatedTool(
    { name: "team_list", description: "List teams", inputSchema: teamListSchema },
    teamListSchema,
    async () => {
      const teams = await querySql("SELECT id, name, mission FROM team");
      if (!teams || teams.length === 0) {
        return { content: [{ type: "text", text: "No teams yet." }] };
      }
      const lines = teams.map((t: any) => `- **${t.id}**: ${t.name} — ${t.mission || 'no mission'}`).join("\n");
      return { content: [{ type: "text", text: `## Teams (${teams.length})\n\n${lines}` }] };
    }
  ));

  server.addTool(createSimpleValidatedTool(
    { name: "team_create", description: "Create a team", inputSchema: teamCreateSchema },
    teamCreateSchema,
    async (input) => {
      const args = input as { name: string; mission?: string };
      try {
        execSync(`spacetime call --server local ${process.env.SDB_NAME ?? "roadmap2"} register_team "${args.name}" "${args.mission || ''}"`, { encoding: 'utf8', cwd: projectRoot, stdio: 'pipe' });
        return { content: [{ type: "text", text: `✅ Created team: ${args.name}` }] };
      } catch (error) {
        throw new Error(`Failed: ${(error as Error).message}`);
      }
    }
  ));

  server.addTool(createSimpleValidatedTool(
    { name: "team_add_member", description: "Add agent to team", inputSchema: teamAddMemberSchema },
    teamAddMemberSchema,
    async (input) => {
      const args = input as { teamId: string; agentId: string; role?: string };
      try {
        execSync(`spacetime call --server local ${process.env.SDB_NAME ?? "roadmap2"} recruit_agent "${args.teamId}" "${args.agentId}" "${args.role || 'member'}"`, { encoding: 'utf8', cwd: projectRoot, stdio: 'pipe' });
        return { content: [{ type: "text", text: `✅ ${args.agentId} added to ${args.teamId}` }] };
      } catch (error) {
        throw new Error(`Failed: ${(error as Error).message}`);
      }
    }
  ));

  console.log('[Teams] Registered 3 SDB tools: team_list, team_create, team_add_member');
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
