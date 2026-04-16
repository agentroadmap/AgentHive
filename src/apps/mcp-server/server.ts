import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	GetPromptRequestSchema,
	ListPromptsRequestSchema,
	ListResourcesRequestSchema,
	ListResourceTemplatesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { RelayService } from "../../core/messaging/relay.ts";
import { PipelineCron } from "../../core/pipeline/pipeline-cron.ts";
import { Core } from "../../core/roadmap.ts";
import * as pgPool from "../../postgres/pool.ts";
import { getPackageName } from "../../shared/utils/app-info.ts";
import { getVersion } from "../../shared/utils/version.ts";
import { registerInitRequiredResource } from "./resources/init-required/index.ts";
import { registerWorkflowResources } from "./resources/workflow/index.ts";
import { registerAgentTools } from "./tools/agents/index.ts";
import { registerCubicTools } from "./tools/cubic/index.ts";
import { registerDocumentTools } from "./tools/documents/index.ts";
import { registerKnowledgeTools } from "./tools/knowledge/index.ts";
import { registerMessageTools } from "./tools/messages/index.ts";
import { registerMilestoneTools } from "./tools/milestones/index.ts";
import { registerNoteTools } from "./tools/notes/index.ts";
import { registerProposalTools as registerFilesystemProposalTools } from "./tools/proposals/index.ts";
import { registerProtocolTools } from "./tools/protocol/index.ts";
import { registerTeamTools } from "./tools/teams/index.ts";
import { registerTestingTools } from "./tools/testing/index.ts";
import { registerWorkflowTools } from "./tools/workflow/index.ts";
import { registerDependencyTools } from "./tools/dependencies/index.ts";
import { registerWorktreeMergeTools } from "./tools/worktree-merge/index.ts";
import { registerConsolidatedTools } from "./tools/consolidated.ts";
import type {
	CallToolResult,
	GetPromptResult,
	ListPromptsResult,
	ListResourcesResult,
	ListResourceTemplatesResult,
	ListToolsResult,
	McpPromptHandler,
	McpResourceHandler,
	McpToolHandler,
	ReadResourceResult,
} from "./types.ts";

/**
 * Minimal MCP server implementation for stdio transport.
 *
 * The Roadmap.md MCP server is intentionally local-only and exposes tools,
 * resources, and prompts through the stdio transport so that desktop editors
 * (e.g. Claude Code) can interact with a project without network exposure.
 */
const APP_NAME = getPackageName();
const APP_VERSION = await getVersion();
const INSTRUCTIONS_NORMAL =
	"At the beginning of each session, read the roadmap://workflow/overview resource to understand how AgentHive proposals, workflow stages, and maturity are managed through the roadmap MCP surface. Additional detailed guides are available as resources when needed.";
const INSTRUCTIONS_FALLBACK =
	"The roadmap workspace is not initialized in this directory. Read the roadmap://init-required resource for setup instructions.";
const SHOW_LEGACY_TOOLS = process.env.MCP_LEGACY_TOOLS === "1";
const CONSOLIDATED_TOOL_NAMES = new Set([
	"mcp_project",
	"mcp_proposal",
	"mcp_message",
	"mcp_agent",
	"mcp_memory",
	"mcp_document",
	"mcp_ops",
]);

// Track whether gate pipeline (PipelineCron) has already been started to avoid duplicates
let gatePipelineStarted = false;

type ServerInitOptions = {
	debug?: boolean;
};

type SseTransportResponse = ConstructorParameters<typeof SSEServerTransport>[1];
type SseTransportRequest = Parameters<
	SSEServerTransport["handlePostMessage"]
>[0];
type SseTransportBody = Parameters<SSEServerTransport["handlePostMessage"]>[2];

export class McpServer extends Core {
	private readonly server: Server;
	private transport?: StdioServerTransport;
	private stopping = false;
	private consolidatedToolSurface = false;

	private readonly tools = new Map<string, McpToolHandler>();
	private readonly resources = new Map<string, McpResourceHandler>();
	private readonly prompts = new Map<string, McpPromptHandler>();

	constructor(projectRoot: string, instructions: string) {
		super(projectRoot, { enableWatchers: true });

		this.server = new Server(
			{
				name: APP_NAME,
				version: APP_VERSION,
			},
			{
				capabilities: {
					tools: { listChanged: true },
					resources: { listChanged: true },
					prompts: { listChanged: true },
				},
				instructions,
			},
		);

		this.setupHandlers();
	}

