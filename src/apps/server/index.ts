import { execSync } from "node:child_process";
import {
	appendFileSync,
	createReadStream,
	existsSync,
	readFileSync,
	statSync,
} from "node:fs";
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
import { Core } from "../../core/roadmap.ts";
import type { ContentStore } from "../../core/storage/content-store.ts";
import { createMcpServer, type McpServer } from "../../mcp/server.ts";
import { handleDirectMcpRequest } from "../mcp-server/http-compat.ts";
import { RfcStates, getView, getRegistry } from "../../core/workflow/state-names.ts";
import { loadStageRegistry } from "../../core/workflow/stage-registry.ts";
import type {
	Proposal,
	ProposalMaturity,
	ProposalUpdateInput,
	SearchPriorityFilter,
	SearchResultType,
} from "../../types/index.ts";
import { watchConfig } from "../../utils/config-watcher.ts";
import { formatVersionLabel, getVersionInfo } from "../../utils/version.ts";
import {
	getPool,
	query,
	setPoolLifecycleMode,
	startPoolPoisonWatchdog,
} from "../../infra/postgres/pool.ts";
import { sendMessage as sendLiaisonMessage } from "../../infra/agency/liaison-message-service.ts";
import { discordSend } from "../../infra/discord/notify.ts";
import { runObservabilityAlertTick } from "../../infra/agency/observability-alerting.ts";
import type { PoolClient, Client as PgClient } from "pg";
import { hashOperatorToken, requireOperator } from "./operator-auth.ts";
import { agentContextStorage, type VerifiedPrincipal } from "../../shared/identity/agent-context.ts";
import { verifyBoundBearer } from "../../core/identity/principal-identity.ts";
import {
	generateArchitectureDocs,
	checkStale,
} from "../../core/infrastructure/architecture-reconstructor.ts";
import {
	listActiveDispatches,
	listAgencies as listAgenciesControl,
	listWorkers,
	stop as operatorStop,
	getFeedEvents,
	replayChain,
	type ScopeType,
	type EventClass,
} from "../../core/governance/control-feed.ts";
import {
	cancelDispatch,
	suspendAgency,
	resumeAgency,
	drainHost,
	resumeHost,
	terminateWorker,
	suspendProviderRoute,
	resumeProviderRoute,
} from "../../core/governance/operator-stop-controls.ts";
import {
	pauseAgencyOperator,
	resumeAgencyOperator,
	retireAgencyOperator,
} from "../../core/orchestration/resolvers/agency-resolver.ts";

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
	// P477 AC-2: per-socket project scope. Updated on every "subscribe"
	// payload that carries a project_id; null means "no scope chosen yet"
	// so we fall back to the server-default project.
	private wsProjectScope = new Map<WebSocket, number | null>();
	private contentStore: ContentStore | null = null;
	private searchService: SearchService | null = null;
	private unsubscribeContentStore?: () => void;
	private storeReadyBroadcasted = false;
	private configWatcher: { stop: () => void } | null = null;
	private mcpServer: McpServer | null = null;
	private sseTransports = new Map<string, SSEServerTransport>();
	private roadmapEventsClient: PoolClient | null = null;
	private roadmapEventsReconnectTimer: ReturnType<typeof setTimeout> | null =
		null;

	// P446: track server start time for /healthz
	private readonly _startedAt = new Date();

	// P846: Operator agency registration and A2A relay
	private readonly _operatorSseSessions = new Map<string, ServerResponse>();
	private _operatorNotifyClient: PgClient | null = null;
	private _operatorHeartbeatInterval: ReturnType<typeof setInterval> | null = null;
	private _operatorSessionId: string | null = null;
	private agencyAlertInterval: ReturnType<typeof setInterval> | null = null;

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
					`SELECT MAX(updated_at) as latest FROM roadmap_proposal.proposal`,
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
		console.log(`📊 Change polling started (every ${POLL_INTERVAL / 1000}s)`);
	}

	private handleSubscribe(ws: WebSocket, channel: string) {
		const subs = this.channelSubscriptions.get(ws);
		if (!subs || subs.has(channel)) return;
		let lastId = 0;
		const interval = setInterval(async () => {
			try {
				const result = await query(
					`SELECT id, from_agent, to_agent, message_content, created_at
					 FROM roadmap.message_ledger
					 WHERE channel = $1 AND id > $2
					 ORDER BY id ASC LIMIT 50`,
					[channel, lastId],
				);
				for (const row of result.rows) {
					lastId = row.id;
					try {
						ws.send(JSON.stringify({ type: "channel-message", channel, message: row }));
					} catch {}
				}
			} catch {}
		}, 1000);
		subs.set(channel, () => clearInterval(interval));
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
	// P477 AC-2: project_id is captured per-socket so subsequent snapshots and
	// broadcasts can be filtered down to the operator's selected project. A
	// null/missing project_id keeps the legacy "all projects" behaviour.
	private async handleTableSubscribe(
		ws: WebSocket,
		tables: string[],
		projectId: number | null,
	) {
		const subscribedTables = this.tableSubscriptions.get(ws);
		if (!subscribedTables) return;

		const previousScope = this.wsProjectScope.get(ws) ?? null;
		const scopeChanged = previousScope !== projectId;
		// Always update the scope; clients re-send subscribe on project change.
		this.wsProjectScope.set(ws, projectId);

		let needsProposalSnapshot = false;
		for (const table of tables) {
			if (subscribedTables.has(table)) {
				if (table === "proposal" && scopeChanged) {
					// Same table, new scope — refresh.
					needsProposalSnapshot = true;
				}
				continue;
			}
			subscribedTables.add(table);
			console.log(
				`[WS] Client subscribed to table: ${table} (project=${projectId ?? "*"})`,
			);

			if (table === "proposal") {
				needsProposalSnapshot = true;
			}
			// Other tables (workforce_registry, etc.) can be added here
		}

		if (needsProposalSnapshot) {
			await this.sendProposalSnapshot(ws);
		}
	}

	// Transform API proposal to frontend WebSocketProposal format
	private proposalToWsFormat(p: any): any {
		const canonicalDisplayId = p.displayId || p.display_id || p.id || "";
		const websocketId = p.id || p.display_id || "";
		const sanitizedLabels = Array.isArray(p.labels)
			? p.labels
					.map((label: unknown) => String(label).trim())
					.filter(
						(label: string) => label.length > 0 && label !== "[object Object]",
					)
			: [];
		return {
			id: canonicalDisplayId || `#${websocketId}`,
			displayId: canonicalDisplayId,
			websocketId,
			parentId: p.parentProposalId || null,
			proposalType: p.proposalType || p.type || "feature",
			category: p.category || "",
			domainId: p.domainId || "",
			title: p.title || "(no title)",
			status: p.status || RfcStates.DRAFT,
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
			maturity: p.maturity || null,
			maturityLevel:
				p.maturity === "new"
					? 0
					: p.maturity === "mature"
						? 5
						: p.maturity === "obsolete"
							? 10
							: null,
			repositoryPath: p.filePath || null,
			budgetLimitUsd: p.budgetLimitUsd || 0,
			tags: sanitizedLabels.length > 0 ? sanitizedLabels.join(",") : null,
			createdAt: (p.createdDate && p.createdDate !== "") ? p.createdDate : (p.createdAt || null),
			updatedAt: (p.updatedDate && p.updatedDate !== "") ? p.updatedDate : (p.updatedAt || null),
		};
	}

	private scheduleRoadmapEventsReconnect() {
		if (this._stopping || this.roadmapEventsReconnectTimer) return;
		this.roadmapEventsReconnectTimer = setTimeout(() => {
			this.roadmapEventsReconnectTimer = null;
			void this.startRoadmapEventsListener();
		}, 3000);
	}

	private async startRoadmapEventsListener(): Promise<void> {
		if (this._stopping || this.roadmapEventsClient) return;
		try {
			const client = await getPool().connect();
			this.roadmapEventsClient = client;
			client.on("error", (err) => {
				console.error("[WS] roadmap_events listener error:", err.message);
				if (this.roadmapEventsClient === client) {
					this.roadmapEventsClient = null;
				}
				try {
					client.release(true);
				} catch {}
				this.scheduleRoadmapEventsReconnect();
			});
			await client.query("LISTEN roadmap_events");
			client.on("notification", (notification) => {
				if (notification.channel !== "roadmap_events") return;
				this.broadcastProposalsUpdated();
			});
			console.log("[WS] Listening for roadmap_events");
		} catch (err) {
			console.warn(
				"[WS] roadmap_events listener unavailable:",
				(err as Error).message,
			);
			this.roadmapEventsClient = null;
			this.scheduleRoadmapEventsReconnect();
		}
	}

	// Send proposal snapshot to a WebSocket client
	// P477 AC-2: roadmap.proposal lives in the control plane and has no
	// project_id column today (CONVENTIONS.md §6.0 / §8d). Filtering happens
	// later via tenant-DB resolution (P429/P482-P485). We still consult the
	// per-socket scope so future wiring can intersect via cubics/dispatches
	// without rewriting this method.
	private async sendProposalSnapshot(ws: WebSocket) {
		try {
			const projectScope = this.wsProjectScope.get(ws) ?? null;
			console.log(
				`[WS] Sending proposal snapshot (project=${projectScope ?? "*"})...`,
			);
			const store = await this.getContentStoreInstance();
			const proposals = await this.core.queryProposals({
				includeCrossBranch: true,
			});
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
			ws.send(
				JSON.stringify({
					type: "proposal_snapshot",
					data: [],
				}),
			);
		}
	}

	// Broadcast proposal update to all subscribed clients.
	// P477 AC-2: proposals are control-plane today (no project_id column),
	// so we cannot filter per recipient. Once tenant-DB routing lands the
	// payload will carry project_id and we will skip clients whose
	// wsProjectScope(ws) does not match.
	private broadcastProposalUpdate(
		type: "proposal_update" | "proposal_insert" | "proposal_delete",
		data: any,
	) {
		const wsData =
			type === "proposal_delete" ? data : this.proposalToWsFormat(data);
		const dataProjectId =
			typeof (data as Record<string, unknown> | null)?.project_id === "number"
				? ((data as Record<string, unknown>).project_id as number)
				: null;
		const msg = JSON.stringify({ type, data: wsData });

		for (const ws of this.sockets) {
			const tables = this.tableSubscriptions.get(ws);
			if (!tables?.has("proposal")) continue;
			// When the row carries an explicit project_id (future tenant-DB path),
			// honour the recipient's scope. Today dataProjectId is always null,
			// so this short-circuits to "send to everyone subscribed".
			if (dataProjectId != null) {
				const scope = this.wsProjectScope.get(ws) ?? null;
				if (scope != null && scope !== dataProjectId) continue;
			}
			try {
				ws.send(msg);
			} catch {}
		}
	}

	async start(port?: number, openBrowser = true): Promise<void> {
		// Prevent duplicate starts (e.g., accidental re-entry)
		if (this.server) {
			console.log("Server already running");
			return;
		}
		setPoolLifecycleMode("long-running");
		startPoolPoisonWatchdog("agenthive-board");
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

			// P846: Register operator agency and start notification relay
			await this._registerOperatorAgency();
			await this._startOperatorNotifyRelay();

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
						// Frontend table subscription: { type: "subscribe", tables: ["proposal", ...], project_id?: number }
						if (data.type === "subscribe" && Array.isArray(data.tables)) {
							const rawId = (data as Record<string, unknown>).project_id;
							const projectId =
								typeof rawId === "number" && Number.isFinite(rawId) && rawId > 0
									? rawId
									: typeof rawId === "string" && /^\d+$/.test(rawId)
										? Number(rawId)
										: null;
							this.handleTableSubscribe(ws, data.tables, projectId);
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
					this.wsProjectScope.delete(ws);
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
			void this.startRoadmapEventsListener();
			void this.scanAgencyObservabilityAlerts();
			this.agencyAlertInterval = setInterval(
				() => void this.scanAgencyObservabilityAlerts(),
				60_000,
			);
			this.agencyAlertInterval.unref?.();
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

		// P846: Clean up operator agency session and notify relay
		try {
			await this._shutdownOperatorAgency();
		} catch (err) {
			console.warn("[P846] Error shutting down operator agency:", err);
		}

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
		if (this.roadmapEventsReconnectTimer) {
			clearTimeout(this.roadmapEventsReconnectTimer);
			this.roadmapEventsReconnectTimer = null;
		}
		if (this.roadmapEventsClient) {
			const client = this.roadmapEventsClient;
			this.roadmapEventsClient = null;
			try {
				await client.query("UNLISTEN roadmap_events");
			} catch {}
			try {
				client.release();
			} catch {}
		}
		if (this.agencyAlertInterval) {
			clearInterval(this.agencyAlertInterval);
			this.agencyAlertInterval = null;
		}

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
		try {
			appendFileSync("/tmp/mcp-debug.log", `[HTTP] ${req.method} ${req.url}\n`);
		} catch {}
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
		const staticExtensions = [
			".js",
			".mjs",
			".css",
			".png",
			".jpg",
			".jpeg",
			".svg",
			".ico",
			".woff",
			".woff2",
			".json",
		];
		if (
			method === "GET" &&
			staticExtensions.some((ext) => pathname.endsWith(ext))
		) {
			const staticPath = join(webDir, pathname);
			console.log(
				`[Static] Looking for: ${staticPath}, exists: ${existsSync(staticPath)}`,
			);
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
					headers: {
						"Content-Type": mimeTypes[ext] || "application/octet-stream",
					},
				});
			}
		}

		// Static routes returning indexHtml.
		// P1696 added /dispatches; the broader fix is the generic SPA fallback
		// at the end of dispatchRequest so future App.tsx routes (e.g.
		// /agencies, currently TODO) work via direct URL without touching this list.
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
					"/activity",
					"/dispatches",
					"/control",
				].some((p) => pathname === p || pathname.startsWith(`${p}/`)))
		) {
			return new Response(indexHtml, {
				headers: { "Content-Type": "text/html" },
			});
		}

		if (method === "POST" && (pathname === "/mcp" || pathname === "/api/mcp")) {
			return await this.handleDirectMcp(req);
		}

		// P446: Health and smoke endpoints (HTTP-layer, not MCP tool handlers)
		if (method === "GET" && pathname === "/healthz") {
			return await this.handleHealthz();
		}
		if (method === "POST" && pathname === "/smoke") {
			return await this.handleSmoke();
		}

		// API Routes
		if (pathname.startsWith("/api/")) {
			if (pathname === "/api/proposals") {
				if (method === "GET") return await this.handleListProposals(req);
				if (method === "POST") return await this.handleCreateProposal(req);
			}

			if (pathname === "/api/agents" && method === "GET")
				return await this.handleListAgents(req);
			if (pathname.startsWith("/api/agents/")) {
				const parts = pathname.split("/").filter(Boolean);
				// /api/agents/:identity            → detail bundle
				// /api/agents/:identity/message    → POST: send a private DM
				// /api/agents/:identity/stop       → POST: stop active runs
				const identity = parts[2] ? decodeURIComponent(parts[2]) : "";
				if (parts.length === 3 && method === "GET" && identity) {
					return await this.handleGetAgentDetail(identity, req);
				}
				if (
					parts.length === 4 &&
					parts[3] === "message" &&
					method === "POST" &&
					identity
				) {
					return await this.handleSendAgentMessage(identity, req);
				}
				if (
					parts.length === 4 &&
					parts[3] === "stop" &&
					method === "POST" &&
					identity
				) {
					return await this.handleStopAgent(identity, req);
				}
			}
			if (pathname.startsWith("/api/cubics/")) {
				const parts = pathname.split("/").filter(Boolean);
				const cubicId = parts[2] ? decodeURIComponent(parts[2]) : "";
				if (
					parts.length === 4 &&
					parts[3] === "stop" &&
					method === "POST" &&
					cubicId
				) {
					return await this.handleStopCubic(cubicId, req);
				}
			}
			if (
				pathname.startsWith("/api/proposals/") &&
				pathname.endsWith("/state-machine/halt")
			) {
				const parts = pathname.split("/").filter(Boolean);
				const id = parts[2] ? decodeURIComponent(parts[2]) : "";
				if (method === "POST" && id) {
					return await this.handleHaltProposalGate(id, req);
				}
			}
			if (
				pathname.startsWith("/api/proposals/") &&
				pathname.endsWith("/state-machine/resume")
			) {
				const parts = pathname.split("/").filter(Boolean);
				const id = parts[2] ? decodeURIComponent(parts[2]) : "";
				if (method === "POST" && id) {
					return await this.handleResumeProposalGate(id, req);
				}
			}
			if (pathname === "/api/projects" && method === "GET")
				return await this.handleListProjects();
			if (pathname === "/api/control-plane/overview" && method === "GET")
				return await this.handleControlPlaneOverview(req);
			if (pathname === "/api/operator/audit" && method === "GET")
				return await this.handleOperatorAudit(req);
			if (pathname === "/api/operator/tokens" && method === "POST")
				return await this.handleIssueOperatorToken(req);
			if (pathname === "/api/operator/tokens" && method === "GET")
				return await this.handleListOperatorTokens(req);
			// P435: Operator Control API
			if (pathname === "/api/operator/control/dispatches" && method === "GET")
				return await this.handleControlListDispatches(req);
			if (pathname === "/api/operator/control/agencies" && method === "GET")
				return await this.handleControlListAgencies(req);
			if (pathname === "/api/operator/control/workers" && method === "GET")
				return await this.handleControlListWorkers(req);
			if (pathname === "/api/operator/control/stop" && method === "POST")
				return await this.handleControlStop(req);
			if (pathname === "/api/operator/control/suspend-agency" && method === "POST")
				return await this.handleControlSuspendAgency(req);
			if (pathname === "/api/operator/control/drain-host" && method === "POST")
				return await this.handleControlDrainHost(req);
			if (pathname === "/api/operator/control/cancel-dispatch" && method === "POST")
				return await this.handleControlCancelDispatch(req);
			if (pathname === "/api/operator/control/terminate-worker" && method === "POST")
				return await this.handleControlTerminateWorker(req);
			if (pathname === "/api/operator/control/feed" && method === "GET")
				return await this.handleControlFeed(req);
			if (pathname.startsWith("/api/operator/control/replay/") && method === "GET") {
				const dispatchId = pathname.split("/").at(-1)!;
				return await this.handleControlReplay(req, dispatchId);
			}
			if (pathname === "/api/operator/action" && method === "POST")
				return await this.handleOperatorGateAction(req);
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
			if (pathname.startsWith("/api/routes/") && method === "PATCH")
				return await this.handleToggleRoute(req, pathname.split("/").at(-1)!);
			if (pathname === "/api/agencies" && method === "GET")
				return await this.handleListAgencies(req);
			if (pathname.startsWith("/api/agencies/")) {
				const parts = pathname.split("/").filter(Boolean);
				const agencyId = parts[2] ? decodeURIComponent(parts[2]) : "";
				if (
					parts.length === 4 &&
					parts[3] === "action" &&
					method === "POST" &&
					agencyId
				) {
					return await this.handleAgencyAction(agencyId, req);
				}
			}
			if (pathname === "/api/dispatches" && method === "GET")
				return await this.handleListDispatches(req);
			if (pathname === "/api/board/stages" && method === "GET")
				return await this.handleGetBoardStages(req);
			if (pathname === "/api/board/columns" && method === "GET")
				return await this.handleGetBoardColumns(req);
			if (pathname === "/api/board/live-feed" && method === "GET")
				return await this.handleBoardLiveFeed(req);
			if (pathname === "/api/arch-docs" && method === "GET")
				return await this.handleGetArchDocs();

			if (pathname === "/api/mcp/sse" && method === "GET") {
				try {
					appendFileSync("/tmp/mcp-debug.log", "[Server] MCP SSE request\n");
				} catch {}
				return await this.handleMcpSse(req);
			}
			if (pathname === "/api/mcp/message" && method === "POST") {
				try {
					appendFileSync("/tmp/mcp-debug.log", "[Server] MCP POST request\n");
				} catch {}
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

			if (pathname === "/api/arch-docs" && method === "GET")
				return await this.handleGetArchDocs();

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

			// P081: SLA contract endpoint
			if (pathname === "/api/sla" && method === "GET") {
				try {
					const { serveSlaContract } = await import("./sla-metrics.ts");
					const contract = serveSlaContract();
					return new Response(JSON.stringify(contract, null, 2), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				} catch (err) {
					return new Response(JSON.stringify({ error: "SLA contract unavailable" }), {
						status: 503,
						headers: { "Content-Type": "application/json" },
					});
				}
			}
			if (pathname === "/api/init" && method === "POST")
				return await this.handleInit(req);
			if (pathname === "/api/search" && method === "GET")
				return await this.handleSearch(req);

			if (pathname === "/api/sequences" && method === "GET")
				return await this.handleGetSequences();
			if (pathname === "/api/sequences/move" && method === "POST")
				return await this.handleMoveSequence(req);

			if (pathname === "/api/teams" && method === "GET")
				return await this.handleListTeams();

			if (pathname === "/api/knowledge" && method === "GET")
				return await this.handleListKnowledge(req);

			if (
				pathname.startsWith("/api/knowledge/") &&
				pathname.endsWith("/helpful") &&
				method === "POST"
			) {
				const id = pathname.split("/")[3]!;
				return await this.handleMarkKnowledgeHelpful(id);
			}

			if (pathname === "/api/sla" && method === "GET")
				return await this.handleGetSla();
		}

		// Metrics endpoint (outside /api/ prefix for Prometheus scraping convention)
		if (pathname === "/metrics" && method === "GET")
			return await this.handleMetrics();

		// Legacy/Duplicate routes
		if (pathname === "/sequences" && method === "GET")
			return await this.handleGetSequences();
		if (pathname === "/sequences/move" && method === "POST")
			return await this.handleMoveSequence(req);

		// Assets (not implemented - return 404)
		if (pathname.startsWith("/assets/")) {
			return new Response("Asset not found", { status: 404 });
		}

		// P1696: generic SPA fallback. After all API and known-path handlers,
		// any GET that looks like browser navigation (HTML accept, no file
		// extension, no /api/ prefix) should serve the SPA shell so client-side
		// React can route it. Prior behaviour 404'd unknown paths, making
		// NotFoundPage unreachable via direct URL and breaking deep-links to
		// new routes whenever the allow-list above wasn't updated.
		if (
			method === "GET" &&
			!pathname.startsWith("/api/") &&
			!pathname.includes(".") &&
			(req.headers.get("accept") ?? "").includes("text/html")
		) {
			return new Response(indexHtml, {
				headers: { "Content-Type": "text/html" },
			});
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
			// P843: Extract and verify operator bearer token if present
			let verifiedPrincipal: VerifiedPrincipal | null = null;
			const authHeader = req.headers.get("Authorization");
			if (authHeader?.startsWith("Bearer ")) {
				const token = authHeader.slice(7);
				const hmacSecret = this._getOperatorHmacSecret();
				const result = await verifyBoundBearer(token, hmacSecret);
				if (result.ok && result.principal_id) {
					verifiedPrincipal = {
						principal_id: result.principal_id,
						principal_kind: "operator",
						parent_principal_id: null,
					};
				}
			}

			const payload = await req.json();

			// Call MCP handler with optional context wrapping
			const callHandler = async () => {
				return await handleDirectMcpRequest(this.mcpServer as McpServer, payload);
			};

			const response = verifiedPrincipal
				? await agentContextStorage.run(
					{ verified: verifiedPrincipal },
					() => callHandler(),
				)
				: await callHandler();

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

	// P446 AC-4: GET /healthz
	private async handleHealthz(): Promise<Response> {
		let dbStatus: "ok" | "error" = "error";
		let schemaVersion: string | null = null;
		let dbErrorMessage: string | undefined;
		try {
			const pool = getPool();
			const [pingResult, migResult] = await Promise.all([
				pool.query("SELECT 1"),
				pool.query<{ filename: string }>(
					"SELECT filename FROM roadmap.migration_history WHERE status = 'applied' ORDER BY applied_at DESC LIMIT 1",
				).catch(() => null),
			]);
			if (pingResult.rowCount && pingResult.rowCount > 0) dbStatus = "ok";
			if (migResult && migResult.rows.length > 0) {
				schemaVersion = migResult.rows[0].filename;
			}
		} catch (err) {
			dbErrorMessage = err instanceof Error ? err.message : String(err);
		}

		const { version, revision } = await getVersionInfo();
		const dbHost = process.env.PGHOST ?? "127.0.0.1";
		const dbName = process.env.PGDATABASE ?? "agenthive";
		const schema = process.env.PG_SCHEMA ?? "roadmap";

		const body: Record<string, unknown> = {
			service: "ok",
			db: dbStatus,
			schema_version: schemaVersion,
			git_revision: revision,
			app_version: version,
			project_root: this.core.filesystem.rootDir,
			db_host: dbHost,
			db_name: dbName,
			schema,
			started_at: this._startedAt.toISOString(),
			mcp_protocol_version: "2024-11-05",
		};
		if (dbErrorMessage !== undefined) {
			body.db_error = dbErrorMessage;
		}

		return Response.json(body, { status: 200 });
	}

	// P446 AC-5: POST /smoke
	private async handleSmoke(): Promise<Response> {
		if (!this.mcpServer) {
			return Response.json(
				{ error: "MCP server not available" },
				{ status: 503 },
			);
		}

		const smokeServer = this.mcpServer as McpServer;
		const t0 = Date.now();
		const steps: Array<{ name: string; elapsed_ms: number; result: "ok" | "error"; detail?: string }> = [];

		const step = async (name: string, payload: unknown) => {
			const stepStart = Date.now();
			try {
				const res = await handleDirectMcpRequest(smokeServer, payload);
				const elapsed_ms = Date.now() - stepStart;
				const isError = res.status >= 400 || ("error" in (res.body as object));
				steps.push({ name, elapsed_ms, result: isError ? "error" : "ok" });
			} catch (err) {
				const elapsed_ms = Date.now() - stepStart;
				const detail = err instanceof Error ? err.message : String(err);
				steps.push({ name, elapsed_ms, result: "error", detail });
			}
		};

		await step("initialize", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
		await step("tools/list", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
		await step("tools/call", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mcp_project", arguments: { action: "list_actions" } } });

		const total_ms = Date.now() - t0;
		const allOk = steps.every((s) => s.result === "ok");
		return Response.json({ steps, total_ms }, { status: allOk ? 200 : 207 });
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
		// P1613: parse limit. Default 100, max 1000 — prior implementation silently
		// dropped the param and always returned the full table (~11MB on prod).
		const DEFAULT_LIMIT = 100;
		const MAX_LIMIT = 1000;
		const limitRaw = url.searchParams.get("limit");
		const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : NaN;
		const limit =
			Number.isFinite(parsedLimit) && parsedLimit > 0
				? Math.min(parsedLimit, MAX_LIMIT)
				: DEFAULT_LIMIT;
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
			limit,
		});

		// P1613 belt-and-suspenders: queryProposals' limit only applies to the
		// search-query path; cap the result here so the list path also respects it.
		return Response.json(proposals.slice(0, limit));
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
			const params: unknown[] = [
				isNumeric ? parseInt(proposalId, 10) : proposalId,
			];
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

	private async handleGetProposalDecisions(
		proposalId: string,
	): Promise<Response> {
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

	private async handleGetProposalReviews(
		proposalId: string,
	): Promise<Response> {
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

		if ("maturity" in updates && typeof updates.maturity === "string") {
			// Live DB CHECK constraint on proposal.maturity accepts exactly 4 values.
			// Reject anything else loudly rather than letting the UPDATE fail at SQL.
			const ALLOWED_MATURITY = new Set([
				"new",
				"active",
				"mature",
				"obsolete",
			]);
			if (!ALLOWED_MATURITY.has(updates.maturity)) {
				return new Response(
					JSON.stringify({
						error: `Invalid maturity '${updates.maturity}'. Allowed: ${Array.from(ALLOWED_MATURITY).join(", ")}`,
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				);
			}
			updateInput.maturity = updates.maturity as ProposalMaturity;
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

	private async handleListAgents(req?: Request): Promise<Response> {
		try {
			// AC-2: when an X-Project-Id header is present, scope the agent
			// listing to that project's registry so the dashboard reflects
			// the operator's selected project. Falls back to core.listAgents()
			// (which serves the default project) when no scope is provided.
			if (req) {
				const scope = await this.resolveProjectScope(req);
				const { rows } = await query<{
					name: string;
					identity: string;
					agent_type: string;
					role: string | null;
					status: string;
					trust_tier: string;
					updated_at: string;
				}>(
					`SELECT agent_identity AS identity,
					        COALESCE(role, agent_identity) AS name,
					        agent_identity AS name_fallback,
					        agent_type, role, status, trust_tier, updated_at
					   FROM roadmap_workforce.agent_registry
					  WHERE project_id = $1
					  ORDER BY agent_identity ASC`,
					[scope.project_id],
				);
				const agents = rows.map((r) => ({
					name: r.identity,
					identity: r.identity,
					agent_type: r.agent_type,
					role: r.role,
					status: r.status,
					trustScore: 0,
					trust_tier: r.trust_tier,
					capabilities: [] as string[],
					lastSeen: r.updated_at,
				}));
				return Response.json(agents);
			}
			const agents = await this.core.listAgents();
			return Response.json(agents);
		} catch (error) {
			console.error("Error listing agents:", error);
			return Response.json({ error: "Failed to list agents" }, { status: 500 });
		}
	}

	// P477 AC-4: stop all running agent_runs rows for an agent.
	// Action name 'agent.stop'. Soft cancel: marks status='cancelled',
	// sets cancelled_by/at/reason. Workers honor this on next heartbeat.
	private async handleStopAgent(
		identity: string,
		req: Request,
	): Promise<Response> {
		let body: { reason?: unknown } = {};
		try {
			body = (await req.json()) as { reason?: unknown };
		} catch {
			/* empty body ok */
		}
		const auth = await requireOperator(req, {
			action: "agent.stop",
			targetKind: "agent",
			targetIdentity: identity,
			requestSummary: {
				reason:
					typeof body.reason === "string" ? body.reason.slice(0, 200) : null,
			},
		});
		if (auth.rejected) return auth.rejected;

		const reason =
			typeof body.reason === "string" && body.reason.trim().length > 0
				? body.reason.trim()
				: null;
		try {
			const { rows: regRows } = await query<{ exists: boolean }>(
				`SELECT EXISTS(SELECT 1 FROM roadmap_workforce.agent_registry WHERE agent_identity=$1) AS exists`,
				[identity],
			);
			if (!regRows[0]?.exists) {
				return Response.json({ error: "Unknown agent" }, { status: 404 });
			}
			const { rows } = await query<{
				id: number;
				status: string;
				stage: string;
			}>(
				`UPDATE roadmap_workforce.agent_runs
				    SET status='cancelled',
				        completed_at = COALESCE(completed_at, now()),
				        cancelled_by = $2,
				        cancelled_at = now(),
				        cancelled_reason = $3
				  WHERE agent_identity = $1
				    AND status = 'running'
				  RETURNING id, status, stage`,
				[identity, auth.outcome.operatorName, reason],
			);
			return Response.json({
				success: true,
				cancelled_count: rows.length,
				cancelled_runs: rows.map((r) => ({ id: r.id, stage: r.stage })),
				operator: auth.outcome.operatorName,
			});
		} catch (err) {
			console.error(`[agent.stop] ${identity}:`, (err as Error).message);
			return Response.json({ error: "Failed to stop agent" }, { status: 500 });
		}
	}

	// P477 AC-4: stop a single cubic. Action 'cubic.stop'. Flips active
	// cubics to 'expired', clears lock_holder/lock_phase, records stop trail.
	private async handleStopCubic(
		cubicId: string,
		req: Request,
	): Promise<Response> {
		let body: { reason?: unknown } = {};
		try {
			body = (await req.json()) as { reason?: unknown };
		} catch {
			/* empty body ok */
		}
		const auth = await requireOperator(req, {
			action: "cubic.stop",
			targetKind: "cubic",
			targetIdentity: cubicId,
			requestSummary: {
				reason:
					typeof body.reason === "string" ? body.reason.slice(0, 200) : null,
			},
		});
		if (auth.rejected) return auth.rejected;

		const reason =
			typeof body.reason === "string" && body.reason.trim().length > 0
				? body.reason.trim()
				: null;
		try {
			const { rows } = await query<{
				cubic_id: string;
				status: string;
				phase: string;
				agent_identity: string | null;
			}>(
				`UPDATE roadmap.cubics
				    SET status         = 'expired',
				        completed_at   = COALESCE(completed_at, now()),
				        lock_holder    = NULL,
				        lock_phase     = NULL,
				        locked_at      = NULL,
				        stopped_by     = $2,
				        stopped_at     = now(),
				        stopped_reason = $3
				  WHERE cubic_id = $1
				    AND status NOT IN ('expired','complete')
				  RETURNING cubic_id, status, phase, agent_identity`,
				[cubicId, auth.outcome.operatorName, reason],
			);
			if (rows.length === 0) {
				const { rows: existsRows } = await query<{ status: string }>(
					`SELECT status FROM roadmap.cubics WHERE cubic_id=$1`,
					[cubicId],
				);
				if (existsRows.length === 0) {
					return Response.json({ error: "Cubic not found" }, { status: 404 });
				}
				return Response.json({
					success: true,
					already_terminal: true,
					status: existsRows[0].status,
				});
			}
			return Response.json({
				success: true,
				cubic_id: rows[0].cubic_id,
				agent_identity: rows[0].agent_identity,
				operator: auth.outcome.operatorName,
			});
		} catch (err) {
			console.error(`[cubic.stop] ${cubicId}:`, (err as Error).message);
			return Response.json({ error: "Failed to stop cubic" }, { status: 500 });
		}
	}

	// P477 AC-4: halt the gate scanner for one proposal.
	// Action 'state-machine.halt'. Sets gate_scanner_paused=true.
	// Scanner / orchestrator must skip paused proposals.
	private async handleHaltProposalGate(
		displayOrNumericId: string,
		req: Request,
	): Promise<Response> {
		let body: { reason?: unknown } = {};
		try {
			body = (await req.json()) as { reason?: unknown };
		} catch {
			/* empty body ok */
		}
		const auth = await requireOperator(req, {
			action: "state-machine.halt",
			targetKind: "proposal",
			targetIdentity: displayOrNumericId,
			requestSummary: {
				reason:
					typeof body.reason === "string" ? body.reason.slice(0, 200) : null,
			},
		});
		if (auth.rejected) return auth.rejected;

		const reason =
			typeof body.reason === "string" && body.reason.trim().length > 0
				? body.reason.trim()
				: null;
		const isNumeric = /^\d+$/.test(displayOrNumericId);
		try {
			const { rows } = await query<{
				id: number;
				display_id: string;
				gate_scanner_paused: boolean;
			}>(
				`UPDATE roadmap_proposal.proposal
				    SET gate_scanner_paused = true,
				        gate_paused_by      = $2,
				        gate_paused_at      = now(),
				        gate_paused_reason  = $3
				  WHERE ${isNumeric ? "id = $1" : "display_id = $1"}
				  RETURNING id, display_id, gate_scanner_paused`,
				[
					isNumeric ? Number(displayOrNumericId) : displayOrNumericId,
					auth.outcome.operatorName,
					reason,
				],
			);
			if (rows.length === 0) {
				return Response.json({ error: "Proposal not found" }, { status: 404 });
			}
			return Response.json({
				success: true,
				proposal_id: rows[0].display_id,
				gate_scanner_paused: rows[0].gate_scanner_paused,
				operator: auth.outcome.operatorName,
			});
		} catch (err) {
			console.error(
				`[state-machine.halt] ${displayOrNumericId}:`,
				(err as Error).message,
			);
			return Response.json(
				{ error: "Failed to halt gate scanner" },
				{ status: 500 },
			);
		}
	}

	// P477 AC-4: resume the gate scanner for one proposal. Same gate as halt
	// but separate action so a narrower operator can be granted halt-only or
	// resume-only.
	private async handleResumeProposalGate(
		displayOrNumericId: string,
		req: Request,
	): Promise<Response> {
		const auth = await requireOperator(req, {
			action: "state-machine.resume",
			targetKind: "proposal",
			targetIdentity: displayOrNumericId,
		});
		if (auth.rejected) return auth.rejected;

		const isNumeric = /^\d+$/.test(displayOrNumericId);
		try {
			const { rows } = await query<{
				id: number;
				display_id: string;
				gate_scanner_paused: boolean;
			}>(
				`UPDATE roadmap_proposal.proposal
				    SET gate_scanner_paused = false,
				        gate_paused_by      = NULL,
				        gate_paused_at      = NULL,
				        gate_paused_reason  = NULL
				  WHERE ${isNumeric ? "id = $1" : "display_id = $1"}
				  RETURNING id, display_id, gate_scanner_paused`,
				[isNumeric ? Number(displayOrNumericId) : displayOrNumericId],
			);
			if (rows.length === 0) {
				return Response.json({ error: "Proposal not found" }, { status: 404 });
			}
			return Response.json({
				success: true,
				proposal_id: rows[0].display_id,
				gate_scanner_paused: rows[0].gate_scanner_paused,
				operator: auth.outcome.operatorName,
			});
		} catch (err) {
			console.error(
				`[state-machine.resume] ${displayOrNumericId}:`,
				(err as Error).message,
			);
			return Response.json(
				{ error: "Failed to resume gate scanner" },
				{ status: 500 },
			);
		}
	}

	// P477 AC-7: list audit log (operator-only, action='audit.read').
	private async handleOperatorAudit(req: Request): Promise<Response> {
		const auth = await requireOperator(req, { action: "audit.read" });
		if (auth.rejected) return auth.rejected;
		try {
			const url = new URL(req.url);
			const limit = Math.min(
				Math.max(
					Number.parseInt(url.searchParams.get("limit") ?? "100", 10) || 100,
					1,
				),
				500,
			);
			const { rows } = await query(
				`SELECT id, occurred_at, operator_name, action, decision,
				        target_kind, target_identity, request_summary,
				        remote_addr, response_status, failure_reason
				   FROM roadmap.operator_audit_log
				  ORDER BY occurred_at DESC
				  LIMIT $1`,
				[limit],
			);
			return Response.json({ entries: rows });
		} catch (err) {
			console.error("[operator-audit] read failed:", (err as Error).message);
			return Response.json({ error: "audit read failed" }, { status: 500 });
		}
	}

	// P477 AC-7: issue a new operator token. The plaintext is returned
	// exactly once; only its sha256 hash is persisted. Locked behind
	// requireOperator(action='token.issue') so existing operators
	// can rotate / add new ones, and the first one is bootstrapped via
	// scripts/operator-token.ts (which talks straight to pg).
	private async handleIssueOperatorToken(req: Request): Promise<Response> {
		const auth = await requireOperator(req, { action: "token.issue" });
		if (auth.rejected) return auth.rejected;
		try {
			const body = await req.json();
			const operatorName =
				typeof body.operator_name === "string" &&
				body.operator_name.trim().length > 0
					? body.operator_name.trim()
					: null;
			if (!operatorName) {
				return Response.json(
					{ error: "operator_name is required" },
					{ status: 400 },
				);
			}
			const allowedActions =
				Array.isArray(body.allowed_actions) &&
				body.allowed_actions.every((s: unknown) => typeof s === "string")
					? (body.allowed_actions as string[])
					: ["*"];
			const expiresAt =
				typeof body.expires_at === "string" && body.expires_at.length > 0
					? body.expires_at
					: null;
			const notes = typeof body.notes === "string" ? body.notes : null;

			// Strong random token. crypto.randomUUID is fine; we hash + store.
			const raw = `op_${crypto.randomUUID().replace(/-/g, "")}${crypto
				.randomUUID()
				.replace(/-/g, "")}`;
			const sha = hashOperatorToken(raw);

			const { rows } = await query<{ id: number }>(
				`INSERT INTO roadmap.operator_token
				   (operator_name, token_sha256, allowed_actions, expires_at, notes)
				 VALUES ($1, $2, $3, $4, $5)
				 RETURNING id`,
				[operatorName, sha, allowedActions, expiresAt, notes],
			);
			return Response.json({
				id: rows[0]?.id,
				operator_name: operatorName,
				allowed_actions: allowedActions,
				expires_at: expiresAt,
				token: raw,
				note: "This is the only time the plaintext token is shown. Store it securely.",
			});
		} catch (err) {
			console.error("[operator-token] issue failed:", (err as Error).message);
			return Response.json({ error: "token issue failed" }, { status: 500 });
		}
	}

	// P477 AC-7: list configured tokens (no plaintext, no hash).
	private async handleListOperatorTokens(req: Request): Promise<Response> {
		const auth = await requireOperator(req, { action: "token.list" });
		if (auth.rejected) return auth.rejected;
		try {
			const { rows } = await query(
				`SELECT id, operator_name, allowed_actions, expires_at, revoked_at,
				        created_at, last_used_at, notes
				   FROM roadmap.operator_token
				  ORDER BY id ASC`,
			);
			return Response.json({ tokens: rows });
		} catch (err) {
			console.error("[operator-token] list failed:", (err as Error).message);
			return Response.json({ error: "token list failed" }, { status: 500 });
		}
	}

	// P477 AC-2: list active projects so the UI can show a switcher.
	// Read-only, unauthenticated (parity with /api/agents). Operators see
	// every active project; archived ones are hidden by default.
	private async handleListProjects(): Promise<Response> {
		try {
			const { rows } = await query<{
				project_id: number;
				slug: string;
				name: string;
				worktree_root: string;
				bootstrap_status: string;
				host: string;
				port: number;
				db_name: string | null;
			}>(
				`SELECT project_id, slug, name, worktree_root,
				        bootstrap_status, host, port, db_name
				   FROM roadmap.project
				  WHERE status = 'active'
				  ORDER BY project_id ASC`,
			);
			return Response.json({
				projects: rows,
				default_project_id: rows[0]?.project_id ?? null,
			});
		} catch (err) {
			console.error("[projects] list failed:", (err as Error).message);
			return Response.json(
				{ error: "Failed to list projects" },
				{ status: 500 },
			);
		}
	}

	// P477 AC-2: resolve the operator's chosen project for a request.
	// Reads X-Project-Id header (or ?project_id=NN query param). Validates
	// against the project table — invalid values fall back to project_id=1
	// so the UI can never lock itself out by sending garbage. Returns the
	// resolved id along with metadata used to render the active-scope chip.
	private async resolveProjectScope(
		req: Request,
	): Promise<{
		project_id: number;
		project_slug: string;
		project_name: string;
	}> {
		const url = new URL(req.url);
		const headerVal = req.headers.get("x-project-id") ?? "";
		const queryVal = url.searchParams.get("project_id") ?? "";
		const requested = headerVal.trim() || queryVal.trim();
		const requestedNum =
			requested && /^\d+$/.test(requested) ? Number(requested) : null;

		const { rows } = await query<{
			project_id: number;
			slug: string;
			name: string;
		}>(
			`SELECT project_id, slug, name FROM roadmap.project
			  WHERE status = 'active'
			    AND ($1::bigint IS NULL OR project_id = $1::bigint)
			  ORDER BY project_id ASC LIMIT 1`,
			[requestedNum],
		);
		const r = rows[0];
		if (r) {
			return {
				project_id: r.project_id,
				project_slug: r.slug,
				project_name: r.name,
			};
		}
		// Fallback: no row matched (e.g. archived project requested) — use first active.
		const { rows: defaultRows } = await query<{
			project_id: number;
			slug: string;
			name: string;
		}>(
			`SELECT project_id, slug, name FROM roadmap.project
			  WHERE status = 'active' ORDER BY project_id ASC LIMIT 1`,
		);
		const d = defaultRows[0];
		return {
			project_id: d?.project_id ?? 1,
			project_slug: d?.slug ?? "agenthive",
			project_name: d?.name ?? "AgentHive",
		};
	}

	// P477 AC-3: live operations overview — single round-trip aggregate
	// covering workforce, active cubics, route health, messaging traffic,
	// and recent system activity. Polled by the dashboard panel; stays
	// cheap by gathering everything in one query and bounding result rows.
	// AC-2: scoped to the operator-selected project. The aggregate adds a
	// `project` echo so the UI can verify which scope rendered the data.
	// P238: extend the same payload with state-machine authoritative views
	// sourced from proposal/dispatch/lease/gate/route tables rather than
	// transition_queue or other gate-pipeline compatibility rows.
	private async handleControlPlaneOverview(req: Request): Promise<Response> {
		try {
			const scope = await this.resolveProjectScope(req);
			const { rows } = await query<{ overview: Record<string, unknown> }>(
				`
				WITH
				project_agents AS (
				  SELECT agent_identity FROM roadmap_workforce.agent_registry
				   WHERE project_id = $1
				),
				workforce AS (
				  SELECT
				    COUNT(*) FILTER (WHERE h.status = 'healthy')   AS healthy,
				    COUNT(*) FILTER (WHERE h.status = 'stale')     AS stale,
				    COUNT(*) FILTER (WHERE h.status = 'offline')   AS offline,
				    COUNT(*) FILTER (WHERE h.status = 'crashed')   AS crashed,
				    COUNT(*) AS total
				  FROM roadmap_workforce.agent_health h
				  WHERE h.agent_identity IN (SELECT agent_identity FROM project_agents)
				),
				busy_agents AS (
				  SELECT jsonb_agg(jsonb_build_object(
				           'agent_identity', agent_identity,
				           'status', status,
				           'current_task', current_task,
				           'current_proposal', current_proposal,
				           'current_cubic', current_cubic,
				           'active_model', active_model,
				           'last_heartbeat_at', last_heartbeat_at
				         ) ORDER BY last_heartbeat_at DESC) AS rows
				  FROM (
				    SELECT h.* FROM roadmap_workforce.agent_health h
				     WHERE h.agent_identity IN (SELECT agent_identity FROM project_agents)
				       AND (h.current_task IS NOT NULL OR h.status IN ('healthy','stale'))
				     ORDER BY h.last_heartbeat_at DESC
				     LIMIT 12
				  ) hb
				),
				cubic_summary AS (
				  SELECT
				    COUNT(*) FILTER (WHERE status = 'active')   AS active,
				    COUNT(*) FILTER (WHERE status = 'idle')     AS idle,
				    COUNT(*) FILTER (WHERE status = 'expired')  AS expired,
				    COUNT(*) FILTER (WHERE status = 'complete') AS complete,
				    COUNT(*) AS total
				  FROM roadmap.cubics
				  WHERE project_id = $1
				),
				active_cubics AS (
				  SELECT jsonb_agg(jsonb_build_object(
				           'cubic_id', cubic_id,
				           'phase', phase,
				           'status', status,
				           'agent_identity', agent_identity,
				           'budget_usd', budget_usd,
				           'lock_holder', lock_holder,
				           'activated_at', activated_at
				         ) ORDER BY activated_at DESC NULLS LAST) AS rows
				  FROM (
				    SELECT * FROM roadmap.cubics
				     WHERE project_id = $1
				       AND status NOT IN ('expired','complete')
				     ORDER BY activated_at DESC NULLS LAST
				     LIMIT 15
				  ) c
				),
				route_health AS (
				  SELECT jsonb_agg(jsonb_build_object(
				           'model_name', model_name,
				           'route_provider', route_provider,
				           'agent_provider', agent_provider,
				           'agent_cli', agent_cli,
				           'is_enabled', is_enabled,
				           'priority', priority,
				           'tier', tier
				         ) ORDER BY tier NULLS LAST, priority ASC) AS rows
				  FROM roadmap.model_routes
				),
				message_metrics AS (
				  SELECT
				    COUNT(*) FILTER (WHERE created_at > now() - interval '5 minutes')  AS last_5m,
				    COUNT(*) FILTER (WHERE created_at > now() - interval '1 hour')     AS last_1h,
				    COUNT(*) FILTER (WHERE created_at > now() - interval '24 hours')   AS last_24h,
				    COUNT(*) FILTER (WHERE channel = 'direct'    AND created_at > now() - interval '1 hour') AS direct_1h,
				    COUNT(*) FILTER (WHERE channel = 'broadcast' AND created_at > now() - interval '1 hour') AS broadcast_1h,
				    COUNT(*) FILTER (WHERE channel LIKE 'team:%' AND created_at > now() - interval '1 hour') AS team_1h
				  FROM roadmap.message_ledger
				  WHERE project_id = $1
				),
				recent_runs AS (
				  SELECT jsonb_agg(jsonb_build_object(
				           'id', id,
				           'agent_identity', agent_identity,
				           'proposal_display_id', display_id,
				           'stage', stage,
				           'status', status,
				           'model_used', model_used,
				           'started_at', started_at,
				           'completed_at', completed_at,
				           'duration_ms', duration_ms,
				           'cost_usd', cost_usd
				         ) ORDER BY started_at DESC) AS rows
				  FROM (
				    SELECT r.* FROM roadmap_workforce.agent_runs r
				     WHERE r.agent_identity IN (SELECT agent_identity FROM project_agents)
				     ORDER BY r.started_at DESC
				     LIMIT 15
				  ) r
				),
				project_proposals AS (
				  SELECT p.id,
				         p.display_id,
				         p.title,
				         p.type,
				         p.status,
				         p.maturity,
				         p.priority,
				         p.workflow_name,
				         p.created_at,
				         p.modified_at
				    FROM roadmap_proposal.proposal p
				   WHERE p.project_id = $1
				),
				queue_pools AS (
				  SELECT jsonb_agg(jsonb_build_object(
				           'project_slug', $2::text,
				           'workflow_name', workflow_name,
				           'stage', status,
				           'maturity', maturity,
				           'proposal_count', proposal_count,
				           'oldest_created_at', oldest_created_at,
				           'oldest_updated_at', oldest_updated_at
				         )
				         ORDER BY workflow_name, status, maturity) AS rows
				    FROM (
				      SELECT workflow_name,
				             status,
				             maturity,
				             COUNT(*) AS proposal_count,
				             MIN(created_at) AS oldest_created_at,
				             MIN(modified_at) AS oldest_updated_at
				        FROM project_proposals
				       GROUP BY workflow_name, status, maturity
				    ) qp
				),
				project_capacity AS (
				  SELECT COUNT(*) FILTER (
				           WHERE pr.status IN ('active', 'throttled', 'dormant')
				             AND COALESCE(inf.in_flight_count, 0) < pr.max_in_flight
				         ) AS available_agencies
				    FROM roadmap_workforce.provider_registry pr
				    JOIN roadmap_workforce.agent_registry ar
				      ON ar.id = pr.agency_id
				    LEFT JOIN roadmap.agency a
				      ON a.agency_id = ar.agent_identity
				    LEFT JOIN roadmap_workforce.v_agency_in_flight inf
				      ON inf.provider_registry_id = pr.id
				   WHERE (pr.project_id IS NULL OR pr.project_id = $1)
				     AND pr.status NOT IN ('offline', 'retired')
				     AND (a.status IS NULL OR a.status <> 'retired')
				     AND ar.agent_type <> 'coordinator'
				),
				candidate_ranking AS (
				  SELECT jsonb_agg(jsonb_build_object(
				           'display_id', display_id,
				           'title', title,
				           'workflow_name', workflow_name,
				           'stage', status,
				           'maturity', maturity,
				           'priority', priority,
				           'dependency_blockers', dependency_blockers,
				           'stale_lease_boost', stale_lease_boost,
				           'capacity_blocked', capacity_blocked,
				           'active_dispatches', active_dispatches,
				           'last_transition_at', last_transition_at
				         )
				         ORDER BY rank_score DESC, dependency_blockers ASC, modified_at ASC) AS rows
				    FROM (
				      SELECT p.display_id,
				             p.title,
				             p.workflow_name,
				             p.status,
				             p.maturity,
				             COALESCE(NULLIF(p.priority, ''), 'medium') AS priority,
				             COALESCE(dep.dependency_blockers, 0) AS dependency_blockers,
				             COALESCE(lease.stale_lease_boost, 0) AS stale_lease_boost,
				             (SELECT available_agencies = 0 FROM project_capacity) AS capacity_blocked,
				             COALESCE(dispatch.active_dispatches, 0) AS active_dispatches,
				             transition.last_transition_at,
				             p.modified_at,
				             (
				               CASE lower(COALESCE(p.priority, ''))
				                 WHEN 'critical' THEN 40
				                 WHEN 'high' THEN 28
				                 WHEN 'medium' THEN 18
				                 WHEN 'low' THEN 10
				                 ELSE 12
				               END
				               + CASE lower(p.maturity)
				                   WHEN 'mature' THEN 16
				                   WHEN 'active' THEN 9
				                   WHEN 'new' THEN 4
				                   ELSE 0
				                 END
				               + COALESCE(lease.stale_lease_boost, 0) * 7
				               - COALESCE(dep.dependency_blockers, 0) * 11
				               - COALESCE(dispatch.active_dispatches, 0) * 3
				             ) AS rank_score
				        FROM project_proposals p
				        LEFT JOIN LATERAL (
				          SELECT COUNT(*) FILTER (
				                   WHERE lower(COALESCE(dep.status, '')) NOT IN ('complete', 'closed')
				                     AND lower(COALESCE(dep.maturity, '')) <> 'obsolete'
				                 ) AS dependency_blockers
				            FROM roadmap_proposal.proposal_dependencies pd
				            LEFT JOIN roadmap_proposal.proposal dep
				              ON dep.id = pd.to_proposal_id
				           WHERE pd.from_proposal_id = p.id
				        ) dep ON true
				        LEFT JOIN LATERAL (
				          SELECT CASE
				                   WHEN COUNT(*) FILTER (
				                     WHERE pl.released_at IS NULL
				                       AND pl.expires_at IS NOT NULL
				                       AND pl.expires_at < now()
				                   ) > 0 THEN 2
				                   WHEN COUNT(*) FILTER (
				                     WHERE pl.release_reason ILIKE '%expired%'
				                       AND pl.released_at > now() - interval '7 days'
				                   ) > 0 THEN 1
				                   ELSE 0
				                 END AS stale_lease_boost
				            FROM roadmap_proposal.proposal_lease pl
				           WHERE pl.proposal_id = p.id
				        ) lease ON true
				        LEFT JOIN LATERAL (
				          SELECT COUNT(*) FILTER (
				                   WHERE lower(sd.dispatch_status) IN ('assigned', 'active', 'blocked')
				                 ) AS active_dispatches
				            FROM roadmap_workforce.squad_dispatch sd
				           WHERE sd.proposal_id = p.id
				             AND sd.project_id = $1
				        ) dispatch ON true
				        LEFT JOIN LATERAL (
				          SELECT MAX(pst.transitioned_at) AS last_transition_at
				            FROM roadmap_proposal.proposal_state_transitions pst
				           WHERE pst.proposal_id = p.id
				        ) transition ON true
				       WHERE lower(p.status) NOT IN ('complete', 'closed')
				         AND lower(p.maturity) <> 'obsolete'
				       ORDER BY rank_score DESC, COALESCE(dep.dependency_blockers, 0) ASC, p.modified_at ASC
				       LIMIT 12
				    ) ranked
				),
				dispatch_lifecycle_counts AS (
				  SELECT jsonb_build_object(
				           'posted', COUNT(*) FILTER (
				             WHERE lower(COALESCE(offer_status, '')) = 'open'
				           ),
				           'claimed', COUNT(*) FILTER (
				             WHERE lower(COALESCE(offer_status, '')) = 'claimed'
				           ),
				           'running', COUNT(*) FILTER (
				             WHERE lower(dispatch_status) = 'active'
				           ),
				           'completed', COUNT(*) FILTER (
				             WHERE lower(dispatch_status) = 'completed'
				           ),
				           'failed', COUNT(*) FILTER (
				             WHERE lower(COALESCE(offer_status, '')) = 'failed'
				           ),
				           'throttled', COUNT(*) FILTER (
				             WHERE lower(COALESCE(offer_status, '')) = 'throttled'
				           ),
				           'cancelled', COUNT(*) FILTER (
				             WHERE lower(dispatch_status) = 'cancelled'
				                OR lower(COALESCE(offer_status, '')) = 'cancelled'
				           ),
				           'expired', COUNT(*) FILTER (
				             WHERE lower(COALESCE(offer_status, '')) = 'expired'
				                OR (
				                  claim_expires_at IS NOT NULL
				                  AND claim_expires_at < now()
				                  AND lower(COALESCE(dispatch_status, '')) NOT IN ('completed', 'cancelled')
				                )
				           )
				         ) AS counts
				    FROM roadmap_workforce.squad_dispatch
				   WHERE project_id = $1
				),
				recent_dispatches AS (
				  SELECT jsonb_agg(jsonb_build_object(
				           'id', id,
				           'proposal_display_id', proposal_display_id,
				           'proposal_title', proposal_title,
				           'dispatch_role', dispatch_role,
				           'dispatch_status', dispatch_status,
				           'offer_status', offer_status,
				           'agent_identity', agent_identity,
				           'worker_identity', worker_identity,
				           'assigned_at', assigned_at,
				           'claim_expires_at', claim_expires_at
				         ) ORDER BY assigned_at DESC NULLS LAST, id DESC) AS rows
				    FROM (
				      SELECT d.id,
				             p.display_id AS proposal_display_id,
				             p.title AS proposal_title,
				             d.dispatch_role,
				             d.dispatch_status,
				             d.offer_status,
				             d.agent_identity,
				             d.worker_identity,
				             d.assigned_at,
				             d.claim_expires_at
				        FROM roadmap_workforce.squad_dispatch d
				        LEFT JOIN roadmap_proposal.proposal p
				          ON p.id = d.proposal_id
				       WHERE d.project_id = $1
				       ORDER BY d.assigned_at DESC NULLS LAST, d.id DESC
				       LIMIT 12
				    ) rd
				),
				lease_recovery_summary AS (
				  SELECT jsonb_build_object(
				           'active', COUNT(*) FILTER (
				             WHERE pl.released_at IS NULL
				               AND (pl.expires_at IS NULL OR pl.expires_at >= now())
				           ),
				           'expired', COUNT(*) FILTER (
				             WHERE pl.released_at IS NULL
				               AND pl.expires_at IS NOT NULL
				               AND pl.expires_at < now()
				           ),
				           'recovered_workspaces', (
				             SELECT COUNT(*)
				               FROM roadmap.cubics c
				              WHERE c.project_id = $1
				                AND c.status = 'expired'
				           )
				         ) AS summary
				    FROM roadmap_proposal.proposal_lease pl
				    JOIN project_proposals p
				      ON p.id = pl.proposal_id
				),
				recent_expired_leases AS (
				  SELECT jsonb_agg(jsonb_build_object(
				           'display_id', display_id,
				           'title', title,
				           'agent_identity', agent_identity,
				           'claimed_at', claimed_at,
				           'expires_at', expires_at,
				           'release_reason', release_reason
				         ) ORDER BY expires_at DESC NULLS LAST, claimed_at DESC) AS rows
				    FROM (
				      SELECT p.display_id,
				             p.title,
				             pl.agent_identity,
				             pl.claimed_at,
				             pl.expires_at,
				             pl.release_reason
				        FROM roadmap_proposal.proposal_lease pl
				        JOIN project_proposals p
				          ON p.id = pl.proposal_id
				       WHERE (pl.released_at IS NULL AND pl.expires_at IS NOT NULL AND pl.expires_at < now())
				          OR (pl.release_reason ILIKE '%expired%' AND pl.released_at > now() - interval '7 days')
				       ORDER BY COALESCE(pl.expires_at, pl.released_at) DESC NULLS LAST
				       LIMIT 10
				    ) rel
				),
				liaison_agencies AS (
				  SELECT jsonb_agg(jsonb_build_object(
				           'agency_identity', agency_identity,
				           'status', status,
				           'last_seen_at', last_seen_at,
				           'max_in_flight', max_in_flight,
				           'in_flight_count', in_flight_count,
				           'throttle_count', throttle_count,
				           'recent_failure_count', recent_failure_count,
				           'session_started_at', session_started_at,
				           'liaison_host', liaison_host,
				           'liaison_pid', liaison_pid
				         ) ORDER BY last_seen_at DESC NULLS LAST, agency_identity) AS rows
				    FROM (
				      SELECT ar.agent_identity AS agency_identity,
				             pr.status,
				             pr.last_seen_at,
				             pr.max_in_flight,
				             COALESCE(inf.in_flight_count, 0) AS in_flight_count,
				             pr.throttle_count,
				             pr.recent_failure_count,
				             sess.started_at AS session_started_at,
				             sess.liaison_host,
				             sess.liaison_pid
				        FROM roadmap_workforce.provider_registry pr
				        JOIN roadmap_workforce.agent_registry ar
				          ON ar.id = pr.agency_id
				        LEFT JOIN roadmap_workforce.v_agency_in_flight inf
				          ON inf.provider_registry_id = pr.id
				        LEFT JOIN LATERAL (
				          SELECT als.started_at,
				                 als.liaison_host,
				                 als.liaison_pid
				            FROM roadmap.agency_liaison_session als
				           WHERE als.agency_id = ar.agent_identity
				             AND als.ended_at IS NULL
				           ORDER BY als.started_at DESC
				           LIMIT 1
				        ) sess ON true
				       WHERE (pr.project_id IS NULL OR pr.project_id = $1)
				       ORDER BY pr.last_seen_at DESC NULLS LAST, ar.agent_identity
				       LIMIT 12
				    ) la
				),
				liaison_summary AS (
				  SELECT jsonb_build_object(
				           'active', COUNT(*) FILTER (WHERE pr.status = 'active'),
				           'throttled', COUNT(*) FILTER (WHERE pr.status = 'throttled'),
				           'dormant', COUNT(*) FILTER (WHERE pr.status = 'dormant'),
				           'offline', COUNT(*) FILTER (WHERE pr.status = 'offline'),
				           'retired', COUNT(*) FILTER (WHERE pr.status = 'retired'),
				           'sessions', COUNT(*) FILTER (WHERE als.ended_at IS NULL)
				         ) AS summary
				    FROM roadmap_workforce.provider_registry pr
				    JOIN roadmap_workforce.agent_registry ar
				      ON ar.id = pr.agency_id
				    LEFT JOIN roadmap.agency_liaison_session als
				      ON als.agency_id = ar.agent_identity
				     AND als.ended_at IS NULL
				   WHERE (pr.project_id IS NULL OR pr.project_id = $1)
				),
				gate_decision_counts AS (
				  SELECT jsonb_build_object(
				           'advance', COUNT(*) FILTER (WHERE decision = 'advance'),
				           'hold', COUNT(*) FILTER (WHERE decision = 'hold'),
				           'reject', COUNT(*) FILTER (WHERE decision = 'reject'),
				           'waive', COUNT(*) FILTER (WHERE decision = 'waive'),
				           'escalate', COUNT(*) FILTER (WHERE decision = 'escalate')
				         ) AS counts
				    FROM roadmap_proposal.gate_decision_log g
				    JOIN project_proposals p
				      ON p.id = g.proposal_id
				   WHERE g.created_at > now() - interval '24 hours'
				),
				recent_gate_decisions AS (
				  SELECT jsonb_agg(jsonb_build_object(
				           'display_id', display_id,
				           'title', title,
				           'from_state', from_state,
				           'to_state', to_state,
				           'maturity', maturity,
				           'decision', decision,
				           'decided_by', decided_by,
				           'created_at', created_at
				         ) ORDER BY created_at DESC) AS rows
				    FROM (
				      SELECT p.display_id,
				             p.title,
				             g.from_state,
				             g.to_state,
				             g.maturity,
				             g.decision,
				             g.decided_by,
				             g.created_at
				        FROM roadmap_proposal.gate_decision_log g
				        JOIN project_proposals p
				          ON p.id = g.proposal_id
				       ORDER BY g.created_at DESC
				       LIMIT 10
				    ) rgd
				),
				recent_transitions AS (
				  SELECT jsonb_agg(jsonb_build_object(
				           'display_id', display_id,
				           'title', title,
				           'from_state', from_state,
				           'to_state', to_state,
				           'transition_reason', transition_reason,
				           'transitioned_by', transitioned_by,
				           'transitioned_at', transitioned_at
				         ) ORDER BY transitioned_at DESC) AS rows
				    FROM (
				      SELECT p.display_id,
				             p.title,
				             pst.from_state,
				             pst.to_state,
				             pst.transition_reason,
				             pst.transitioned_by,
				             pst.transitioned_at
				        FROM roadmap_proposal.proposal_state_transitions pst
				        JOIN project_proposals p
				          ON p.id = pst.proposal_id
				       ORDER BY pst.transitioned_at DESC
				       LIMIT 10
				    ) rt
				),
				recent_route_decisions AS (
				  SELECT jsonb_agg(jsonb_build_object(
				           'display_id', display_id,
				           'role', role,
				           'agency_identity', agency_identity,
				           'chosen_route', chosen_route,
				           'eliminated_count', eliminated_count,
				           'decided_at', decided_at
				         ) ORDER BY decided_at DESC) AS rows
				    FROM (
				      SELECT p.display_id,
				             rdl.role,
				             rdl.agency_identity,
				             COALESCE(mr.model_name, CONCAT('route#', rdl.chosen_route_id::text)) AS chosen_route,
				             jsonb_array_length(COALESCE(rdl.eliminated_routes, '[]'::jsonb)) AS eliminated_count,
				             rdl.decided_at
				        FROM roadmap.route_decision_log rdl
				        LEFT JOIN roadmap_proposal.proposal p
				          ON p.id = rdl.proposal_id
				        LEFT JOIN roadmap.model_routes mr
				          ON mr.id = rdl.chosen_route_id
				       WHERE rdl.proposal_id IN (SELECT id FROM project_proposals)
				          OR rdl.agency_identity IN (
				            SELECT agent_identity FROM roadmap_workforce.agent_registry WHERE project_id = $1
				          )
				       ORDER BY rdl.decided_at DESC
				       LIMIT 10
				    ) rrd
				),
				budget_counters AS (
				  SELECT jsonb_build_object(
				           'tracked_principals', COUNT(*),
				           'total_budget_cents', COALESCE(SUM(max_usd_cents), 0),
				           'total_spent_cents', COALESCE(SUM(current_spent_usd_cents), 0),
				           'over_budget_principals', COUNT(*) FILTER (
				             WHERE current_spent_usd_cents > max_usd_cents
				           )
				         ) AS summary
				    FROM roadmap.principal_spending_cap
				   WHERE project_id IN ($1::text, $2::text)
				),
				dispatch_budget_decisions AS (
				  SELECT jsonb_build_object(
				           'approved', COUNT(*) FILTER (WHERE budget_decision = 'approved'),
				           'rejected', COUNT(*) FILTER (WHERE budget_decision = 'rejected'),
				           'deny_budget', COUNT(*) FILTER (WHERE decision = 'deny_budget'),
				           'deny_compliance', COUNT(*) FILTER (WHERE decision = 'deny_compliance')
				         ) AS counts
				    FROM roadmap.dispatch_route_audit
				   WHERE project_id = $1
				     AND decided_at > now() - interval '24 hours'
				)
				SELECT jsonb_build_object(
				  'generated_at', now(),
				  'project', jsonb_build_object(
				    'project_id', $1::bigint,
				    'slug', $2::text,
				    'name', $3::text
				  ),
				  'workforce', (SELECT to_jsonb(w) FROM workforce w),
				  'busy_agents', COALESCE((SELECT rows FROM busy_agents), '[]'::jsonb),
				  'cubics_summary', (SELECT to_jsonb(c) FROM cubic_summary c),
				  'active_cubics', COALESCE((SELECT rows FROM active_cubics), '[]'::jsonb),
				  'queue_pools', COALESCE((SELECT rows FROM queue_pools), '[]'::jsonb),
				  'candidate_ranking', COALESCE((SELECT rows FROM candidate_ranking), '[]'::jsonb),
				  'dispatch_lifecycle', jsonb_build_object(
				    'status_counts', COALESCE((SELECT counts FROM dispatch_lifecycle_counts), '{}'::jsonb),
				    'recent_dispatches', COALESCE((SELECT rows FROM recent_dispatches), '[]'::jsonb)
				  ),
				  'lease_recovery', jsonb_build_object(
				    'summary', COALESCE((SELECT summary FROM lease_recovery_summary), '{}'::jsonb),
				    'recent_expired', COALESCE((SELECT rows FROM recent_expired_leases), '[]'::jsonb)
				  ),
				  'liaison_health', jsonb_build_object(
				    'summary', COALESCE((SELECT summary FROM liaison_summary), '{}'::jsonb),
				    'agencies', COALESCE((SELECT rows FROM liaison_agencies), '[]'::jsonb)
				  ),
				  'gate_audit', jsonb_build_object(
				    'decision_counts', COALESCE((SELECT counts FROM gate_decision_counts), '{}'::jsonb),
				    'recent_decisions', COALESCE((SELECT rows FROM recent_gate_decisions), '[]'::jsonb),
				    'recent_transitions', COALESCE((SELECT rows FROM recent_transitions), '[]'::jsonb)
				  ),
				  'route_budget_audit', jsonb_build_object(
				    'recent_route_decisions', COALESCE((SELECT rows FROM recent_route_decisions), '[]'::jsonb),
				    'budget_counters', COALESCE((SELECT summary FROM budget_counters), '{}'::jsonb),
				    'budget_decisions', COALESCE((SELECT counts FROM dispatch_budget_decisions), '{}'::jsonb)
				  ),
				  'routes', COALESCE((SELECT rows FROM route_health), '[]'::jsonb),
				  'messages', (SELECT to_jsonb(m) FROM message_metrics m),
				  'recent_runs', COALESCE((SELECT rows FROM recent_runs), '[]'::jsonb)
				) AS overview
				`,
				[scope.project_id, scope.project_slug, scope.project_name],
			);
			return Response.json(rows[0]?.overview ?? {});
		} catch (error) {
			console.error("Error loading control-plane overview:", error);
			return Response.json(
				{ error: "Failed to load control-plane overview" },
				{ status: 500 },
			);
		}
	}

	// P477 AC-5: per-agent detail bundle.
	// One round-trip: registry row, latest health snapshot, recent
	// heartbeats, recent agent_runs (current work + recent output),
	// and recent messages from/to the agent.
	// AC-2: enforces project scope — if the agent belongs to a different
	// project than the caller's scope, returns 404 (not "you can't see
	// this", just "not in this project").
	private async handleGetAgentDetail(
		identity: string,
		req?: Request,
	): Promise<Response> {
		try {
			if (req) {
				const scope = await this.resolveProjectScope(req);
				const { rows: scopeRows } = await query<{ in_scope: boolean }>(
					`SELECT EXISTS(
					   SELECT 1 FROM roadmap_workforce.agent_registry
					    WHERE agent_identity = $1 AND project_id = $2
					 ) AS in_scope`,
					[identity, scope.project_id],
				);
				if (!scopeRows[0]?.in_scope) {
					return Response.json(
						{
							error: "Agent not found in current project scope",
							project_id: scope.project_id,
							project_slug: scope.project_slug,
						},
						{ status: 404 },
					);
				}
			}
			const { rows } = await query<{
				registry: Record<string, unknown> | null;
				health: Record<string, unknown> | null;
				heartbeats: Array<Record<string, unknown>> | null;
				runs: Array<Record<string, unknown>> | null;
				messages: Array<Record<string, unknown>> | null;
			}>(
				`
				SELECT
				  (SELECT to_jsonb(r) - 'public_key' - 'api_spec'
				     FROM (SELECT *
				             FROM roadmap_workforce.agent_registry
				            WHERE agent_identity = $1) r) AS registry,
				  (SELECT to_jsonb(h)
				     FROM roadmap_workforce.agent_health h
				    WHERE h.agent_identity = $1) AS health,
				  (SELECT COALESCE(jsonb_agg(jsonb_build_object(
				            'heartbeat_at', heartbeat_at,
				            'cpu_percent', cpu_percent,
				            'memory_mb', memory_mb,
				            'active_model', active_model,
				            'current_task', current_task
				          ) ORDER BY heartbeat_at DESC), '[]'::jsonb)
				     FROM (SELECT *
				             FROM roadmap_workforce.agent_heartbeat_log
				            WHERE agent_identity = $1
				            ORDER BY heartbeat_at DESC
				            LIMIT 20) hb) AS heartbeats,
				  (SELECT COALESCE(jsonb_agg(jsonb_build_object(
				            'id', id,
				            'proposal_display_id', display_id,
				            'stage', stage,
				            'model_used', model_used,
				            'status', status,
				            'activity', activity,
				            'output_summary', output_summary,
				            'tokens_in', tokens_in,
				            'tokens_out', tokens_out,
				            'cost_usd', cost_usd,
				            'duration_ms', duration_ms,
				            'started_at', started_at,
				            'completed_at', completed_at,
				            'error_detail', error_detail
				          ) ORDER BY started_at DESC), '[]'::jsonb)
				     FROM (SELECT *
				             FROM roadmap_workforce.agent_runs
				            WHERE agent_identity = $1
				            ORDER BY started_at DESC
				            LIMIT 25) r) AS runs,
				  (SELECT COALESCE(jsonb_agg(jsonb_build_object(
				            'id', id,
				            'from_agent', from_agent,
				            'to_agent', to_agent,
				            'channel', channel,
				            'message_type', message_type,
				            'message_content', message_content,
				            'created_at', created_at,
				            'proposal_id', proposal_id
				          ) ORDER BY created_at DESC), '[]'::jsonb)
				     FROM (SELECT *
				             FROM roadmap.message_ledger
				            WHERE from_agent = $1 OR to_agent = $1
				            ORDER BY created_at DESC
				            LIMIT 25) m) AS messages
				`,
				[identity],
			);
			const r = rows[0];
			if (!r || !r.registry) {
				return Response.json({ error: "Agent not found" }, { status: 404 });
			}
			return Response.json({
				identity,
				registry: r.registry,
				health: r.health ?? null,
				heartbeats: r.heartbeats ?? [],
				runs: r.runs ?? [],
				messages: r.messages ?? [],
			});
		} catch (error) {
			console.error(`Error loading agent detail for ${identity}:`, error);
			return Response.json(
				{ error: "Failed to load agent detail" },
				{ status: 500 },
			);
		}
	}

	// P477 AC-5 + AC-7: operator → agent reminder/message.
	// Inserts directly into roadmap.message_ledger as a private DM.
	// (We don't go through core.sendMessage because that path rejects
	// private DMs from the web API.)
	// AC-7: gated by requireOperator with action='agent.message'.
	private async handleSendAgentMessage(
		identity: string,
		req: Request,
	): Promise<Response> {
		try {
			const body = await req.json();
			const auth = await requireOperator(req, {
				action: "agent.message",
				targetKind: "agent",
				targetIdentity: identity,
				requestSummary: {
					message_type:
						typeof body.message_type === "string" ? body.message_type : null,
					length: typeof body.text === "string" ? body.text.length : null,
				},
			});
			if (auth.rejected) return auth.rejected;
			// On allow, prefer the operator name from the token over body.from
			// so we never let the caller spoof a different operator identity.
			body.from = auth.outcome.operatorName ?? body.from;
			const text = typeof body.text === "string" ? body.text.trim() : "";
			// message_ledger.from_agent has a FK to agent_registry, so an
			// arbitrary "@operator" handle won't work. Default to the human
			// operator row that already exists ('gary'); allow body.from
			// override for callers that pass a registered identity.
			const from =
				typeof body.from === "string" && body.from.trim().length > 0
					? body.from.trim()
					: "gary";

			// message_ledger.message_type is constrained to:
			// text | task | notify | ack | error | event
			// Operator intent ('reminder', 'nudge', 'instruction') lives in
			// metadata.intent so we can render labels without breaking the CHECK.
			const ALLOWED_TYPES = new Set([
				"text",
				"task",
				"notify",
				"ack",
				"error",
				"event",
			]);
			const requestedIntent =
				typeof body.message_type === "string" &&
				body.message_type.trim().length > 0
					? body.message_type.trim()
					: "reminder";
			const messageType = ALLOWED_TYPES.has(requestedIntent)
				? requestedIntent
				: "notify";
			if (!text) {
				return Response.json({ error: "text is required" }, { status: 400 });
			}

			// Verify the target and the sender both exist so we don't trip
			// the message_ledger FKs.
			const { rows: regRows } = await query<{
				to_exists: boolean;
				from_exists: boolean;
			}>(
				`SELECT
				   EXISTS(SELECT 1 FROM roadmap_workforce.agent_registry WHERE agent_identity = $1) AS to_exists,
				   EXISTS(SELECT 1 FROM roadmap_workforce.agent_registry WHERE agent_identity = $2) AS from_exists`,
				[identity, from],
			);
			if (!regRows[0]?.to_exists) {
				return Response.json({ error: "Unknown agent" }, { status: 404 });
			}
			if (!regRows[0]?.from_exists) {
				return Response.json(
					{ error: `from agent '${from}' is not registered` },
					{ status: 400 },
				);
			}

			// message_ledger.channel is constrained to direct|team:*|broadcast|system.
			// Use 'direct' for operator → agent DMs so anything filtering by
			// channel can still classify the message; per-agent routing is
			// handled by to_agent. fn_notify_new_message fires on insert,
			// waking any LISTEN new_message subscriber.
			const channel = "direct";
			const { rows } = await query<{ id: number; created_at: string }>(
				`INSERT INTO roadmap.message_ledger
				   (from_agent, to_agent, channel, message_type, message_content, metadata)
				 VALUES ($1, $2, $3, $4, $5, $6)
				 RETURNING id, created_at`,
				[
					from,
					identity,
					channel,
					messageType,
					text,
					JSON.stringify({
						source: "web-control-plane",
						intent: requestedIntent,
					}),
				],
			);

			return Response.json({
				success: true,
				message_id: rows[0]?.id,
				created_at: rows[0]?.created_at,
				message_type: messageType,
				intent: requestedIntent,
			});
		} catch (error) {
			console.error(`Error sending message to ${identity}:`, error);
			return Response.json(
				{ error: "Failed to send agent message" },
				{ status: 500 },
			);
		}
	}

	private async handleListPulse(req: Request): Promise<Response> {
		try {
			const url = new URL(req.url);
			const limitParam = url.searchParams.get("limit");
			const parsed = limitParam ? Number.parseInt(limitParam, 10) : NaN;
			const limit = Number.isFinite(parsed) && parsed > 0 && parsed <= 1000 ? parsed : 100;

			// Read heartbeats directly from roadmap_workforce.agent_heartbeat_log.
			// Prior implementation delegated to this.core.listPulse() which doesn't
			// exist on Core (only daemon-client has it, and that would have been a
			// recursive HTTP call into this same endpoint).
			const { rows } = await query(
				`SELECT id,
				        agent_identity,
				        heartbeat_at,
				        current_task,
				        active_model,
				        cpu_percent,
				        memory_mb,
				        metadata
				   FROM roadmap_workforce.agent_heartbeat_log
				  ORDER BY heartbeat_at DESC
				  LIMIT $1`,
				[limit],
			);
			const events = rows.map((r) => ({
				type: "heartbeat" as const,
				id: String(r.id),
				title: r.current_task || r.active_model || "heartbeat",
				agent: r.agent_identity,
				timestamp:
					r.heartbeat_at instanceof Date
						? r.heartbeat_at.toISOString()
						: String(r.heartbeat_at),
				impact: undefined,
			}));
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
			const { rows } = await query(
				`SELECT DISTINCT channel, COUNT(*) as msg_count
				 FROM roadmap.message_ledger WHERE channel IS NOT NULL
				 GROUP BY channel ORDER BY channel ASC LIMIT 200`,
				[],
			);
			return Response.json(rows);
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
			const params: (string)[] = [channel];
			const sinceClause = since ? ` AND created_at > $2` : "";
			if (since) params.push(since);
			const { rows } = await query(
				`SELECT id, from_agent, to_agent, channel, message_content, message_type, created_at
				 FROM roadmap.message_ledger WHERE channel = $1${sinceClause}
				 ORDER BY created_at DESC LIMIT 100`,
				params,
			);
			return Response.json(rows);
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

			const { rows } = await query(
				`INSERT INTO roadmap.message_ledger (from_agent, channel, message_content, message_type)
				 VALUES ($1, $2, $3, 'text') RETURNING id, created_at`,
				[from, channel, text],
			);
			return Response.json({ success: true, id: rows[0]?.id });
		} catch (error) {
			console.error("Error sending message:", error);
			return Response.json(
				{ error: "Failed to send message" },
				{ status: 500 },
			);
		}
	}

	private async handleGetArchDocs(): Promise<Response> {
		const { generateArchitectureDocs, checkStale, getLatestArchDocs } =
			await import("../../core/infrastructure/architecture-reconstructor.ts");
		try {
			if (process.env.ARCH_RECONSTRUCTOR_DISABLED === "true") {
				return Response.json(
					{ error: "arch_reconstructor_disabled" },
					{ status: 503 },
				);
			}
			const views = await generateArchitectureDocs({
				projectRoot: process.cwd(),
			});
			const { staleSince } = await checkStale(views);
			const headers: Record<string, string> = {
				"X-Generated-At": views.generatedAt.toISOString(),
			};
			if (staleSince) {
				headers["X-Arch-Stale"] = `true; since=${staleSince.toISOString()}`;
			}
			return Response.json(views, { headers });
		} catch (error) {
			console.error("[arch-docs] DB query failed:", error);
			const fallback = getLatestArchDocs(process.cwd());
			if (fallback) {
				return Response.json(
					{
						error: "db_unavailable",
						fallback: "last_generated",
						...fallback,
					},
					{
						status: 503,
						headers: {
							"X-Generated-At": fallback.generatedAt.toISOString(),
							"X-Arch-Stale": `true; since=unknown`,
						},
					},
				);
			}
			return Response.json(
				{ error: "db_unavailable", fallback: "last_generated" },
				{ status: 503 },
			);
		}
	}

	private async handleListRoutes(): Promise<Response> {
		try {
			const { rows } = await query(
				`SELECT mr.id,
				        mr.model_name,
				        mr.route_provider,
				        mr.agent_provider,
				        mr.agent_cli,
				        mr.fallback_cli,
				        mr.is_enabled,
				        mr.priority,
				        mr.api_spec,
				        mr.base_url,
				        mr.cost_per_million_input,
				        mr.cost_per_million_output,
				        mr.plan_type,
				        mr.notes,
				        mr.created_at,
				        COALESCE(
				          (SELECT bool_or(
				                    NOT (mr.route_provider = ANY(hmp.forbidden_providers))
				                    AND (hmp.allowed_providers = '{}'
				                         OR mr.route_provider = ANY(hmp.allowed_providers))
				                  )
				             FROM roadmap.host_model_policy hmp
				          ),
				          true
				        ) AS has_host_policy_match
				   FROM roadmap.model_routes mr
				  ORDER BY mr.is_enabled DESC, mr.priority ASC, mr.model_name ASC`,
			);
			return Response.json({ routes: rows ?? [] });
		} catch (error) {
			console.error("Error listing routes:", error);
			return Response.json({ error: "Failed to list routes" }, { status: 500 });
		}
	}

	private async handleToggleRoute(req: Request, id: string): Promise<Response> {
		const auth = await requireOperator(req, { action: "routes.toggle" });
		if (auth.rejected) return auth.rejected;

		try {
			const numericId = parseInt(id, 10);
			if (Number.isNaN(numericId))
				return Response.json({ error: "Invalid id" }, { status: 400 });

			let body: unknown;
			try {
				body = await req.json();
			} catch {
				body = null;
			}
			if (
				body === null ||
				typeof body !== "object" ||
				typeof (body as Record<string, unknown>).is_enabled !== "boolean"
			) {
				return Response.json({ error: "is_enabled (boolean) required" }, { status: 400 });
			}

			const isEnabled = (body as { is_enabled: boolean }).is_enabled;
			const { rows } = await query(
				`UPDATE roadmap.model_routes SET is_enabled = $1 WHERE id = $2 RETURNING id, is_enabled`,
				[isEnabled, numericId],
			);

			if (!rows.length)
				return Response.json({ error: "Route not found" }, { status: 404 });
			return Response.json(rows[0]);
		} catch (error) {
			console.error("Error toggling route:", error);
			return Response.json({ error: "Failed to update route" }, { status: 500 });
		}
	}

	private async handleGetBoardStages(req?: Request): Promise<Response> {
		try {
			const url = new URL(req?.url || "http://localhost/?workflow=Standard RFC");
			const workflow = url.searchParams.get("workflow") || "Standard RFC";

			const registry = getRegistry();
			const view = registry.getView(workflow);

			// Load display metadata (displayLabel, hexColor) from the stage-definition table.
			// Falls back gracefully — if the table is empty or a stage has no entry, use
			// the stage name as the display label and null for colour.
			let stageDefMap: Map<string, { displayLabel: string; hexColor: string | null }> = new Map();
			try {
				const raw = await loadStageRegistry();
				for (const [name, def] of raw) {
					stageDefMap.set(name, { displayLabel: def.displayLabel, hexColor: def.hexColor });
				}
			} catch {
				// non-fatal — proceed with name-only labels
			}

			const stages = view.stages.map((stage) => {
				const def = stageDefMap.get(stage.name);
				return {
					id: stage.name,
					stageName: stage.name,
					label: def?.displayLabel ?? stage.name,
					displayLabel: def?.displayLabel ?? stage.name,
					hexColor: def?.hexColor ?? null,
					order: stage.order,
					isTerminal: stage.isTerminal,
				};
			});

			return Response.json({ stages, workflow: view.template });
		} catch (error) {
			const stages = [
				{ id: "DRAFT", stageName: "DRAFT", label: "Draft", displayLabel: "Draft", hexColor: null, order: 1, isTerminal: false },
				{ id: "REVIEW", stageName: "REVIEW", label: "Review", displayLabel: "Review", hexColor: null, order: 2, isTerminal: false },
				{ id: "DEVELOP", stageName: "DEVELOP", label: "Develop", displayLabel: "Develop", hexColor: null, order: 3, isTerminal: false },
				{ id: "MERGE", stageName: "MERGE", label: "Merge", displayLabel: "Merge", hexColor: null, order: 4, isTerminal: false },
				{ id: "COMPLETE", stageName: "COMPLETE", label: "Complete", displayLabel: "Complete", hexColor: null, order: 5, isTerminal: true },
			];
			return Response.json({
				stages,
				workflow: "Standard RFC",
				error: error instanceof Error ? error.message : "Registry not loaded",
			});
		}
	}

	private async handleGetBoardColumns(req?: Request): Promise<Response> {
		try {
			const url = new URL(req?.url || "http://localhost/?workflowName=Standard+RFC");

			// ?bust=<ts> bypasses cache
			const bust = url.searchParams.get("bust");
			const workflowName = url.searchParams.get("workflowName") || "Standard RFC";

			const registry = getRegistry();
			const view = registry.getView(workflowName);

			let stageDefMap: Map<string, { displayLabel: string; hexColor: string | null; isTerminal: boolean; maturityGate: number | null }> = new Map();
			try {
				const raw = await loadStageRegistry();
				for (const [name, def] of raw) {
					stageDefMap.set(name, {
						displayLabel: def.displayLabel,
						hexColor: def.hexColor,
						isTerminal: def.isTerminal,
						maturityGate: null,
					});
				}
			} catch {
				// non-fatal — proceed with name-only labels
			}

			// Best-effort dwell stats — omit the field if the view isn't ready yet.
			let dwellMap = new Map<string, number | null>();
			try {
				const { rows } = await query<{ stage_name: string; avg_dwell_days: string | null }>(
					`SELECT stage_name, avg_dwell_days FROM roadmap_proposal.v_stage_dwell_stats`,
				);
				for (const row of rows) {
					dwellMap.set(row.stage_name, row.avg_dwell_days !== null ? parseFloat(row.avg_dwell_days) : null);
				}
			} catch {
				// non-fatal — view may not exist yet on first boot
			}

			const columns = view.stages.map((stage, idx) => {
				const def = stageDefMap.get(stage.name);
				const avgDwell = dwellMap.get(stage.name) ?? null;
				return {
					stage_name:     stage.name,
					stage_order:    stage.order ?? idx + 1,
					display_label:  def?.displayLabel ?? stage.name,
					is_terminal:    stage.isTerminal ?? false,
					maturity_gate:  def?.maturityGate ?? null,
					avg_dwell_days: avgDwell,
				};
			});

			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				"Cache-Control": bust ? "no-cache" : "public, max-age=300",
			};

			return new Response(JSON.stringify(columns), { status: 200, headers });
		} catch (error) {
			const fallback = [
				{ stage_name: "DRAFT",    stage_order: 1, display_label: "Draft",    is_terminal: false, maturity_gate: null, avg_dwell_days: null },
				{ stage_name: "REVIEW",   stage_order: 2, display_label: "Review",   is_terminal: false, maturity_gate: null, avg_dwell_days: null },
				{ stage_name: "DEVELOP",  stage_order: 3, display_label: "Develop",  is_terminal: false, maturity_gate: null, avg_dwell_days: null },
				{ stage_name: "MERGE",    stage_order: 4, display_label: "Merge",    is_terminal: false, maturity_gate: null, avg_dwell_days: null },
				{ stage_name: "COMPLETE", stage_order: 5, display_label: "Complete", is_terminal: true,  maturity_gate: null, avg_dwell_days: null },
			];
			return new Response(JSON.stringify(fallback), {
				status: 200,
				headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
			});
		}
	}

	/**
	 * GET /api/board/live-feed
	 * P720 Activity Feed — Returns recent events from message_ledger WHERE channel=system:proposal-feed
	 * Query params:
	 *   ?proposal_id=<id>  — Filter by proposal_id
	 *   ?agent_identity=<id> — Filter by from_agent
	 *   ?limit=50          — Max events to return (default 50)
	 *   ?cursor=<id>       — Pagination cursor (id of last seen event)
	 *
	 * Returns array of activity feed events in reverse-chronological order.
	 * Latency target: <200ms at 10,000 event table size (AC-5).
	 */
	private async handleBoardLiveFeed(req: Request): Promise<Response> {
		try {
			const url = new URL(req.url);
			const proposalId = url.searchParams.get("proposal_id")
				? Number(url.searchParams.get("proposal_id"))
				: undefined;
			const agentIdentity = url.searchParams.get("agent_identity")
				? String(url.searchParams.get("agent_identity")).trim()
				: undefined;
			const limit = Math.min(
				url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : 50,
				200, // Cap at 200 rows per request
			);
			const cursor = url.searchParams.get("cursor")
				? Number(url.searchParams.get("cursor"))
				: undefined;

			// Build WHERE clause filters
			const whereParts: string[] = ["channel = 'system:proposal-feed'"];
			const params: (number | string | undefined)[] = [];

			if (proposalId) {
				whereParts.push(`proposal_id = $${params.length + 1}`);
				params.push(proposalId);
			}

			if (agentIdentity) {
				whereParts.push(`from_agent = $${params.length + 1}`);
				params.push(agentIdentity);
			}

			if (cursor) {
				whereParts.push(`id < $${params.length + 1}`);
				params.push(cursor);
			}

			const whereClause = whereParts.join(" AND ");

			// Query activity feed with indexed lookup
			const { rows } = await query<{
				id: number;
				from_agent: string;
				proposal_id: number | null;
				message_content: string;
				created_at: string;
				metadata: Record<string, unknown>;
			}>(
				`SELECT id, from_agent, proposal_id, message_content, created_at, metadata
				 FROM roadmap.message_ledger
				 WHERE ${whereClause}
				 ORDER BY created_at DESC, id DESC
				 LIMIT $${params.length + 1}`,
				[...params, limit],
			);

			// Format response with next cursor if available
			const events = rows.map((row) => ({
				id: row.id,
				actor: row.from_agent,
				proposal_id: row.proposal_id,
				message: row.message_content,
				timestamp: row.created_at,
				event_type: row.metadata?.event_type ?? "unknown",
			}));

			const nextCursor = events.length >= limit ? events[events.length - 1]?.id : null;

			return Response.json(
				{
					events,
					cursor: nextCursor,
					count: events.length,
				},
				{
					status: 200,
					headers: {
						"Cache-Control": "no-cache, must-revalidate",
						"Content-Type": "application/json",
					},
				},
			);
		} catch (error) {
			console.error("[P720] board live-feed query failed:", (error as Error).message);
			return Response.json(
				{ error: "Failed to fetch activity feed", events: [] },
				{ status: 500, headers: { "Content-Type": "application/json" } },
			);
		}
	}

	private async scanAgencyObservabilityAlerts(): Promise<void> {
		try {
			await runObservabilityAlertTick();
		} catch (error) {
			console.error("[agency-observability] alert scan failed:", (error as Error).message);
		}
	}

	// P477 AC-2: dispatches scoped to operator's selected project_id.
	// squad_dispatch carries project_id directly so we filter there; an
	// `?all=1` query bypass is preserved for control-plane debug views.
	private async handleListDispatches(req: Request): Promise<Response> {
		try {
			const url = new URL(req.url);
			const all = url.searchParams.get("all") === "1";
			const scope = await this.resolveProjectScope(req);
			const baseSelect = `SELECT d.id,
			        d.proposal_id,
			        d.project_id,
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
			     ON p.id = d.proposal_id`;
			const { rows } = all
				? await query(
						`${baseSelect}
					  ORDER BY d.assigned_at DESC NULLS LAST, d.id DESC`,
					)
				: await query(
						`${baseSelect}
					  WHERE d.project_id = $1
					  ORDER BY d.assigned_at DESC NULLS LAST, d.id DESC`,
						[scope.project_id],
					);
			return Response.json({
				dispatches: rows ?? [],
				project: {
					project_id: scope.project_id,
					slug: scope.project_slug,
					name: scope.project_name,
				},
			});
		} catch (error) {
			console.error("Error listing dispatches:", error);
			return Response.json(
				{ error: "Failed to list dispatches" },
				{ status: 500 },
			);
		}
	}

	private async handleListAgencies(req: Request): Promise<Response> {
		try {
			const url = new URL(req.url);
			const proposal = url.searchParams.get("proposal")?.trim().replace(/^P/i, "");
			const agency = url.searchParams.get("agency")?.trim();
			const route = url.searchParams.get("route")?.trim();
			const severity = url.searchParams.get("severity")?.trim();

			const { rows } = await query<Record<string, unknown>>(
				`SELECT d.*,
				        COALESCE(to_jsonb(h) - 'agency_id', '{}'::jsonb) AS protocol_health
				   FROM roadmap.v_agency_dashboard d
				   LEFT JOIN roadmap.v_liaison_protocol_health h
				     ON h.agency_id = d.agency_id
				  WHERE ($1::text IS NULL OR d.agency_id = $1 OR d.provider = $1)
				    AND ($2::text IS NULL OR $2 = ANY(d.route_providers))
				    AND ($3::text IS NULL OR $3 = ANY(d.severities))
				  ORDER BY d.status, d.open_assistance DESC, d.agency_id`,
				[agency || null, route || null, severity || null],
			);
			const { rows: assistanceRows } = await query<Record<string, unknown>>(
				`SELECT *
				   FROM roadmap.v_assistance_open
				  WHERE ($1::text IS NULL OR agency_id = $1)
				    AND ($2::text IS NULL OR route_provider = $2)
				    AND ($3::text IS NULL OR severity = $3)
				  ORDER BY opened_at`,
				[agency || null, route || null, severity || null],
			);

			const matchesProposal = (value: unknown): boolean => {
				if (!proposal) return true;
				if (value == null) return false;
				const wanted = String(proposal);
				if (typeof value === "number") return String(value) === wanted;
				if (typeof value === "string") return value.replace(/^P/i, "") === wanted;
				if (Array.isArray(value)) return value.some(matchesProposal);
				if (typeof value === "object") {
					return Object.values(value as Record<string, unknown>).some(matchesProposal);
				}
				return false;
			};

			const filteredRows = proposal
				? rows.filter((row) =>
						matchesProposal(row.active_claims) ||
						matchesProposal(row.assistance_requests) ||
						matchesProposal(row.recent_messages),
					)
				: rows;

			const agencyIds = filteredRows.map((r) => String(r.agency_id));
			const timelines = new Map<string, unknown[]>();
			if (agencyIds.length > 0) {
				const timelineRows = await query<{ agency_id: string; timeline: unknown[] }>(
					`SELECT agency_id,
					        jsonb_agg(
					          jsonb_build_object(
					            'message_id', message_id,
					            'kind', kind,
					            'sequence', sequence,
					            'signed_at', signed_at,
					            'ack_outcome', ack_outcome,
					            'payload', payload
					          )
					          ORDER BY signed_at DESC
					        ) AS timeline
					   FROM roadmap.liaison_message
					  WHERE agency_id = ANY($1::text[])
					    AND kind IN ('progress_note', 'claim_status')
					    AND signed_at > now() - interval '24 hours'
					  GROUP BY agency_id`,
					[agencyIds],
				);
				for (const row of timelineRows.rows) {
					timelines.set(row.agency_id, row.timeline ?? []);
				}
			}

			// Agency roster + liaison metadata, keyed by agency_id (the liaison
			// identity). An "agency" is a roadmap.agency row that is registered as
			// an agency-parent in the workforce registry (agent_type='agency').
			// Its named agents are registry rows whose agency_id self-FK points at
			// that parent and that carry an agency_style (the permanent named
			// roster — this excludes the hundreds of ephemeral per-task session
			// identities, which have agency_style NULL). Member presence comes from
			// each agent's own heartbeat row in roadmap.agency under the
			// <style>.<identity>.a convention; workload is its in-flight dispatch
			// count. None of this touches the shared v_agency_dashboard view.
			const roster = new Map<
				string,
				{
					is_liaison: boolean;
					named_agents: unknown[];
					liaison_models: string[];
					liaison_route_model: string | null;
				}
			>();
			if (agencyIds.length > 0) {
				const rosterRows = await query<{
					agency_id: string;
					named_agents: unknown[] | null;
					supported_models: string[] | null;
					route_model: string | null;
				}>(
					`WITH members AS (
					   SELECT parent.agent_identity AS agency_id,
					          jsonb_agg(jsonb_build_object(
					            'identity', m.agent_identity,
					            'role', m.role,
					            'provider', m.agency_style,
					            'live', (ma.last_heartbeat_at > now() - interval '60 seconds'),
					            'last_heartbeat_at', ma.last_heartbeat_at,
					            'skills', m.skills,
					            'in_flight', COALESCE(wl.in_flight, 0)
					          ) ORDER BY (ma.last_heartbeat_at > now() - interval '60 seconds') DESC NULLS LAST,
					                     m.agent_identity) AS named_agents
					     FROM roadmap_workforce.agent_registry m
					     JOIN roadmap_workforce.agent_registry parent
					       ON parent.id = m.agency_id AND parent.agent_type = 'agency'
					     LEFT JOIN roadmap.agency ma
					       ON ma.agency_id = m.agency_style || '.' || m.agent_identity || '.a'
					     LEFT JOIN LATERAL (
					       SELECT count(*) AS in_flight
					         FROM roadmap_workforce.squad_dispatch sd
					        WHERE sd.worker_identity IN (m.agent_identity,
					                                     m.agency_style || '.' || m.agent_identity || '.a')
					          AND (lower(COALESCE(sd.offer_status, '')) IN ('claimed', 'active')
					            OR lower(COALESCE(sd.dispatch_status, '')) IN ('assigned', 'active', 'blocked'))
					     ) wl ON true
					    WHERE m.agency_style IS NOT NULL
					      AND m.status = 'active'
					      AND m.agent_type <> 'agency'
					    GROUP BY parent.agent_identity
					 )
					 SELECT a.agency_id,
					        mem.named_agents,
					        r.supported_models,
					        mr.model_name AS route_model
					   FROM roadmap.agency a
					   JOIN roadmap_workforce.agent_registry r
					     ON r.agent_identity = a.agency_id AND r.agent_type = 'agency'
					   LEFT JOIN roadmap.model_routes mr ON mr.id = r.current_route_id
					   LEFT JOIN members mem ON mem.agency_id = a.agency_id
					  WHERE a.agency_id = ANY($1::text[])`,
					[agencyIds],
				);
				for (const row of rosterRows.rows) {
					roster.set(String(row.agency_id), {
						is_liaison: true,
						named_agents: Array.isArray(row.named_agents) ? row.named_agents : [],
						liaison_models: Array.isArray(row.supported_models)
							? row.supported_models
							: [],
						liaison_route_model: row.route_model ?? null,
					});
				}
			}

			const normalizedAgencies = filteredRows.map((row) => {
				const protocolHealth =
					typeof row.protocol_health === "object" && row.protocol_health !== null
						? (row.protocol_health as Record<string, unknown>)
						: {};
				const recentMessages = Array.isArray(row.recent_messages)
					? row.recent_messages
					: [];
				const agencyId = String(row.agency_id);
				const rosterEntry = roster.get(agencyId);
				const namedAgents = rosterEntry?.named_agents ?? [];
				// Liveness is heartbeat-derived, NOT the stale status column. An
				// agency counts as live if its liaison heartbeat is fresh OR any of
				// its named agents is live (a liaison can be down while its workers
				// keep heartbeating — surface that rather than hide it).
				const liaisonLive =
					row.last_heartbeat_at != null &&
					Date.now() - new Date(String(row.last_heartbeat_at)).getTime() < 60_000;
				const anyMemberLive = namedAgents.some(
					(a) => (a as Record<string, unknown>)?.live === true,
				);
				return {
					...row,
					assistance: row.assistance_requests ?? [],
					claim_timeline:
						timelines.get(agencyId) ??
						recentMessages.filter((message) => {
							const kind = (message as Record<string, unknown>).kind;
							return kind === "progress_note" || kind === "claim_status";
						}),
					unacked_old: protocolHealth.unacked_old ?? 0,
					recent_rejects: protocolHealth.recent_rejects ?? 0,
					recent_refusals: protocolHealth.recent_rejects ?? 0,
					sequence_gap_count: protocolHealth.sequence_gaps ?? 0,
					last_ping_rtt: protocolHealth.last_ping_rtt ?? null,
					is_liaison: rosterEntry?.is_liaison ?? false,
					named_agents: namedAgents,
					liaison_models: rosterEntry?.liaison_models ?? [],
					liaison_route_model: rosterEntry?.liaison_route_model ?? null,
					liaison_live: liaisonLive,
					agency_live: liaisonLive || anyMemberLive,
				};
			});

			return Response.json({
				agencies: normalizedAgencies,
				assistance: proposal
					? assistanceRows.filter((row) => matchesProposal(row.proposal_id) || matchesProposal(row.payload))
					: assistanceRows,
				filters: {
					agency: agency || null,
					route: route || null,
					severity: severity || null,
					proposal: proposal ? `P${proposal}` : null,
				},
			});
		} catch (error) {
			console.error("Error listing agencies:", error);
			return Response.json({ error: "Failed to list agencies" }, { status: 500 });
		}
	}

	private async handleAgencyAction(
		agencyId: string,
		req: Request,
	): Promise<Response> {
		let body: Record<string, unknown> = {};
		try {
			body = await req.json();
		} catch {
			body = {};
		}

		const action = typeof body.action === "string" ? body.action : "";
		const allowed = new Set([
			"liaison_pause",
			"liaison_resume",
			"liaison_drain",
			"claim_revoke",
			"agency_retire",
		]);
		if (!allowed.has(action)) {
			return Response.json({ error: "Unsupported agency action" }, { status: 400 });
		}
		if (action === "claim_revoke" && typeof body.claim_id !== "string") {
			return Response.json({ error: "claim_id is required" }, { status: 400 });
		}

		const auth = await requireOperator(req, {
			action: `agency.${action}`,
			targetKind: "agency",
			targetIdentity: agencyId,
			requestSummary: { action, claim_id: body.claim_id ?? null },
		});
		if (auth.rejected) return auth.rejected;

		try {
			const reason = typeof body.reason === "string" ? body.reason : undefined;
			const operator = auth.outcome.operatorName ?? "operator";

			// Update agency status for operator-initiated pause/resume/retire (P766 AC-2/AC-4)
			if (action === "liaison_pause") {
				await pauseAgencyOperator(agencyId, operator, reason);
			} else if (action === "liaison_resume") {
				await resumeAgencyOperator(agencyId, operator, reason);
			} else if (action === "agency_retire") {
				await retireAgencyOperator(agencyId, operator, reason);
			}

			const payload =
				action === "claim_revoke"
					? {
							claim_id: body.claim_id,
							reason: typeof body.reason === "string" ? body.reason : "operator",
						}
					: action === "liaison_pause"
						? {
								until_iso:
									typeof body.until_iso === "string" && body.until_iso.length > 0
										? body.until_iso
										: null,
							}
						: action === "liaison_resume"
							? {}
							: {
									reason:
										typeof body.reason === "string" && body.reason.length > 0
											? body.reason
											: "operator",
								};

			const message = await sendLiaisonMessage({
				agency_id: agencyId,
				direction: "orchestrator->liaison",
				kind: action,
				payload,
			});

			// requireOperator() above already audits to roadmap.operator_audit_log;
			// no additional audit insert needed here.

			return Response.json({
				success: true,
				agency_id: agencyId,
				action,
				message_id: message.message_id,
				sequence: String(message.sequence),
				operator: auth.outcome.operatorName,
			});
		} catch (error) {
			console.error("Error sending agency action:", error);
			return Response.json({ error: "Failed to send agency action" }, { status: 500 });
		}
	}

	private async handleListTeams(): Promise<Response> {
		try {
			const { rows } = await query(`
				SELECT
					squad_name AS name,
					ARRAY_AGG(DISTINCT agent_identity ORDER BY agent_identity) AS members,
					MAX(assigned_at) AS created_at
				FROM roadmap_workforce.squad_dispatch
				WHERE squad_name IS NOT NULL
				  AND squad_name <> ''
				GROUP BY squad_name
				ORDER BY squad_name
			`);
			return Response.json(rows ?? []);
		} catch (error) {
			console.error("Error listing teams:", error);
			return Response.json({ error: "Failed to list teams" }, { status: 500 });
		}
	}

	private async handleListKnowledge(req: Request): Promise<Response> {
		try {
			const url = new URL(req.url);
			const queryParam = url.searchParams.get("query") ?? "";
			const typeParam = url.searchParams.get("type") ?? "";

			let sql = `
				SELECT
					id, type, content, keywords,
					source_proposal_id AS source,
					helpful_count, created_at
				FROM roadmap.knowledge_entries
				WHERE 1=1
			`;
			const params: unknown[] = [];
			let idx = 1;

			if (queryParam) {
				sql += ` AND (content ILIKE $${idx} OR keywords::text ILIKE $${idx} OR title ILIKE $${idx})`;
				params.push(`%${queryParam}%`);
				idx++;
			}
			if (typeParam) {
				sql += ` AND type = $${idx}`;
				params.push(typeParam);
				idx++;
			}
			sql += ` ORDER BY helpful_count DESC, created_at DESC LIMIT 100`;

			const { rows } = await query(sql, params);
			return Response.json(
				(rows ?? []).map((row: Record<string, unknown>) => ({
					...row,
					keywords: Array.isArray(row.keywords) ? row.keywords : [],
				})),
			);
		} catch (error) {
			console.error("Error listing knowledge entries:", error);
			return Response.json(
				{ error: "Failed to list knowledge entries" },
				{ status: 500 },
			);
		}
	}

	private async handleMarkKnowledgeHelpful(id: string): Promise<Response> {
		try {
			await query(
				`UPDATE roadmap.knowledge_entries
				    SET helpful_count = helpful_count + 1, updated_at = now()
				  WHERE id = $1`,
				[id],
			);
			return Response.json({ ok: true });
		} catch (error) {
			console.error("Error marking knowledge helpful:", error);
			return Response.json(
				{ error: "Failed to mark as helpful" },
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

		// P846: Check for operator bearer token and register SSE session
		const incomingReq = req as IncomingMessage & { headers: Record<string, string> };
		const authHeader = incomingReq.headers["authorization"];
		if (authHeader?.startsWith("Bearer ")) {
			const token = authHeader.slice(7);
			const hmacSecret = this._getOperatorHmacSecret();
			const result = await verifyBoundBearer(token, hmacSecret);
			if (result.ok && result.principal_id) {
				console.log(`[P846] Operator SSE session registered: ${sessionId}`);
				this._operatorSseSessions.set(sessionId, res);
			}
		}

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
			// P846: Also remove from operator sessions map
			this._operatorSseSessions.delete(sessionId);
			try {
				await transport.close();
			} catch {}
		});
	}

	private async handleMcpMessage(req: Request): Promise<Response> {
		try {
			appendFileSync("/tmp/mcp-debug.log", "[MCP] handleMcpMessage called\n");
		} catch {}
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

		try {
			appendFileSync(
				"/tmp/mcp-debug.log",
				`[MCP] POST message: ${parsedMethod} sessionId: ${sessionId}\n`,
			);
		} catch {}

		// Handle message through SSE transport
		try {
			try {
				appendFileSync(
					"/tmp/mcp-debug.log",
					"[MCP] Calling transport.handlePostMessage\n",
				);
			} catch {}

			// P843: Extract and verify operator bearer token if present
			let verifiedPrincipal: VerifiedPrincipal | null = null;
			const authHeader = req.headers.get("Authorization");
			if (authHeader?.startsWith("Bearer ")) {
				const token = authHeader.slice(7);
				const hmacSecret = this._getOperatorHmacSecret();
				const result = await verifyBoundBearer(token, hmacSecret);
				if (result.ok && result.principal_id) {
					verifiedPrincipal = {
						principal_id: result.principal_id,
						principal_kind: "operator",
						parent_principal_id: null,
					};
				}
			}

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
					try {
						appendFileSync(
							"/tmp/mcp-debug.log",
							`[MCP] Response status: ${responseStatus} body: ${responseBody.slice(0, 100)}\n`,
						);
					} catch {}
					return mockRes;
				},
				flushHeaders: () => {},
				headersSent: false,
				setHeader: () => {},
			};

			// Call transport's handlePostMessage (wrapped in agentContextStorage if principal was verified)
			const callHandler = async () => {
				await transport.handlePostMessage(
					{
						headers: Object.fromEntries(new Headers(req.headers as any)),
						auth: undefined,
					} as any,
					mockRes as any,
					parsedBody,
				);
			};

			if (verifiedPrincipal) {
				await agentContextStorage.run(
					{ verified: verifiedPrincipal },
					() => callHandler(),
				);
			} else {
				await callHandler();
			}

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
			try {
				appendFileSync(
					"/tmp/mcp-debug.log",
					`[MCP] POST error: ${String(e)}\n`,
				);
			} catch {}
			return Response.json({ error: String(e) }, { status: 500 });
		}
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
		const { randomBytes } = require("node:crypto") as typeof import("node:crypto");
		return randomBytes(32);
	}

	// P846: Register operator agency and set up heartbeat
	private async _registerOperatorAgency(): Promise<void> {
		const pool = getPool();
		try {
			// Insert or update operator agency registration
			const registerResult = await pool.query(`
				INSERT INTO roadmap.agency (
					agency_id, display_name, provider, host_id, capability_tags, status, metadata
				) VALUES ('operator', 'Operator Session', 'claude-code', 'bot', '[]', 'active', '{}')
				ON CONFLICT (agency_id) DO UPDATE
					SET status = 'active', last_heartbeat_at = NOW()
				RETURNING agency_id
			`);

			// Create liaison session
			const sessionResult = await pool.query(`
				INSERT INTO roadmap.agency_liaison_session (agency_id, liaison_host, started_at)
				VALUES ('operator', inet_server_addr()::text, NOW())
				RETURNING session_id
			`);

			if (sessionResult.rows.length > 0) {
				this._operatorSessionId = sessionResult.rows[0].session_id;
				console.log(`[P846] Operator agency registered with session: ${this._operatorSessionId}`);
			}

			// Start heartbeat every 30 seconds
			this._operatorHeartbeatInterval = setInterval(
				() => this._sendOperatorHeartbeat().catch((err) => {
					console.warn("[P846] Heartbeat error:", err.message);
				}),
				30000,
			);
		} catch (err) {
			console.error("[P846] Failed to register operator agency:", err);
		}
	}

	// P846: Send heartbeat to keep operator session active
	private async _sendOperatorHeartbeat(): Promise<void> {
		const pool = getPool();
		try {
			await pool.query(
				`UPDATE roadmap.agency SET last_heartbeat_at = NOW() WHERE agency_id = 'operator'`,
			);
		} catch (err) {
			console.warn("[P846] Heartbeat update failed:", err);
		}
	}

	// P846: Clean up operator agency session on shutdown
	private async _shutdownOperatorAgency(): Promise<void> {
		const pool = getPool();

		// Stop heartbeat
		if (this._operatorHeartbeatInterval) {
			clearInterval(this._operatorHeartbeatInterval);
			this._operatorHeartbeatInterval = null;
		}

		// Mark session as ended
		if (this._operatorSessionId) {
			try {
				await pool.query(`
					UPDATE roadmap.agency_liaison_session
					SET ended_at = NOW(), end_reason = 'normal'
					WHERE session_id = $1
				`, [this._operatorSessionId]);
			} catch (err) {
				console.warn("[P846] Failed to mark session as ended:", err);
			}
		}

		// Mark agency as dormant
		try {
			await pool.query(
				`UPDATE roadmap.agency SET status = 'dormant' WHERE agency_id = 'operator'`,
			);
		} catch (err) {
			console.warn("[P846] Failed to mark agency as dormant:", err);
		}

		// Close notify relay client
		if (this._operatorNotifyClient) {
			try {
				await this._operatorNotifyClient.query(`UNLISTEN "a2a_msg_operator"`);
			} catch {}
			try {
				await this._operatorNotifyClient.end();
			} catch {}
			this._operatorNotifyClient = null;
		}

		console.log("[P846] Operator agency shutdown complete");
	}

	// P846: Start listening for operator messages via pg_notify
	private async _startOperatorNotifyRelay(): Promise<void> {
		try {
			const { Client } = await import("pg");
			const notifyClient = new Client({ connectionString: process.env.DATABASE_URL });
			await notifyClient.connect();
			await notifyClient.query(`LISTEN "a2a_msg_operator"`);

			notifyClient.on("notification", (msg) => {
				if (msg.channel !== "a2a_msg_operator") return;
				try {
					const payload = JSON.parse(msg.payload ?? "{}");
					const frame = `event: a2a_message\ndata: ${JSON.stringify(payload)}\n\n`;
					for (const [, res] of this._operatorSseSessions) {
						try {
							res.write(frame);
						} catch {
							// Session may have closed, that's okay
						}
					}
				} catch (err) {
					console.warn("[P846] Error processing notify message:", err);
				}
			});

			notifyClient.on("error", (err) => {
				console.error("[P846] Notify client error:", err.message);
			});

			this._operatorNotifyClient = notifyClient;
			console.log("[P846] Operator notify relay started");
		} catch (err) {
			console.error("[P846] Failed to start notify relay:", err);
		}
	}

	private async handleGetSla(): Promise<Response> {
		try {
			const slaPath = join(
				import.meta.dirname,
				"../../../../docs/sla-contract.json",
			);
			const slaContent = readFileSync(slaPath, "utf-8");
			const slaParsed = JSON.parse(slaContent);
			return Response.json(slaParsed, {
				headers: {
					"Content-Type": "application/json",
					"Cache-Control": "max-age=3600",
				},
			});
		} catch (error) {
			console.error("Error reading SLA contract:", error);
			return Response.json(
				{ error: "SLA contract not found" },
				{ status: 404 },
			);
		}
	}

	private async handleMetrics(): Promise<Response> {
		try {
			const pool = getPool();

			// Query trace_span for current state and tool call counts
			let slaState = 0; // default to 0 (down)
			let toolCallCount = 0;
			let rateLimitViolationsTotal = 0;
			let rateLimitViolationsByReason: Record<string, number> = {};

			try {
				// Check if system is in normal state by counting recent spans
				const spanResult = await pool.query(`
					SELECT COUNT(*) as count
					FROM roadmap.trace_span
					WHERE created_at > NOW() - INTERVAL '5 minutes'
				`);
				toolCallCount = spanResult.rows[0]?.count || 0;

				// Simple heuristic: if we have spans in last 5 min, state is normal
				slaState = toolCallCount > 0 ? 1 : 0;
			} catch (err) {
				console.warn("Error querying trace_span:", err);
				slaState = 0;
			}

			// P1100 AC-11: Query rate limit violations for observability
			try {
				// Total rate limit violations across all senders and channels
				const totalResult = await pool.query(`
					SELECT COUNT(*) as count
					FROM roadmap.msg_send_rate_limit_violation
					WHERE violation_at > NOW() - INTERVAL '1 hour'
				`);
				rateLimitViolationsTotal = parseInt(totalResult.rows[0]?.count || "0", 10);

				// Violations broken down by reason
				const byReasonResult = await pool.query(`
					SELECT reason, COUNT(*) as count
					FROM roadmap.msg_send_rate_limit_violation
					WHERE violation_at > NOW() - INTERVAL '1 hour'
					GROUP BY reason
				`);
				for (const row of byReasonResult.rows) {
					rateLimitViolationsByReason[row.reason] = parseInt(row.count || "0", 10);
				}
			} catch (err) {
				console.warn("Error querying rate limit violations:", err);
				// Non-fatal: metrics endpoint continues without rate limit data
			}

			// Build Prometheus text format response
			let metrics = `# HELP agenthive_sla_state Current SLA state (1=normal, 0=down)
# TYPE agenthive_sla_state gauge
agenthive_sla_state{state="normal"} ${slaState}

# HELP agenthive_mcp_tool_calls_total Total MCP tool calls in last 5 minutes
# TYPE agenthive_mcp_tool_calls_total counter
agenthive_mcp_tool_calls_total ${toolCallCount}

# HELP agenthive_msg_send_rate_limit_violations_total Total msg_send rate limit violations in last hour
# TYPE agenthive_msg_send_rate_limit_violations_total counter
agenthive_msg_send_rate_limit_violations_total ${rateLimitViolationsTotal}
`;

			// P1100 AC-11: Per-reason breakdown of rate limit violations
			for (const [reason, count] of Object.entries(rateLimitViolationsByReason)) {
				metrics += `# HELP agenthive_msg_send_rate_limit_violations_by_reason_total Rate limit violations by reason
# TYPE agenthive_msg_send_rate_limit_violations_by_reason_total counter
agenthive_msg_send_rate_limit_violations_by_reason_total{reason="${reason}"} ${count}
`;
			}

			metrics += `
# Note: install prom-client for full histogram support
`;

			return new Response(metrics, {
				headers: {
					"Content-Type": "text/plain; version=0.0.4",
					"Cache-Control": "no-cache, no-store, must-revalidate",
				},
			});
		} catch (error) {
			console.error("Error generating metrics:", error);
			return new Response("# error generating metrics\n", {
				status: 500,
				headers: { "Content-Type": "text/plain" },
			});
		}
	}

	private async handleGetArchDocs(): Promise<Response> {
		if (process.env.ARCH_RECONSTRUCTOR_DISABLED === "true") {
			return Response.json(
				{ error: "arch_reconstructor_disabled", fallback: "env_var_set" },
				{ status: 503 },
			);
		}
		let views;
		try {
			views = await generateArchitectureDocs();
		} catch (err) {
			console.error("[arch-docs] DB query failed:", err);
			return Response.json(
				{ error: "db_unavailable", fallback: "last_generated" },
				{ status: 503 },
			);
		}
		const staleResult = await checkStale(views).catch(() => ({}));
		const staleSince = (staleResult as { staleSince?: Date }).staleSince;

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"X-Generated-At": views.generatedAt.toISOString(),
		};
		if (staleSince) {
			headers["X-Arch-Stale"] = `true; since=${staleSince.toISOString()}`;
		}

		return new Response(
			JSON.stringify({
				...views,
				generatedAt: views.generatedAt.toISOString(),
				timeline: views.timeline.map((e) => ({
					...e,
					transitionedAt: e.transitionedAt.toISOString(),
				})),
			}),
			{ status: 200, headers },
		);
	}

	// ── P435: Operator Control API handlers ──────────────────────────────────────

	/** GET /api/operator/control/dispatches?project_id=<n> */
	private async handleControlListDispatches(req: Request): Promise<Response> {
		const auth = await requireOperator(req, { action: "control.read" });
		if (auth.rejected) return auth.rejected;
		try {
			const url = new URL(req.url);
			const projectId = url.searchParams.get("project_id");
			const dispatches = await listActiveDispatches(
				projectId ? Number(projectId) : undefined,
			);
			return Response.json({ dispatches });
		} catch (err) {
			console.error("[p435] list_active_dispatches failed:", (err as Error).message);
			return Response.json({ error: "list_active_dispatches failed" }, { status: 500 });
		}
	}

	/** GET /api/operator/control/agencies?status=<s> */
	private async handleControlListAgencies(req: Request): Promise<Response> {
		const auth = await requireOperator(req, { action: "control.read" });
		if (auth.rejected) return auth.rejected;
		try {
			const url = new URL(req.url);
			const status = url.searchParams.get("status") ?? undefined;
			const agencies = await listAgenciesControl(status);
			return Response.json({ agencies });
		} catch (err) {
			console.error("[p435] list_agencies failed:", (err as Error).message);
			return Response.json({ error: "list_agencies failed" }, { status: 500 });
		}
	}

	/** GET /api/operator/control/workers?agency_id=<s>&dispatch_id=<n> */
	private async handleControlListWorkers(req: Request): Promise<Response> {
		const auth = await requireOperator(req, { action: "control.read" });
		if (auth.rejected) return auth.rejected;
		try {
			const url = new URL(req.url);
			const agencyId = url.searchParams.get("agency_id") ?? undefined;
			const dispatchIdRaw = url.searchParams.get("dispatch_id");
			const workers = await listWorkers({
				agencyId,
				dispatchId: dispatchIdRaw ? Number(dispatchIdRaw) : undefined,
			});
			return Response.json({ workers });
		} catch (err) {
			console.error("[p435] list_workers failed:", (err as Error).message);
			return Response.json({ error: "list_workers failed" }, { status: 500 });
		}
	}

	/**
	 * POST /api/operator/control/stop
	 * Body: { scope_type, scope_id, reason }
	 * Unified stop verb — delegates to appropriate operator-stop-controls function.
	 * AC-2: writes to control_audit.operator_action_log.
	 */
	private async handleControlStop(req: Request): Promise<Response> {
		const auth = await requireOperator(req, { action: "control.stop" });
		if (auth.rejected) return auth.rejected;
		try {
			const body = await req.json() as Record<string, unknown>;
			const scopeType = body.scope_type as ScopeType | undefined;
			const scopeId = typeof body.scope_id === "string" ? body.scope_id
				: String(body.scope_id ?? "");
			const reason = typeof body.reason === "string" ? body.reason : undefined;

			const VALID_SCOPES: ScopeType[] = [
				"dispatch", "proposal", "agency", "host", "worker", "provider_route",
			];
			if (!scopeType || !VALID_SCOPES.includes(scopeType)) {
				return Response.json(
					{ error: "scope_type must be one of: dispatch, proposal, agency, host, worker, provider_route" },
					{ status: 400 },
				);
			}
			if (!scopeId) {
				return Response.json({ error: "scope_id is required" }, { status: 400 });
			}

			const actor = auth.outcome.operatorName ?? "operator";
			const result = await operatorStop({ scopeType, scopeId, reason, actor });
			return Response.json({ result, scope_type: scopeType, scope_id: scopeId });
		} catch (err) {
			console.error("[p435] stop failed:", (err as Error).message);
			return Response.json({ error: "stop failed" }, { status: 500 });
		}
	}

	/**
	 * POST /api/operator/control/suspend-agency
	 * Body: { agency_id, reason }
	 */
	private async handleControlSuspendAgency(req: Request): Promise<Response> {
		const auth = await requireOperator(req, { action: "control.stop" });
		if (auth.rejected) return auth.rejected;
		try {
			const body = await req.json() as Record<string, unknown>;
			const agencyId = typeof body.agency_id === "string" ? body.agency_id : "";
			const reason = typeof body.reason === "string" ? body.reason : undefined;
			if (!agencyId) {
				return Response.json({ error: "agency_id is required" }, { status: 400 });
			}
			const actor = auth.outcome.operatorName ?? "operator";
			const result = await suspendAgency({ agencyIdentity: agencyId, actor, reason });
			return Response.json({ result, agency_id: agencyId });
		} catch (err) {
			console.error("[p435] suspend_agency failed:", (err as Error).message);
			return Response.json({ error: "suspend_agency failed" }, { status: 500 });
		}
	}

	/**
	 * POST /api/operator/control/drain-host
	 * Body: { host_id, grace_seconds?, reason }
	 */
	private async handleControlDrainHost(req: Request): Promise<Response> {
		const auth = await requireOperator(req, { action: "control.stop" });
		if (auth.rejected) return auth.rejected;
		try {
			const body = await req.json() as Record<string, unknown>;
			const host = typeof body.host_id === "string" ? body.host_id : "";
			const graceSeconds = typeof body.grace_seconds === "number" ? body.grace_seconds : 0;
			const reason = typeof body.reason === "string" ? body.reason : undefined;
			if (!host) {
				return Response.json({ error: "host_id is required" }, { status: 400 });
			}
			const actor = auth.outcome.operatorName ?? "operator";
			const result = await drainHost({
				host,
				allowGraceSeconds: graceSeconds,
				actor,
				reason,
			});
			return Response.json({ result, host });
		} catch (err) {
			console.error("[p435] drain_host failed:", (err as Error).message);
			return Response.json({ error: "drain_host failed" }, { status: 500 });
		}
	}

	/**
	 * POST /api/operator/control/cancel-dispatch
	 * Body: { dispatch_id, reason }
	 */
	private async handleControlCancelDispatch(req: Request): Promise<Response> {
		const auth = await requireOperator(req, { action: "control.stop" });
		if (auth.rejected) return auth.rejected;
		try {
			const body = await req.json() as Record<string, unknown>;
			const dispatchId = Number(body.dispatch_id);
			const reason = typeof body.reason === "string" ? body.reason : undefined;
			if (!dispatchId || Number.isNaN(dispatchId)) {
				return Response.json({ error: "dispatch_id is required" }, { status: 400 });
			}
			const actor = auth.outcome.operatorName ?? "operator";
			const result = await cancelDispatch({ dispatchId, actor, reason });
			return Response.json({ result, dispatch_id: dispatchId });
		} catch (err) {
			console.error("[p435] cancel_dispatch failed:", (err as Error).message);
			return Response.json({ error: "cancel_dispatch failed" }, { status: 500 });
		}
	}

	/**
	 * POST /api/operator/control/terminate-worker
	 * Body: { worker_id, signal?, reason }
	 */
	private async handleControlTerminateWorker(req: Request): Promise<Response> {
		const auth = await requireOperator(req, { action: "control.stop" });
		if (auth.rejected) return auth.rejected;
		try {
			const body = await req.json() as Record<string, unknown>;
			const workerIdentity = typeof body.worker_id === "string" ? body.worker_id : "";
			const signal = typeof body.signal === "string" ? body.signal : "SIGTERM";
			const reason = typeof body.reason === "string" ? body.reason : undefined;
			if (!workerIdentity) {
				return Response.json({ error: "worker_id is required" }, { status: 400 });
			}
			const actor = auth.outcome.operatorName ?? "operator";
			const result = await terminateWorker({ workerIdentity, signal, actor, reason });
			return Response.json({ result, worker_id: workerIdentity });
		} catch (err) {
			console.error("[p435] terminate_worker failed:", (err as Error).message);
			return Response.json({ error: "terminate_worker failed" }, { status: 500 });
		}
	}

	/**
	 * GET /api/operator/control/feed
	 * Query params: project_id, proposal_id, dispatch_id, event_class, since, limit
	 */
	private async handleControlFeed(req: Request): Promise<Response> {
		const auth = await requireOperator(req, { action: "control.read" });
		if (auth.rejected) return auth.rejected;
		try {
			const url = new URL(req.url);
			const events = await getFeedEvents({
				projectId: url.searchParams.get("project_id")
					? Number(url.searchParams.get("project_id"))
					: undefined,
				proposalId: url.searchParams.get("proposal_id")
					? Number(url.searchParams.get("proposal_id"))
					: undefined,
				dispatchId: url.searchParams.get("dispatch_id")
					? Number(url.searchParams.get("dispatch_id"))
					: undefined,
				eventClass: url.searchParams.get("event_class") as EventClass | undefined ?? undefined,
				since: url.searchParams.get("since")
					? new Date(url.searchParams.get("since")!)
					: undefined,
				limit: url.searchParams.get("limit")
					? Number(url.searchParams.get("limit"))
					: 200,
			});
			return Response.json({ events });
		} catch (err) {
			console.error("[p435] feed failed:", (err as Error).message);
			return Response.json({ error: "feed query failed" }, { status: 500 });
		}
	}

	/**
	 * GET /api/operator/control/replay/:dispatch_id
	 * Returns full causal chain for a dispatch (AC-6).
	 */
	private async handleControlReplay(
		_req: Request,
		dispatchIdStr: string,
	): Promise<Response> {
		const auth = await requireOperator(_req, { action: "control.read" });
		if (auth.rejected) return auth.rejected;
		try {
			const dispatchId = Number(dispatchIdStr);
			if (!dispatchId || Number.isNaN(dispatchId)) {
				return Response.json({ error: "dispatch_id must be a number" }, { status: 400 });
			}
			const rows = await replayChain(dispatchId);
			return Response.json({ dispatch_id: dispatchId, events: rows, count: rows.length });
		} catch (err) {
			console.error("[p435] replay failed:", (err as Error).message);
			return Response.json({ error: "replay query failed" }, { status: 500 });
		}
	}

	/**
	 * POST /api/operator/action
	 * P659: Operator-as-Gate-Agent gate actions (advance/hold/move_back/split/combine)
	 * Body: { action, proposalIds, args?, comment }
	 *
	 * AC-7: Identity enforcement: decided_by and author are always 'operator'/'operator-dashboard'
	 * AC-8: Security: reject with 403 unless from loopback (127.0.0.1/::1/::ffff:127.0.0.1)
	 */
	private async handleOperatorGateAction(req: Request): Promise<Response> {
		// AC-8: Loopback-only security check
		const remoteAddr = (req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()) ||
			(req.headers.get("x-real-ip")) ||
			"unknown";
		const isLoopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddr);
		if (!isLoopback) {
			return Response.json(
				{ error: "Operator gate actions only allowed from loopback" },
				{ status: 403 },
			);
		}

		// Require operator auth
		const auth = await requireOperator(req, { action: "gate.action" });
		if (auth.rejected) return auth.rejected;

		try {
			const body = await req.json() as Record<string, unknown>;
			const action = String(body.action ?? "").trim().toLowerCase();
			const proposalIds = Array.isArray(body.proposalIds) ? body.proposalIds : [];
			const comment = typeof body.comment === "string" ? body.comment.trim() : "";
			const args = (typeof body.args === "object" && body.args !== null)
				? (body.args as Record<string, unknown>)
				: {};

			if (!action) {
				return Response.json({ error: "action is required" }, { status: 400 });
			}

			if (!Array.isArray(proposalIds) || proposalIds.length === 0) {
				return Response.json({ error: "proposalIds array is required" }, { status: 400 });
			}

			// Validate all proposal IDs are numbers
			const numIds = proposalIds.map(id => {
				const num = Number(id);
				if (Number.isNaN(num)) throw new Error(`Invalid proposal ID: ${id}`);
				return num;
			});

			// Dispatch to action-specific handlers
			switch (action) {
				case "advance":
					return await this.handleOperatorAdvance(numIds, comment);
				case "hold":
					return await this.handleOperatorHold(numIds, comment);
				case "move_back":
					return await this.handleOperatorMoveBack(numIds, comment);
				case "split":
					return await this.handleOperatorSplit(numIds[0]!, args, comment);
				case "combine":
					return await this.handleOperatorCombine(numIds, args, comment);
				default:
					return Response.json(
						{ error: `Unknown action: ${action}` },
						{ status: 400 },
					);
			}
		} catch (err) {
			console.error("[p659] gate action failed:", (err as Error).message);
			return Response.json({ error: "gate action failed" }, { status: 500 });
		}
	}

	/**
	 * Operator advance action: insert gate_decision_log, then prop_transition
	 * AC-2: INSERT before transition; if INSERT fails, abort
	 * AC-7: identity constants enforced server-side
	 */
	private async handleOperatorAdvance(
		proposalIds: number[],
		rationale: string,
	): Promise<Response> {
		try {
			const results = [];
			const pool = getPool();

			for (const proposalId of proposalIds) {
				// Fetch current proposal state
				const { rows: proposals } = await query(
					`SELECT id, status, maturity FROM roadmap_proposal.proposal WHERE id = $1`,
					[proposalId],
				);

				if (proposals.length === 0) {
					results.push({ proposal_id: proposalId, error: "Proposal not found" });
					continue;
				}

				const proposal = proposals[0] as any;
				const currentStatus = proposal.status;

				// Determine next status based on current workflow
				let nextStatus: string;
				if (currentStatus === "DRAFT") nextStatus = "REVIEW";
				else if (currentStatus === "REVIEW") nextStatus = "DEVELOP";
				else if (currentStatus === "DEVELOP") nextStatus = "MERGE";
				else if (currentStatus === "MERGE") nextStatus = "COMPLETE";
				else {
					results.push({
						proposal_id: proposalId,
						error: `Cannot advance from status ${currentStatus}`,
					});
					continue;
				}

				// AC-2: INSERT gate_decision_log first
				try {
					await query(
						`INSERT INTO roadmap_proposal.gate_decision_log
							(proposal_id, from_state, to_state, maturity, gate, decided_by,
							 authority_agent, decision, rationale, project_id)
						 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
						[
							proposalId,
							currentStatus,
							nextStatus,
							"mature",
							"operator-dashboard",
							"operator",
							"operator-dashboard",
							"advance",
							rationale,
							1, // project_id
						],
					);
				} catch (insertErr) {
					console.error(
						`[p659] gate_decision_log INSERT failed for proposal ${proposalId}:`,
						(insertErr as Error).message,
					);
					return Response.json(
						{ error: "Failed to record gate decision", detail: (insertErr as Error).message },
						{ status: 500 },
					);
				}

				// Then invoke MCP prop_transition
				if (!this.mcpServer) {
					return Response.json({ error: "MCP server not initialized" }, { status: 500 });
				}

				const mcp = this.mcpServer as any;
				const toolResult = await mcp.testInterface.callTool({
					params: {
						name: "prop_transition",
						arguments: {
							proposal_id: proposalId,
							to_state: nextStatus,
							author: "operator",
							reason: "decision",
							notes: rationale,
						},
					},
				});

				results.push({
					proposal_id: proposalId,
					from_state: currentStatus,
					to_state: nextStatus,
					tool_result: toolResult,
				});
			}

			return Response.json({ results });
		} catch (err) {
			console.error("[p659] advance failed:", (err as Error).message);
			return Response.json({ error: "advance action failed" }, { status: 500 });
		}
	}

	/**
	 * Operator hold action: set maturity to 'new'
	 */
	private async handleOperatorHold(
		proposalIds: number[],
		rationale: string,
	): Promise<Response> {
		try {
			const results = [];

			for (const proposalId of proposalIds) {
				// Record hold decision
				await query(
					`INSERT INTO roadmap_proposal.gate_decision_log
						(proposal_id, from_state, to_state, maturity, gate, decided_by,
						 authority_agent, decision, rationale, project_id)
					 SELECT id, status, status, 'new', 'operator-dashboard', 'operator',
						    'operator-dashboard', 'hold', $2, project_id
					   FROM roadmap_proposal.proposal
					  WHERE id = $1`,
					[proposalId, rationale],
				);

				// Call prop_set_maturity
				if (!this.mcpServer) {
					return Response.json({ error: "MCP server not initialized" }, { status: 500 });
				}

				const mcp = this.mcpServer as any;
				const toolResult = await mcp.testInterface.callTool({
					params: {
						name: "prop_set_maturity",
						arguments: {
							proposal_id: proposalId,
							maturity: "new",
							agent: "operator",
							reason: rationale,
						},
					},
				});

				results.push({ proposal_id: proposalId, tool_result: toolResult });
			}

			return Response.json({ results });
		} catch (err) {
			console.error("[p659] hold failed:", (err as Error).message);
			return Response.json({ error: "hold action failed" }, { status: 500 });
		}
	}

	/**
	 * Operator move_back action: transition to prior stage
	 */
	private async handleOperatorMoveBack(
		proposalIds: number[],
		rationale: string,
	): Promise<Response> {
		try {
			const results = [];

			for (const proposalId of proposalIds) {
				// Fetch current status
				const { rows: proposals } = await query(
					`SELECT status FROM roadmap_proposal.proposal WHERE id = $1`,
					[proposalId],
				);

				if (proposals.length === 0) {
					results.push({ proposal_id: proposalId, error: "Proposal not found" });
					continue;
				}

				const currentStatus = (proposals[0] as any).status;
				let priorStatus: string;

				if (currentStatus === "REVIEW") priorStatus = "DRAFT";
				else if (currentStatus === "DEVELOP") priorStatus = "REVIEW";
				else if (currentStatus === "MERGE") priorStatus = "DEVELOP";
				else if (currentStatus === "COMPLETE") priorStatus = "MERGE";
				else {
					results.push({
						proposal_id: proposalId,
						error: `Cannot move back from status ${currentStatus}`,
					});
					continue;
				}

				// Record rejection decision
				await query(
					`INSERT INTO roadmap_proposal.gate_decision_log
						(proposal_id, from_state, to_state, maturity, gate, decided_by,
						 authority_agent, decision, rationale, project_id)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
					[
						proposalId,
						currentStatus,
						priorStatus,
						"new",
						"operator-dashboard",
						"operator",
						"operator-dashboard",
						"reject",
						rationale,
						1,
					],
				);

				// Call prop_transition
				if (!this.mcpServer) {
					return Response.json({ error: "MCP server not initialized" }, { status: 500 });
				}

				const mcp = this.mcpServer as any;
				const toolResult = await mcp.testInterface.callTool({
					params: {
						name: "prop_transition",
						arguments: {
							proposal_id: proposalId,
							to_state: priorStatus,
							author: "operator",
							reason: "iteration",
							notes: rationale,
						},
					},
				});

				results.push({
					proposal_id: proposalId,
					from_state: currentStatus,
					to_state: priorStatus,
					tool_result: toolResult,
				});
			}

			return Response.json({ results });
		} catch (err) {
			console.error("[p659] move_back failed:", (err as Error).message);
			return Response.json({ error: "move_back action failed" }, { status: 500 });
		}
	}

	/**
	 * Operator split action: create N child proposals
	 * No gate_decision_log row; mark source obsolete with 'superseded_by_split'
	 */
	private async handleOperatorSplit(
		sourceId: number,
		args: Record<string, unknown>,
		rationale: string,
	): Promise<Response> {
		try {
			const children = Array.isArray(args.children) ? args.children : [];

			// Validate: at least 2 children required
			if (children.length < 2) {
				return Response.json(
					{ error: "split action requires at least 2 children" },
					{ status: 400 },
				);
			}

			// Validate: all children have non-empty titles
			for (let i = 0; i < children.length; i++) {
				const child = children[i] as Record<string, unknown>;
				if (!child || typeof child !== "object") {
					return Response.json(
						{ error: `Child ${i} is not an object` },
						{ status: 400 },
					);
				}
				if (typeof child.title !== "string" || !child.title.trim()) {
					return Response.json(
						{ error: `Child ${i} requires non-empty title` },
						{ status: 400 },
					);
				}
			}

			// Validate: rationale is required
			if (!rationale || !rationale.trim()) {
				return Response.json(
					{ error: "comment/rationale is required for split action" },
					{ status: 400 },
				);
			}

			// Fetch source proposal
			const { rows: proposals } = await query(
				`SELECT id, display_id, type, title, status FROM roadmap_proposal.proposal WHERE id = $1`,
				[sourceId],
			);

			if (proposals.length === 0) {
				return Response.json(
					{ error: `Source proposal ${sourceId} not found` },
					{ status: 404 },
				);
			}

			const sourceProposal = proposals[0] as any;

			// Check MCP server initialization
			if (!this.mcpServer) {
				return Response.json({ error: "MCP server not initialized" }, { status: 500 });
			}

			const mcp = this.mcpServer as any;
			const createdChildren = [];

			// Step 1: Create each child proposal via MCP prop_create
			for (const childInput of children) {
				const child = childInput as Record<string, unknown>;
				const toolResult = await mcp.testInterface.callTool({
					params: {
						name: "prop_create",
						arguments: {
							type: sourceProposal.type,
							title: String(child.title).trim(),
							summary: child.summary ? String(child.summary).trim() : undefined,
							parent_id: sourceId,
							author: "operator",
						},
					},
				});

				// Check for errors in the MCP result
				if (toolResult.content && toolResult.content.length > 0) {
					const content = toolResult.content[0];
					if (content.type === "text") {
						const text = content.text || "";
						// MCP errors contain "⚠️"
						if (text.includes("⚠️") || text.toLowerCase().includes("error")) {
							return Response.json(
								{
									error: "Failed to create child proposal",
									detail: text,
									created_children: createdChildren.map((c) => c.display_id),
								},
								{ status: 500 },
							);
						}
						// Try to parse result to extract the created proposal
						try {
							// MCP returns YAML-like text; look for 'id:' or 'display_id:'
							const displayIdMatch = text.match(/display_id:\s*(\S+)/i);
							if (displayIdMatch) {
								createdChildren.push({
									display_id: displayIdMatch[1],
									title: child.title,
								});
							}
						} catch {
							// Continue on parse error; we at least attempted the create
						}
					}
				}
			}

			// Step 2: Mark source proposal obsolete via prop_set_maturity
			const obsoleteResult = await mcp.testInterface.callTool({
				params: {
					name: "prop_set_maturity",
					arguments: {
						proposal_id: sourceId,
						maturity: "obsolete",
						agent: "operator",
						reason: `Split into ${children.length} child proposals: ${createdChildren.map((c) => c.display_id).join(", ")}`,
					},
				},
			});

			// Check for errors in obsolete call
			if (obsoleteResult.content && obsoleteResult.content.length > 0) {
				const content = obsoleteResult.content[0];
				if (content.type === "text" && content.text && content.text.includes("⚠️")) {
					return Response.json(
						{
							error: "Failed to obsolete source proposal",
							detail: content.text,
							created_children: createdChildren.map((c) => c.display_id),
						},
						{ status: 500 },
					);
				}
			}

			// Step 3: Record discussion entry on source with superseded_by_split
			const childDisplayIds = createdChildren.map((c) => c.display_id).join(", ");
			const discussionBody = `Split into child proposals: ${childDisplayIds}. Rationale: ${rationale}`;

			await query(
				`INSERT INTO roadmap_proposal.proposal_discussions
					(proposal_id, author_identity, context_prefix, body)
				 VALUES ($1, $2, 'superseded_by_split:', $3)`,
				[sourceId, "operator", discussionBody],
			);

			return Response.json({
				result: "split completed",
				source_id: sourceId,
				created_children: createdChildren,
			});
		} catch (err) {
			console.error("[p659] split failed:", (err as Error).message);
			return Response.json({ error: "split action failed" }, { status: 500 });
		}
	}

	/**
	 * Operator combine action: merge two proposals into one
	 * No gate_decision_log row; mark originals obsolete with 'superseded_by'
	 */
	private async handleOperatorCombine(
		proposalIds: number[],
		args: Record<string, unknown>,
		rationale: string,
	): Promise<Response> {
		try {
			// Validate: exactly 2 proposals required
			if (proposalIds.length !== 2) {
				return Response.json(
					{ error: "combine action requires exactly 2 proposals" },
					{ status: 400 },
				);
			}

			// Validate: title and summary provided
			const mergedTitle = args.title ? String(args.title).trim() : "";
			const mergedSummary = args.summary ? String(args.summary).trim() : "";

			if (!mergedTitle) {
				return Response.json(
					{ error: "merged proposal requires a non-empty title" },
					{ status: 400 },
				);
			}

			// Validate: rationale is required
			if (!rationale || !rationale.trim()) {
				return Response.json(
					{ error: "comment/rationale is required for combine action" },
					{ status: 400 },
				);
			}

			// Fetch both source proposals
			const { rows: sources } = await query(
				`SELECT id, display_id, type, title, status FROM roadmap_proposal.proposal
				 WHERE id = ANY($1::int[])`,
				[proposalIds],
			);

			if (sources.length !== 2) {
				return Response.json(
					{ error: `One or both proposals not found (found ${sources.length} of 2)` },
					{ status: 404 },
				);
			}

			const source1 = sources[0] as any;
			const source2 = sources[1] as any;

			// Check MCP server initialization
			if (!this.mcpServer) {
				return Response.json({ error: "MCP server not initialized" }, { status: 500 });
			}

			const mcp = this.mcpServer as any;

			// Step 1: Create merged proposal via MCP prop_create
			const mergedResult = await mcp.testInterface.callTool({
				params: {
					name: "prop_create",
					arguments: {
						type: source1.type, // Use type from first source
						title: mergedTitle,
						summary: mergedSummary || undefined,
						author: "operator",
					},
				},
			});

			// Check for errors in the MCP result
			let mergedDisplayId: string | null = null;
			if (mergedResult.content && mergedResult.content.length > 0) {
				const content = mergedResult.content[0];
				if (content.type === "text") {
					const text = content.text || "";
					if (text.includes("⚠️") || text.toLowerCase().includes("error")) {
						return Response.json(
							{
								error: "Failed to create merged proposal",
								detail: text,
							},
							{ status: 500 },
						);
					}
					// Try to extract display_id from result
					const displayIdMatch = text.match(/display_id:\s*(\S+)/i);
					if (displayIdMatch) {
						mergedDisplayId = displayIdMatch[1];
					}
				}
			}

			if (!mergedDisplayId) {
				return Response.json(
					{
						error: "Could not extract merged proposal display_id from MCP response",
					},
					{ status: 500 },
				);
			}

			// Step 2: Mark both source proposals obsolete via prop_set_maturity
			for (const sourceId of proposalIds) {
				const obsoleteResult = await mcp.testInterface.callTool({
					params: {
						name: "prop_set_maturity",
						arguments: {
							proposal_id: sourceId,
							maturity: "obsolete",
							agent: "operator",
							reason: `Combined with other proposal into: ${mergedDisplayId}`,
						},
					},
				});

				// Check for errors
				if (obsoleteResult.content && obsoleteResult.content.length > 0) {
					const content = obsoleteResult.content[0];
					if (content.type === "text" && content.text && content.text.includes("⚠️")) {
						return Response.json(
							{
								error: `Failed to obsolete source proposal ${sourceId}`,
								detail: content.text,
								merged_proposal_id: mergedDisplayId,
							},
							{ status: 500 },
						);
					}
				}
			}

			// Step 3: Record discussion entries on both sources with superseded_by
			for (const source of sources) {
				const discussionBody = `Combined with other proposal into: ${mergedDisplayId}. Rationale: ${rationale}`;

				await query(
					`INSERT INTO roadmap_proposal.proposal_discussions
						(proposal_id, author_identity, context_prefix, body)
					 VALUES ($1, $2, 'superseded_by:', $3)`,
					[source.id, "operator", discussionBody],
				);
			}

			return Response.json({
				result: "combine completed",
				source_ids: proposalIds,
				merged_proposal_id: mergedDisplayId,
				source_proposals: sources.map((s) => s.display_id),
			});
		} catch (err) {
			console.error("[p659] combine failed:", (err as Error).message);
			return Response.json({ error: "combine action failed" }, { status: 500 });
		}
	}
}
