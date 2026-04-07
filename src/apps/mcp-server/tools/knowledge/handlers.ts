/**
 * MCP tool handlers for knowledge base operations
 */

import {
	KnowledgeBase,
	type KnowledgeEntryType,
	type KnowledgeSearchQuery,
} from "../../../../core/infrastructure/knowledge-base.ts";
import { McpError } from "../../errors/mcp-errors.ts";
import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";

export class KnowledgeHandlers {
	private knowledgeBase: KnowledgeBase | null = null;

	constructor(private readonly server: McpServer) {}

	private getKnowledgeBase(): KnowledgeBase {
		if (!this.knowledgeBase) {
			const cwd = process.cwd();
			this.knowledgeBase = new KnowledgeBase(cwd);
		}
		return this.knowledgeBase;
	}

	async addEntry(args: {
		type: KnowledgeEntryType;
		title: string;
		content: string;
		keywords?: string[];
		relatedProposals?: string[];
		sourceProposalId?: string;
		author: string;
		confidence?: number;
		tags?: string[];
	}): Promise<CallToolResult> {
		try {
			const kb = this.getKnowledgeBase();
			const entry = await kb.addEntry({
				type: args.type,
				title: args.title,
				content: args.content,
				keywords: args.keywords || [],
				relatedProposals: args.relatedProposals || [],
				sourceProposalId: args.sourceProposalId,
				author: args.author,
				confidence: args.confidence ?? 50,
				tags: args.tags || [],
			});

			return {
				content: [
					{
						type: "text",
						text: `Added knowledge entry:\n- ID: ${entry.id}\n- Type: ${entry.type}\n- Title: ${entry.title}\n- Author: ${entry.author}\n- Confidence: ${entry.confidence}`,
					},
				],
			};
		} catch (error) {
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	async search(args: {
		keywords: string[];
		type?: KnowledgeEntryType;
		tags?: string[];
		minConfidence?: number;
		relatedProposal?: string;
		limit?: number;
	}): Promise<CallToolResult> {
		try {
			const kb = this.getKnowledgeBase();

			const query: KnowledgeSearchQuery = {
				keywords: args.keywords,
				type: args.type,
				tags: args.tags,
				minConfidence: args.minConfidence,
				relatedProposal: args.relatedProposal,
				limit: args.limit,
			};

			const results = await kb.search(query);

			if (results.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No knowledge entries found for keywords: ${args.keywords.join(", ")}`,
						},
					],
				};
			}

			const lines = [`Found ${results.length} knowledge entries:`];
			for (const result of results) {
				lines.push("");
				lines.push(`### ${result.entry.title} (${result.entry.type})`);
				lines.push(`- ID: ${result.entry.id}`);
				lines.push(`- Relevance: ${result.relevanceScore}%`);
				lines.push(`- Confidence: ${result.entry.confidence}%`);
				lines.push(`- Author: ${result.entry.author}`);
				lines.push(`- Keywords: ${result.entry.keywords.join(", ")}`);
				lines.push(`- Matched: ${result.matchedKeywords.join(", ")}`);
				if (result.entry.relatedProposals.length > 0) {
					lines.push(
						`- Related Proposals: ${result.entry.relatedProposals.join(", ")}`,
					);
				}
				lines.push(
					`- Helpful: ${result.entry.helpfulCount} | References: ${result.entry.referenceCount}`,
				);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
			};
		} catch (error) {
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	async recordDecision(args: {
		title: string;
		content: string;
		rationale: string;
		alternatives?: string[];
		author: string;
		relatedProposalId?: string;
		tags?: string[];
	}): Promise<CallToolResult> {
		try {
			const kb = this.getKnowledgeBase();
			const entry = await kb.recordDecision({
				title: args.title,
				content: args.content,
				rationale: args.rationale,
				alternatives: args.alternatives || [],
				author: args.author,
				relatedProposalId: args.relatedProposalId,
				tags: args.tags,
			});

			return {
				content: [
					{
						type: "text",
						text: `Recorded decision:\n- ID: ${entry.id}\n- Title: ${entry.title}\n- Author: ${entry.author}\n- Confidence: ${entry.confidence}`,
					},
				],
			};
		} catch (error) {
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	async extractPattern(args: {
		name: string;
		description: string;
		codeExample?: string;
		firstSeenAt: string;
		relatedEntries?: string[];
	}): Promise<CallToolResult> {
		try {
			const kb = this.getKnowledgeBase();
			const pattern = await kb.extractPattern({
				name: args.name,
				description: args.description,
				codeExample: args.codeExample,
				firstSeenAt: args.firstSeenAt,
				relatedEntries: args.relatedEntries || [],
			});

			return {
				content: [
					{
						type: "text",
						text: `Extracted pattern:\n- ID: ${pattern.id}\n- Name: ${pattern.name}\n- First Seen: ${pattern.firstSeenAt}`,
					},
				],
			};
		} catch (error) {
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	async getDecisions(args: {
		relatedProposal?: string;
	}): Promise<CallToolResult> {
		try {
			const kb = this.getKnowledgeBase();
			const decisions = await kb.getDecisions({
				relatedProposal: args.relatedProposal,
			});

			if (decisions.length === 0) {
				return {
					content: [{ type: "text", text: "No decisions recorded." }],
				};
			}

			const lines = [`Recorded Decisions (${decisions.length}):`];
			for (const decision of decisions) {
				lines.push("");
				lines.push(`### ${decision.title}`);
				lines.push(`- ID: ${decision.id}`);
				lines.push(`- Author: ${decision.author}`);
				lines.push(`- Confidence: ${decision.confidence}%`);
				lines.push(`- Created: ${decision.createdAt}`);
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
			};
		} catch (error) {
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	async getStats(): Promise<CallToolResult> {
		try {
			const kb = this.getKnowledgeBase();
			const stats = await kb.getStats();

			const lines = [
				"Knowledge Base Statistics:",
				`- Total Entries: ${stats.totalEntries}`,
				`- Total Patterns: ${stats.totalPatterns}`,
				`- Average Confidence: ${stats.averageConfidence}%`,
				"",
				"Entries by Type:",
			];

			for (const [type, count] of Object.entries(stats.entriesByType)) {
				lines.push(`  - ${type}: ${count}`);
			}

			if (stats.topContributors.length > 0) {
				lines.push("");
				lines.push("Top Contributors:");
				for (const contrib of stats.topContributors) {
					lines.push(`  - ${contrib.author}: ${contrib.count} entries`);
				}
			}

			if (stats.mostHelpful.length > 0) {
				lines.push("");
				lines.push("Most Helpful Entries:");
				for (const entry of stats.mostHelpful) {
					lines.push(`  - ${entry.title} (${entry.helpfulCount} upvotes)`);
				}
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
			};
		} catch (error) {
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	async markHelpful(args: { entryId: string }): Promise<CallToolResult> {
		try {
			const kb = this.getKnowledgeBase();
			const marked = await kb.markHelpful(args.entryId);

			if (!marked) {
				return {
					content: [
						{
							type: "text",
							text: `Entry ${args.entryId} not found.`,
						},
					],
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Marked entry ${args.entryId} as helpful.`,
					},
				],
			};
		} catch (error) {
			if (error instanceof Error) {
				throw new McpError(error.message, "OPERATION_FAILED");
			}
			throw new McpError(String(error), "OPERATION_FAILED");
		}
	}

	dispose(): void {
		if (this.knowledgeBase) {
			this.knowledgeBase.close();
			this.knowledgeBase = null;
		}
	}
}
