import { execSync } from "node:child_process";
import { appendFileSync, createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { join } from "node:path";
import type { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { type WebSocket, WebSocketServer } from "ws";
import { initializeProject } from "../../core/infrastructure/init.ts";
import type { SearchService } from "../../core/infrastructure/search-service.ts";
import { getProposalStatistics } from "../../core/infrastructure/statistics.ts";
import { RelayService } from "../../core/messaging/relay.ts";
import { Core } from "../../core/roadmap.ts";
import type { ContentStore } from "../../core/storage/content-store.ts";
import { createMcpServer, type McpServer } from "../../mcp/server.ts";
import { handleDirectMcpRequest } from "../mcp-server/http-compat.ts";
import type {
	Proposal,
	ProposalUpdateInput,
	SearchPriorityFilter,
	SearchResultType,
} from "../../types/index.ts";
import { watchConfig } from "../../utils/config-watcher.ts";
import { formatVersionLabel, getVersionInfo } from "../../utils/version.ts";
import { query } from "../../infra/postgres/pool.ts";

// Regex pattern to match any prefix (letters followed by dash)
const PREFIX_PATTERN = /^[a-zA-Z]+-/i;
const DEFAULT_PREFIX = "proposal-";

/**
 * Strip any prefix from an ID (e.g., "proposal-123" -> "123", "JIRA-456" -> "456")
 */
function stripPrefix(id: string): string {
	return id.replace(PREFIX_PATTERN, "");
}

/**
 * Ensure an ID has a prefix. If it already has one, return as-is.
 * Otherwise, add the default "proposal-" prefix.
 */
function ensurePrefix(id: string): string {
	if (PREFIX_PATTERN.test(id)) {
		return id;
	}
	return `${DEFAULT_PREFIX}${id}`;
}

function parseProposalIdSegments(value: string): number[] | null {
	const withoutPrefix = stripPrefix(value);
	if (!/^[0-9]+(?:\.[0-9]+)*$/.test(withoutPrefix)) {
		return null;
	}
	return withoutPrefix
		.split(".")
		.map((segment) => Number.parseInt(segment, 10));
}

function findProposalByLooseId(
	proposals: Proposal[],
	inputId: string,
): Proposal | undefined {
	// First try exact match (case-insensitive)
	const lowerInputId = inputId.toLowerCase();
	const exact = proposals.find(
		(proposal) => proposal.id.toLowerCase() === lowerInputId,
	);
	if (exact) {
		return exact;
	}

	// Try matching by numeric segments only
	const inputSegments = parseProposalIdSegments(inputId);
	if (!inputSegments) {
		return undefined;
	}

	return proposals.find((proposal) => {
		const candidateSegments = parseProposalIdSegments(proposal.id);
		if (
			!candidateSegments ||
			candidateSegments.length !== inputSegments.length
		) {
			return false;
		}
		for (let index = 0; index < candidateSegments.length; index += 1) {
			if (candidateSegments[index] !== inputSegments[index]) {
				return false;
			}
		}
		return true;
	});
}

// Asset paths (will be read from disk)
const faviconPath = join(import.meta.dirname, "../web/favicon.png");
// Resolve index.html relative to project root, not module location
// Works both when bundled (scripts/cli.cjs.js) and when running via jiti
const indexHtmlPath = (() => {
	// If running from scripts/, ../web/ works
	const fromScripts = join(import.meta.dirname, "../web/index.html");
	if (existsSync(fromScripts)) return fromScripts;
	// If running from src/apps/server/, ../../../web/ works
	const fromSource = join(import.meta.dirname, "../../../web/index.html");
	if (existsSync(fromSource)) return fromSource;
	// Fallback to CWD
	return join(process.cwd(), "web/index.html");
})();
// Resolve web directory relative to project root
const webDir = (() => {
	const fromScripts = join(import.meta.dirname, "../web");
	if (existsSync(fromScripts)) return fromScripts;
	const fromSource = join(import.meta.dirname, "../../../web");
	if (existsSync(fromSource)) return fromSource;
	return join(process.cwd(), "web");
})();
let indexHtml = "";
try {
	indexHtml = readFileSync(indexHtmlPath, "utf-8");
} catch (e) {
	console.error("Failed to read index.html:", e);
}

export class RoadmapServer {
	private core: Core;
	private server: ReturnType<typeof createServer> | null = null;
	private wss: WebSocketServer | null = null;
	private projectName = "Untitled Project";
	private sockets = new Set<WebSocket>();
	private channelSubscriptions = new Map<WebSocket, Map<string, () => void>>();
	// Table subscriptions for frontend protocol: { ws -> Set<table> }
	private tableSubscriptions = new Map<WebSocket, Set<string>>();
	private contentStore: ContentStore | null = null;
	private searchService: SearchService | null = null;
	private unsubscribeContentStore?: () => void;
	private storeReadyBroadcasted = false;
	private configWatcher: { stop: () => void } | null = null;
	private mcpServer: McpServer | null = null;
	private sseTransports = new Map<string, SSEServerTransport>();
	private relayService: RelayService | null = null;

	constructor(projectPath: string) {
		this.core = new Core(projectPath, { enableWatchers: true });
	}

	private async resolveDirectiveInput(directive: string): Promise<string> {
		const normalized = directive.trim();
		if (!normalized) {
			return normalized;
		}

		const key = normalized.toLowerCase();
		const aliasKeys = new Set<string>([key]);
		const looksLikeDirectiveId =
			/^\d+$/.test(normalized) || /^d-\d+$/i.test(normalized);
		const canonicalInputId =
			/^\d+$/.test(normalized) || /^d-\d+$/i.test(normalized)
				? `d-${String(Number.parseInt(normalized.replace(/^d-/i, ""), 10))}`
				: null;
		if (/^\d+$/.test(normalized)) {
			const numeric = String(Number.parseInt(normalized, 10));
			aliasKeys.add(numeric);
			aliasKeys.add(`d-${numeric}`);
		} else {
			const match = normalized.match(/^d-(\d+)$/i);
			if (match?.[1]) {
				const numeric = String(Number.parseInt(match[1], 10));
				aliasKeys.add(numeric);
				aliasKeys.add(`d-${numeric}`);
			}
		}
		const [activeDirectives, archivedDirectives] = await Promise.all([
			this.core.filesystem.listDirectives(),
			this.core.filesystem.listArchivedDirectives(),
		]);
		const idMatchesAlias = (directiveId: string): boolean => {
			const idKey = directiveId.trim().toLowerCase();
			if (aliasKeys.has(idKey)) {
				return true;
			}
			if (/^\d+$/.test(directiveId.trim())) {
				const numeric = String(Number.parseInt(directiveId.trim(), 10));
				return aliasKeys.has(numeric) || aliasKeys.has(`d-${numeric}`);
			}
			const idMatch = directiveId.trim().match(/^d-(\d+)$/i);
			if (!idMatch?.[1]) {
				return false;
			}
			const numeric = String(Number.parseInt(idMatch[1], 10));
			return aliasKeys.has(numeric) || aliasKeys.has(`d-${numeric}`);
		};
		const findIdMatch = (
			directives: Array<{ id: string; title: string }>,
		): { id: string; title: string } | undefined => {
			const rawExactMatch = directives.find(
				(item) => item.id.trim().toLowerCase() === key,
			);
			if (rawExactMatch) {
				return rawExactMatch;
			}
			if (canonicalInputId) {
				const canonicalRawMatch = directives.find(
					(item) => item.id.trim().toLowerCase() === canonicalInputId,
				);
				if (canonicalRawMatch) {
					return canonicalRawMatch;
				}
			}
			return directives.find((item) => idMatchesAlias(item.id));
		};
		const findUniqueTitleMatch = (
			directives: Array<{ id: string; title: string }>,
		): { id: string; title: string } | null => {
			const titleMatches = directives.filter(
				(item) => item.title.trim().toLowerCase() === key,
			);
			if (titleMatches.length === 1) {
				return titleMatches[0] ?? null;
			}
			return null;
		};

		const matchByAlias = (
			directives: Array<{ id: string; title: string }>,
		): string | null => {
			const idMatch = findIdMatch(directives);
			const titleMatch = findUniqueTitleMatch(directives);
			if (looksLikeDirectiveId) {
				return idMatch?.id ?? null;
			}
			if (titleMatch) {
				return titleMatch.id;
			}
			if (idMatch) {
				return idMatch.id;
			}
			return null;
		};

		const activeTitleMatches = activeDirectives.filter(
			(item) => item.title.trim().toLowerCase() === key,
		);
		const hasAmbiguousActiveTitle = activeTitleMatches.length > 1;
		if (looksLikeDirectiveId) {
			const activeIdMatch = findIdMatch(activeDirectives);
			if (activeIdMatch) {
				return activeIdMatch.id;
			}
			const archivedIdMatch = findIdMatch(archivedDirectives);
			if (archivedIdMatch) {
				return archivedIdMatch.id;
			}
			if (activeTitleMatches.length === 1) {
				return activeTitleMatches[0]?.id ?? normalized;
			}
			if (hasAmbiguousActiveTitle) {
				return normalized;
			}
			const archivedTitleMatch = findUniqueTitleMatch(archivedDirectives);
			return archivedTitleMatch?.id ?? normalized;
		}

		const activeMatch = matchByAlias(activeDirectives);
		if (activeMatch) {
			return activeMatch;
		}
		if (hasAmbiguousActiveTitle) {
			return normalized;
		}

		const archivedMatch = matchByAlias(archivedDirectives);
		if (archivedMatch) {
			return archivedMatch;
		}

		return normalized;
	}

	private async ensureServicesReady(): Promise<void> {
		const store = await this.core.getContentStore();
		this.contentStore = store;

		if (!this.unsubscribeContentStore) {
			this.unsubscribeContentStore = store.subscribe((event) => {
				if (event.type === "ready") {
					if (!this.storeReadyBroadcasted) {
						this.storeReadyBroadcasted = true;
						return;
					}
					this.broadcastProposalsUpdated();
					return;
				}

				// Broadcast for proposals/documents/decisions so clients refresh caches/search
				this.storeReadyBroadcasted = true;
				this.broadcastProposalsUpdated();
			});
		}

		const search = await this.core.getSearchService();
		this.searchService = search;

		if (!this.mcpServer) {
			this.mcpServer = await createMcpServer(this.core.filesystem.rootDir);
			// The mcpServer factory already starts its own background maintenance
		}

		const config = await this.core.filesystem.loadConfig();
		if (config?.relay?.enabled && !this.relayService) {
			this.relayService = new RelayService(this.core, config.relay);
			void this.relayService.start();
		}
	}

	private async getContentStoreInstance(): Promise<ContentStore> {
		await this.ensureServicesReady();
		if (!this.contentStore) {
			throw new Error("Content store not initialized");
		}
		return this.contentStore;
	}

	private async getSearchServiceInstance(): Promise<SearchService> {
		await this.ensureServicesReady();
		if (!this.searchService) {
			throw new Error("Search service not initialized");
		}
		return this.searchService;
	}

	getPort(): number | null {
		const addr = this.server?.address();
		return typeof addr === "object" ? (addr?.port ?? null) : null;
	}

	private broadcastProposalsUpdated() {
		// Send proper protocol messages to table-subscribed clients
		// Also keep backward compat for simple string subscribers
		for (const ws of this.sockets) {
			try {
				const tables = this.tableSubscriptions.get(ws);
				if (tables?.has("proposal")) {
					// Frontend protocol: send snapshot for full refresh
					void this.sendProposalSnapshot(ws);
				} else {
					// Legacy: simple notification string
					ws.send("proposals-updated");
				}
			} catch {}
		}
	}

	private broadcastConfigUpdated() {
		for (const ws of this.sockets) {
			try {
				ws.send("config-updated");
			} catch {}
		}
	}

	// Poll for external DB changes (cron, MCP, direct SQL)
	private lastProposalCheck = new Date(0);
	private startChangePolling() {
		const POLL_INTERVAL = 30000; // 30 seconds
		setInterval(async () => {
			try {
				const result = await query(
					`SELECT MAX(updated_at) as latest FROM roadmap_proposal.proposal`
				);
				const latest = result.rows[0]?.latest;
				if (latest && new Date(latest) > this.lastProposalCheck) {
					this.lastProposalCheck = new Date(latest);
					this.broadcastProposalsUpdated();
				}
			} catch (err) {
				// Silently continue on polling errors
			}
		}, POLL_INTERVAL);
		console.log(`📊 Change polling started (every ${POLL_INTERVAL/1000}s)`);
	}

	private async handleSubscribe(ws: WebSocket, channel: string) {
		const subs = this.channelSubscriptions.get(ws);
		if (!subs || subs.has(channel)) return;
		const unsubscribe = await this.core.watchMessages({
			channel,
			onMessage: (msg) => {
				try {
					ws.send(
						JSON.stringify({ type: "channel-message", channel, message: msg }),
					);
				} catch {}
			},
		});
		subs.set(channel, unsubscribe);
	}

	private handleUnsubscribe(ws: WebSocket, channel: string) {
		const subs = this.channelSubscriptions.get(ws);
		const unsub = subs?.get(channel);
		if (unsub) {
			unsub();
			subs?.delete(channel);
		}
	}

	private cleanupSubscriptions(ws: WebSocket) {
		const subs = this.channelSubscriptions.get(ws);
		if (!subs) return;
		for (const unsub of subs.values()) {
			unsub();
		}
		subs.clear();
	}

	// Frontend table subscription protocol
	private async handleTableSubscribe(ws: WebSocket, tables: string[]) {
		const subscribedTables = this.tableSubscriptions.get(ws);
		if (!subscribedTables) return;

		for (const table of tables) {
			if (subscribedTables.has(table)) {
				continue;
			}
			subscribedTables.add(table);
			console.log(`[WS] Client subscribed to table: ${table}`);

			// Send initial snapshot for each subscribed table
			if (table === "proposal") {
				await this.sendProposalSnapshot(ws);
			}
			// Other tables (workforce_registry, etc.) can be added here
		}
	}

	// Transform API proposal to frontend WebSocketProposal format
	private proposalToWsFormat(p: any): any {
		const canonicalDisplayId = p.displayId || p.display_id || p.id || "";
		const websocketId = p.id || p.display_id || "";
		return {
			id: canonicalDisplayId || `#${websocketId}`,
			displayId: canonicalDisplayId,
			websocketId,
			parentId: p.parentProposalId || null,
			proposalType: p.proposalType || p.type || "feature",
			category: p.category || "",
			domainId: p.domainId || "",
			title: p.title || "(no title)",
			status: p.status || "DRAFT",
			priority: p.priority || "",
			bodyMarkdown: p.summary || p.description || p.rawContent || null,
			summary: p.summary || p.description || null,
			motivation: p.motivation || null,
			design: p.design || p.implementationPlan || null,
			drawbacks: p.drawbacks || null,
			alternatives: p.alternatives || null,
			dependencyNote: p.dependency_note || null,
			processLogic: p.design || p.implementationPlan || null,
			implementationPlan: p.implementationPlan || p.design || null,
			implementationNotes: p.implementationNotes || null,
			finalSummary: p.finalSummary || null,
			acceptanceCriteriaItems: p.acceptanceCriteriaItems || [],
			requiredCapabilities: p.required_capabilities || [],
			needsCapabilities: p.needs_capabilities || [],
			liveActivity: p.liveActivity || null,
			maturityLevel: p.maturity === "new" ? 0 : p.maturity === "mature" ? 5 : p.maturity === "obsolete" ? 10 : null,
			repositoryPath: p.filePath || null,
			budgetLimitUsd: p.budgetLimitUsd || 0,
			tags:
				Array.isArray(p.labels) && p.labels.length > 0
					? p.labels.join(",")
					: null,
			createdAt: p.createdDate || p.createdAt || "",
			updatedAt: p.updatedDate || p.updatedAt || "",
		};
	}

	// Send proposal snapshot to a WebSocket client
	private async sendProposalSnapshot(ws: WebSocket) {
		try {
			console.log("[WS] Sending proposal snapshot...");
			const store = await this.getContentStoreInstance();
			const proposals = await this.core.queryProposals({ includeCrossBranch: true });
			console.log(`[WS] Got ${proposals.length} proposals from query`);
			const wsProposals = proposals.map((p) => this.proposalToWsFormat(p));
			console.log(`[WS] Transformed to ${wsProposals.length} WS proposals`);

			const msg = JSON.stringify({
				type: "proposal_snapshot",
				data: wsProposals,
			});
			console.log(`[WS] Sending message (${msg.length} bytes)`);
			ws.send(msg);
			console.log("[WS] Snapshot sent successfully");
		} catch (err) {
			console.error("[WS] Failed to send proposal snapshot:", err);
			// Send empty snapshot on error so frontend doesn't hang
			ws.send(JSON.stringify({
				type: "proposal_snapshot",
				data: [],
			}));
		}
	}

	// Broadcast proposal update to all subscribed clients
	private broadcastProposalUpdate(type: "proposal_update" | "proposal_insert" | "proposal_delete", data: any) {
		const wsData = type === "proposal_delete" ? data : this.proposalToWsFormat(data);
		const msg = JSON.stringify({ type, data: wsData });

		for (const ws of this.sockets) {
			const tables = this.tableSubscriptions.get(ws);
			if (tables?.has("proposal")) {
				try { ws.send(msg); } catch {}
			}
		}
	}

	async start(port?: number, openBrowser = true): Promise<void> {
		// Prevent duplicate starts (e.g., accidental re-entry)
		if (this.server) {
			console.log("Server already running");
			return;
		}
		// Load config (migration is handled globally by CLI)
		const config = await this.core.filesystem.loadConfig();

		// Use config default port if no port specified
		const finalPort = port ?? config?.defaultPort ?? 6420;
		this.projectName = config?.projectName || "Untitled Project";

		// Check if browser should open (config setting or CLI override)
		// Default to true if autoOpenBrowser is not explicitly set to false
		const shouldOpenBrowser = openBrowser && (config?.autoOpenBrowser ?? true);

		// Set up config watcher to broadcast changes
		this.configWatcher = watchConfig(this.core, {
			onConfigChanged: () => {
				this.broadcastConfigUpdated();
			},
		});

		try {
			await this.ensureServicesReady();

			this.server = createServer(async (req, res) => {
				// Handle SSE directly with raw ServerResponse
				const url = new URL(req.url || "/", `http://${req.headers.host}`);
				if (url.pathname === "/api/mcp/sse" && req.method === "GET") {
					await this.handleMcpSseRaw(req, res);
					return;
				}
				await this.handleHttpRequest(req, res);
			});

			this.wss = new WebSocketServer({ server: this.server });
			this.wss.on("connection", (ws) => {
				this.sockets.add(ws);
				this.channelSubscriptions.set(ws, new Map());
				this.tableSubscriptions.set(ws, new Set());
				ws.on("message", (msg) => {
					const text = msg.toString();
					if (text === "ping") {
						ws.send("pong");
						return;
					}
					// Try JSON protocol for table/channel subscribe
					try {
						const data = JSON.parse(text);
						// Frontend table subscription: { type: "subscribe", tables: ["proposal", ...] }
						if (data.type === "subscribe" && Array.isArray(data.tables)) {
							this.handleTableSubscribe(ws, data.tables);
							return;
						}
						if (data.type === "subscribe" && data.channel) {
							this.handleSubscribe(ws, data.channel);
							return;
						}
						if (data.type === "unsubscribe" && data.channel) {
							this.handleUnsubscribe(ws, data.channel);
							return;
						}
					} catch {
						// Not JSON, ignore unknown messages
					}
				});
				ws.on("close", () => {
					this.cleanupSubscriptions(ws);
					this.channelSubscriptions.delete(ws);
					this.tableSubscriptions.delete(ws);
					this.sockets.delete(ws);
				});
			});

			await new Promise<void>((resolve, reject) => {
				const httpServer = this.server;
				if (httpServer) {
					(httpServer as any).once("listening", () => resolve());
					(httpServer as any).once("error", (err: any) => reject(err));
					httpServer.listen({ port: finalPort, reusePort: true });
				}
			});

			const url = `http://localhost:${finalPort}`;
			const versionInfo = await getVersionInfo();
			const versionLabel = formatVersionLabel(versionInfo);
			console.log(
				`🚀 Roadmap.md browser interface ${versionLabel} running at ${url}`,
			);
			console.log(`📊 Project: ${this.projectName}`);
			const stopKey = process.platform === "darwin" ? "Cmd+C" : "Ctrl+C";
			console.log(`⏹️  Press ${stopKey} to stop the server`);

			if (shouldOpenBrowser) {
				console.log("🌐 Opening browser...");
				await this.openBrowser(url);
			} else {
				console.log("💡 Open your browser and navigate to the URL above");
			}

			// Start polling for external DB changes (cron, MCP, direct SQL)
			this.startChangePolling();
		} catch (error) {
			// Handle port already in use error
			const errorCode = (error as { code?: string })?.code;
			const errorMessage = (error as Error)?.message;
			if (
				errorCode === "EADDRINUSE" ||
				errorMessage?.includes("address already in use")
			) {
				console.error(`\n❌ Error: Port ${finalPort} is already in use.\n`);
				console.log("💡 Suggestions:");
				console.log(
					`   1. Try a different port: roadmap browser --port ${finalPort + 1}`,
				);
				console.log(`   2. Find what's using port ${finalPort}:`);
				if (process.platform === "darwin" || process.platform === "linux") {
					console.log(`      Run: lsof -i :${finalPort}`);
				} else if (process.platform === "win32") {
					console.log(`      Run: netstat -ano | findstr :${finalPort}`);
				}
				console.log("   3. Or kill the process using the port and try again\n");
				process.exit(1);
			}

			// Handle other errors
			console.error("❌ Failed to start server:", errorMessage || error);
			process.exit(1);
		}
	}

	private _stopping = false;

	async stop(): Promise<void> {
		if (this._stopping) return;
		this._stopping = true;

		// Stop filesystem watcher first to reduce churn
		try {
			this.unsubscribeContentStore?.();
			this.unsubscribeContentStore = undefined;
		} catch {}

		// Stop config watcher
		try {
			this.configWatcher?.stop();
			this.configWatcher = null;
		} catch {}

		this.core.disposeSearchService();
		this.core.disposeContentStore();
		this.searchService = null;
		this.contentStore = null;
		this.storeReadyBroadcasted = false;

		// Proactively close WebSocket connections
		for (const ws of this.sockets) {
			try {
				ws.close();
			} catch {}
		}
		this.sockets.clear();
		this.wss?.close();

		// Attempt to stop the server but don't hang forever
		if (this.server) {
			const serverRef = this.server;
			const stopPromise = new Promise<void>((resolve) => {
				serverRef.close(() => resolve());
			});
			const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1500));
			await Promise.race([stopPromise, timeout]);
			this.server = null;
			console.log("Server stopped");
		}

		this._stopping = false;
	}

	private async openBrowser(url: string): Promise<void> {
		try {
			const platform = process.platform;
			let cmd: string;

			switch (platform) {
				case "darwin": // macOS
					cmd = `open "${url}"`;
					break;
				case "win32": // Windows
					cmd = `start "" "${url}"`;
					break;
				default: // Linux and others
					cmd = `xdg-open "${url}"`;
					break;
			}

			execSync(cmd, { stdio: "ignore" });
		} catch (error) {
			console.warn("⚠️  Failed to open browser automatically:", error);
			console.log(
				"💡 Please open your browser manually and navigate to the URL above",
			);
		}
	}

	private async handleHttpRequest(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		const url = new URL(
			req.url || "/",
			`http://${req.headers.host || "localhost"}`,
		);
		try { appendFileSync("/tmp/mcp-debug.log", `[HTTP] ${req.method} ${req.url}\n`); } catch {}
		const _pathname = url.pathname;
		const method = req.method || "GET";

		try {
			// Convert Node IncomingMessage to WHATWG Request
			const request = new Request(url.toString(), {
				method,
				headers: req.headers as Record<string, string>,
				body: method !== "GET" && method !== "HEAD" ? (req as any) : null,
				// @ts-expect-error
				duplex: "half",
			});

			const response = await this.dispatchRequest(request);

			// Disable caching for GET/HEAD so browser always fetches latest content
			if (method === "GET" || method === "HEAD") {
				response.headers.set(
					"Cache-Control",
					"no-store, max-age=0, must-revalidate",
				);
				response.headers.set("Pragma", "no-cache");
				response.headers.set("Expires", "0");
			}

			res.writeHead(
				response.status,
				Object.fromEntries(response.headers.entries()),
			);
			if (response.body) {
				const reader = response.body.getReader();
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					res.write(value);
				}
			}
			res.end();
		} catch (error) {
			const errorRes = this.handleError(error as Error);
			res.writeHead(errorRes.status);
			res.end(await errorRes.text());
		}
	}

	private async dispatchRequest(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const pathname = url.pathname;
		const method = req.method;

	// Static file serving from webDir
	const staticExtensions = [".js", ".mjs", ".css", ".png", ".jpg", ".jpeg", ".svg", ".ico", ".woff", ".woff2", ".json"];
	if (method === "GET" && staticExtensions.some(ext => pathname.endsWith(ext))) {
		const staticPath = join(webDir, pathname);
		console.log(`[Static] Looking for: ${staticPath}, exists: ${existsSync(staticPath)}`);
		if (existsSync(staticPath) && statSync(staticPath).isFile()) {
			const ext = staticPath.split(".").pop() || "";
			const mimeTypes: Record<string, string> = {
				js: "application/javascript",
				mjs: "application/javascript",
				css: "text/css",
				html: "text/html",
				json: "application/json",
				png: "image/png",
				jpg: "image/jpeg",
				jpeg: "image/jpeg",
				svg: "image/svg+xml",
				ico: "image/x-icon",
				woff: "font/woff",
				woff2: "font/woff2",
			};
			const content = readFileSync(staticPath);
			return new Response(content, {
				headers: { "Content-Type": mimeTypes[ext] || "application/octet-stream" },
			});
		}
	}

	// Static routes returning indexHtml
	if (
		method === "GET" &&
		(pathname === "/" ||
			[
				"/board",
				"/proposals",
				"/directives",
				"/drafts",
				"/documentation",
				"/decisions",
				"/statistics",
				"/settings",
				"/dashboard",
				"/agents",
				"/teams",
				"/channels",
				"/agent-dashboard",
				"/knowledge",
				"/documents",
				"/map",
				"/routes",
				"/achievements",
			].some((p) => pathname === p || pathname.startsWith(`${p}/`)))
	) {
		return new Response(indexHtml, {
			headers: { "Content-Type": "text/html" },
		});
	}

		if (
			method === "POST" &&
			(pathname === "/mcp" || pathname === "/api/mcp")
		) {
			return await this.handleDirectMcp(req);
		}

		// API Routes
		if (pathname.startsWith("/api/")) {
			if (pathname === "/api/proposals") {
				if (method === "GET") return await this.handleListProposals(req);
				if (method === "POST") return await this.handleCreateProposal(req);
			}

			if (pathname === "/api/agents" && method === "GET")
				return await this.handleListAgents();
			if (pathname === "/api/pulse" && method === "GET")
				return await this.handleListPulse(req);
			if (pathname === "/api/channels" && method === "GET")
				return await this.handleListChannels();
			if (pathname === "/api/messages" && method === "GET")
				return await this.handleListMessages(req);
			if (pathname === "/api/messages" && method === "POST")
				return await this.handleSendMessage(req);
			if (pathname === "/api/routes" && method === "GET")
				return await this.handleListRoutes();
			if (pathname === "/api/dispatches" && method === "GET")
				return await this.handleListDispatches();

			if (pathname === "/api/mcp/sse" && method === "GET") {
				try { appendFileSync("/tmp/mcp-debug.log", "[Server] MCP SSE request\n"); } catch {}
				return await this.handleMcpSse(req);
			}
			if (pathname === "/api/mcp/message" && method === "POST") {
				try { appendFileSync("/tmp/mcp-debug.log", "[Server] MCP POST request\n"); } catch {}
				return await this.handleMcpMessage(req);
			}

			if (pathname.startsWith("/api/proposal/")) {
				const id = pathname.slice("/api/proposal/".length);
				if (method === "GET") return await this.handleGetProposal(id);
			}

			if (pathname.startsWith("/api/proposals/")) {
				const parts = pathname.split("/");
				const id = parts[3]!;
				if (parts.length === 4) {
					if (method === "GET") return await this.handleGetProposal(id);
					if (method === "PUT") return await this.handleUpdateProposal(req, id);
					if (method === "DELETE") return await this.handleDeleteProposal(id);
				}
				if (parts.length === 5 && parts[4] === "complete") {
					if (method === "POST") return await this.handleCompleteProposal(id);
				}
				if (parts.length === 5 && parts[4] === "release") {
					if (method === "POST") return await this.handleReleaseProposal(id);
				}
				if (parts.length === 5 && parts[4] === "demote") {
					if (method === "POST") return await this.handleDemoteProposal(id);
				}
			}

			// GET /api/proposals/:id/notes - Discussion notes for a proposal
			if (
				pathname.startsWith("/api/proposals/") &&
				pathname.endsWith("/notes")
			) {
				const parts = pathname.split("/");
				const id = parts[3]!; // /api/proposals/{id}/notes
				if (method === "GET") return await this.handleGetProposalNotes(id, req);
			}

			// GET /api/proposals/:id/decisions
			if (
				pathname.startsWith("/api/proposals/") &&
				pathname.endsWith("/decisions")
			) {
				const parts = pathname.split("/");
				const id = parts[3]!;
				if (method === "GET") return await this.handleGetProposalDecisions(id);
			}

			// GET /api/proposals/:id/reviews
			if (
				pathname.startsWith("/api/proposals/") &&
				pathname.endsWith("/reviews")
			) {
				const parts = pathname.split("/");
				const id = parts[3]!;
				if (method === "GET") return await this.handleGetProposalReviews(id);
			}

			if (pathname === "/api/statuses" && method === "GET")
				return await this.handleGetStatuses();

			if (pathname === "/api/config") {
				if (method === "GET") return await this.handleGetConfig();
				if (method === "PUT") return await this.handleUpdateConfig(req);
			}

			if (pathname === "/api/docs") {
				if (method === "GET") return await this.handleListDocs();
				if (method === "POST") return await this.handleCreateDoc(req);
			}

			if (pathname.startsWith("/api/doc/")) {
				const id = pathname.slice("/api/doc/".length);
				if (method === "GET") return await this.handleGetDoc(id);
			}

			if (pathname.startsWith("/api/docs/")) {
				const id = pathname.split("/")[3]!;
				if (method === "GET") return await this.handleGetDoc(id);
				if (method === "PUT") return await this.handleUpdateDoc(req, id);
			}

			if (pathname === "/api/decisions") {
				if (method === "GET") return await this.handleListDecisions();
				if (method === "POST") return await this.handleCreateDecision(req);
			}

			if (pathname.startsWith("/api/decision/")) {
				const id = pathname.slice("/api/decision/".length);
				if (method === "GET") return await this.handleGetDecision(id);
			}

			if (pathname.startsWith("/api/decisions/")) {
				const id = pathname.split("/")[3]!;
				if (method === "GET") return await this.handleGetDecision(id);
				if (method === "PUT") return await this.handleUpdateDecision(req, id);
			}

			if (pathname === "/api/drafts" && method === "GET")
				return await this.handleListDrafts();
			if (
				pathname.startsWith("/api/drafts/") &&
				pathname.endsWith("/promote") &&
				method === "POST"
			) {
				const id = pathname.split("/")[3]!;
				return await this.handlePromoteDraft(id);
			}

			if (pathname === "/api/directives") {
				if (method === "GET") return await this.handleListDirectives();
				if (method === "POST") return await this.handleCreateDirective(req);
			}

			if (pathname === "/api/directives/archived" && method === "GET")
				return await this.handleListArchivedDirectives();

			if (pathname.startsWith("/api/directives/")) {
				const parts = pathname.split("/");
				const id = parts[3]!;
				if (parts.length === 4) {
					if (method === "GET") return await this.handleGetDirective(id);
				}
				if (parts.length === 5 && parts[4] === "archive") {
					if (method === "POST") return await this.handleArchiveDirective(id);
				}
			}

			if (pathname === "/api/proposals/reorder" && method === "POST")
				return await this.handleReorderProposal(req);
			if (pathname === "/api/proposals/cleanup" && method === "GET")
				return await this.handleCleanupPreview(req);
			if (pathname === "/api/proposals/cleanup/execute" && method === "POST")
				return await this.handleCleanupExecute(req);

			if (pathname === "/api/version" && method === "GET")
				return await this.handleGetVersion();
			if (pathname === "/api/statistics" && method === "GET")
				return await this.handleGetStatistics();
			if (pathname === "/api/status" && method === "GET")
				return await this.handleGetStatus();
			if (pathname === "/api/init" && method === "POST")
				return await this.handleInit(req);
			if (pathname === "/api/search" && method === "GET")
				return await this.handleSearch(req);

			if (pathname === "/api/sequences" && method === "GET")
				return await this.handleGetSequences();
			if (pathname === "/api/sequences/move" && method === "POST")
				return await this.handleMoveSequence(req);
		}

		// Legacy/Duplicate routes
		if (pathname === "/sequences" && method === "GET")
			return await this.handleGetSequences();
		if (pathname === "/sequences/move" && method === "POST")
			return await this.handleMoveSequence(req);

		// Assets (not implemented - return 404)
		if (pathname.startsWith("/assets/")) {
			return new Response("Asset not found", { status: 404 });
		}

		return await this.handleRequest(req);
	}

	private async handleDirectMcp(req: Request): Promise<Response> {
		await this.ensureServicesReady();
		if (!this.mcpServer) {
			return Response.json(
				{
					jsonrpc: "2.0",
					id: null,
					error: { code: -32000, message: "MCP server not available" },
				},
				{ status: 500 },
			);
		}

		try {
			const payload = await req.json();
			const response = await handleDirectMcpRequest(this.mcpServer, payload);
			return Response.json(response.body, { status: response.status });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return Response.json(
				{
					jsonrpc: "2.0",
					id: null,
					error: { code: -32700, message },
				},
				{ status: 400 },
			);
		}
	}

	private async handleRequest(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const pathname = url.pathname;

		// Workaround for favicon
		if (pathname.startsWith("/favicon")) {
			const stream = createReadStream(faviconPath);
			return new Response(stream as any, {
				headers: { "Content-Type": "image/png" },
			});
		}

		// For all other routes, return 404
		return new Response("Not Found", { status: 404 });
	}

	// Proposal handlers
	private async handleListProposals(req: Request): Promise<Response> {
		const url = new URL(req.url);
		const status = url.searchParams.get("status") || undefined;
		const assignee = url.searchParams.get("assignee") || undefined;
		const parent = url.searchParams.get("parent") || undefined;
		const priorityParam = url.searchParams.get("priority") || undefined;
		const crossBranch = url.searchParams.get("crossBranch") === "true";
		const labelParams = [
			...url.searchParams.getAll("label"),
			...url.searchParams.getAll("labels"),
		];
		const labelsCsv = url.searchParams.get("labels");
		if (labelsCsv) {
			labelParams.push(...labelsCsv.split(","));
		}
		const labels = labelParams
			.map((label) => label.trim())
			.filter((label) => label.length > 0);

		let priority: "high" | "medium" | "low" | undefined;
		if (priorityParam) {
			const normalizedPriority = priorityParam.toLowerCase();
			const allowed = ["high", "medium", "low"];
			if (!allowed.includes(normalizedPriority)) {
				return Response.json(
					{ error: "Invalid priority filter" },
					{ status: 400 },
				);
			}
			priority = normalizedPriority as "high" | "medium" | "low";
		}

		// Resolve parent proposal ID if provided
		let parentProposalId: string | undefined;
		if (parent) {
			const store = await this.getContentStoreInstance();
			const allProposals = store.getProposals();
			let parentProposal = findProposalByLooseId(allProposals, parent);
			if (!parentProposal) {
				const fallbackId = ensurePrefix(parent);
				const fallback = await this.core.filesystem.loadProposal(fallbackId);
				if (fallback) {
					store.upsertProposal(fallback);
					parentProposal = fallback;
				}
			}
			if (!parentProposal) {
				const normalizedParent = ensurePrefix(parent);
				return Response.json(
					{ error: `Parent proposal ${normalizedParent} not found` },
					{ status: 404 },
				);
			}
			parentProposalId = parentProposal.id;
		}

		// Use Core.queryProposals which handles all filtering and cross-branch logic
		const proposals = await this.core.queryProposals({
			filters: {
				status,
				assignee,
				priority,
				parentProposalId,
				labels: labels.length > 0 ? labels : undefined,
			},
			includeCrossBranch: crossBranch,
		});

		return Response.json(proposals);
	}

	private async handleSearch(req: Request): Promise<Response> {
		try {
			const searchService = await this.getSearchServiceInstance();
			const url = new URL(req.url);
			const query = url.searchParams.get("query") ?? undefined;
			const limitParam = url.searchParams.get("limit");
			const typeParams = [
				...url.searchParams.getAll("type"),
				...url.searchParams.getAll("types"),
			];
			const statusParams = url.searchParams.getAll("status");
			const priorityParamsRaw = url.searchParams.getAll("priority");
			const labelParamsRaw = [
				...url.searchParams.getAll("label"),
				...url.searchParams.getAll("labels"),
			];
			const labelsCsv = url.searchParams.get("labels");
			if (labelsCsv) {
				labelParamsRaw.push(...labelsCsv.split(","));
			}

			let limit: number | undefined;
			if (limitParam) {
				const parsed = Number.parseInt(limitParam, 10);
				if (Number.isNaN(parsed) || parsed <= 0) {
					return Response.json(
						{ error: "limit must be a positive integer" },
						{ status: 400 },
					);
				}
				limit = parsed;
			}

			let types: SearchResultType[] | undefined;
			if (typeParams.length > 0) {
				const allowed: SearchResultType[] = [
					"proposal",
					"document",
					"decision",
				];
				const normalizedTypes = typeParams
					.map((value) => value.toLowerCase())
					.filter((value): value is SearchResultType => {
						return allowed.includes(value as SearchResultType);
					});
				if (normalizedTypes.length === 0) {
					return Response.json(
						{ error: "type must be proposal, document, or decision" },
						{ status: 400 },
					);
				}
				types = normalizedTypes;
			}

			const filters: {
				status?: string | string[];
				priority?: SearchPriorityFilter | SearchPriorityFilter[];
				labels?: string | string[];
			} = {};

			if (statusParams.length === 1) {
				filters.status = statusParams[0];
			} else if (statusParams.length > 1) {
				filters.status = statusParams;
			}

			if (priorityParamsRaw.length > 0) {
				const allowedPriorities: SearchPriorityFilter[] = [
					"high",
					"medium",
					"low",
				];
				const normalizedPriorities = priorityParamsRaw.map((value) =>
					value.toLowerCase(),
				);
				const invalidPriority = normalizedPriorities.find(
					(value) => !allowedPriorities.includes(value as SearchPriorityFilter),
				);
				if (invalidPriority) {
					return Response.json(
						{
							error: `Unsupported priority '${invalidPriority}'. Use high, medium, or low.`,
						},
						{ status: 400 },
					);
				}
				const casted = normalizedPriorities as SearchPriorityFilter[];
				filters.priority = casted.length === 1 ? casted[0] : casted;
			}

			if (labelParamsRaw.length > 0) {
				const normalizedLabels = labelParamsRaw
					.map((value) => value.trim())
					.filter((value) => value.length > 0);
				if (normalizedLabels.length > 0) {
					filters.labels =
						normalizedLabels.length === 1
							? normalizedLabels[0]
							: normalizedLabels;
				}
			}

			const results = searchService.search({ query, limit, types, filters });
			return Response.json(results);
		} catch (error) {
			console.error("Error performing search:", error);
			return Response.json({ error: "Search failed" }, { status: 500 });
		}
	}

	private async handleCreateProposal(req: Request): Promise<Response> {
		const payload = await req.json();

		if (
			!payload ||
			typeof payload.title !== "string" ||
			payload.title.trim().length === 0
		) {
			return Response.json({ error: "Title is required" }, { status: 400 });
		}

		const acceptanceCriteria = Array.isArray(payload.acceptanceCriteriaItems)
			? payload.acceptanceCriteriaItems
					.map((item: { text?: string; checked?: boolean }) => ({
						text: String(item?.text ?? "").trim(),
						checked: Boolean(item?.checked),
					}))
					.filter((item: { text: string }) => item.text.length > 0)
			: [];

		try {
			const directive =
				typeof payload.directive === "string"
					? await this.resolveDirectiveInput(payload.directive)
					: undefined;

			const { proposal: createdProposal } =
				await this.core.createProposalFromInput({
					title: payload.title,
					description: payload.summary ?? payload.description,
					status: payload.status,
					priority: payload.priority,
					directive,
					labels: payload.labels,
					assignee: payload.assignee,
					dependencies: payload.dependencies,
					references: payload.references,
					parentProposalId: payload.parentProposalId,
					summary: payload.summary,
					motivation: payload.motivation,
					design: payload.design,
					drawbacks: payload.drawbacks,
					alternatives: payload.alternatives,
					dependency_note: payload.dependency_note,
					needs_capabilities:
						payload.needs_capabilities ?? payload.required_capabilities,
					required_capabilities: payload.required_capabilities,
					implementationPlan: payload.design ?? payload.implementationPlan,
					implementationNotes: payload.implementationNotes,
					finalSummary: payload.finalSummary,
					acceptanceCriteria,
				});
			return Response.json(createdProposal, { status: 201 });
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Failed to create proposal";
			return Response.json({ error: message }, { status: 400 });
		}
	}

	private async handleGetProposal(proposalId: string): Promise<Response> {
		const liveProposal = await this.core.getProposal(proposalId);
		if (liveProposal) {
			return Response.json(liveProposal);
		}

		const store = await this.getContentStoreInstance();
		const proposals = store.getProposals();
		const proposal = findProposalByLooseId(proposals, proposalId);
		if (!proposal) {
			const fallbackId = ensurePrefix(proposalId);
			const fallback = await this.core.filesystem.loadProposal(fallbackId);
			if (fallback) {
				return Response.json(fallback);
			}
			return Response.json({ error: "Proposal not found" }, { status: 404 });
		}
		return Response.json(proposal);
	}

	private async handleGetProposalNotes(
		proposalId: string,
		req: Request,
	): Promise<Response> {
		try {
			const url = new URL(req.url);
			const noteType = url.searchParams.get("type");
			const isNumeric = /^\d+$/.test(proposalId);
			let sql = `SELECT id, proposal_id, author_identity, context_prefix, COALESCE(body, body_markdown) as body_markdown, created_at
				FROM roadmap_proposal.proposal_discussions
				WHERE proposal_id = ${isNumeric ? "$1" : "(SELECT id FROM roadmap_proposal.proposal WHERE display_id = $1)"}`;
			const params: unknown[] = [isNumeric ? parseInt(proposalId, 10) : proposalId];
			if (noteType) {
				sql += ` AND context_prefix = $2`;
				params.push(noteType);
			}
			sql += ` ORDER BY created_at DESC LIMIT 50`;
			const { rows } = await query(sql, params);
			return Response.json({ notes: rows || [] });
		} catch (error) {
			return Response.json({ error: String(error) }, { status: 500 });
		}
	}

	private async handleGetProposalDecisions(proposalId: string): Promise<Response> {
		try {
			const isNumeric = /^\d+$/.test(proposalId);
			const { rows } = await query(
				`SELECT id, decision, authority, rationale, binding, decided_at
				 FROM roadmap_proposal.proposal_decision
				 WHERE proposal_id = ${isNumeric ? "$1" : "(SELECT id FROM roadmap_proposal.proposal WHERE display_id = $1)"}
				 ORDER BY decided_at DESC`,
				[isNumeric ? parseInt(proposalId, 10) : proposalId],
			);
			return Response.json({ decisions: rows || [] });
		} catch (error) {
			return Response.json({ error: String(error) }, { status: 500 });
		}
	}

	private async handleGetProposalReviews(proposalId: string): Promise<Response> {
		try {
			const isNumeric = /^\d+$/.test(proposalId);
			const { rows } = await query(
				`SELECT id, reviewer_identity, verdict, notes, findings, is_blocking, reviewed_at
				 FROM roadmap_proposal.proposal_reviews
				 WHERE proposal_id = ${isNumeric ? "$1" : "(SELECT id FROM roadmap_proposal.proposal WHERE display_id = $1)"}
				 ORDER BY reviewed_at DESC`,
				[isNumeric ? parseInt(proposalId, 10) : proposalId],
			);
			return Response.json({ reviews: rows || [] });
		} catch (error) {
			return Response.json({ error: String(error) }, { status: 500 });
		}
	}

	private async handleUpdateProposal(
		req: Request,
		proposalId: string,
	): Promise<Response> {
		const updates = await req.json();
		const updateInput: ProposalUpdateInput = {};

		if ("title" in updates && typeof updates.title === "string") {
			updateInput.title = updates.title;
		}

		if ("description" in updates && typeof updates.description === "string") {
			updateInput.description = updates.description;
		}
		if ("summary" in updates && typeof updates.summary === "string") {
			updateInput.summary = updates.summary;
			updateInput.description = updates.summary;
		}
		if ("motivation" in updates && typeof updates.motivation === "string") {
			updateInput.motivation = updates.motivation;
		}
		if ("design" in updates && typeof updates.design === "string") {
			updateInput.design = updates.design;
			updateInput.implementationPlan = updates.design;
		}
		if ("drawbacks" in updates && typeof updates.drawbacks === "string") {
			updateInput.drawbacks = updates.drawbacks;
		}
		if ("alternatives" in updates && typeof updates.alternatives === "string") {
			updateInput.alternatives = updates.alternatives;
		}
		if (
			"dependency_note" in updates &&
			typeof updates.dependency_note === "string"
		) {
			updateInput.dependency_note = updates.dependency_note;
		}

		if ("status" in updates && typeof updates.status === "string") {
			updateInput.status = updates.status;
		}

		if ("priority" in updates && typeof updates.priority === "string") {
			updateInput.priority = updates.priority;
		}

		if (
			"directive" in updates &&
			(typeof updates.directive === "string" || updates.directive === null)
		) {
			if (typeof updates.directive === "string") {
				updateInput.directive = await this.resolveDirectiveInput(
					updates.directive,
				);
			} else {
				updateInput.directive = updates.directive;
			}
		}

		if ("labels" in updates && Array.isArray(updates.labels)) {
			updateInput.labels = updates.labels;
		}

		if ("assignee" in updates && Array.isArray(updates.assignee)) {
			updateInput.assignee = updates.assignee;
		}

		if ("dependencies" in updates && Array.isArray(updates.dependencies)) {
			updateInput.dependencies = updates.dependencies;
		}

		if ("references" in updates && Array.isArray(updates.references)) {
			updateInput.references = updates.references;
		}
		if (
			"required_capabilities" in updates &&
			Array.isArray(updates.required_capabilities)
		) {
			updateInput.required_capabilities = updates.required_capabilities;
			updateInput.needs_capabilities = updates.required_capabilities;
		}
		if (
			"needs_capabilities" in updates &&
			Array.isArray(updates.needs_capabilities)
		) {
			updateInput.needs_capabilities = updates.needs_capabilities;
		}

		if (
			"implementationPlan" in updates &&
			typeof updates.implementationPlan === "string" &&
			!("design" in updates)
		) {
			updateInput.implementationPlan = updates.implementationPlan;
		}

		if (
			"implementationNotes" in updates &&
			typeof updates.implementationNotes === "string"
		) {
			updateInput.implementationNotes = updates.implementationNotes;
		}

		if ("finalSummary" in updates && typeof updates.finalSummary === "string") {
			updateInput.finalSummary = updates.finalSummary;
		}

		if (
			"acceptanceCriteriaItems" in updates &&
			Array.isArray(updates.acceptanceCriteriaItems)
		) {
			updateInput.acceptanceCriteria = updates.acceptanceCriteriaItems
				.map((item: { text?: string; checked?: boolean }) => ({
					text: String(item?.text ?? "").trim(),
					checked: Boolean(item?.checked),
				}))
				.filter((item: { text: string }) => item.text.length > 0);
		}

		try {
			const updatedProposal = await this.core.updateProposalFromInput(
				proposalId,
				updateInput,
			);
			return Response.json(updatedProposal);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Failed to update proposal";
			return Response.json({ error: message }, { status: 400 });
		}
	}

	private async handleDeleteProposal(proposalId: string): Promise<Response> {
		const success = await this.core.archiveProposal(proposalId);
		if (!success) {
			return Response.json({ error: "Proposal not found" }, { status: 404 });
		}
		return Response.json({ success: true });
	}

	private async handleCompleteProposal(proposalId: string): Promise<Response> {
		try {
			const proposal = await this.core.filesystem.loadProposal(proposalId);
			if (!proposal) {
				return Response.json({ error: "Proposal not found" }, { status: 404 });
			}

			const success = await this.core.completeProposal(proposalId);
			if (!success) {
				return Response.json(
					{ error: "Failed to complete proposal" },
					{ status: 500 },
				);
			}

			// Notify listeners to refresh
			this.broadcastProposalsUpdated();
			return Response.json({ success: true });
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Failed to complete proposal";
			console.error("Error completing proposal:", error);
			return Response.json({ error: message }, { status: 500 });
		}
	}

	private async handleReleaseProposal(proposalId: string): Promise<Response> {
		try {
			const proposal = await this.core.filesystem.loadProposal(proposalId);
			if (!proposal) {
				return Response.json({ error: "Proposal not found" }, { status: 404 });
			}

			// Get the claim agent or use a default
			const agent = proposal.claim?.agent ?? "system";
			await this.core.releaseClaim(proposalId, agent, { force: true });

			// Notify listeners to refresh
			this.broadcastProposalsUpdated();
			return Response.json({ success: true });
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Failed to release proposal";
			console.error("Error releasing proposal:", error);
			return Response.json({ error: message }, { status: 500 });
		}
	}

	private async handleDemoteProposal(proposalId: string): Promise<Response> {
		try {
			const proposal = await this.core.filesystem.loadProposal(proposalId);
			if (!proposal) {
				return Response.json({ error: "Proposal not found" }, { status: 404 });
			}

			const result = await this.core.demoteProposalProper(
				proposalId,
				"user",
				true,
			);
			// Notify listeners to refresh
			this.broadcastProposalsUpdated();
			return Response.json({ success: true, status: result.status });
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Failed to demote proposal";
			console.error("Error demoting proposal:", error);
			return Response.json({ error: message }, { status: 500 });
		}
	}

	private async handleGetStatuses(): Promise<Response> {
		const config = await this.core.filesystem.loadConfig();
		const statuses = config?.statuses || [
			"Draft",
			"Review",
			"Develop",
			"Merge",
			"Complete",
		];
		return Response.json(statuses);
	}

	// Documentation handlers
	private async handleListDocs(): Promise<Response> {
		try {
			const store = await this.getContentStoreInstance();
			const docs = store.getDocuments();
			const docFiles = docs.map((doc) => ({
				name: `${doc.title}.md`,
				id: doc.id,
				title: doc.title,
				type: doc.type,
				createdDate: doc.createdDate,
				updatedDate: doc.updatedDate,
				lastModified: doc.updatedDate || doc.createdDate,
				tags: doc.tags || [],
			}));
			return Response.json(docFiles);
		} catch (error) {
			console.error("Error listing documents:", error);
			return Response.json([]);
		}
	}

	private async handleGetDoc(docId: string): Promise<Response> {
		try {
			const doc = await this.core.getDocument(docId);
			if (!doc) {
				return Response.json({ error: "Document not found" }, { status: 404 });
			}
			return Response.json(doc);
		} catch (error) {
			console.error("Error loading document:", error);
			return Response.json({ error: "Document not found" }, { status: 404 });
		}
	}

	private async handleCreateDoc(req: Request): Promise<Response> {
		const { filename, content } = await req.json();

		try {
			const title = filename.replace(".md", "");
			const document = await this.core.createDocumentWithId(title, content);
			return Response.json({ success: true, id: document.id }, { status: 201 });
		} catch (error) {
			console.error("Error creating document:", error);
			return Response.json(
				{ error: "Failed to create document" },
				{ status: 500 },
			);
		}
	}

	private async handleUpdateDoc(
		req: Request,
		docId: string,
	): Promise<Response> {
		try {
			const body = await req.json();
			const content =
				typeof body?.content === "string" ? body.content : undefined;
			const title = typeof body?.title === "string" ? body.title : undefined;

			if (typeof content !== "string") {
				return Response.json(
					{ error: "Document content is required" },
					{ status: 400 },
				);
			}

			let normalizedTitle: string | undefined;

			if (typeof title === "string") {
				normalizedTitle = title.trim();
				if (normalizedTitle.length === 0) {
					return Response.json(
						{ error: "Document title cannot be empty" },
						{ status: 400 },
					);
				}
			}

			const existingDoc = await this.core.getDocument(docId);
			if (!existingDoc) {
				return Response.json({ error: "Document not found" }, { status: 404 });
			}

			const nextDoc = normalizedTitle
				? { ...existingDoc, title: normalizedTitle }
				: { ...existingDoc };

			await this.core.updateDocument(nextDoc, content);
			return Response.json({ success: true });
		} catch (error) {
			console.error("Error updating document:", error);
			if (error instanceof SyntaxError) {
				return Response.json(
					{ error: "Invalid request payload" },
					{ status: 400 },
				);
			}
			return Response.json(
				{ error: "Failed to update document" },
				{ status: 500 },
			);
		}
	}

	// Decision handlers
	private async handleListDecisions(): Promise<Response> {
		try {
			const store = await this.getContentStoreInstance();
			const decisions = store.getDecisions();
			const decisionFiles = decisions.map((decision) => ({
				id: decision.id,
				title: decision.title,
				status: decision.status,
				date: decision.date,
				context: decision.context,
				decision: decision.decision,
				consequences: decision.consequences,
				alternatives: decision.alternatives,
			}));
			return Response.json(decisionFiles);
		} catch (error) {
			console.error("Error listing decisions:", error);
			return Response.json([]);
		}
	}

	private async handleGetDecision(decisionId: string): Promise<Response> {
		try {
			const store = await this.getContentStoreInstance();
			const normalizedId = decisionId.startsWith("decision-")
				? decisionId
				: `decision-${decisionId}`;
			const decision = store
				.getDecisions()
				.find((item) => item.id === normalizedId || item.id === decisionId);

			if (!decision) {
				return Response.json({ error: "Decision not found" }, { status: 404 });
			}

			return Response.json(decision);
		} catch (error) {
			console.error("Error loading decision:", error);
			return Response.json({ error: "Decision not found" }, { status: 404 });
		}
	}

	private async handleCreateDecision(req: Request): Promise<Response> {
		const { title } = await req.json();

		try {
			const decision = await this.core.createDecisionWithTitle(title);
			return Response.json(decision, { status: 201 });
		} catch (error) {
			console.error("Error creating decision:", error);
			return Response.json(
				{ error: "Failed to create decision" },
				{ status: 500 },
			);
		}
	}

	private async handleUpdateDecision(
		req: Request,
		decisionId: string,
	): Promise<Response> {
		const content = await req.text();

		try {
			await this.core.updateDecisionFromContent(decisionId, content);
			return Response.json({ success: true });
		} catch (error) {
			if (error instanceof Error && error.message.includes("not found")) {
				return Response.json({ error: "Decision not found" }, { status: 404 });
			}
			console.error("Error updating decision:", error);
			return Response.json(
				{ error: "Failed to update decision" },
				{ status: 500 },
			);
		}
	}

	private async handleGetConfig(): Promise<Response> {
		try {
			const config = await this.core.filesystem.loadConfig();
			if (!config) {
				return Response.json(
					{ error: "Configuration not found" },
					{ status: 404 },
				);
			}
			return Response.json(config);
		} catch (error) {
			console.error("Error loading config:", error);
			return Response.json(
				{ error: "Failed to load configuration" },
				{ status: 500 },
			);
		}
	}

	private async handleUpdateConfig(req: Request): Promise<Response> {
		try {
			const updatedConfig = await req.json();

			// Validate configuration
			if (!updatedConfig.projectName?.trim()) {
				return Response.json(
					{ error: "Project name is required" },
					{ status: 400 },
				);
			}

			if (
				updatedConfig.defaultPort &&
				(updatedConfig.defaultPort < 1 || updatedConfig.defaultPort > 65535)
			) {
				return Response.json(
					{ error: "Port must be between 1 and 65535" },
					{ status: 400 },
				);
			}

			// Save configuration
			await this.core.filesystem.saveConfig(updatedConfig);

			// Update local project name if changed
			if (updatedConfig.projectName !== this.projectName) {
				this.projectName = updatedConfig.projectName;
			}

			// Notify connected clients so that they refresh configuration-dependent data (e.g., statuses)
			this.broadcastProposalsUpdated();

			return Response.json(updatedConfig);
		} catch (error) {
			console.error("Error updating config:", error);
			return Response.json(
				{ error: "Failed to update configuration" },
				{ status: 500 },
			);
		}
	}

	private handleError(error: Error): Response {
		console.error("Server Error:", error);
		return new Response("Internal Server Error", { status: 500 });
	}

	// Draft handlers
	private async handleListDrafts(): Promise<Response> {
		try {
			const drafts = await this.core.filesystem.listDrafts();
			return Response.json(drafts);
		} catch (error) {
			console.error("Error listing drafts:", error);
			return Response.json([]);
		}
	}

	private async handlePromoteDraft(draftId: string): Promise<Response> {
		try {
			const success = await this.core.promoteDraft(draftId);
			if (!success) {
				return Response.json({ error: "Draft not found" }, { status: 404 });
			}
			return Response.json({ success: true });
		} catch (error) {
			console.error("Error promoting draft:", error);
			return Response.json(
				{ error: "Failed to promote draft" },
				{ status: 500 },
			);
		}
	}

	// Directive handlers
	private async handleListDirectives(): Promise<Response> {
		try {
			const directives = await this.core.fs.listDirectives();
			return Response.json(directives);
		} catch (error) {
			console.error("Error listing directives:", error);
			return Response.json([]);
		}
	}

	private async handleListArchivedDirectives(): Promise<Response> {
		try {
			const directives = await this.core.filesystem.listArchivedDirectives();
			return Response.json(directives);
		} catch (error) {
			console.error("Error listing archived directives:", error);
			return Response.json([]);
		}
	}

	private async handleGetDirective(directiveId: string): Promise<Response> {
		try {
			const directive = await this.core.filesystem.loadDirective(directiveId);
			if (!directive) {
				return Response.json({ error: "Directive not found" }, { status: 404 });
			}
			return Response.json(directive);
		} catch (error) {
			console.error("Error loading directive:", error);
			return Response.json({ error: "Directive not found" }, { status: 404 });
		}
	}

	private async handleCreateDirective(req: Request): Promise<Response> {
		try {
			const body = (await req.json()) as {
				title?: string;
				description?: string;
			};
			const title = body.title?.trim();

			if (!title) {
				return Response.json(
					{ error: "Directive title is required" },
					{ status: 400 },
				);
			}

			// Check for duplicates
			const existingDirectives = await this.core.filesystem.listDirectives();
			const buildAliasKeys = (value: string): Set<string> => {
				const normalized = value.trim().toLowerCase();
				const keys = new Set<string>();
				if (!normalized) {
					return keys;
				}
				keys.add(normalized);
				if (/^\d+$/.test(normalized)) {
					const numeric = String(Number.parseInt(normalized, 10));
					keys.add(numeric);
					keys.add(`d-${numeric}`);
					return keys;
				}
				const match = normalized.match(/^d-(\d+)$/);
				if (match?.[1]) {
					const numeric = String(Number.parseInt(match[1], 10));
					keys.add(numeric);
					keys.add(`d-${numeric}`);
				}
				return keys;
			};
			const requestedKeys = buildAliasKeys(title);
			const duplicate = existingDirectives.find((directive) => {
				const directiveKeys = new Set<string>([
					...buildAliasKeys(directive.id),
					...buildAliasKeys(directive.title),
				]);
				for (const key of requestedKeys) {
					if (directiveKeys.has(key)) {
						return true;
					}
				}
				return false;
			});
			if (duplicate) {
				return Response.json(
					{ error: "A directive with this title or ID already exists" },
					{ status: 400 },
				);
			}

			const directive = await this.core.filesystem.createDirective(
				title,
				body.description,
			);
			return Response.json(directive, { status: 201 });
		} catch (error) {
			console.error("Error creating directive:", error);
			return Response.json(
				{ error: "Failed to create directive" },
				{ status: 500 },
			);
		}
	}

	private async handleArchiveDirective(directiveId: string): Promise<Response> {
		try {
			const result = await this.core.archiveDirective(directiveId);
			if (!result.success) {
				return Response.json({ error: "Directive not found" }, { status: 404 });
			}
			this.broadcastProposalsUpdated();
			return Response.json({
				success: true,
				directive: result.directive ?? null,
			});
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Failed to archive directive";
			console.error("Error archiving directive:", error);
			return Response.json({ error: message }, { status: 500 });
		}
	}

	private async handleGetVersion(): Promise<Response> {
		try {
			const versionInfo = await getVersionInfo();
			const version = formatVersionLabel(versionInfo);
			return Response.json({ version });
		} catch (error) {
			console.error("Error getting version:", error);
			return Response.json({ error: "Failed to get version" }, { status: 500 });
		}
	}

	private async handleReorderProposal(req: Request): Promise<Response> {
		try {
			const body = await req.json();
			const proposalId =
				typeof body.proposalId === "string"
					? body.proposalId
					: typeof body.proposalId === "string"
						? body.proposalId
						: "";
			const targetStatus =
				typeof body.targetStatus === "string" ? body.targetStatus : "";
			const orderedProposalIds = Array.isArray(body.orderedProposalIds)
				? body.orderedProposalIds
				: Array.isArray(body.orderedProposalIds)
					? body.orderedProposalIds
					: [];
			const targetDirective =
				typeof body.targetDirective === "string"
					? body.targetDirective
					: body.targetDirective === null
						? null
						: typeof body.targetDirective === "string"
							? body.targetDirective
							: body.targetDirective === null
								? null
								: undefined;

			if (!proposalId || !targetStatus || orderedProposalIds.length === 0) {
				return Response.json(
					{
						error:
							"Missing required fields: proposalId, targetStatus, and orderedProposalIds",
					},
					{ status: 400 },
				);
			}

			const { updatedProposal } = await this.core.reorderProposal({
				proposalId,
				targetStatus,
				orderedProposalIds,
				targetDirective,
				commitMessage: `Reorder proposals in ${targetStatus}`,
			});

			return Response.json({ success: true, proposal: updatedProposal });
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Failed to reorder proposal";
			// Cross-branch and validation errors are client errors (400), not server errors (500)
			const isCrossBranchError = message.includes("exists in branch");
			const isValidationError =
				message.includes("not found") || message.includes("Missing required");
			const status = isCrossBranchError || isValidationError ? 400 : 500;
			if (status === 500) {
				console.error("Error reordering proposal:", error);
			}
			return Response.json({ error: message }, { status });
		}
	}

	private async handleCleanupPreview(req: Request): Promise<Response> {
		try {
			const url = new URL(req.url);
			const ageParam = url.searchParams.get("age");

			if (!ageParam) {
				return Response.json(
					{ error: "Missing age parameter" },
					{ status: 400 },
				);
			}

			const age = Number.parseInt(ageParam, 10);
			if (Number.isNaN(age) || age < 0) {
				return Response.json(
					{ error: "Invalid age parameter" },
					{ status: 400 },
				);
			}

			// Get Reached proposals older than specified days
			const proposalsToCleanup = await this.core.getReachedProposalsByAge(age);

			// Return preview of proposals to be cleaned up
			const preview = proposalsToCleanup.map((proposal) => ({
				id: proposal.id,
				title: proposal.title,
				updatedDate: proposal.updatedDate,
				createdDate: proposal.createdDate,
			}));

			return Response.json({
				count: preview.length,
				proposals: preview,
			});
		} catch (error) {
			console.error("Error getting cleanup preview:", error);
			return Response.json(
				{ error: "Failed to get cleanup preview" },
				{ status: 500 },
			);
		}
	}

	private async handleCleanupExecute(req: Request): Promise<Response> {
		try {
			const { age } = await req.json();

			if (age === undefined || age === null) {
				return Response.json(
					{ error: "Missing age parameter" },
					{ status: 400 },
				);
			}

			const ageInDays = Number.parseInt(age, 10);
			if (Number.isNaN(ageInDays) || ageInDays < 0) {
				return Response.json(
					{ error: "Invalid age parameter" },
					{ status: 400 },
				);
			}

			// Get Reached proposals older than specified days
			const proposalsToCleanup =
				await this.core.getReachedProposalsByAge(ageInDays);

			if (proposalsToCleanup.length === 0) {
				return Response.json({
					success: true,
					movedCount: 0,
					message: "No proposals to clean up",
				});
			}

			// Move proposals to completed folder
			let successCount = 0;
			const failedProposals: string[] = [];

			for (const proposal of proposalsToCleanup) {
				try {
					const success = await this.core.completeProposal(proposal.id);
					if (success) {
						successCount++;
					} else {
						failedProposals.push(proposal.id);
					}
				} catch (error) {
					console.error(`Failed to complete proposal ${proposal.id}:`, error);
					failedProposals.push(proposal.id);
				}
			}

			// Notify listeners to refresh
			this.broadcastProposalsUpdated();

			return Response.json({
				success: true,
				movedCount: successCount,
				totalCount: proposalsToCleanup.length,
				failedProposals:
					failedProposals.length > 0 ? failedProposals : undefined,
				message: `Moved ${successCount} of ${proposalsToCleanup.length} proposals to completed folder`,
			});
		} catch (error) {
			console.error("Error executing cleanup:", error);
			return Response.json(
				{ error: "Failed to execute cleanup" },
				{ status: 500 },
			);
		}
	}

	// Sequences handlers
	private async handleGetSequences(): Promise<Response> {
		const data = await this.core.listActiveSequences();
		return Response.json(data);
	}

	private async handleMoveSequence(req: Request): Promise<Response> {
		try {
			const body = await req.json();
			const proposalId = String(
				body.proposalId || body.proposalId || "",
			).trim();
			const moveToUnsequenced = Boolean(body.unsequenced === true);
			const targetSequenceIndex =
				body.targetSequenceIndex !== undefined
					? Number(body.targetSequenceIndex)
					: undefined;

			if (!proposalId)
				return Response.json(
					{ error: "proposalId is required" },
					{ status: 400 },
				);

			const next = await this.core.moveProposalInSequences({
				proposalId,
				unsequenced: moveToUnsequenced,
				targetSequenceIndex,
			});
			return Response.json(next);
		} catch (error) {
			const message = (error as Error)?.message || "Invalid request";
			return Response.json({ error: message }, { status: 400 });
		}
	}

	private async handleGetStatistics(): Promise<Response> {
		try {
			// Load proposals using the same logic as CLI overview
			const { proposals, drafts, statuses } =
				await this.core.loadAllProposalsForStatistics();

			// Calculate statistics using the exact same function as CLI
			const statistics = getProposalStatistics(proposals, drafts, statuses);

			// Convert Maps to objects for JSON serialization
			const response = {
				...statistics,
				statusCounts: Object.fromEntries(statistics.statusCounts),
				priorityCounts: Object.fromEntries(statistics.priorityCounts),
			};

			return Response.json(response);
		} catch (error) {
			console.error("Error getting statistics:", error);
			return Response.json(
				{ error: "Failed to get statistics" },
				{ status: 500 },
			);
		}
	}

	private async handleGetStatus(): Promise<Response> {
		try {
			const config = await this.core.filesystem.loadConfig();
			return Response.json({
				initialized: !!config,
				projectPath: this.core.filesystem.rootDir,
			});
		} catch (error) {
			console.error("Error getting status:", error);
			return Response.json({
				initialized: false,
				projectPath: this.core.filesystem.rootDir,
			});
		}
	}

	private async handleInit(req: Request): Promise<Response> {
		try {
			const body = await req.json();
			const projectName =
				typeof body.projectName === "string" ? body.projectName.trim() : "";
			const integrationMode = body.integrationMode as
				| "mcp"
				| "cli"
				| "none"
				| undefined;
			const mcpClients = Array.isArray(body.mcpClients) ? body.mcpClients : [];
			const agentInstructions = Array.isArray(body.agentInstructions)
				? body.agentInstructions
				: [];
			const installClaudeAgentFlag = Boolean(body.installClaudeAgent);
			const advancedConfig = body.advancedConfig || {};

			// Input validation (browser layer responsibility)
			if (!projectName) {
				return Response.json(
					{ error: "Project name is required" },
					{ status: 400 },
				);
			}

			// Check if already initialized (for browser, we don't allow re-init)
			const existingConfig = await this.core.filesystem.loadConfig();
			if (existingConfig) {
				return Response.json(
					{ error: "Project is already initialized" },
					{ status: 400 },
				);
			}

			// Call shared core init function
			const result = await initializeProject(this.core, {
				projectName,
				integrationMode: integrationMode || "none",
				mcpClients,
				agentInstructions,
				installClaudeAgent: installClaudeAgentFlag,
				advancedConfig,
				existingConfig: null,
			});

			// Update server's project name
			this.projectName = result.projectName;

			// Ensure config watcher is set up now that config file exists
			if (this.contentStore) {
				this.contentStore.ensureConfigWatcher();
			}

			return Response.json({
				success: result.success,
				projectName: result.projectName,
				mcpResults: result.mcpResults,
			});
		} catch (error) {
			console.error("Error initializing project:", error);
			const message =
				error instanceof Error ? error.message : "Failed to initialize project";
			return Response.json({ error: message }, { status: 500 });
		}
	}

	private async handleListAgents(): Promise<Response> {
		try {
			const agents = await this.core.listAgents();
			return Response.json(agents);
		} catch (error) {
			console.error("Error listing agents:", error);
			return Response.json({ error: "Failed to list agents" }, { status: 500 });
		}
	}

	private async handleListPulse(req: Request): Promise<Response> {
		try {
			const url = new URL(req.url);
			const limitParam = url.searchParams.get("limit");
			const limit = limitParam ? Number.parseInt(limitParam, 10) : 100;

			const events = await this.core.listPulse(limit);
			return Response.json(events);
		} catch (error) {
			console.error("Error listing pulse events:", error);
			return Response.json(
				{ error: "Failed to list pulse events" },
				{ status: 500 },
			);
		}
	}

	private async handleListChannels(): Promise<Response> {
		try {
			const channels = await this.core.listChannels();
			return Response.json(channels);
		} catch (error) {
			console.error("Error listing channels:", error);
			return Response.json(
				{ error: "Failed to list channels" },
				{ status: 500 },
			);
		}
	}

	private async handleListMessages(req: Request): Promise<Response> {
		try {
			const url = new URL(req.url);
			const channel = url.searchParams.get("channel");
			if (!channel) {
				return Response.json(
					{ error: "channel parameter is required" },
					{ status: 400 },
				);
			}
			const since = url.searchParams.get("since") || undefined;
			const messages = await this.core.readMessages({ channel, since });
			return Response.json(messages);
		} catch (error) {
			console.error("Error listing messages:", error);
			return Response.json(
				{ error: "Failed to list messages" },
				{ status: 500 },
			);
		}
	}

	private async handleSendMessage(req: Request): Promise<Response> {
		try {
			const body = await req.json();
			const channel =
				typeof body.channel === "string" ? body.channel.trim() : "";
			const text = typeof body.text === "string" ? body.text.trim() : "";
			const from =
				typeof body.from === "string" && body.from.trim().length > 0
					? body.from.trim()
					: "@operator";

			if (!channel) {
				return Response.json({ error: "channel is required" }, { status: 400 });
			}
			if (!text) {
				return Response.json({ error: "text is required" }, { status: 400 });
			}
			if (channel.startsWith("private-")) {
				return Response.json(
					{ error: "Private DM sending is not wired through the web API yet" },
					{ status: 400 },
				);
			}

			await this.core.sendMessage({
				from,
				message: text,
				type: channel === "public" ? "public" : "group",
				group: channel === "public" ? undefined : channel,
			});

			return Response.json({ success: true });
		} catch (error) {
			console.error("Error sending message:", error);
			return Response.json(
				{ error: "Failed to send message" },
				{ status: 500 },
			);
		}
	}

	private async handleListRoutes(): Promise<Response> {
		try {
			const { rows } = await query(
				`SELECT id,
				        model_name,
				        route_provider,
				        agent_provider,
				        agent_cli,
				        fallback_cli,
				        is_enabled,
				        priority,
				        api_spec,
				        base_url,
				        cost_per_1k_input * 1000 AS cost_per_million_input,
				        cost_per_1k_output * 1000 AS cost_per_million_output,
				        plan_type,
				        notes,
				        created_at
				   FROM roadmap.model_routes
				  ORDER BY is_enabled DESC, priority ASC, model_name ASC`,
			);
			return Response.json({ routes: rows ?? [] });
		} catch (error) {
			console.error("Error listing routes:", error);
			return Response.json({ error: "Failed to list routes" }, { status: 500 });
		}
	}

	private async handleListDispatches(): Promise<Response> {
		try {
			const { rows } = await query(
				`SELECT d.id,
				        d.proposal_id,
				        p.display_id AS proposal_display_id,
				        p.title AS proposal_title,
				        d.agent_identity,
				        d.worker_identity,
				        d.squad_name,
				        d.dispatch_role,
				        d.dispatch_status,
				        d.offer_status,
				        d.assigned_at,
				        d.completed_at,
				        d.claim_expires_at,
				        d.claimed_at,
				        d.renew_count,
				        d.reissue_count,
				        d.max_reissues,
				        d.required_capabilities,
				        d.metadata
				   FROM roadmap_workforce.squad_dispatch d
				   LEFT JOIN roadmap_proposal.proposal p
				     ON p.id = d.proposal_id
				  ORDER BY d.assigned_at DESC NULLS LAST, d.id DESC`,
			);
			return Response.json({ dispatches: rows ?? [] });
		} catch (error) {
			console.error("Error listing dispatches:", error);
			return Response.json(
				{ error: "Failed to list dispatches" },
				{ status: 500 },
			);
		}
	}

	private async handleMcpSse(_req: Request): Promise<Response> {
		// This is now handled by handleMcpSseRaw for proper SSE support
		return Response.json({ error: "Use raw SSE endpoint" }, { status: 501 });
	}

	/**
	 * Handle SSE with raw Node.js ServerResponse (required by SSEServerTransport)
	 */
	private async handleMcpSseRaw(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		await this.ensureServicesReady();
		if (!this.mcpServer) {
			res.writeHead(500).end("MCP server not available");
			return;
		}

		// Create SSE transport with raw response
		const { SSEServerTransport } = await import(
			"@modelcontextprotocol/sdk/server/sse.js"
		);
		const transport = new SSEServerTransport("/api/mcp/message", res);

		const sessionId = transport.sessionId;
		this.sseTransports.set(sessionId, transport);

		console.log(`[MCP] SSE connection: ${sessionId}`);

		// Connect MCP server's underlying Server to transport
		// Note: connect() calls start() automatically
		try {
			await ((this.mcpServer as any).server as any).connect(transport);
		} catch (e: any) {
			if (e.message?.includes("Already connected")) {
				// Close existing and reconnect
				await ((this.mcpServer as any).server as any).close();
				await ((this.mcpServer as any).server as any).connect(transport);
			} else {
				throw e;
			}
		}

		// Clean up on close
		req.on("close", async () => {
			console.log(`[MCP] SSE closed: ${sessionId}`);
			this.sseTransports.delete(sessionId);
			try {
				await transport.close();
			} catch {}
		});
	}

	private async handleMcpMessage(req: Request): Promise<Response> {
		try { appendFileSync("/tmp/mcp-debug.log", "[MCP] handleMcpMessage called\n"); } catch {}
		await this.ensureServicesReady();
		if (!this.mcpServer) {
			return Response.json(
				{ error: "MCP server not available" },
				{ status: 500 },
			);
		}

		const url = new URL(req.url);
		const sessionId = url.searchParams.get("sessionId");
		if (!sessionId) {
			return Response.json({ error: "sessionId required" }, { status: 400 });
		}

		const transport = this.sseTransports.get(sessionId);
		if (!transport) {
			return Response.json({ error: "Invalid sessionId" }, { status: 404 });
		}

		// Read body
		const body = await req.text();
		let parsedBody: Parameters<SSEServerTransport["handlePostMessage"]>[2];
		try {
			parsedBody = JSON.parse(body) as Parameters<
				SSEServerTransport["handlePostMessage"]
			>[2];
		} catch {
			return Response.json({ error: "Invalid JSON" }, { status: 400 });
		}
		const parsedMethod =
			typeof parsedBody === "object" &&
			parsedBody !== null &&
			"method" in parsedBody &&
			typeof parsedBody.method === "string"
				? parsedBody.method
				: "unknown";

	try { appendFileSync(
		"/tmp/mcp-debug.log",
		`[MCP] POST message: ${parsedMethod} sessionId: ${sessionId}\n`,
	); } catch {}

		// Handle message through SSE transport
		try {
			try { appendFileSync(
				"/tmp/mcp-debug.log",
				"[MCP] Calling transport.handlePostMessage\n",
			); } catch {}

			// Create mock response that captures status
			let responseStatus = 202;
			let responseBody = "";
			const mockRes = {
				writeHead: (status: number) => {
					responseStatus = status;
					return mockRes;
				},
				write: (chunk: any) => {
					responseBody += Buffer.from(chunk).toString();
					return true;
				},
				end: (chunk?: any) => {
					if (chunk) responseBody += Buffer.from(chunk).toString();
					try { appendFileSync(
						"/tmp/mcp-debug.log",
						`[MCP] Response status: ${responseStatus} body: ${responseBody.slice(0, 100)}\n`,
					); } catch {}
					return mockRes;
				},
				flushHeaders: () => {},
				headersSent: false,
				setHeader: () => {},
			};

			// Call transport's handlePostMessage which handles the message internally
			await transport.handlePostMessage(
				{
					headers: Object.fromEntries(new Headers(req.headers as any)),
					auth: undefined,
				} as any,
				mockRes as any,
				parsedBody,
			);

			// Return the actual captured response
			if (responseBody) {
				try {
					return Response.json(JSON.parse(responseBody));
				} catch {
					return new Response(responseBody, { status: responseStatus });
				}
			}
			return Response.json({ ok: true });
		} catch (e) {
			try { appendFileSync("/tmp/mcp-debug.log", `[MCP] POST error: ${String(e)}\n`); } catch {}
			return Response.json({ error: String(e) }, { status: 500 });
		}
	}
}
