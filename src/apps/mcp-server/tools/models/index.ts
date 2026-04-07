import type { McpServer } from "../../server.ts";
import { PgModelHandlers } from "../spending/pg-handlers.ts";

export function registerModelTools(
	server: McpServer,
	projectRoot = process.cwd(),
): void {
	const handlers = new PgModelHandlers(server, projectRoot);

	server.addTool({
		name: "model_list",
		description: "List models registered in Postgres",
		inputSchema: {
			type: "object",
			properties: {},
		},
		handler: async () => await handlers.listModels({}),
	});

	server.addTool({
		name: "model_add",
		description: "Register a model in Postgres",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string" },
				model_name: { type: "string" },
				provider: { type: "string" },
				cost_per_1k_input: { type: "string" },
				cost_per_1k_output: { type: "string" },
				max_tokens: { type: "string" },
				capabilities: { type: "string" },
				rating: { type: "string" },
			},
			required: ["name"],
		},
		handler: async (args: any) =>
			await handlers.addModel({
				model_name: String(args.model_name ?? args.name),
				provider: typeof args.provider === "string" ? args.provider : undefined,
				cost_per_1k_input:
					typeof args.cost_per_1k_input === "string"
						? args.cost_per_1k_input
						: undefined,
				cost_per_1k_output:
					typeof args.cost_per_1k_output === "string"
						? args.cost_per_1k_output
						: undefined,
				max_tokens:
					typeof args.max_tokens === "string" ? args.max_tokens : undefined,
				capabilities:
					typeof args.capabilities === "string" ? args.capabilities : undefined,
				rating: typeof args.rating === "string" ? args.rating : undefined,
			}),
	});
}
