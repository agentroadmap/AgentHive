import { randomBytes } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
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
// P754: PipelineCron import removed — gate-pipeline service decommissioned.
import { Core } from "../../core/roadmap.ts";
import * as pgPool from "../../postgres/pool.ts";
import { loadStateNames } from "../../core/workflow/state-names.ts";
import { getPackageName } from "../../shared/utils/app-info.ts";
import { getVersion } from "../../shared/utils/version.ts";
import { parseEnvelopeFromEnv, opsMatch, type ToolEnvelope } from "../../infra/agency/tool-grant.ts";
import { query } from "../../infra/postgres/pool.ts";
import { agentContextStorage, type AgentContext } from "../../shared/identity/agent-context.ts";
import { PrincipalVerifier, type McpAuthEnvelope, type VerifiedPrincipal } from "../../core/identity/principal-verifier.ts";
import { PrincipalIdentityStore, verifyBoundBearer, type BoundBearerToken } from "../../core/identity/principal-identity.ts";
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
import { registerProjectTools } from "./tools/projects/index.ts";
import { registerConsolidatedTools } from "./tools/consolidated.ts";
import {
	verifyUserBearer,
	logBearerRejection,
	extractBearerFromHeader,
} from "./tools/messages/user-bearer-auth.ts";
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

// P843: Auth enforcement mode flag (default log-only)
const P843_AUTH_ENFORCE_MCP = process.env.P843_AUTH_ENFORCE_MCP === "true";

