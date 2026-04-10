import type { McpServer } from "../../server.ts";
import type { CallToolResult } from "../../types.ts";
import { PgMemoryHandlers } from "./pg-handlers.ts";

function textResult(text: string): CallToolResult {
	return { content: [{ type: "text", text }] };
}

export function registerMemoryTools(server: McpServer): void {
	const handlers = new PgMemoryHandlers(server);

	server.addTool({
		name: "memory_set",
		description: "Store agent memory in the Postgres memory layer",
		inputSchema: {
			type: "object",
			properties: {
				agent_identity: { type: "string" },
				layer: { type: "string" },
				key: { type: "string" },
				value: { type: "string" },
				metadata: { type: "string" },
				ttl_seconds: { type: "number" },
			},
			required: ["key", "value"],
		},
		handler: async (args: Record<string, unknown>) =>
			await handlers.setMemory({
				agent_identity: String(args.agent_identity ?? "system"),
				layer: String(args.layer ?? "working"),
				key: String(args.key),
				value: String(args.value),
				metadata: typeof args.metadata === "string" ? args.metadata : undefined,
				ttl_seconds:
					typeof args.ttl_seconds === "number" ? args.ttl_seconds : undefined,
			}),
	});

	server.addTool({
		name: "memory_get",
		description: "Read agent memory from the Postgres memory layer",
		inputSchema: {
			type: "object",
			properties: {
				agent_identity: { type: "string" },
				layer: { type: "string" },
				key: { type: "string" },
			},
			required: [],
		},
		handler: async (args: Record<string, unknown>) =>
			await handlers.getMemory({
				agent_identity: String(args.agent_identity ?? "system"),
				layer: String(args.layer ?? "working"),
				key: typeof args.key === "string" ? args.key : undefined,
			}),
	});

	server.addTool({
		name: "memory_search",
		description: "Search agent memory in Postgres",
		inputSchema: {
			type: "object",
			properties: {
				agent_identity: { type: "string" },
				layer: { type: "string" },
				embedding: { type: "array", items: { type: "number" } },
				query: { type: "string" },
				top_k: { type: "number" },
				threshold: { type: "number" },
			},
			required: [],
		},
		handler: async (args: Record<string, unknown>) => {
			if (!Array.isArray(args.embedding)) {
				return textResult(
					"Memory search requires an embedding vector in Postgres mode.",
				);
			}
			return await handlers.searchMemory({
				agent_identity:
					typeof args.agent_identity === "string"
						? args.agent_identity
						: undefined,
				layer: typeof args.layer === "string" ? args.layer : undefined,
				embedding: args.embedding.map((value: unknown) => Number(value)),
				top_k: typeof args.top_k === "number" ? args.top_k : undefined,
				threshold:
					typeof args.threshold === "number" ? args.threshold : undefined,
			});
		},
	});
}