	private setupHandlers(): void {
		this.server.setRequestHandler(ListToolsRequestSchema, async () =>
			this.listTools(),
		);
		this.server.setRequestHandler(CallToolRequestSchema, async (request) =>
			this.callTool(request),
		);
		this.server.setRequestHandler(ListResourcesRequestSchema, async () =>
			this.listResources(),
		);
		this.server.setRequestHandler(
			ListResourceTemplatesRequestSchema,
			async () => this.listResourceTemplates(),
		);
		this.server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
			this.readResource(request),
		);
		this.server.setRequestHandler(ListPromptsRequestSchema, async () =>
			this.listPrompts(),
		);
		this.server.setRequestHandler(GetPromptRequestSchema, async (request) =>
			this.getPrompt(request),
		);
	}

	/**
	 * Register a tool implementation with the server.
	 */
	public addTool(tool: McpToolHandler): void {
		this.tools.set(tool.name, tool);
	}

	public setConsolidatedToolSurface(enabled: boolean): void {
		this.consolidatedToolSurface = enabled;
	}

	/**
	 * Register a resource implementation with the server.
	 */
	public addResource(resource: McpResourceHandler): void {
		this.resources.set(resource.uri, resource);
	}

	/**
	 * Register a prompt implementation with the server.
	 */
	public addPrompt(prompt: McpPromptHandler): void {
		this.prompts.set(prompt.name, prompt);
	}

	/**
	 * Connect the server to the stdio transport.
	 */
	public async connect(): Promise<void> {
		if (this.transport) {
			return;
		}

		this.transport = new StdioServerTransport();
		await this.server.connect(this.transport);
	}

	/**
	 * Start the server. The stdio transport begins handling requests as soon as
	 * it is connected, so this method exists primarily for symmetry with
	 * callers that expect an explicit start step.
	 */
	public async start(): Promise<void> {
		if (!this.transport) {
			throw new Error(
				"MCP server not connected. Call connect() before start().",
			);
		}
	}

	/**
	 * Stop the server and release transport resources.
	 */
	public async stop(): Promise<void> {
		if (this.stopping) {
			return;
		}
		this.stopping = true;
		try {
			await this.server.close();
		} finally {
			this.transport = undefined;
			this.disposeSearchService();
			this.disposeContentStore();
		}
	}

	public getServer(): Server {
		return this.server;
	}

	// -- Internal handlers --------------------------------------------------

	protected async listTools(): Promise<ListToolsResult> {
		const tools = Array.from(this.tools.values()).filter(
			(tool) =>
				SHOW_LEGACY_TOOLS ||
				!this.consolidatedToolSurface ||
				CONSOLIDATED_TOOL_NAMES.has(tool.name),
		);
		return {
			tools: tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: {
					type: "object",
					...tool.inputSchema,
				},
			})),
		};
	}

	public async invokeTool(
		name: string,
		args: Record<string, unknown> = {},
	): Promise<CallToolResult> {
		const tool = this.tools.get(name);
		if (!tool) {
			throw new Error(`Tool not found: ${name}`);
		}
		return tool.handler(args);
	}

	protected async callTool(request: {
		params: { name: string; arguments?: Record<string, unknown> };
	}): Promise<CallToolResult> {
		const { name, arguments: args = {} } = request.params;
		const tool = this.tools.get(name);

		if (!tool) {
			throw new Error(`Tool not found: ${name}`);
		}

		const result = await tool.handler(args);

		// Log tool call to pulse
		try {
			await this.emitPulse({
				type: "tool_called",
				id: name,
				title: `Tool Called: ${name}`,
				agent: (args.agent as string) || (args.from as string) || "agent",
				impact: JSON.stringify(args),
				timestamp: new Date().toISOString(),
			});
		} catch (_err) {
			// Ignore pulse logging errors to not block tool execution
		}

		return result;
	}

	protected async listResources(): Promise<ListResourcesResult> {
		return {
			resources: Array.from(this.resources.values()).map((resource) => ({
				uri: resource.uri,
				name: resource.name || "Unnamed Resource",
				description: resource.description,
				mimeType: resource.mimeType,
			})),
		};
	}

	protected async listResourceTemplates(): Promise<ListResourceTemplatesResult> {
		return {
			resourceTemplates: [],
		};
	}

	protected async readResource(request: {
		params: { uri: string };
	}): Promise<ReadResourceResult> {
		const { uri } = request.params;

		// Exact match first
		let resource = this.resources.get(uri);

		// Fallback to base URI for parameterised resources
		if (!resource) {
			const baseUri = uri.split("?")[0] || uri;
			resource = this.resources.get(baseUri);
		}

		if (!resource) {
			throw new Error(`Resource not found: ${uri}`);
		}

		return await resource.handler(uri);
	}

	protected async listPrompts(): Promise<ListPromptsResult> {
		return {
			prompts: Array.from(this.prompts.values()).map((prompt) => ({
				name: prompt.name,
				description: prompt.description,
				arguments: prompt.arguments,
			})),
		};
	}

	protected async getPrompt(request: {
		params: { name: string; arguments?: Record<string, unknown> };
	}): Promise<GetPromptResult> {
		const { name, arguments: args = {} } = request.params;
		const prompt = this.prompts.get(name);

		if (!prompt) {
			throw new Error(`Prompt not found: ${name}`);
		}

		return await prompt.handler(args);
	}

	/**
	 * Create a new SSE transport for a connection.
	 */
	public async createSseTransport(
		endpoint: string,
		res: SseTransportResponse,
	): Promise<SSEServerTransport> {
		const transport = new SSEServerTransport(endpoint, res);
		await this.server.connect(transport);
		return transport;
	}

	/**
	 * Handle an incoming message for an SSE transport.
	 * The Express `req` and `res` objects are needed to write the response.
	 * Pass `parsedBody` (already parsed by Express) so the SDK doesn't try
	 * to re-read the request stream (which would fail with "stream not readable").
	 */
	public async handleSseMessage(
		transport: SSEServerTransport,
		req: SseTransportRequest,
		res: SseTransportResponse,
		parsedBody?: SseTransportBody,
	): Promise<void> {
		if (transport.handlePostMessage) {
			await transport.handlePostMessage(req, res, parsedBody);
		}
	}

	/**
	 * Helper exposed for tests so they can call handlers directly.
	 */
	public get testInterface() {
		return {
			listTools: () => this.listTools(),
			callTool: (request: {
				params: { name: string; arguments?: Record<string, unknown> };
			}) => this.callTool(request),
			listResources: () => this.listResources(),
			listResourceTemplates: () => this.listResourceTemplates(),
			readResource: (request: { params: { uri: string } }) =>
				this.readResource(request),
			listPrompts: () => this.listPrompts(),
			getPrompt: (request: {
				params: { name: string; arguments?: Record<string, unknown> };
			}) => this.getPrompt(request),
		};
	}
}

