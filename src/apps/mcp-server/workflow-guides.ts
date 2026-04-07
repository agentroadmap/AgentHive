import {
	MCP_CHAT_SKILL,
	MCP_STATE_CREATION_GUIDE,
	MCP_STATE_EXECUTION_GUIDE,
	MCP_STATE_FINALIZATION_GUIDE,
	MCP_WORKFLOW_OVERVIEW,
	MCP_WORKFLOW_OVERVIEW_TOOLS,
} from "../guidelines/mcp/index.ts";

export interface WorkflowGuideDefinition {
	key:
		| "overview"
		| "proposal-creation"
		| "proposal-execution"
		| "proposal-finalization"
		| "chat-skill";
	uri: string;
	name: string;
	description: string;
	mimeType: string;
	resourceText: string;
	toolText?: string;
	toolName: string;
	toolDescription: string;
}

export const WORKFLOW_GUIDES: WorkflowGuideDefinition[] = [
	{
		key: "overview",
		uri: "roadmap://workflow/overview",
		name: "Roadmap Workflow Overview",
		description:
			"Overview of when and how to use Roadmap.md for proposal management",
		mimeType: "text/markdown",
		resourceText: MCP_WORKFLOW_OVERVIEW,
		toolText: MCP_WORKFLOW_OVERVIEW_TOOLS,
		toolName: "get_workflow_overview",
		toolDescription:
			"Retrieve the Roadmap.md workflow overview guidance in markdown format",
	},
	{
		key: "proposal-creation",
		uri: "roadmap://workflow/proposal-creation",
		name: "Proposal Creation Guide",
		description:
			"Detailed guide for creating proposals: scope assessment, acceptance criteria, parent/subproposals",
		mimeType: "text/markdown",
		resourceText: MCP_STATE_CREATION_GUIDE,
		toolName: "get_proposal_creation_guide",
		toolDescription:
			"Retrieve the Roadmap.md proposal creation guide in markdown format",
	},
	{
		key: "proposal-execution",
		uri: "roadmap://workflow/proposal-execution",
		name: "Proposal Execution Guide",
		description:
			"Detailed guide for planning and executing proposals: workflow, discipline, scope changes",
		mimeType: "text/markdown",
		resourceText: MCP_STATE_EXECUTION_GUIDE,
		toolName: "get_proposal_execution_guide",
		toolDescription:
			"Retrieve the Roadmap.md proposal execution guide in markdown format",
	},
	{
		key: "proposal-finalization",
		uri: "roadmap://workflow/proposal-finalization",
		name: "Proposal Finalization Guide",
		description:
			"Detailed guide for finalizing proposals: finalization workflow, next steps",
		mimeType: "text/markdown",
		resourceText: MCP_STATE_FINALIZATION_GUIDE,
		toolName: "get_proposal_finalization_guide",
		toolDescription:
			"Retrieve the Roadmap.md proposal finalization guide in markdown format",
	},
	{
		key: "chat-skill",
		uri: "roadmap://skills/chat",
		name: "Chat Skill: Listen & Respond",
		description:
			"How to listen to project chat channels and respond to messages from humans and other agents",
		mimeType: "text/markdown",
		resourceText: MCP_CHAT_SKILL,
		toolName: "get_chat_skill",
		toolDescription:
			"Retrieve the chat skill guide: how to listen to channels and respond to messages using msg_read, msg_send, and chan_list tools",
	},
];

export function getWorkflowGuideByUri(
	uri: string,
): WorkflowGuideDefinition | undefined {
	return WORKFLOW_GUIDES.find((guide) => guide.uri === uri);
}
