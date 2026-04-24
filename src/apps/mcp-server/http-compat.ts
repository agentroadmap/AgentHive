import type { McpServer } from "./server.ts";

type JsonRpcRequest = {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: {
		name?: string;
		arguments?: Record<string, unknown>;
	};
};

type JsonRpcResponse =
	| {
			jsonrpc: "2.0";
			id: string | number | null;
			result: unknown;
	  }
	| {
			jsonrpc: "2.0";
			id: string | number | null;
			error: {
				code: number;
				message: string;
			};
	  };

function errorResponse(
	id: string | number | null,
	code: number,
	message: string,
): JsonRpcResponse {
	return {
		jsonrpc: "2.0",
		id,
		error: { code, message },
	};
}

/**
 * Handle the direct MCP HTTP POST used by internal callers and smoke tests.
 *
 * This accepts the small JSON-RPC surface needed to verify MCP health without
 * opening a streaming session: `initialize`, `tools/list`, `tools/call`, and
 * `notifications/initialized`. Full clients should continue using SSE or
 * StreamableHTTP.
 */
export async function handleDirectMcpRequest(
	server: McpServer,
	payload: unknown,
): Promise<{ status: number; body: JsonRpcResponse }> {
	if (typeof payload !== "object" || payload === null) {
		return {
			status: 400,
			body: errorResponse(null, -32600, "Invalid JSON-RPC request"),
		};
	}

	const request = payload as JsonRpcRequest;
	const id = request.id ?? null;

	if (request.jsonrpc !== "2.0") {
		return {
			status: 400,
			body: errorResponse(id, -32600, "Invalid JSON-RPC request"),
		};
	}

	if (request.method === "initialize") {
		return {
			status: 200,
			body: {
				jsonrpc: "2.0",
				id,
				result: {
					protocolVersion: "2024-11-05",
					capabilities: {
						tools: { listChanged: true },
						resources: { listChanged: true },
						prompts: { listChanged: true },
					},
					serverInfo: {
						name: "agenthive",
						version: "direct-http",
					},
				},
			},
		};
	}

	if (request.method === "notifications/initialized") {
		return {
			status: 202,
			body: {
				jsonrpc: "2.0",
				id,
				result: {},
			},
		};
	}

	if (request.method === "tools/list") {
		try {
			const result = await server.testInterface.listTools();
			return {
				status: 200,
				body: {
					jsonrpc: "2.0",
					id,
					result,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				status: 500,
				body: errorResponse(id, -32000, message),
			};
		}
	}

	if (request.method !== "tools/call") {
		return {
			status: 400,
			body: errorResponse(id, -32600, "Unsupported JSON-RPC method"),
		};
	}

	const toolName = request.params?.name;
	const toolArguments = request.params?.arguments ?? {};
	if (!toolName || typeof toolName !== "string") {
		return {
			status: 400,
			body: errorResponse(id, -32602, "Tool name is required"),
		};
	}

	try {
		const result = await server.testInterface.callTool({
			params: {
				name: toolName,
				arguments: toolArguments,
			},
		});
		return {
			status: 200,
			body: {
				jsonrpc: "2.0",
				id,
				result,
			},
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const code = message.startsWith("Tool not found") ? -32601 : -32000;
		return {
			status: code === -32601 ? 404 : 500,
			body: errorResponse(id, code, message),
		};
	}
}
