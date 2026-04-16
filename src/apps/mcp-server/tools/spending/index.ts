import type { McpServer } from "../../server.ts";
import { PgSpendingHandlers } from "./pg-handlers.ts";

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
}
