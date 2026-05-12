import type { McpServer } from "../../server.ts";
import { PgSpendingHandlers, reportAgentUsage } from "./pg-handlers.ts";

export function registerSpendingTools(server: McpServer): void {
	const projectRoot = server.filesystem.rootDir;
	const handlers = new PgSpendingHandlers(server, projectRoot);

	server.addTool({
		name: "spending_set_cap",
		description: "Set spending cap for an agent",
		inputSchema: {},
		handler: async (args) => handlers.setSpendingCap(args as any),
	});

	server.addTool({
		name: "spending_log",
		description: "Log a spending event",
		inputSchema: {},
		handler: async (args) => handlers.logSpending(args as any),
	});

	server.addTool({
		name: "spending_report",
		description: "Generate spending report",
		inputSchema: {},
		handler: async (args) => handlers.getSpendingReport(args as any),
	});

	server.addTool({
		name: "spending_efficiency_report",
		description: "Generate token efficiency report. Use granularity='daily' for per-day breakdown (AC-7), default is weekly.",
		inputSchema: {
			type: "object",
			properties: {
				agent_identity: { type: "string", description: "Filter by agent identity (e.g. 'claude/one')" },
				model_name: { type: "string", description: "Filter by model name" },
				granularity: { type: "string", enum: ["daily", "weekly"], description: "Report granularity (default: weekly)" },
			},
		},
		handler: async (args) => handlers.getTokenEfficiencyReport(args as any),
	});

	// P1004: agent usage & quota self-reporting
	server.addTool({
		name: "ops_report_usage",
		description:
			"P1004: Report LLM API usage and quota state from an agent subprocess. " +
			"Call after each significant API interaction. Triggers a budget_alert pg_notify " +
			"when quota_remaining < 20% of quota_limit. " +
			"Providers: anthropic | codex | gemini | openai | custom.",
		inputSchema: {
			type: "object",
			properties: {
				provider:               { type: "string", description: "Provider identifier (anthropic | codex | gemini | openai | custom)" },
				agent_identity:         { type: "string", description: "Caller agent identity (e.g. 'adam')" },
				session_id:             { type: "string", description: "Links to agent_runs display_id (e.g. 'wt:claude-one')" },
				tokens_in:              { type: "number", description: "Raw input tokens billed" },
				tokens_out:             { type: "number", description: "Raw output tokens billed" },
				cache_creation_tokens:  { type: "number", description: "Cache write tokens (+25% surcharge on Anthropic)" },
				cache_read_tokens:      { type: "number", description: "Cache read tokens (zero rate-limit cost on Anthropic)" },
				quota_remaining:        { type: "number", description: "Tokens remaining in quota window (from rate-limit header)" },
				quota_limit:            { type: "number", description: "Total quota window limit" },
				quota_reset_at:         { type: "string", description: "ISO timestamp of quota window reset" },
				cost_usd_estimate:      { type: "number", description: "Agent-computed cost estimate (null for subscription billing)" },
				raw_headers:            { type: "object", description: "JSONB dump of relevant response headers for audit" },
			},
			required: ["provider", "agent_identity"],
		},
		handler: async (args) => reportAgentUsage(args as any),
	});
}