/**
 * Factory that bootstraps a fully configured MCP server instance.
 *
 * If roadmap is not initialized in the project directory, the server will start
 * successfully but only provide the roadmap://init-required resource to guide
 * users to run `roadmap init`.
 */
export async function createMcpServer(
	projectRoot: string,
	options: ServerInitOptions = {},
): Promise<McpServer> {
	// We need to check config first to determine which instructions to use
	const tempCore = new Core(projectRoot);
	await tempCore.ensureConfigLoaded();
	const config = await tempCore.filesystem.loadConfig();

	// Create server with appropriate instructions
	const instructions = config ? INSTRUCTIONS_NORMAL : INSTRUCTIONS_FALLBACK;
	const server = new McpServer(projectRoot, instructions);

	// Graceful fallback: if config doesn't exist, provide init-required resource
	if (!config) {
		registerInitRequiredResource(server);

		if (options.debug) {
			console.error(
				"MCP server initialised in fallback mode (roadmap not initialized in this directory).",
			);
		}

		return server;
	}

	// Normal mode: full tools and resources
	registerWorkflowResources(server);
	registerWorkflowTools(server);
	registerNoteTools(server, projectRoot);
	registerMilestoneTools(server);
	registerDocumentTools(server, config);
	registerKnowledgeTools(server);
	registerProtocolTools(server);
	registerCubicTools(server, projectRoot);
	registerWorktreeMergeTools(server, projectRoot);

	// --- Backend routing: Postgres vs filesystem ---
	const usePostgres = config.database?.provider === "Postgres";

	if (usePostgres) {
		if (config.database) {
			pgPool.initPoolFromConfig(config.database);
		}

		// Postgres-backed tools
		const { registerProposalTools } = await import(
			"./tools/proposals/backend-switch.ts"
		);
		registerProposalTools(server, projectRoot);

		const { PgMessagingHandlers } = await import(
			"./tools/messages/pg-handlers.ts"
		);
		const msg = new PgMessagingHandlers(server, projectRoot);
		type SendMessageArgs = Parameters<typeof msg.sendMessage>[0];
		type ReadMessagesArgs = Parameters<typeof msg.readMessages>[0];
		type ListChannelsArgs = Parameters<typeof msg.listChannels>[0];
		type SubscribeArgs = Parameters<typeof msg.subscribe>[0];
		type ListSubscriptionsArgs = Parameters<typeof msg.listSubscriptions>[0];
		server.addTool({
			name: "msg_send",
			description: "Send message via Postgres message_ledger",
			inputSchema: {
				type: "object",
				properties: {
					from_agent: { type: "string" },
					to_agent: { type: "string" },
					channel: { type: "string" },
					message_content: { type: "string" },
					message_type: { type: "string" },
					proposal_id: { type: "string" },
				},
				required: ["from_agent", "message_content"],
			},
			handler: (a) => msg.sendMessage(a as SendMessageArgs),
		});
		server.addTool({
			name: "msg_read",
			description:
				"Read messages from Postgres. With wait_ms, blocks until new messages arrive via pg_notify (0-30000ms).",
			inputSchema: {
				type: "object",
				properties: {
					agent: { type: "string", description: "Filter by agent identity" },
					channel: { type: "string", description: "Filter by channel name" },
					limit: { type: "number", description: "Max messages to return (default 50)" },
					wait_ms: {
						type: "number",
						description:
							"Block up to N milliseconds waiting for new messages via pg_notify (0-30000). Returns immediately if messages exist.",
					},
				},
			},
			handler: (a) => msg.readMessages(a as ReadMessagesArgs),
		});
		server.addTool({
			name: "chan_list",
			description: "List channels",
			inputSchema: { type: "object", properties: {} },
			handler: (a) => msg.listChannels(a as ListChannelsArgs),
		});
		// P149: Channel subscription for push notifications
		server.addTool({
			name: "chan_subscribe",
			description:
				"Subscribe or unsubscribe from a channel to receive push notifications via pg_notify when new messages arrive. Subscriptions persist in the database.",
			inputSchema: {
				type: "object",
				properties: {
					agent_identity: {
						type: "string",
						description: "Agent identity for the subscription",
					},
					channel: {
						type: "string",
						description:
							"Channel to subscribe to (direct, team:<name>, broadcast, system)",
					},
					subscribe: {
						type: "boolean",
						description: "True to subscribe, false to unsubscribe. Defaults to true.",
					},
				},
				required: ["agent_identity", "channel"],
			},
			handler: (a) => msg.subscribe(a as SubscribeArgs),
		});
		// P149: List active subscriptions
		server.addTool({
			name: "chan_subscriptions",
			description:
				"List channel subscriptions, optionally filtered by agent. Shows who is subscribed to which channels.",
			inputSchema: {
				type: "object",
				properties: {
					agent_identity: {
						type: "string",
						description: "Filter by agent identity (optional)",
					},
				},
			},
			handler: (a) => msg.listSubscriptions(a as ListSubscriptionsArgs),
		});

		const { PgAgentHandlers } = await import("./tools/agents/pg-handlers.ts");
		type ListPgAgentsArgs = Parameters<typeof agents.listAgents>[0];
		type GetPgAgentArgs = Parameters<typeof agents.getAgent>[0];
		type RegisterPgAgentArgs = Parameters<typeof agents.registerAgent>[0];
		type ListTeamsArgs = Parameters<typeof agents.listTeams>[0];
		type CreateTeamArgs = Parameters<typeof agents.createTeam>[0];
		type AddTeamMemberArgs = Parameters<typeof agents.addTeamMember>[0];
		const agents = new PgAgentHandlers();
		server.addTool({
			name: "agent_list",
			description: "List registered agents",
			inputSchema: {
				type: "object",
				properties: { status: { type: "string" } },
			},
			handler: (a) => agents.listAgents(a as ListPgAgentsArgs),
		});
		server.addTool({
			name: "agent_get",
			description: "Get agent details",
			inputSchema: {
				type: "object",
				properties: { identity: { type: "string" } },
				required: ["identity"],
			},
			handler: (a) => agents.getAgent(a as GetPgAgentArgs),
		});
		server.addTool({
			name: "agent_register",
			description: "Register or update an agent",
			inputSchema: {
				type: "object",
				properties: {
					identity: { type: "string" },
					agent_type: { type: "string" },
					role: { type: "string" },
					skills: { type: "string" },
				},
				required: ["identity"],
			},
			handler: (a) => agents.registerAgent(a as RegisterPgAgentArgs),
		});
		server.addTool({
			name: "team_list",
			description: "List teams",
			inputSchema: { type: "object", properties: {} },
			handler: (a) => agents.listTeams(a as ListTeamsArgs),
		});
		server.addTool({
			name: "team_create",
			description: "Create a team",
			inputSchema: {
				type: "object",
				properties: { name: { type: "string" }, team_type: { type: "string" } },
				required: ["name"],
			},
			handler: (a) => agents.createTeam(a as CreateTeamArgs),
		});
		server.addTool({
			name: "team_add_member",
			description: "Add agent to team",
			inputSchema: {
				type: "object",
				properties: {
					team_name: { type: "string" },
					agent_identity: { type: "string" },
					role: { type: "string" },
				},
				required: ["team_name", "agent_identity"],
			},
			handler: (a) => agents.addTeamMember(a as AddTeamMemberArgs),
		});

		const { PgSpendingHandlers, PgModelHandlers } = await import(
			"./tools/spending/pg-handlers.ts"
		);
		const spending = new PgSpendingHandlers(server, projectRoot);
		const models = new PgModelHandlers(server, projectRoot);
		type SetSpendingCapArgs = Parameters<typeof spending.setSpendingCap>[0];
		type LogSpendingArgs = Parameters<typeof spending.logSpending>[0];
		type GetSpendingReportArgs = Parameters<
			typeof spending.getSpendingReport
		>[0];
		type GetTokenEfficiencyReportArgs = Parameters<
			typeof spending.getTokenEfficiencyReport
		>[0];
		type ListModelsArgs = Parameters<typeof models.listModels>[0];
		type AddModelArgs = Parameters<typeof models.addModel>[0];
		server.addTool({
			name: "spending_set_cap",
			description: "Set agent spending cap",
			inputSchema: {
				type: "object",
				properties: {
					agent_identity: { type: "string" },
					daily_limit_usd: { type: "string" },
					monthly_limit_usd: { type: "string" },
					is_frozen: { type: "boolean" },
					frozen_reason: { type: "string" },
				},
				required: ["agent_identity", "daily_limit_usd"],
			},
			handler: (a) => spending.setSpendingCap(a as SetSpendingCapArgs),
		});
		server.addTool({
			name: "spending_log",
			description: "Log agent spending",
			inputSchema: {
				type: "object",
				properties: {
					agent_identity: { type: "string" },
					proposal_id: { type: "string" },
					cost_usd: { type: "string" },
					model_name: { type: "string" },
					token_count: { type: "string" },
					run_id: { type: "string" },
					budget_id: { type: "string" },
					session_id: { type: "string" },
					agent_role: { type: "string" },
					task_type: { type: "string" },
					input_tokens: { type: "string" },
					output_tokens: { type: "string" },
					cache_write_tokens: { type: "string" },
					cache_read_tokens: { type: "string" },
				},
				required: ["agent_identity", "cost_usd"],
			},
			handler: (a) => spending.logSpending(a as LogSpendingArgs),
		});
		server.addTool({
			name: "spending_report",
			description: "Get spending report",
			inputSchema: {
				type: "object",
				properties: { agent_identity: { type: "string" } },
			},
			handler: (a) => spending.getSpendingReport(a as GetSpendingReportArgs),
		});
		server.addTool({
			name: "spending_efficiency_report",
			description: "Get token efficiency report",
			inputSchema: {
				type: "object",
				properties: {
					agent_role: { type: "string" },
					model: { type: "string" },
				},
			},
			handler: (a) =>
				spending.getTokenEfficiencyReport(a as GetTokenEfficiencyReportArgs),
		});
		// P059: Enhanced model_list with capability filtering and is_active support
		server.addTool({
			name: "model_list",
			description: "List registered models with optional capability and cost filters",
			inputSchema: {
				type: "object",
				properties: {
					capability: { type: "string", description: "Filter by capability, e.g. 'tool_use=true'" },
					max_cost_per_1k_input: { type: "string", description: "Max cost per 1k input tokens" },
					active_only: { type: "boolean", description: "Only show active models (default: true)" },
				},
			},
			handler: (a) => models.listModels(a as ListModelsArgs),
		});
		// P059: Enhanced model_add with is_active and context_window support
		server.addTool({
			name: "model_add",
			description: "Register or update a model",
			inputSchema: {
				type: "object",
				properties: {
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
				required: ["model_name"],
			},
			handler: (a) => models.addModel(a as AddModelArgs),
		});

		const { PgMemoryHandlers } = await import("./tools/memory/pg-handlers.ts");
		const memory = new PgMemoryHandlers(server);
		type SetMemoryArgs = Parameters<typeof memory.setMemory>[0];
		type GetMemoryArgs = Parameters<typeof memory.getMemory>[0];
		type DeleteMemoryArgs = Parameters<typeof memory.deleteMemory>[0];
		type MemoryListArgs = Parameters<typeof memory.memoryList>[0];
		type MemorySummaryArgs = Parameters<typeof memory.memorySummary>[0];
		type SearchMemoryArgs = Parameters<typeof memory.searchMemory>[0];
		server.addTool({
			name: "memory_set",
			description:
				"Set agent memory (layers: episodic, semantic, working, procedural)",
			inputSchema: {
				type: "object",
				properties: {
					agent_identity: { type: "string" },
					layer: {
						type: "string",
						enum: ["episodic", "semantic", "working", "procedural"],
					},
					key: { type: "string" },
					value: { type: "string" },
					metadata: { type: "string" },
					ttl_seconds: { type: "number" },
				},
				required: ["agent_identity", "layer", "key", "value"],
			},
			handler: (a) => memory.setMemory(a as SetMemoryArgs),
		});
		server.addTool({
			name: "memory_get",
			description: "Get agent memory",
			inputSchema: {
				type: "object",
				properties: {
					agent_identity: { type: "string" },
					layer: { type: "string" },
					key: { type: "string" },
				},
				required: ["agent_identity", "layer"],
			},
			handler: (a) => memory.getMemory(a as GetMemoryArgs),
		});
		server.addTool({
			name: "memory_delete",
			description: "Delete agent memory",
			inputSchema: {
				type: "object",
				properties: {
					agent_identity: { type: "string" },
					layer: { type: "string" },
					key: { type: "string" },
				},
				required: ["agent_identity", "layer"],
			},
			handler: (a) => memory.deleteMemory(a as DeleteMemoryArgs),
		});
		server.addTool({
			name: "memory_list",
			description: "List memory summaries",
			inputSchema: {
				type: "object",
				properties: {
					agent_identity: { type: "string" },
					layer: { type: "string" },
				},
			},
			handler: (a) => memory.memoryList(a as MemoryListArgs),
		});
		// P062: memory_summary with optional filters
		server.addTool({
			name: "memory_summary",
			description: "Get agent memory summary grouped by agent/layer",
			inputSchema: {
				type: "object",
				properties: {
					agent_identity: { type: "string", description: "Filter by agent identity (optional)" },
					layer: { type: "string", description: "Filter by memory layer (optional)" },
				},
			},
			handler: (a) => memory.memorySummary(a as MemorySummaryArgs),
		});

		// Semantic memory search (uses `body_vector vector(1536)` + pgvector)
		server.addTool({
			name: "memory_search",
			description:
				"Semantically search agent memory by embedding similarity (pgvector cosine search)",
			inputSchema: {
				type: "object",
				properties: {
					agent_identity: {
						type: "string",
						description: "Filter by agent identity",
					},
					layer: {
						type: "string",
						enum: ["episodic", "semantic", "working", "procedural"],
						description: "Filter by memory layer",
					},
					embedding: {
						type: "array",
						items: { type: "number" },
						description: "1536-dim query embedding vector",
					},
					top_k: {
						type: "number",
						description: "Max results (default 10, max 100)",
					},
					threshold: {
						type: "number",
						description: "Min cosine similarity (default 0.5)",
					},
				},
				required: ["embedding"],
			},
			handler: (a) => memory.searchMemory(a as SearchMemoryArgs),
		});

		// P078: Escalation Management tools
		const { registerEscalationTools } = await import("./tools/escalation/index.ts");
		registerEscalationTools(server);

		// Proposal CRUD tools via backend-switch (prop_list, prop_get, prop_create, prop_update, prop_transition, prop_delete)
		// Already registered at line 352 via registerProposalTools

		// RFC Workflow tools (state machine, AC, deps, reviews, discussions)
		const { RfcWorkflowHandlers } = await import("./tools/rfc/pg-handlers.ts");
		const rfc = new RfcWorkflowHandlers(server);
		rfc.register();

		// SMDL configurable workflow tools (load YAML, load builtins, list)
		const { SMDLWorkflowHandlers } = await import(
			"./tools/workflow/smdl-mcp.ts"
		);
		const smdl = new SMDLWorkflowHandlers(server);
		smdl.register();

		// Cubic Orchestration tools (P058) — Postgres-backed
		const { PgCubicHandlers } = await import(
			"./tools/cubic/pg-handlers.ts"
		);
		const cubic = new PgCubicHandlers(server);
		type CreateCubicArgs = Parameters<typeof cubic.createCubic>[0];
		type ListCubicsArgs = Parameters<typeof cubic.listCubics>[0];
		type FocusCubicArgs = Parameters<typeof cubic.focusCubic>[0];
		type TransitionCubicArgs = Parameters<typeof cubic.transitionCubic>[0];
		type RecycleCubicArgs = Parameters<typeof cubic.recycleCubic>[0];
		server.addTool({
			name: "cubic_create",
			description: "Create a new cubic workspace",
			inputSchema: {
				type: "object",
				properties: {
					name: { type: "string" },
					agents: { type: "array", items: { type: "string" } },
					proposals: { type: "array", items: { type: "string" } },
				},
				required: ["name"],
			},
			handler: (a) => cubic.createCubic(a as CreateCubicArgs),
		});
		server.addTool({
			name: "cubic_list",
			description: "List all cubics",
			inputSchema: {
				type: "object",
				properties: {
					status: { type: "string" },
					agent: { type: "string" },
				},
			},
			handler: (a) => cubic.listCubics(a as ListCubicsArgs),
		});
		server.addTool({
			name: "cubic_focus",
			description: "Update cubic focus and acquire lock",
			inputSchema: {
				type: "object",
				properties: {
					cubicId: { type: "string" },
					agent: { type: "string" },
					task: { type: "string" },
					phase: { type: "string" },
				},
				required: ["cubicId", "agent", "task"],
			},
			handler: (a) => cubic.focusCubic(a as FocusCubicArgs),
		});
		server.addTool({
			name: "cubic_transition",
			description: "Transition cubic phase and release lock",
			inputSchema: {
				type: "object",
				properties: {
					cubicId: { type: "string" },
					toPhase: { type: "string" },
				},
				required: ["cubicId", "toPhase"],
			},
			handler: (a) => cubic.transitionCubic(a as TransitionCubicArgs),
		});
		server.addTool({
			name: "cubic_recycle",
			description: "Recycle cubic for new task",
			inputSchema: {
				type: "object",
				properties: {
					cubicId: { type: "string" },
					resetCode: { type: "boolean" },
				},
				required: ["cubicId"],
			},
			handler: (a) => cubic.recycleCubic(a as RecycleCubicArgs),
		});

		// Pulse Fleet Observability tools (P063) — Postgres-backed
		const { PgPulseHandlers } = await import(
			"./tools/pulse/pg-handlers.ts"
		);
		const pulse = new PgPulseHandlers(server);
		type RecordHeartbeatArgs = Parameters<typeof pulse.recordHeartbeat>[0];
		type GetAgentHealthArgs = Parameters<typeof pulse.getAgentHealth>[0];
		type GetHeartbeatHistoryArgs = Parameters<
			typeof pulse.getHeartbeatHistory
		>[0];
		server.addTool({
			name: "pulse_heartbeat",
			description: "Record an agent heartbeat for fleet observability",
			inputSchema: {
				type: "object",
				properties: {
					agent_identity: { type: "string" },
					current_task: { type: "string" },
					current_proposal: { type: "string" },
					current_cubic: { type: "string" },
					cpu_percent: { type: "number" },
					memory_mb: { type: "number" },
					active_model: { type: "string" },
					uptime_seconds: { type: "number" },
					metadata: { type: "string" },
				},
				required: ["agent_identity"],
			},
			handler: (a) => pulse.recordHeartbeat(a as RecordHeartbeatArgs),
		});
		server.addTool({
			name: "pulse_health",
			description:
				"Get health status for agents (single or all) with inferred status from heartbeat cadence",
			inputSchema: {
				type: "object",
				properties: {
					agent_identity: { type: "string" },
				},
			},
			handler: (a) => pulse.getAgentHealth(a as GetAgentHealthArgs),
		});
		server.addTool({
			name: "pulse_fleet",
			description:
				"Get fleet-wide health metrics: status counts, uptime, CPU, heartbeat rate",
			inputSchema: { type: "object", properties: {} },
			handler: () => pulse.getFleetStatus(),
		});
		server.addTool({
			name: "pulse_history",
			description: "Get heartbeat history for an agent (trend analysis)",
			inputSchema: {
				type: "object",
				properties: {
					agent_identity: { type: "string" },
					limit: { type: "number" },
				},
				required: ["agent_identity"],
			},
			handler: (a) =>
				pulse.getHeartbeatHistory(a as GetHeartbeatHistoryArgs),
		});
		server.addTool({
			name: "pulse_refresh",
			description:
				"Refresh agent statuses: mark stale/offline/crashed based on heartbeat age, prune old logs",
			inputSchema: { type: "object", properties: {} },
			handler: () => pulse.refreshAgentStatuses(),
		});

		// Federation tools (P068) — filesystem-backed PKI
		const { FederationHandlers } = await import(
			"./tools/federation/handlers.ts"
		);
		const fed = new FederationHandlers(server);
		type FedListHostsArgs = Parameters<typeof fed.listHosts>[0];
		type FedListJoinArgs = Parameters<typeof fed.listJoinRequests>[0];
		type FedApproveArgs = Parameters<typeof fed.approveJoin>[0];
		type FedDenyArgs = Parameters<typeof fed.denyJoin>[0];
		type FedQuarantineArgs = Parameters<typeof fed.quarantineHost>[0];
		type FedLiftArgs = Parameters<typeof fed.liftQuarantine>[0];
		type FedListCertsArgs = Parameters<typeof fed.listCertificates>[0];
		type FedFailedConnArgs = Parameters<typeof fed.getFailedConnections>[0];
		type FedRemoveHostArgs = Parameters<typeof fed.removeHost>[0];
		server.addTool({
			name: "federation_stats",
			description: "Get federation statistics: hosts, certs, connections, CA",
			inputSchema: { type: "object", properties: {} },
			handler: () => fed.getStats(),
		});
		server.addTool({
			name: "federation_list_hosts",
			description: "List registered federation hosts",
			inputSchema: {
				type: "object",
				properties: { status: { type: "string" } },
			},
			handler: (a) => fed.listHosts(a as FedListHostsArgs),
		});
		server.addTool({
			name: "federation_list_join_requests",
			description: "List join requests (pending or all)",
			inputSchema: {
				type: "object",
				properties: { all: { type: "boolean" } },
			},
			handler: (a) => fed.listJoinRequests(a as FedListJoinArgs),
		});
		server.addTool({
			name: "federation_approve_join",
			description: "Approve a pending join request",
			inputSchema: {
				type: "object",
				properties: {
					requestId: { type: "string" },
					reviewerId: { type: "string" },
				},
				required: ["requestId", "reviewerId"],
			},
			handler: (a) => fed.approveJoin(a as FedApproveArgs),
		});
		server.addTool({
			name: "federation_deny_join",
			description: "Deny a pending join request",
			inputSchema: {
				type: "object",
				properties: {
					requestId: { type: "string" },
					reviewerId: { type: "string" },
					reason: { type: "string" },
				},
				required: ["requestId", "reviewerId", "reason"],
			},
			handler: (a) => fed.denyJoin(a as FedDenyArgs),
		});
		server.addTool({
			name: "federation_quarantine",
			description: "Quarantine a host (block connections)",
			inputSchema: {
				type: "object",
				properties: {
					hostId: { type: "string" },
					reason: { type: "string" },
				},
				required: ["hostId", "reason"],
			},
			handler: (a) => fed.quarantineHost(a as FedQuarantineArgs),
		});
		server.addTool({
			name: "federation_lift_quarantine",
			description: "Lift quarantine on a host",
			inputSchema: {
				type: "object",
				properties: {
					hostId: { type: "string" },
					reviewerId: { type: "string" },
				},
				required: ["hostId", "reviewerId"],
			},
			handler: (a) => fed.liftQuarantine(a as FedLiftArgs),
		});
		server.addTool({
			name: "federation_list_certificates",
			description:
				"List certificates for a host or expiring certificates",
			inputSchema: {
				type: "object",
				properties: {
					hostId: { type: "string" },
					expiringDays: { type: "number" },
				},
			},
			handler: (a) => fed.listCertificates(a as FedListCertsArgs),
		});
		server.addTool({
			name: "federation_failed_connections",
			description: "Get failed mTLS connections for monitoring",
			inputSchema: {
				type: "object",
				properties: { limit: { type: "number" } },
			},
			handler: (a) => fed.getFailedConnections(a as FedFailedConnArgs),
		});
		server.addTool({
			name: "federation_remove_host",
			description: "Remove a host (revoke cert + delete)",
			inputSchema: {
				type: "object",
				properties: { hostId: { type: "string" } },
				required: ["hostId"],
			},
			handler: (a) => fed.removeHost(a as FedRemoveHostArgs),
		});

		// Discord outbound tool (P233) — pg_notify('discord_send')
		const { discordSend } = await import(
			"../../infra/discord/notify.ts"
		);
		server.addTool({
			name: "discord_send",
			description:
				"Send a message to Discord via pg_notify (zero-cost, handled by discord-bridge)",
			inputSchema: {
				type: "object",
				properties: {
					from: {
						type: "string",
						description: "Agent or sender identity",
					},
					message: {
						type: "string",
						description: "Message content to send",
					},
					level: {
						type: "string",
						enum: ["info", "success", "warning", "error"],
						description:
							"Message level (determines icon in Discord)",
					},
				},
				required: ["from", "message"],
			},
			handler: async (a: Record<string, unknown>) => {
				await discordSend(
					a.from as string,
					a.message as string,
					(a.level as "info" | "success" | "warning" | "error") ?? "info",
				);
				return {
					content: [
						{
							type: "text",
							text: `Discord message sent from ${a.from}`,
						},
					],
				};
			},
		});

		console.log(
			"[MCP] Using Postgres backend (agenthive) for proposals, messaging, agents, spending, memory, RFC workflow, SMDL, cubics, pulse, federation, discord",
		);
	} else {
		registerFilesystemProposalTools(server, config);
		registerMessageTools(server);
		registerAgentTools(server);
		await registerTeamTools(server);
		console.log("[MCP] Using legacy filesystem proposal tools");
	}
	registerTestingTools(server);
	registerDependencyTools(server);
	if (usePostgres) {
		registerConsolidatedTools(server);
		server.setConsolidatedToolSurface(true);
	}

	// Start background maintenance tasks
	const MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
	setInterval(async () => {
		try {
			await server.checkLeaseHealth({ autoCommit: true });
		} catch (_err) {
			// Silently ignore background maintenance errors
		}
	}, MAINTENANCE_INTERVAL_MS);

	// Start Relay Service if enabled
	if (config.relay?.enabled) {
		const relay = new RelayService(server, config.relay);
		void relay.start();
	}

	if (options.debug) {
		console.error("MCP server initialised (stdio transport only).");
	}

	return server;
}
