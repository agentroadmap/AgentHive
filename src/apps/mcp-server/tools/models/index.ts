import type { McpServer } from "../../server.ts";
import { PgModelHandlers } from "../spending/pg-handlers.ts";

export function registerModelTools(
	server: McpServer,
	projectRoot = process.cwd(),
): void {
	const handlers = new PgModelHandlers(server, projectRoot);

	// P059: Enhanced model_list with capability filtering and is_active support
	server.addTool({
		name: "model_list",
		description: "List models registered in Postgres with optional capability and cost filters",
		inputSchema: {
			type: "object",
			properties: {
				capability: { type: "string", description: "Filter by capability, e.g. 'tool_use=true'" },
				max_cost_per_1k_input: { type: "string", description: "Max cost per 1k input tokens" },
				active_only: { type: "boolean", description: "Only show active models (default: true)" },
			},
		},
		handler: async (args: Record<string, unknown>) =>
			await handlers.listModels({
				capability: typeof args.capability === "string" ? args.capability : undefined,
				max_cost_per_1k_input: typeof args.max_cost_per_1k_input === "string" ? args.max_cost_per_1k_input : undefined,
				active_only: typeof args.active_only === "boolean" ? args.active_only : undefined,
			}),
	});

	// P059: Enhanced model_add with is_active and context_window support
	server.addTool({
		name: "model_add",
		description: "Register or update a model in Postgres",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string" },
				model_name: { type: "string" },
				provider: { type: "string" },
				cost_per_1k_input: { type: "string" },
				cost_per_1k_output: { type: "string" },
				max_tokens: { type: "string" },
				context_window: { type: "string" },
				capabilities: { type: "string", description: "JSON object, e.g. '{\"tool_use\":true,\"vision\":true}'" },
				rating: { type: "string" },
				is_active: { type: "string", description: "'true' or 'false' to activate/deactivate" },
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
				context_window:
					typeof args.context_window === "string" ? args.context_window : undefined,
				capabilities:
					typeof args.capabilities === "string" ? args.capabilities : undefined,
				rating: typeof args.rating === "string" ? args.rating : undefined,
				is_active: typeof args.is_active === "string" ? args.is_active : undefined,
			}),
	});
}
