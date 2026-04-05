import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
	CallToolRequestSchema,
	GetPromptRequestSchema,
	ListPromptsRequestSchema,
	ListResourcesRequestSchema,
	ListResourceTemplatesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Core } from "../core/roadmap.ts";
import { RelayService } from '../core/messaging/relay.ts';
import { getPackageName } from "../utils/app-info.ts";
import { getVersion } from "../utils/version.ts";
import { registerInitRequiredResource } from "./resources/init-required/index.ts";
import { registerWorkflowResources } from "./resources/workflow/index.ts";
import { registerExportTools } from "./tools/export/sdb-export-mcp.ts";
import { registerNoteTools } from "./tools/notes/index.ts";
import { registerTestingTools } from "./tools/testing/index.ts";
import { registerSdbMessageTools } from "./tools/messages/sdb-index.ts";
import { registerSdbProposalTools } from "./tools/proposals/sdb-index.ts";
import { registerSdbAgentTools } from "./tools/agents/sdb-index.ts";
import { registerSdbWorkflowTools } from "./tools/workflow/sdb-index.ts";
import { registerSdbMilestoneTools } from "./tools/milestones/sdb-index.ts";
import { registerSdbTeamTools } from "./tools/teams/sdb-index.ts";
import { registerSdbDocumentTools } from "./tools/documents/sdb-index.ts";
import { registerSdbKnowledgeTools } from "./tools/knowledge/sdb-index.ts";
import { registerSdbProtocolTools } from "./tools/protocol/sdb-index.ts";
import { registerCubicTools } from "./tools/cubic/index.ts";
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
	"At the beginning of each session, read the roadmap://workflow/overview resource to understand when and how to use Roadmap.md for proposal management. Additional detailed guides are available as resources when needed.";
const INSTRUCTIONS_FALLBACK =
	"Roadmap.md is not initialized in this directory. Read the roadmap://init-required resource for setup instructions.";

type ServerInitOptions = {
	debug?: boolean;
};

