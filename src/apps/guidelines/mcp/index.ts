import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const chatSkill = readFileSync(join(__dirname, "./chat-skill.md"), "utf-8");
const initRequired = readFileSync(
	join(__dirname, "./init-required.md"),
	"utf-8",
);
const overviewResources = readFileSync(
	join(__dirname, "./overview.md"),
	"utf-8",
);
const overviewTools = readFileSync(
	join(__dirname, "./overview-tools.md"),
	"utf-8",
);
const proposalCreation = readFileSync(
	join(__dirname, "./proposal-creation.md"),
	"utf-8",
);
const proposalExecution = readFileSync(
	join(__dirname, "./proposal-execution.md"),
	"utf-8",
);
const proposalFinalization = readFileSync(
	join(__dirname, "./proposal-finalization.md"),
	"utf-8",
);

export const MCP_WORKFLOW_OVERVIEW = overviewResources.trim();
export const MCP_WORKFLOW_OVERVIEW_TOOLS = overviewTools.trim();
export const MCP_STATE_CREATION_GUIDE = proposalCreation.trim();
export const MCP_STATE_EXECUTION_GUIDE = proposalExecution.trim();
export const MCP_STATE_FINALIZATION_GUIDE = proposalFinalization.trim();
export const MCP_INIT_REQUIRED_GUIDE = initRequired.trim();
export const MCP_CHAT_SKILL = chatSkill.trim();
