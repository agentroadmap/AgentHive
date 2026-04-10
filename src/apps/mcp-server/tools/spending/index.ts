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
		description: "Generate token efficiency report",
		inputSchema: {},
		handler: async (args) => handlers.getTokenEfficiencyReport(args as any),
	});
}