export class McpServer extends Core {
	private readonly server: Server;
	private transport?: StdioServerTransport;
	private stopping = false;

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
		this.server.setRequestHandler(ListToolsRequestSchema, async () => this.listTools());
		this.server.setRequestHandler(CallToolRequestSchema, async (request) => this.callTool(request));
		this.server.setRequestHandler(ListResourcesRequestSchema, async () => this.listResources());
		this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => this.listResourceTemplates());
		this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => this.readResource(request));
		this.server.setRequestHandler(ListPromptsRequestSchema, async () => this.listPrompts());
		this.server.setRequestHandler(GetPromptRequestSchema, async (request) => this.getPrompt(request));
	}

	/**
	 * Register a tool implementation with the server.
	 */
	public addTool(tool: McpToolHandler): void {
		this.tools.set(tool.name, tool);
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
			throw new Error("MCP server not connected. Call connect() before start().");
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
		return {
			tools: Array.from(this.tools.values()).map((tool) => ({
				name: tool.name,
				description: tool.description,
				inputSchema: {
					type: "object",
					...tool.inputSchema,
				},
			})),
		};
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

	protected async readResource(request: { params: { uri: string } }): Promise<ReadResourceResult> {
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
	public async createSseTransport(endpoint: string, res?: any): Promise<SSEServerTransport> {
		const transport = new SSEServerTransport(endpoint, res);
		await this.server.connect(transport);
		return transport;
	}

	/**
	 * Handle an incoming message for an SSE transport.
	 */
	public async handleSseMessage(transport: SSEServerTransport, request: any): Promise<void> {
		if (transport.handlePostMessage) {
			await transport.handlePostMessage(request as any, {} as any);
		}
	}

	/**
	 * Helper exposed for tests so they can call handlers directly.
	 */
	public get testInterface() {
		return {
			listTools: () => this.listTools(),
			callTool: (request: { params: { name: string; arguments?: Record<string, unknown> } }) => this.callTool(request),
			listResources: () => this.listResources(),
			listResourceTemplates: () => this.listResourceTemplates(),
			readResource: (request: { params: { uri: string } }) => this.readResource(request),
			listPrompts: () => this.listPrompts(),
			getPrompt: (request: { params: { name: string; arguments?: Record<string, unknown> } }) =>
				this.getPrompt(request),
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
export async function createMcpServer(projectRoot: string, options: ServerInitOptions = {}): Promise<McpServer> {
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
			console.error("MCP server initialised in fallback mode (roadmap not initialized in this directory).");
		}

		return server;
	}

	// Normal mode: full tools and resources
	registerWorkflowResources(server);
	registerSdbWorkflowTools(server, projectRoot);
	registerNoteTools(server, projectRoot);
	registerSdbMilestoneTools(server, projectRoot);
	registerSdbDocumentTools(server, projectRoot);
	registerSdbKnowledgeTools(server, projectRoot);
	registerSdbProtocolTools(server, projectRoot);
	registerExportTools(server);
	registerSdbTeamTools(server, projectRoot);
	// Note: SdbAgentTools moved to backend-switch below

	// --- Backend routing: Postgres vs SpacetimeDB ---
	const usePostgres = config.database?.provider === 'Postgres';

	if (usePostgres) {
		// Postgres-backed tools
		const { registerProposalTools } = await import('./tools/proposals/backend-switch.ts');
		registerProposalTools(server, projectRoot);

		const { PgMessagingHandlers } = await import('./tools/messages/pg-handlers.ts');
		const msg = new PgMessagingHandlers(server, projectRoot);
		server.addTool({ name: 'msg_send', description: 'Send message via Postgres message_ledger', inputSchema: { type: 'object', properties: { from_agent: { type: 'string' }, to_agent: { type: 'string' }, channel: { type: 'string' }, message_content: { type: 'string' }, message_type: { type: 'string' }, proposal_id: { type: 'string' } }, required: ['from_agent', 'message_content'] }, handler: (a: any) => msg.sendMessage(a) });
		server.addTool({ name: 'msg_read', description: 'Read messages from Postgres', inputSchema: { type: 'object', properties: { agent: { type: 'string' }, channel: { type: 'string' }, limit: { type: 'number' } } }, handler: (a: any) => msg.readMessages(a) });
		server.addTool({ name: 'chan_list', description: 'List channels', inputSchema: { type: 'object', properties: {} }, handler: (a: any) => msg.listChannels(a) });

		const { PgAgentHandlers } = await import('./tools/agents/pg-handlers.ts');
		const agents = new PgAgentHandlers(server, projectRoot);
		server.addTool({ name: 'agent_list', description: 'List registered agents', inputSchema: { type: 'object', properties: { status: { type: 'string' } } }, handler: (a: any) => agents.listAgents(a) });
		server.addTool({ name: 'agent_get', description: 'Get agent details', inputSchema: { type: 'object', properties: { identity: { type: 'string' } }, required: ['identity'] }, handler: (a: any) => agents.getAgent(a) });
		server.addTool({ name: 'agent_register', description: 'Register or update an agent', inputSchema: { type: 'object', properties: { identity: { type: 'string' }, agent_type: { type: 'string' }, role: { type: 'string' }, skills: { type: 'string' } }, required: ['identity'] }, handler: (a: any) => agents.registerAgent(a) });
		server.addTool({ name: 'team_list', description: 'List teams', inputSchema: { type: 'object', properties: {} }, handler: (a: any) => agents.listTeams(a) });
		server.addTool({ name: 'team_create', description: 'Create a team', inputSchema: { type: 'object', properties: { name: { type: 'string' }, team_type: { type: 'string' } }, required: ['name'] }, handler: (a: any) => agents.createTeam(a) });
		server.addTool({ name: 'team_add_member', description: 'Add agent to team', inputSchema: { type: 'object', properties: { team_name: { type: 'string' }, agent_identity: { type: 'string' }, role: { type: 'string' } }, required: ['team_name', 'agent_identity'] }, handler: (a: any) => agents.addTeamMember(a) });

		const { PgSpendingHandlers, PgModelHandlers } = await import('./tools/spending/pg-handlers.ts');
		const spending = new PgSpendingHandlers(server, projectRoot);
		const models = new PgModelHandlers(server, projectRoot);
		server.addTool({ name: 'spending_set_cap', description: 'Set agent spending cap', inputSchema: { type: 'object', properties: { agent_identity: { type: 'string' }, daily_limit_usd: { type: 'string' } }, required: ['agent_identity', 'daily_limit_usd'] }, handler: (a: any) => spending.setSpendingCap(a) });
		server.addTool({ name: 'spending_log', description: 'Log agent spending', inputSchema: { type: 'object', properties: { agent_identity: { type: 'string' }, proposal_id: { type: 'string' }, cost_usd: { type: 'string' } }, required: ['agent_identity', 'cost_usd'] }, handler: (a: any) => spending.logSpending(a) });
		server.addTool({ name: 'spending_report', description: 'Get spending report', inputSchema: { type: 'object', properties: { agent_identity: { type: 'string' } } }, handler: (a: any) => spending.getSpendingReport(a) });
		server.addTool({ name: 'model_list', description: 'List registered models', inputSchema: { type: 'object', properties: {} }, handler: (a: any) => models.listModels(a) });
		server.addTool({ name: 'model_add', description: 'Register a model', inputSchema: { type: 'object', properties: { model_name: { type: 'string' }, provider: { type: 'string' }, cost_per_1k_input: { type: 'string' }, cost_per_1k_output: { type: 'string' }, max_tokens: { type: 'string' }, capabilities: { type: 'string' }, rating: { type: 'string' } }, required: ['model_name'] }, handler: (a: any) => models.addModel(a) });

		const { PgMemoryHandlers } = await import('./tools/memory/pg-handlers.ts');
		const memory = new PgMemoryHandlers(server, projectRoot);
		server.addTool({ name: 'memory_set', description: 'Set agent memory (4-layer: identity, constitution, project, task)', inputSchema: { type: 'object', properties: { agent_identity: { type: 'string' }, layer: { type: 'string' }, key: { type: 'string' }, value: { type: 'string' }, metadata: { type: 'string' } }, required: ['agent_identity', 'layer', 'key', 'value'] }, handler: (a: any) => memory.memorySet(a) });
		server.addTool({ name: 'memory_get', description: 'Get agent memory', inputSchema: { type: 'object', properties: { agent_identity: { type: 'string' }, layer: { type: 'string' }, key: { type: 'string' } }, required: ['agent_identity', 'layer'] }, handler: (a: any) => memory.memoryGet(a) });
		server.addTool({ name: 'memory_delete', description: 'Delete agent memory', inputSchema: { type: 'object', properties: { agent_identity: { type: 'string' }, layer: { type: 'string' }, key: { type: 'string' } }, required: ['agent_identity', 'layer'] }, handler: (a: any) => memory.memoryDelete(a) });
		server.addTool({ name: 'memory_list', description: 'List memory summaries', inputSchema: { type: 'object', properties: { agent_identity: { type: 'string' }, layer: { type: 'string' } } }, handler: (a: any) => memory.memoryList(a) });
		server.addTool({ name: 'memory_summary', description: 'Get agent memory summary', inputSchema: { type: 'object', properties: { agent_identity: { type: 'string' } }, required: ['agent_identity'] }, handler: (a: any) => memory.memorySummary(a) });

		// Semantic memory search (requires `body_embedding vector(1536)` column + pgvector)
		server.addTool({
			name: 'memory_search',
			description: 'Semantically search agent memory by embedding similarity (pgvector cosine search)',
			inputSchema: {
				type: 'object',
				properties: {
					agent_identity: { type: 'string', description: 'Filter by agent identity' },
					layer: { type: 'string', enum: ['identity','constitution','project','task'], description: 'Filter by memory layer' },
					embedding: { type: 'array', items: { type: 'number' }, description: '1536-dim query embedding vector' },
					top_k: { type: 'number', description: 'Max results (default 10, max 100)' },
					threshold: { type: 'number', description: 'Min cosine similarity (default 0.5)' },
				},
				required: ['embedding'],
			},
			handler: (a: any) => memory.searchMemory(a),
		});

		// RFC Workflow tools (state machine, AC, deps, reviews, discussions)
		const { RfcWorkflowHandlers } = await import('./tools/rfc/pg-handlers.ts');
		const rfc = new RfcWorkflowHandlers(server);
		rfc.register();

		// Proposal CRUD tools (create, get, list, update, search, summary)
		const { ProposalHandlers } = await import('./tools/proposal/pg-handlers.ts');
		const proposals = new ProposalHandlers(server);
		proposals.register();

		console.log('[MCP] Using Postgres backend (agenthive) for proposals, messaging, agents, spending, memory, RFC workflow');
	} else {
		// SpacetimeDB-backed tools (fallback)
		registerSdbProposalTools(server, projectRoot);
		registerSdbMessageTools(server, projectRoot);
		registerSdbAgentTools(server, projectRoot);
		console.log('[MCP] Using SDB backend for legacy tools');
	}
	registerTestingTools(server);

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
