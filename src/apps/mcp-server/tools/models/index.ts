import type { McpServer } from "../../server.ts";
import { PgModelHandlers } from "../spending/pg-handlers.ts";

export function registerModelTools(
	server: McpServer,
	projectRoot = process.cwd(),
): void {
	const handlers = new PgModelHandlers(server, projectRoot);

// P797: model_list with provider/tier/project_id filtering and route join
	server.addTool({
		name: "model_list",
		description: "List models registered in Postgres with optional capability, cost, provider, and tier filters. Results are joined with model_routes — only models with at least one enabled route are returned.",
		inputSchema: {
			type: "object",
			properties: {
				capability: { type: "string", description: "Filter by capability, e.g. 'tool_use=true'" },
				max_cost_per_1k_input: { type: "string", description: "Max cost per 1k input tokens" },
				active_only: { type: "boolean", description: "Only show active models (default: true)" },
				provider: { type: "string", description: "Filter by route provider (e.g. 'anthropic', 'openai')" },
				tier: {
					type: "string",
					enum: ["frontier", "standard", "economy"],
					description: "Filter by model tier: frontier, standard, or economy",
				},
				project_id: { type: "number", description: "Optional project context for future per-project route filtering" },
			},
		},
		handler: async (args: Record<string, unknown>) =>
			await handlers.listModels({
				capability: typeof args.capability === "string" ? args.capability : undefined,
				max_cost_per_1k_input: typeof args.max_cost_per_1k_input === "string" ? args.max_cost_per_1k_input : undefined,
				active_only: typeof args.active_only === "boolean" ? args.active_only : undefined,
				provider: typeof args.provider === "string" ? args.provider : undefined,
				tier: typeof args.tier === "string" ? args.tier : undefined,
				project_id: typeof args.project_id === "number" ? args.project_id : undefined,
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
				cost_per_million_input: { type: "string" },
				cost_per_million_output: { type: "string" },
				cost_per_million_cache_write: { type: "string" },
				cost_per_million_cache_hit: { type: "string" },
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
				cost_per_million_input:
					typeof args.cost_per_million_input === "string"
						? args.cost_per_million_input
						: undefined,
				cost_per_million_output:
					typeof args.cost_per_million_output === "string"
						? args.cost_per_million_output
						: undefined,
				cost_per_million_cache_write:
					typeof args.cost_per_million_cache_write === "string"
						? args.cost_per_million_cache_write
						: undefined,
				cost_per_million_cache_hit:
					typeof args.cost_per_million_cache_hit === "string"
						? args.cost_per_million_cache_hit
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
