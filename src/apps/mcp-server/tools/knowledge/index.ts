/**
 * MCP tools for knowledge base operations
 *
 * STATE-47: Agent Knowledge Base & Documentation
 * AC#4: Knowledge base accessible via MCP tool
 */

import type { McpServer } from "../../server.ts";
import type { McpToolHandler } from "../../types.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import { KnowledgeHandlers } from "./handlers.ts";
import {
	knowledgeAddSchema,
	knowledgeExtractPatternSchema,
	knowledgeGetDecisionsSchema,
	knowledgeGetStatsSchema,
	knowledgeMarkHelpfulSchema,
	knowledgeRecordDecisionSchema,
	knowledgeSearchSchema,
} from "./schemas.ts";

export function registerKnowledgeTools(server: McpServer): void {
	const handlers = new KnowledgeHandlers(server);

	const addEntryTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "knowledge_add",
			description:
				"Add a knowledge entry (solution, pattern, decision, obstacle, or learned lesson)",
			inputSchema: knowledgeAddSchema,
		},
		knowledgeAddSchema,
		async (input) => handlers.addEntry(input as any),
	);

	const searchTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "knowledge_search",
			description: "Search the knowledge base by keywords with fuzzy matching",
			inputSchema: knowledgeSearchSchema,
		},
		knowledgeSearchSchema,
		async (input) => handlers.search(input as any),
	);

	const recordDecisionTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "knowledge_record_decision",
			description:
				"Record an architectural or technical decision with rationale and alternatives",
			inputSchema: knowledgeRecordDecisionSchema,
		},
		knowledgeRecordDecisionSchema,
		async (input) => handlers.recordDecision(input as any),
	);

	const extractPatternTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "knowledge_extract_pattern",
			description:
				"Extract and index a common pattern from successful solutions",
			inputSchema: knowledgeExtractPatternSchema,
		},
		knowledgeExtractPatternSchema,
		async (input) => handlers.extractPattern(input as any),
	);

	const getDecisionsTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "knowledge_get_decisions",
			description:
				"Get all recorded decisions, optionally filtered by related proposal",
			inputSchema: knowledgeGetDecisionsSchema,
		},
		knowledgeGetDecisionsSchema,
		async (input) => handlers.getDecisions(input as any),
	);

	const getStatsTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "knowledge_get_stats",
			description: "Get statistics about the knowledge base",
			inputSchema: knowledgeGetStatsSchema,
		},
		knowledgeGetStatsSchema,
		async () => handlers.getStats(),
	);

	const markHelpfulTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "knowledge_mark_helpful",
			description: "Mark a knowledge entry as helpful (upvote)",
			inputSchema: knowledgeMarkHelpfulSchema,
		},
		knowledgeMarkHelpfulSchema,
		async (input) => handlers.markHelpful(input as any),
	);

	server.addTool(addEntryTool);
	server.addTool(searchTool);
	server.addTool(recordDecisionTool);
	server.addTool(extractPatternTool);
	server.addTool(getDecisionsTool);
	server.addTool(getStatsTool);
	server.addTool(markHelpfulTool);
}
