import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const agentGuidelinesContent = readFileSync(
	join(__dirname, "./agent-guidelines.md"),
	"utf-8",
);
const mcpAgentNudgeContent = readFileSync(
	join(__dirname, "./mcp/agent-nudge.md"),
	"utf-8",
);
const claudeAgentContent = readFileSync(
	join(__dirname, "./project-manager-roadmap.md"),
	"utf-8",
);

export const AGENT_GUIDELINES = agentGuidelinesContent;
export const CLAUDE_GUIDELINES = agentGuidelinesContent;
export const CURSOR_GUIDELINES = agentGuidelinesContent;
export const GEMINI_GUIDELINES = agentGuidelinesContent;
export const COPILOT_GUIDELINES = agentGuidelinesContent;
export const README_GUIDELINES = `## AI Agent Guidelines\n\n${agentGuidelinesContent.replace(/^#.*\n/, "")}`;
export const CLAUDE_AGENT_CONTENT = claudeAgentContent;
export const MCP_AGENT_NUDGE = mcpAgentNudgeContent;