// P843: Write auth decision to audit log (non-blocking, fire-and-forget)
async function writeAuthDecisionLog(
	principalId: string | null,
	toolName: string,
	result: "allowed" | "denied" | "unauthenticated",
): Promise<void> {
	try {
		await query(
			`INSERT INTO control_identity.auth_decision_log (principal_id, tool_name, result)
			 VALUES ($1, $2, $3)`,
			[principalId, toolName, result],
		);
	} catch {
		// Non-fatal: auth decision logging never blocks tool execution
	}
}

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
	private readonly instructions: string;
	private transport?: StdioServerTransport;
	private stopping = false;
	private consolidatedToolSurface = false;

	// P599: Tool grant envelope. Read once at startup from AGENT_TOOL_ENVELOPE.
	// null = no restriction (orchestrator context; shared server).
	private readonly toolEnvelope: ToolEnvelope | null = parseEnvelopeFromEnv();

	private readonly tools = new Map<string, McpToolHandler>();
	private readonly resources = new Map<string, McpResourceHandler>();
	private readonly prompts = new Map<string, McpPromptHandler>();

	// P843: Principal identity and auth verification
	private readonly principalIdentityStore: PrincipalIdentityStore;
	private readonly principalVerifier: PrincipalVerifier;

	constructor(projectRoot: string, instructions: string) {
		super(projectRoot, { enableWatchers: true });

		this.instructions = instructions;
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

		// P843: Initialize principal identity store and verifier
		const pool = pgPool.getPool();
		this.principalIdentityStore = new PrincipalIdentityStore(pool);
		const operatorHmacSecret = this._getOperatorHmacSecret();
		this.principalVerifier = new PrincipalVerifier(this.principalIdentityStore, operatorHmacSecret);

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
	 *
	 * Collision detection: if a tool with the same name is already registered,
	 * a structured warning is emitted (with old vs. new descriptions and the
	 * call-site stack).  When AGENTHIVE_TOOL_REGISTRY_STRICT=true the conflict
	 * is treated as a hard error; otherwise last-write-wins (the new tool
	 * replaces the old one).
	 */
	public addTool(tool: McpToolHandler): void {
		const existing = this.tools.get(tool.name);
		if (existing) {
			const callSite = new Error().stack ?? "(stack unavailable)";
			const warning = {
				event: "tool_registry_collision",
				tool_name: tool.name,
				prior_description: existing.description ?? "(none)",
				new_description: tool.description ?? "(none)",
				call_site: callSite,
			};
			if (process.env.AGENTHIVE_TOOL_REGISTRY_STRICT === "true") {
				throw new Error(
					`[tool-registry] Duplicate tool registration: '${tool.name}'\n${JSON.stringify(warning, null, 2)}`,
				);
			}
			// biome-ignore lint/suspicious/noConsole: intentional structured warning
			console.warn("[tool-registry] collision:", JSON.stringify(warning));
		}
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
		const tools = Array.from(this.tools.values()).filter((tool) => {
			if (
				!SHOW_LEGACY_TOOLS &&
				this.consolidatedToolSurface &&
				!CONSOLIDATED_TOOL_NAMES.has(tool.name)
			) {
				return false;
			}
			// P599: if an envelope is present, only expose tools with at least one granted op.
			if (this.toolEnvelope !== null) {
				const granted = this.toolEnvelope[tool.name];
				return Array.isArray(granted) && granted.length > 0;
			}
			return true;
		});
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

		// P843: Identity gate — verify principal before capability check
		const envelope = args._auth as McpAuthEnvelope | undefined;
		delete args._auth; // Strip auth envelope before handler sees it
		const ctx = agentContextStorage.getStore();

		let verifiedPrincipal: VerifiedPrincipal | null = null;
		if (ctx) {
			// Context set by HTTP transport handler (operator bearer token)
			verifiedPrincipal = ctx.verified;
			await writeAuthDecisionLog(verifiedPrincipal.principal_id, name, "allowed");
		} else if (envelope) {
			// Inline _auth envelope (agency/agent flow, or stdio)
			const authResult = await this.principalVerifier.verify(envelope);
			if (authResult.ok && authResult.principal) {
				verifiedPrincipal = authResult.principal;
				await writeAuthDecisionLog(authResult.principal.principal_id, name, "allowed");
			} else {
				await writeAuthDecisionLog(envelope.principal_id ?? null, name, "denied");
				if (P843_AUTH_ENFORCE_MCP) {
					throw new Error(`[P843] Auth denied: ${authResult.reason}`);
				}
			}
		} else {
			// No auth context or envelope
			await writeAuthDecisionLog(null, name, "unauthenticated");
			if (P843_AUTH_ENFORCE_MCP) {
				throw new Error("[P843] No auth envelope");
			}
		}

		// P1105 AC-3: Bearer token required for user/* from_agent on msg_send.
		// Token is passed via inline _bearer arg (consistent with _auth envelope pattern).
		// For HTTP transport callers the agent extracts their JWT from the Authorization
		// header and passes it here; stdio callers pass it directly.
		if (name === "msg_send") {
			const fromAgent = args.from_agent as string | undefined;
			if (fromAgent?.startsWith("user/")) {
				const bearerHeader = args._bearer as string | undefined;
				delete args._bearer; // strip before handler sees it
				const token = extractBearerFromHeader(bearerHeader);
				const check = verifyUserBearer(token, fromAgent);
				if (!check.ok) {
					const errorCode = check.error!;
					void logBearerRejection(fromAgent, errorCode);
					const httpStatus = errorCode === "missing" ? 401 : 403;
					return {
						isError: true,
						content: [
							{
								type: "text",
								text: `⛔ [P1105] Bearer auth rejected (${errorCode}). HTTP ${httpStatus}.`,
							},
						],
					};
				}
			}
		}

		// P599: enforce tool grant envelope. Deny if tool absent from envelope.
		if (this.toolEnvelope !== null) {
			const granted = this.toolEnvelope[name] ?? [];
			// Use tool:* as the representative op for a generic call; callers may
			// provide a specific op via args._op for finer-grained checks.
			const requestedOp = (args._op as string | undefined) ?? `${name}:*`;
			if (!opsMatch(granted, requestedOp)) {
				throw new Error(
					`[P599] Tool "${name}" is not granted for this agent (op=${requestedOp}).`,
				);
			}
		}

		// P854: _auth envelope path sets verifiedPrincipal but has no transport context;
		// wrap handler so getProjectDb() P844 gate sees the principal.
		// AC-5/AC-26: per-call error boundary — isolates handler failures from transport/SSE clients.
		let result: CallToolResult;
		try {
			result = verifiedPrincipal && !ctx
				? await agentContextStorage.run({ verified: verifiedPrincipal }, () => tool.handler(args))
				: await tool.handler(args);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { isError: true, content: [{ type: "text", text: `Tool handler error: ${message}` }] };
		}

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

		// P599: write to tool_invocation_log (best-effort; never blocks the response).
		try {
			const principal =
				(args.agent as string | undefined) ||
				(args.from as string | undefined) ||
				process.env.AGENT_PRINCIPAL_ID ||
				"unknown";
			const op = (args._op as string | undefined) ?? `${name}:call`;
			await query(
				`INSERT INTO roadmap.tool_invocation_log (tool_name, principal_id, op, metadata)
				 VALUES ($1, $2, $3, $4)`,
				[name, principal, op, JSON.stringify({ args })],
			);
		} catch (_err) {
			// Invocation log write failures are non-fatal.
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
	 * Create a fresh SDK Server whose request handlers all delegate to this
	 * shared McpServer instance.
	 *
	 * The MCP SDK Protocol is strictly one-to-one with a transport: calling
	 * server.connect() a second time throws "Already connected to a transport".
	 * SSE and StreamableHTTP sessions therefore each need their own SDK Server,
	 * but they can share this McpServer's tool/resource/prompt registries.
	 * Using this factory, createMcpServer() is called only once at process
	 * startup (no repeated DB queries or NOTIFY listener setup).
	 */
	private createBoundSessionServer(): Server {
		const sessionServer = new Server(
			{ name: APP_NAME, version: APP_VERSION },
			{
				capabilities: {
					tools: { listChanged: true },
					resources: { listChanged: true },
					prompts: { listChanged: true },
				},
				instructions: this.instructions,
			},
		);
		sessionServer.setRequestHandler(ListToolsRequestSchema, async () =>
			this.listTools(),
		);
		sessionServer.setRequestHandler(CallToolRequestSchema, async (request) =>
			this.callTool(request),
		);
		sessionServer.setRequestHandler(ListResourcesRequestSchema, async () =>
			this.listResources(),
		);
		sessionServer.setRequestHandler(
			ListResourceTemplatesRequestSchema,
			async () => this.listResourceTemplates(),
		);
		sessionServer.setRequestHandler(
			ReadResourceRequestSchema,
			async (request) => this.readResource(request),
		);
		sessionServer.setRequestHandler(ListPromptsRequestSchema, async () =>
			this.listPrompts(),
		);
		sessionServer.setRequestHandler(GetPromptRequestSchema, async (request) =>
			this.getPrompt(request),
		);
		return sessionServer;
	}

	/**
	 * Create a new SSE transport for a connection.
	 * Uses a per-session SDK Server that delegates handlers to this shared instance.
	 */
	public async createSseTransport(
		endpoint: string,
		res: SseTransportResponse,
	): Promise<SSEServerTransport> {
		const transport = new SSEServerTransport(endpoint, res);
		await this.createBoundSessionServer().connect(transport);
		return transport;
	}

	/**
	 * Create a new StreamableHTTP transport for a connection.
	 * Compatible with hermes MCP client and other StreamableHTTP clients.
	 * Uses a per-session SDK Server that delegates handlers to this shared instance.
	 */
	public async createStreamableHttpTransport(): Promise<StreamableHTTPServerTransport> {
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined, // stateless
		});
		await this.createBoundSessionServer().connect(transport);
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

	// P854: Run fn inside agentContextStorage if Authorization header carries a valid bearer token.
	async runWithBearerContext<T>(authHeader: string | undefined, fn: () => Promise<T>): Promise<T> {
		if (authHeader?.startsWith("Bearer ")) {
			const token = authHeader.slice(7) as BoundBearerToken;
			const res = verifyBoundBearer(token, this._getOperatorHmacSecret());
			if (res.ok && res.principal_id) {
				const principal: VerifiedPrincipal = {
					principal_id: res.principal_id,
					principal_kind: "operator",
					parent_principal_id: null,
				};
				return agentContextStorage.run({ verified: principal }, fn);
			}
		}
		return fn();
	}

	// P843: Get or generate operator HMAC secret
	private _getOperatorHmacSecret(): Buffer {
		const envSecret = process.env.OPERATOR_HMAC_SECRET;
		if (envSecret) {
			try {
				return Buffer.from(envSecret, "hex");
			} catch {
				console.warn(
					"[P843] OPERATOR_HMAC_SECRET is not valid hex; generating random secret"
				);
			}
		}
		// Generate a random 32-byte secret as fallback
		return randomBytes(32);
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
	registerProjectTools(server);

	// --- Backend routing: Postgres vs filesystem ---
	const usePostgres = config.database?.provider === "Postgres";

	if (usePostgres) {
		if (config.database) {
			pgPool.initPoolFromConfig(config.database);
		}

		// Load state-names registry from DB (includes NOTIFY listener for live reloads)
		try {
			const pool = pgPool.getPool();
			await loadStateNames(pool);
			if (options.debug) {
				console.error("[MCP] State-names registry loaded from database");
			}
		} catch (error) {
			console.error("[MCP] Failed to load state-names registry:", error);
			// Non-fatal; continue without the registry
		}

		// Register timeout cron for A2A message reliability (P835)
		try {
			const { registerTimeoutCron } = await import(
				"../../infra/messaging/timeout-cron.ts"
			);
			const pool = pgPool.getPool();
			await registerTimeoutCron(pool);
			if (options.debug) {
				console.error("[MCP] Timeout cron registered for message reliability");
			}
		} catch (error) {
			console.error("[MCP] Failed to register timeout cron:", error);
			// Non-fatal; continue without timeout reliability (messages won't escalate/remind)
		}

		// Register delivery_id_log cleanup cron (P836) — every 5 min, advisory-lock guarded
		try {
			const { registerDeliveryIdLogCleanup } = await import(
				"../../infra/messaging/cross-host-relay.ts"
			);
			const cleanupPool = pgPool.getPool();
			await registerDeliveryIdLogCleanup(cleanupPool);
			if (options.debug) {
				console.error("[MCP] Delivery ID log cleanup cron registered");
			}
		} catch (error) {
			console.error("[MCP] Failed to register delivery ID log cleanup:", error);
			// Non-fatal; delivery_id_log will grow until manually pruned
		}

		// P194: memory from durable proposal, dispatch, liaison, route, and gate events.
		try {
			const { registerMemoryEventConsumer } = await import(
				"../../memory/memory-event-consumer.ts"
			);
			await registerMemoryEventConsumer();
			if (options.debug) {
				console.error("[MCP] Memory event consumer registered");
			}
		} catch (error) {
			console.error("[MCP] Failed to register memory event consumer:", error);
		}

		// P404: reap scratch dirs left by any prior MCP server epoch (dry-run logs, then delete).
		try {
			const { reapOrphanScratch } = await import(
				"../../core/orchestration/scratch.ts"
			);
			await reapOrphanScratch({ dryRun: true });
			await reapOrphanScratch({ dryRun: false });
			if (options.debug) {
				console.error("[MCP] Boot scratch orphan reap complete");
			}
		} catch (error) {
			console.error("[MCP] Boot scratch orphan reap failed (non-fatal):", error);
		}

		// V2 agentHive2 connectivity check (P826) — non-fatal, opt-in via env
		if (process.env.AGENTHIVE_V2_DB_URL) {
			const { verifyAgentHive2Connection } = await import(
				"../../postgres/pool-registry.ts"
			);
			void verifyAgentHive2Connection(
				process.env.AGENTHIVE_V2_PROJECT_SCHEMA ?? "agentHive",
			);
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
			description:
				"Register or update an agent. Idempotent UPSERT keyed on identity. " +
				"COALESCE on UPDATE preserves existing values when fields are omitted. " +
				"P1129 Phase A: accepts agency-shape fields (preferred_provider, agent_cli, host_affinity, display_alias, display_name).",
			inputSchema: {
				type: "object",
				properties: {
					identity: { type: "string", description: "Agent identity (canonical key)" },
					agent_type: { type: "string", description: "e.g. 'agency', 'llm', 'tool'" },
					role: { type: "string", description: "e.g. 'liaison', 'developer'" },
					skills: {
						type: "string",
						description: "JSON array or comma-separated string",
					},
					preferred_provider: {
						type: "string",
						description:
							"Agent-provider vocabulary (claude/codex/gemini/copilot). NOT route_provider.",
					},
					agent_cli: {
						type: "string",
						description: "CLI command this agent uses (e.g. 'claude', 'gemini')",
					},
					host_affinity: {
						type: "string",
						description:
							"Preferred host_name (must match host_model_policy.host_name when used by an agency)",
					},
					display_alias: {
						type: "string",
						description: "Short alias for display (must be unique)",
					},
					display_name: {
						type: "string",
						description: "Human-readable label",
					},
				},
				required: ["identity"],
			},
			handler: (a) => agents.registerAgent(a as RegisterPgAgentArgs),
		});
		server.addTool({
			name: "agent_register_agency",
			description:
				"P1372: Register an agency in roadmap.agency. Validates that the agency_id exists in agent_registry as an active agency, then idempotently inserts into roadmap.agency.",
			inputSchema: {
				type: "object",
				properties: {
					agent_identity: { type: "string" },
					identity: { type: "string" },
					agency_id: { type: "string" },
					display_name: { type: "string" },
					provider: { type: "string" },
					host_id: { type: "string" },
					metadata: { type: "object", additionalProperties: true },
				},
			},
			handler: (a) =>
				agents.registerAgency(
					a as Parameters<PgAgentHandlers["registerAgency"]>[0],
				),
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
		// P797: model_list with provider/tier/project_id filtering and route join
		server.addTool({
			name: "model_list",
			description: "List registered models with optional capability, cost, provider, and tier filters. Results are joined with model_routes — only models with at least one enabled route are returned.",
			inputSchema: {
				type: "object",
				properties: {
					capability: { type: "string", description: "Filter by capability, e.g. 'tool_use=true'" },
					max_cost_per_million_input: { type: "string", description: "Max cost per million input tokens" },
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
					tier: {
						type: "string",
						enum: ["frontier", "standard", "economy"],
						description: "Model tier: frontier (GPT-4o, Claude Opus/Sonnet), standard (GPT-4o-mini, Claude Haiku), economy (Llama, open-source)",
					},
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

		// P230: Team memory tools
		type TeamMemSetArgs = Parameters<typeof memory.teamMemSet>[0];
		type TeamMemGetArgs = Parameters<typeof memory.teamMemGet>[0];
		type TeamMemListArgs = Parameters<typeof memory.teamMemList>[0];
		server.addTool({
			name: "team_mem_set",
			description: "Set a team-scoped shared memory entry (squad decisions, durable knowledge)",
			inputSchema: {
				type: "object",
				properties: {
					team_name: { type: "string", description: "Team/squad identifier" },
					key: { type: "string", description: "Memory key" },
					value: { type: "string", description: "JSON-serializable value" },
					created_by: { type: "string", description: "Agent identity writing this entry" },
					expires_in_days: { type: "number", description: "TTL in days (omit for no expiry)" },
				},
				required: ["team_name", "key", "value"],
			},
			handler: (a) => memory.teamMemSet(a as TeamMemSetArgs),
		});
		server.addTool({
			name: "team_mem_get",
			description: "Get a single team-scoped memory entry by key",
			inputSchema: {
				type: "object",
				properties: {
					team_name: { type: "string", description: "Team/squad identifier" },
					key: { type: "string", description: "Memory key to retrieve" },
				},
				required: ["team_name", "key"],
			},
			handler: (a) => memory.teamMemGet(a as TeamMemGetArgs),
		});
		server.addTool({
			name: "team_mem_list",
			description: "List all non-expired memory entries for a team",
			inputSchema: {
				type: "object",
				properties: {
					team_name: { type: "string", description: "Team/squad identifier" },
				},
				required: ["team_name"],
			},
			handler: (a) => memory.teamMemList(a as TeamMemListArgs),
		});

		// P078: Escalation Management tools
		const { registerEscalationTools } = await import("./tools/escalation/index.ts");
		registerEscalationTools(server);

		// P187: Reference Catalog tools
		const { registerReferenceTools } = await import("./tools/reference/index.ts");
		registerReferenceTools(server);

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
			description:
				"Create a new cubic workspace. P459: Supports phase-driven role allocation. " +
				"If agent_identity provided, validates its role against phase. " +
				"Without agent_identity, uses phase defaults. " +
				"agents arg overrides (operator escape hatch) but is still validated.",
			inputSchema: {
				type: "object",
				properties: {
					name: { type: "string" },
					agent_identity: {
						type: "string",
						description:
							"Optional agent identity. Role validated against allowed_roles for phase.",
					},
					agents: {
						type: "array",
						items: { type: "string" },
						description:
							"Optional override of agents. If provided, still validated against phase allowed_roles.",
					},
					proposals: { type: "array", items: { type: "string" } },
					phase: {
						type: "string",
						description: "Phase (design/build/test/ship, default: design)",
					},
				},
				required: ["name"],
			},
			handler: (a) => cubic.createCubic(a as CreateCubicArgs),
		});
		server.addTool({
			name: "cubic_list",
			description:
				"List cubics. By default returns up to 50 active/idle cubics " +
				"without large metadata. Pass include_terminal=true for completed/expired, " +
				"include_metadata=true to include per-cubic metadata payload, or limit/agent/status " +
				"to scope further. (Re: P458)",
			inputSchema: {
				type: "object",
				properties: {
					status: {
						type: "string",
						description:
							"Filter by exact status (e.g. active, idle, expired, completed). " +
							"If omitted, defaults to active+idle.",
					},
					agent: { type: "string" },
					limit: {
						type: "number",
						description:
							"Max cubics returned (1..500, default 50).",
					},
					include_metadata: {
						type: "boolean",
						description:
							"Include each cubic's metadata JSON in the response. " +
							"Default false to keep responses small (avg metadata ~1.3KB/row, " +
							"6900+ historical rows).",
					},
					include_terminal: {
						type: "boolean",
						description:
							"If true, include expired/completed/recycled cubics. " +
							"Default false. Use status= for explicit terminal filtering.",
					},
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
		server.addTool({
			name: "cubic_acquire",
			description:
				"Atomic cubic acquisition: find-or-create for agent, recycle if locked elsewhere, focus on proposal. One call replaces cubic_list + cubic_recycle + cubic_focus.",
			inputSchema: {
				type: "object",
				properties: {
					agent_identity: {
						type: "string",
						description: "Agent identity (resolved from trust registry; format: provider/agency-name or role-name)",
					},
					proposal_id: {
						type: "number",
						description: "Proposal ID to focus the cubic on",
					},
					phase: {
						type: "string",
						description: "Cubic phase (design, build, test, ship). Default: design",
					},
					budget_usd: {
						type: "number",
						description: "Optional budget allocation for this cubic session",
					},
					worktree_path: {
						type: "string",
						description: "Optional worktree path override",
					},
				},
				required: ["agent_identity", "proposal_id"],
			},
			handler: (a) =>
				cubic.acquireCubic(
					a as Parameters<typeof cubic.acquireCubic>[0],
				),
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

		// P499: PgBouncer stats — queries admin console on PGPORT
		server.addTool({
			name: "pgbouncer_stats",
			description:
				"Query PgBouncer admin console (SHOW POOLS + SHOW STATS). " +
				"Returns pool saturation, queue depth, and per-database stats. " +
				"Returns an error message if PgBouncer is not reachable.",
			inputSchema: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
			handler: async (): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
				const { Client } = await import("pg");
				const host = process.env.PGHOST ?? "127.0.0.1";
				const port = Number(process.env.PGPORT ?? 6432);
				const adminUser =
					process.env.PGBOUNCER_ADMIN_USER ?? process.env.PGUSER ?? "pgbouncer";
				const client = new Client({ host, port, user: adminUser, database: "pgbouncer" });
				try {
					await client.connect();
					const [poolsRes, statsRes] = await Promise.all([
						client.query("SHOW POOLS"),
						client.query("SHOW STATS"),
					]);
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									{ pools: poolsRes.rows, stats: statsRes.rows },
									null,
									2,
								),
							},
						],
					};
				} catch (err) {
					return {
						content: [
							{
								type: "text",
								text: `pgbouncer_stats unavailable: ${(err as Error).message}`,
							},
						],
					};
				} finally {
					try {
						await client.end();
					} catch {
						// ignore close errors
					}
				}
			},
		});

		console.error(
			"[MCP] Using Postgres backend (agenthive) for proposals, messaging, agents, spending, memory, RFC workflow, SMDL, cubics, pulse, federation, discord",
		);
	} else {
		registerFilesystemProposalTools(server, config);
		registerMessageTools(server);
		registerAgentTools(server);
		await registerTeamTools(server);
		console.error("[MCP] Using legacy filesystem proposal tools");
	}
	registerTestingTools(server);
	registerDependencyTools(server);
	if (usePostgres) {
		registerConsolidatedTools(server);
		server.setConsolidatedToolSurface(true);
	}

	// P895: Backup harness tools
	const { registerBackupTools } = await import("./tools/backup/index.ts");
	registerBackupTools(server);

	// P1109 Tier-1: schema introspection so build agents stop fabricating column names.
	const { registerSchemaTools } = await import("./tools/schema/index.ts");
	registerSchemaTools(server);

	// P289: Workforce management tools (agency registration, provider registry, dispatches)
	const workforce = await import("./tools/workforce/handlers.ts");
	const workforceSchemas = await import("./tools/workforce/schemas.ts");
	const smHandlers = await import("./tools/workforce/state-machine-handlers.ts");
	server.addTool({
		name: "agency_register",
		description:
			"Register an agency (long-lived identity) in agent_registry. EVERY " +
			"registration also spawns a liaison — the agency and its liaison are " +
			"the same combined service (P996 '-a' convention), there is no " +
			"separate liaison_register call. Naming: prefer first-name pools " +
			"(a* Claude, c* Codex, g* Gemini, p* Copilot, h* Hermes; male = " +
			"builder, female = skeptic) or P1367 aliases (claude-a, codex-a, " +
			"claude-mimo-a, copilot-gary-a). Call this BEFORE provider_register.",
		inputSchema: workforceSchemas.agencyRegisterSchema,
		handler: (a) => workforce.agencyRegisterHandler(a),
	});
	server.addTool({
		name: "provider_register",
		description: "Register an agency as a provider for a project/squad with capabilities. Agency must be registered first via agency_register.",
		inputSchema: workforceSchemas.providerRegisterSchema,
		handler: (a) => workforce.providerRegisterHandler(a),
	});
	server.addTool({
		name: "dispatch_list",
		description: "List squad_dispatch offers with status filter. Shows agency, worker, offer status, and lease info.",
		inputSchema: workforceSchemas.dispatchListSchema,
		handler: (a) => workforce.dispatchListHandler(a),
	});
	server.addTool({
		name: "worker_register",
		description: "Register an ephemeral worker agent under a parent agency. Called on spawn.",
		inputSchema: workforceSchemas.workerRegisterSchema,
		handler: (a) => workforce.workerRegisterHandler(a),
	});

	// P917: Agency lifecycle tools — liaison registration, project join/leave, status
	const {
		agencyBootstrapHandler,
		agencyJoinProjectHandler,
		agencyLeaveProjectHandler,
		agencyLiaisonStatusHandler,
	} = await import("./tools/agency/liaison-pg-handlers.ts");
	server.addTool({
		name: "agency_bootstrap",
		description:
			"Register an agency with the liaison layer (roadmap.agency) and open a new session. " +
			"Idempotent — safe to call on every boot. " +
			"Required: agency_id, display_name, provider, host_id.",
		inputSchema: {
			type: "object",
			properties: {
				agency_id: { type: "string", description: "Canonical agency identity (e.g. anthropic/hermes)" },
				display_name: { type: "string", description: "Human-readable name" },
				provider: { type: "string", description: "Provider prefix (e.g. anthropic, openai)" },
				host_id: { type: "string", description: "Host machine identifier" },
				capabilities: { type: "array", items: { type: "string" }, description: "Capability tags" },
				capacity_envelope: { type: "object", additionalProperties: true, description: "Capacity metadata (concurrency, slots, …)" },
				public_key: { type: "string", description: "Optional public key for identity verification" },
				metadata: { type: "object", additionalProperties: true, description: "Arbitrary metadata bag" },
			},
			required: ["agency_id", "display_name", "provider", "host_id"],
			additionalProperties: false,
		},
		handler: (a) => agencyBootstrapHandler(a),
	});
	server.addTool({
		name: "agency_join_project",
		description:
			"Bridge a registered agency into a project's dispatch pool (provider_registry). " +
			"Agency must already be registered via agency_bootstrap AND agency_register. " +
			"Required: agency_id, project_slug.",
		inputSchema: {
			type: "object",
			properties: {
				agency_id: { type: "string", description: "Agency identity" },
				project_slug: { type: "string", description: "Project name/slug to join" },
				capabilities: { type: "array", items: { type: "string" }, description: "Override capabilities for this project" },
			},
			required: ["agency_id", "project_slug"],
			additionalProperties: false,
		},
		handler: (a) => agencyJoinProjectHandler(a),
	});
	server.addTool({
		name: "agency_leave_project",
		description:
			"Pause an agency's dispatch eligibility for a project (sets provider_registry.status = 'paused'). " +
			"No-op if already paused or not found.",
		inputSchema: {
			type: "object",
			properties: {
				agency_id: { type: "string", description: "Agency identity" },
				project_slug: { type: "string", description: "Project name/slug to leave" },
			},
			required: ["agency_id", "project_slug"],
			additionalProperties: false,
		},
		handler: (a) => agencyLeaveProjectHandler(a),
	});
	server.addTool({
		name: "agency_liaison_status",
		description:
			"Query liaison status for an agency or list all dispatchable agencies. " +
			"With agency_id: returns { agency_id, display_name, status, silence_seconds, dispatchable }. " +
			"Without agency_id: returns all dispatchable agencies.",
		inputSchema: {
			type: "object",
			properties: {
				agency_id: { type: "string", description: "Optional agency identity; omit to list all dispatchable agencies" },
			},
			additionalProperties: false,
		},
		handler: (a) => agencyLiaisonStatusHandler(a),
	});
	console.error("[MCP] Registered 4 P917 agency lifecycle tools (bootstrap / join_project / leave_project / liaison_status)");

	// P297: State machine management tools
	server.addTool({
		name: "state_machine_start",
		description: "Start the orchestrator service",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		handler: () => smHandlers.stateMachineStartHandler({}),
	});
	server.addTool({
		name: "state_machine_stop",
		description: "Stop the orchestrator service",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		handler: () => smHandlers.stateMachineStopHandler({}),
	});
	server.addTool({
		name: "state_machine_status",
		description: "Show state machine status: services, agencies, offers, active dispatches",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		handler: () => smHandlers.stateMachineStatusHandler({}),
	});
	server.addTool({
		name: "agencies_list",
		description: "List registered agencies and their capabilities",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		handler: () => smHandlers.agenciesListHandler({}),
	});
	server.addTool({
		name: "offers_list",
		description: "List dispatch offers, optionally filtered by status",
		inputSchema: {
			type: "object",
			properties: {
				status: { type: "string", enum: ["open", "claimed", "active", "delivered", "failed", "expired"] },
			},
			additionalProperties: false,
		},
		handler: (a) => smHandlers.offersListHandler(a),
	});

	// P297: Project management tools (multi-project agency routing)
	const projectHandlers = await import("./tools/workforce/project-handlers.ts");
	server.addTool({
		name: "project_list",
		description: "List all projects with agency counts",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		handler: () => projectHandlers.projectListHandler({}),
	});
	server.addTool({
		name: "project_create",
		description: "Create a new project",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string", description: "Project name (unique)" },
				description: { type: "string", description: "What this project is about" },
				owner: { type: "string", description: "Who created it" },
			},
			required: ["name"],
			additionalProperties: false,
		},
		handler: (a) => projectHandlers.projectCreateHandler(a),
	});
	server.addTool({
		name: "project_join",
		description: "Agency joins a project. Call agency_register first.",
		inputSchema: {
			type: "object",
			properties: {
				agencyIdentity: { type: "string", description: "Agency identity" },
				projectName: { type: "string", description: "Project to join" },
				capabilities: { type: "array", items: { type: "string" }, description: "Caps for this project" },
			},
			required: ["agencyIdentity", "projectName"],
			additionalProperties: false,
		},
		handler: (a) => projectHandlers.projectJoinHandler(a),
	});
	server.addTool({
		name: "project_leave",
		description: "Agency leaves a project",
		inputSchema: {
			type: "object",
			properties: {
				agencyIdentity: { type: "string" },
				projectName: { type: "string" },
			},
			required: ["agencyIdentity", "projectName"],
			additionalProperties: false,
		},
		handler: (a) => projectHandlers.projectLeaveHandler(a),
	});
	server.addTool({
		name: "project_agencies",
		description: "List agencies in a project (or all projects)",
		inputSchema: {
			type: "object",
			properties: {
				projectName: { type: "string", description: "Filter by project name" },
			},
			additionalProperties: false,
		},
		handler: (a) => projectHandlers.projectAgenciesHandler(a),
	});
	server.addTool({
		name: "project_overview",
		description: "Full overview: all projects with their agencies and capabilities",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		handler: () => projectHandlers.projectOverviewHandler({}),
	});

	// P466: Spawn-briefing protocol — wire the liaison loop.
	// Without these tools registered, briefing_assemble / briefing_load /
	// spawn_summary_emit are unreachable and dispatched agents run blind
	// with no proposal context. The handlers themselves were already built
	// in tools/agency/handlers.ts; this block exposes them over MCP and
	// adapts their raw return shape to CallToolResult.
	const agencyHandlers = await import("./tools/agency/handlers.ts");
	const wrapJson = (fn: (a: any) => Promise<unknown>) =>
		async (args: any): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
			try {
				const result = await fn(args);
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `❌ ${(err as Error).message}`,
						},
					],
				};
			}
		};

	server.addTool({
		name: "briefing_assemble",
		description:
			"Parent assembles a warm-boot briefing before spawning a child agent. " +
			"Returns briefing_id; pass it to the child as AGENTHIVE_BRIEFING_ID env or in task metadata. " +
			"Required: task_id, mission, briefed_by. " +
			"Optional: success_criteria[], allowed_tools[], forbidden_tools[], budget, parent_agent, liaison_agent.",
		inputSchema: {
			type: "object",
			properties: {
				task_id: { type: "string" },
				mission: { type: "string" },
				success_criteria: { type: "array", items: { type: "string" } },
				done_signal: { type: "string", enum: ["ac-pass", "verdict", "pr-merged", "custom"] },
				allowed_tools: { type: "array", items: { type: "string" } },
				forbidden_tools: { type: "array", items: { type: "string" } },
				budget: {
					type: "object",
					properties: {
						max_tokens: { type: ["number", "null"] },
						max_minutes: { type: ["number", "null"] },
						max_tool_calls: { type: ["number", "null"] },
					},
				},
				stop_conditions: { type: "array", items: { type: "string" } },
				parent_agent: { type: "string" },
				liaison_agent: { type: "string" },
				rescue_team_channel: { type: "string" },
				request_assistance_threshold: { type: "number" },
				topic_keywords: { type: "array", items: { type: "string" } },
				briefed_by: { type: "string" },
			},
			required: ["task_id", "mission", "briefed_by"],
		},
		handler: wrapJson((a) => agencyHandlers.handleBriefingAssemble(a)),
	});

	server.addTool({
		name: "briefing_load",
		description:
			"Child agent calls this on boot to retrieve the warm-boot briefing assembled by its parent. " +
			"Returns the full SpawnBriefing (mission, success_criteria, allowed_tools, MCP quirks, fallback playbook, escalation channels). " +
			"Fails closed if briefing_id is missing or unknown — child should HALT in that case.",
		inputSchema: {
			type: "object",
			properties: { briefing_id: { type: "string" } },
			required: ["briefing_id"],
		},
		handler: wrapJson((a) => agencyHandlers.handleBriefingLoad(a)),
	});

	server.addTool({
		name: "child_boot_check",
		description:
			"Child agent calls at startup to verify the warm-boot payload exists. " +
			"Returns {status: 'ready', briefing}. Fails closed when briefing_id absent or unknown — refuse to proceed.",
		inputSchema: {
			type: "object",
			properties: { briefing_id: { type: "string" } },
			required: ["briefing_id"],
		},
		handler: wrapJson((a) => agencyHandlers.handleChildBootCheck(a)),
	});

	server.addTool({
		name: "spawn_summary_emit",
		description:
			"Child agent calls on completion to emit outcome + new findings + updated MCP quirks. " +
			"Required: briefing_id, outcome (success|partial|failure|timeout|escalated), emitted_by. " +
			"Subsequent spawns inherit harvested findings via briefing_assemble.",
		inputSchema: {
			type: "object",
			properties: {
				briefing_id: { type: "string" },
				outcome: { type: "string", enum: ["success", "partial", "failure", "timeout", "escalated"] },
				summary: { type: "string" },
				new_findings: {
					type: "array",
					items: {
						type: "object",
						properties: {
							date: { type: "string" },
							summary: { type: "string" },
							proposal: { type: "string" },
						},
						required: ["summary"],
					},
				},
				updated_quirks: { type: "array", items: { type: "object" } },
				tool_calls_made: { type: "number" },
				tokens_used: { type: "number" },
				duration_seconds: { type: "number" },
				error_log: { type: "object" },
				state_snapshot: { type: "object" },
				emitted_by: { type: "string" },
			},
			required: ["briefing_id", "outcome", "emitted_by"],
		},
		handler: wrapJson((a) => agencyHandlers.handleSpawnSummaryEmit(a)),
	});

	server.addTool({
		name: "briefing_list",
		description: "Operator/debug: list recent briefings (briefing_id, task_id, mission, briefed_by, briefed_at).",
		inputSchema: {
			type: "object",
			properties: {
				limit: { type: "number" },
				offset: { type: "number" },
			},
		},
		handler: wrapJson((a) => agencyHandlers.handleBriefingList(a)),
	});

	server.addTool({
		name: "fallback_playbook_add",
		description: "Add an error→action recovery pattern that future briefings will inherit.",
		inputSchema: {
			type: "object",
			properties: {
				error_signature: { type: "string" },
				tool_name: { type: "string" },
				error_class: { type: "string" },
				try_action: { type: "string" },
				rationale: { type: "string" },
				source_proposal: { type: "string" },
				confidence: { type: "number" },
			},
			required: ["error_signature", "try_action"],
		},
		handler: wrapJson((a) => agencyHandlers.handleFallbackPlaybookAdd(a)),
	});

	server.addTool({
		name: "mcp_quirks_register",
		description: "Register/update canonical args + known gotchas for an MCP tool. Briefings inherit this catalog.",
		inputSchema: {
			type: "object",
			properties: {
				tool_name: { type: "string" },
				mcp_server: { type: "string" },
				canonical_args: { type: "object", additionalProperties: { type: "string" } },
				description: { type: "string" },
				known_gotchas: { type: "array", items: { type: "object" } },
				param_aliases: { type: "object", additionalProperties: { type: "string" } },
			},
			required: ["tool_name", "canonical_args"],
		},
		handler: wrapJson((a) => agencyHandlers.handleMcpQuirksRegister(a)),
	});

	server.addTool({
		name: "request_lease_renewal",
		description:
			"Request a lease extension for a proposal that needs more time (agent is making progress, not stuck). " +
			"Renewals 1 and 2 are auto-approved (extend lease 30 min). Renewal 3 requires operator approval.",
		inputSchema: {
			type: "object",
			properties: {
				briefing_id: { type: "string", description: "UUID of the current briefing" },
				agency_id: { type: "string", description: "Agency handling this briefing" },
				reason: { type: "string", description: "Why more time is needed" },
				proposal_id: {
					type: "number",
					description: "Optional proposal_id for direct lease lookup (faster than briefing lookup)",
				},
			},
			required: ["briefing_id", "agency_id", "reason"],
		},
		handler: wrapJson(async (a) => {
			const { requestLeaseRenewal } = await import("../../infra/agency/liaison-lease.ts");
			return requestLeaseRenewal(
				a.briefing_id,
				a.agency_id,
				a.reason,
				a.proposal_id != null ? BigInt(a.proposal_id) : undefined
			);
		}),
	});

	server.addTool({
		name: "progress_note",
		description:
			"Report a progress checkpoint to Liaison. Call every 5 tool calls to confirm you are making forward progress. " +
			"Required when checkpoint_interval is due — failure to call causes Liaison to flag you as stuck.",
		inputSchema: {
			type: "object",
			properties: {
				briefing_id: { type: "string", description: "UUID of the current briefing" },
				summary: { type: "string", description: "What you accomplished since the last checkpoint" },
				confidence: {
					type: "string",
					enum: ["low", "med", "high"],
					description: "How confident you are that your current approach will succeed",
				},
				next_attempt: {
					type: "string",
					description: "Optional: what you plan to do next",
				},
			},
			required: ["briefing_id", "summary", "confidence"],
		},
		handler: wrapJson(async (a) => {
			const { recordProgressCheckpoint } = await import("../../infra/agency/stuck-detection.ts");
			const accepted = await recordProgressCheckpoint({
				briefing_id: a.briefing_id,
				summary: a.summary,
				next_attempt: a.next_attempt ?? "",
				confidence: a.confidence as "low" | "med" | "high",
			});
			// Best-effort notification to Liaison channel
			try {
				await pgPool.query(
					`INSERT INTO roadmap.message_ledger
					    (from_agent, channel, message_content, message_type, metadata)
					 VALUES ('subagent', $1, $2, 'progress_note', $3)`,
					[
						`system:progress:${a.briefing_id}`,
						a.summary,
						JSON.stringify({
							briefing_id: a.briefing_id,
							confidence: a.confidence,
							next_attempt: a.next_attempt ?? null,
							accepted,
							ts: new Date().toISOString(),
						}),
					]
				);
			} catch {
				// Best-effort; do not fail the checkpoint because the ledger insert failed
			}
			return {
				accepted,
				message: accepted
					? "Checkpoint recorded. Keep going."
					: "Checkpoint already pending — no duplicate recorded. Continue working.",
			};
		}),
	});

	console.error("[MCP] Registered 9 P466/P468/P475 spawn-briefing tools (liaison protocol)");

	// P917: Agency lifecycle actions
	{
		const {
			agencyBootstrapHandler,
			agencyJoinProjectHandler,
			agencyLeaveProjectHandler,
			agencyLiaisonStatusHandler,
		} = await import("./tools/agency/liaison-pg-handlers.ts");

		server.addTool({
			name: "agency_bootstrap",
			description:
				"Register an agency and open a liaison session (idempotent UPSERT). " +
				"Call once on agency boot; safe to re-call — replaces the active session and refreshes registration.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				properties: {
					agency_id: { type: "string", description: "Stable identity of the agency (e.g. 'hermes')" },
					display_name: { type: "string", description: "Human-readable name shown in dashboards" },
					provider: { type: "string", description: "Model provider (e.g. 'anthropic', 'google', 'openai')" },
					host_id: { type: "string", description: "Hostname or node identifier where the agency is running" },
					capabilities: { type: "array", items: { type: "string" }, description: "Optional capability tags" },
					capacity_envelope: { type: "object", description: "Optional capacity envelope (free-form JSON)" },
					public_key: { type: "string", description: "Optional public key for A2A auth" },
					metadata: { type: "object", description: "Optional extra metadata" },
				},
				required: ["agency_id", "display_name", "provider", "host_id"],
			},
			handler: wrapJson((a) => agencyBootstrapHandler(a)),
		});

		server.addTool({
			name: "agency_join_project",
			description:
				"Opt an agency into a project's dispatch pool. " +
				"Inserts or re-activates a provider_registry row so the agency receives work offers for that project.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				properties: {
					agency_id: { type: "string", description: "Agency identity" },
					project_id: { type: "number", description: "Numeric project ID to join" },
				},
				required: ["agency_id", "project_id"],
			},
			handler: wrapJson((a) => agencyJoinProjectHandler(a)),
		});

		server.addTool({
			name: "agency_leave_project",
			description:
				"Remove an agency from a project's dispatch pool. " +
				"Sets is_active=false in provider_registry; the agency stops receiving new offers for that project.",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				properties: {
					agency_id: { type: "string", description: "Agency identity" },
					project_id: { type: "number", description: "Numeric project ID to leave" },
				},
				required: ["agency_id", "project_id"],
			},
			handler: wrapJson((a) => agencyLeaveProjectHandler(a)),
		});

		server.addTool({
			name: "agency_liaison_status",
			description:
				"Query the current liveness and dispatch status of an agency from v_agency_status. " +
				"Returns: agency_id, display_name, status, silence_seconds, dispatchable, " +
				"liveness_state (one of: poke-pending | stale-unresponsive | late-pong | live-and-working | live-but-idle | offline).",
			inputSchema: {
				type: "object",
				additionalProperties: false,
				properties: {
					agency_id: { type: "string", description: "Agency identity to query" },
				},
				required: ["agency_id"],
			},
			handler: wrapJson((a) => agencyLiaisonStatusHandler(a)),
		});

		console.error("[MCP] Registered 4 P917 agency lifecycle tools");
	}

	// P499: PgBouncer operator tools
	const { PgBouncerOpsHandler } = await import("./tools/ops/pgbouncer-ops.ts");
	const pgbouncer = new PgBouncerOpsHandler();
	server.addTool({
		name: "pgbouncer_stats",
		description: "Query PgBouncer admin console: SHOW POOLS + SHOW STATS. Returns pool sizes, wait times, and per-database query statistics.",
		inputSchema: { type: "object", properties: {} },
		handler: () => pgbouncer.pgbouncerStats().then((r) => ({ content: [{ type: "text", text: JSON.stringify(r, null, 2) }] })),
	});
	server.addTool({
		name: "pgbouncer_ping",
		description: "Ping the PgBouncer admin console. Returns { ok, latency_ms, host, port }.",
		inputSchema: { type: "object", properties: {} },
		handler: () => pgbouncer.pgbouncerPing().then((r) => ({ content: [{ type: "text", text: JSON.stringify(r) }] })),
	});
	server.addTool({
		name: "pgbouncer_reload",
		description: "Send RELOAD to PgBouncer — picks up userlist.txt and pgbouncer.ini changes without dropping existing connections.",
		inputSchema: { type: "object", properties: {} },
		handler: () => pgbouncer.pgbouncerReload().then((r) => ({ content: [{ type: "text", text: JSON.stringify(r) }] })),
	});

	// P1359: Provider/model cooldown management tools
	const { cooldownStatus, cooldownClear, providerCooldownClear } = await import(
		"./tools/ops/cooldown-ops.ts"
	);
	server.addTool({
		name: "cooldown_status",
		description: "List active model-level and provider-level cooldowns. Params: provider (optional filter), only_active (default true).",
		inputSchema: {
			type: "object",
			properties: {
				provider: {
					type: "string",
					description: "Optional filter by route provider name",
				},
				only_active: {
					type: "boolean",
					description: "Only show active cooldowns (default: true)",
				},
			},
		},
		handler: (args) => {
			return cooldownStatus(args as Record<string, unknown>).then((r) => ({
				content: [{ type: "text", text: JSON.stringify(r, null, 2) }],
			}));
		},
	});
	server.addTool({
		name: "cooldown_clear",
		description: "Clear model-level cooldown for a specific (provider, model) pair. Sets cooldown_until to NULL.",
		inputSchema: {
			type: "object",
			properties: {
				provider: {
					type: "string",
					description: "Route provider name (required)",
				},
				model: {
					type: "string",
					description: "Model name (required)",
				},
			},
			required: ["provider", "model"],
		},
		handler: (args) => {
			return cooldownClear(args as Record<string, unknown>).then((r) => ({
				content: [{ type: "text", text: JSON.stringify(r, null, 2) }],
			}));
		},
	});
	server.addTool({
		name: "provider_cooldown_clear",
		description: "Clear provider-level cooldown. Sets cooldown_until to NULL on provider_health.",
		inputSchema: {
			type: "object",
			properties: {
				provider: {
					type: "string",
					description: "Provider name (required)",
				},
			},
			required: ["provider"],
		},
		handler: (args) => {
			return providerCooldownClear(args as Record<string, unknown>).then((r) => ({
				content: [{ type: "text", text: JSON.stringify(r, null, 2) }],
			}));
		},
	});

	// P1365: Agency capacity tracking tools
	const { capacitySnapshot, capacityClear } = await import(
		"./tools/ops/capacity-ops.ts"
	);
	server.addTool({
		name: "capacity_snapshot",
		description: "Get current agency capacity signals (rate-limits, headroom %). Optional filters: provider, model.",
		inputSchema: {
			type: "object",
			properties: {
				provider: {
					type: "string",
					description: "Optional filter by provider (anthropic, openai, google, github)",
				},
				model: {
					type: "string",
					description: "Optional filter by model name",
				},
			},
		},
		handler: (args) => {
			return capacitySnapshot(args as Record<string, unknown>).then((r) => ({
				content: [{ type: "text", text: JSON.stringify(r, null, 2) }],
			}));
		},
	});

	server.addTool({
		name: "capacity_clear",
		description: "Clear agency capacity entry from agency_capacity table and reset in-memory tracker.",
		inputSchema: {
			type: "object",
			properties: {
				agency_id: {
					type: "string",
					description: "Agency ID (required)",
				},
				provider: {
					type: "string",
					description: "Provider name (required)",
				},
				model: {
					type: "string",
					description: "Model name (required)",
				},
			},
			required: ["agency_id", "provider", "model"],
		},
		handler: (args) => {
			return capacityClear(args as Record<string, unknown>).then((r) => ({
				content: [{ type: "text", text: JSON.stringify(r, null, 2) }],
			}));
		},
	});

	// P1129: Agency lifecycle tools — agency_start / agency_status
	const { AgencyOpsHandler } = await import("./tools/ops/agency-ops.ts");
	const agencyOps = new AgencyOpsHandler();
	server.addTool({
		name: "agency_start",
		description:
			"P1129: Enable and start an agency's liaison systemd service. " +
			"Verifies agent_type='agency' in agent_registry before touching systemd. " +
			"Requires the mcp-server process user to have sudoers access to agenthive-agency@.service.",
		inputSchema: {
			type: "object",
			properties: {
				identity: {
					type: "string",
					description: "Agency identity (agent_identity in agent_registry, e.g. 'george')",
				},
			},
			required: ["identity"],
		},
		handler: async (args: Record<string, unknown>) =>
			agencyOps.agencyStart({ identity: String(args.identity) })
				.then((r) => ({ content: [{ type: "text", text: JSON.stringify(r, null, 2) }] })),
	});
	server.addTool({
		name: "agency_status",
		description:
			"P1129: Query live status of an agency — combines systemd is-active state with " +
			"agent_registry.last_seen_at and status. Read-only operation.",
		inputSchema: {
			type: "object",
			properties: {
				identity: {
					type: "string",
					description: "Agency identity (agent_identity in agent_registry)",
				},
			},
			required: ["identity"],
		},
		handler: async (args: Record<string, unknown>) =>
			agencyOps.agencyStatus({ identity: String(args.identity) })
				.then((r) => ({ content: [{ type: "text", text: JSON.stringify(r, null, 2) }] })),
	});

	// Start background maintenance tasks
	const MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
	setInterval(async () => {
		try {
			await server.checkLeaseHealth({ autoCommit: true });
		} catch (_err) {
			// Silently ignore background maintenance errors
		}
	}, MAINTENANCE_INTERVAL_MS);

	if (options.debug) {
		console.error("MCP server initialised (stdio transport only).");
	}

	return server;
}
