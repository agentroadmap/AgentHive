/**
 * websocket.ts — WebSocket / broadcast / subscription machinery extracted from
 * `RoadmapServer` (P3796 monolith decomposition, Phase 2, AC-17).
 *
 * `WebSocketManager` owns the WebSocket server, the connected-socket set, and
 * all per-socket subscription state (channel subscriptions, table subscriptions,
 * and per-socket project scope). It also owns the `roadmap_events` LISTEN client
 * and the 30s change-polling timer.
 *
 * `RoadmapServer` constructs one `WebSocketManager`, calls `setup(server)` from
 * `start()` after the HTTP server exists, and delegates broadcast calls to it.
 * The manager reaches back into the server only through the injected `core` and
 * `getContentStore` callback, so there is no circular import on `index.ts`.
 */
import { type WebSocket, WebSocketServer } from "ws";
import type { createServer } from "node:http";
import type { PoolClient } from "pg";
import type { Core } from "../../core/roadmap.ts";
import type { ContentStore } from "../../core/storage/content-store.ts";
import { getPool, query } from "../../infra/postgres/pool.ts";
import { RfcStates } from "../../core/workflow/state-names.ts";

type HttpServer = ReturnType<typeof createServer>;

export interface WebSocketManagerDeps {
	/** Core roadmap engine (used to query proposals for snapshots). */
	core: Core;
	/** Lazily resolve the content store (ensures services ready). */
	getContentStore: () => Promise<ContentStore>;
}

export class WebSocketManager {
	private readonly core: Core;
	private readonly getContentStore: () => Promise<ContentStore>;

	private wss: WebSocketServer | null = null;
	private sockets = new Set<WebSocket>();
	private channelSubscriptions = new Map<WebSocket, Map<string, () => void>>();
	// Table subscriptions for frontend protocol: { ws -> Set<table> }
	private tableSubscriptions = new Map<WebSocket, Set<string>>();
	// P477 AC-2: per-socket project scope. Updated on every "subscribe"
	// payload that carries a project_id; null means "no scope chosen yet"
	// so we fall back to the server-default project.
	private wsProjectScope = new Map<WebSocket, number | null>();

	private lastProposalCheck = new Date(0);
	private changePollTimer: ReturnType<typeof setInterval> | null = null;
	private roadmapEventsClient: PoolClient | null = null;
	private roadmapEventsReconnectTimer: ReturnType<typeof setTimeout> | null =
		null;
	private stopping = false;

	constructor(deps: WebSocketManagerDeps) {
		this.core = deps.core;
		this.getContentStore = deps.getContentStore;
	}

	/**
	 * Attach a WebSocketServer to the given HTTP server and wire connection
	 * handling. Called from `RoadmapServer.start()` after `createServer(...)`.
	 */
	setup(server: HttpServer): void {
		this.stopping = false;
		this.wss = new WebSocketServer({ server });
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
	}

	/** Start the 30s external-change polling loop and roadmap_events listener. */
	startBackgroundListeners(): void {
		this.startChangePolling();
		void this.startRoadmapEventsListener();
	}

	/**
	 * Tear down all WebSocket state, timers, and the roadmap_events listener.
	 * Called from `RoadmapServer.stop()`.
	 */
	async shutdown(): Promise<void> {
		this.stopping = true;

		if (this.changePollTimer) {
			clearInterval(this.changePollTimer);
			this.changePollTimer = null;
		}
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

		// Proactively close WebSocket connections
		for (const ws of this.sockets) {
			try {
				ws.close();
			} catch {}
		}
		this.sockets.clear();
		this.wss?.close();
		this.wss = null;
	}

	broadcastProposalsUpdated(): void {
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

	broadcastConfigUpdated(): void {
		for (const ws of this.sockets) {
			try {
				ws.send("config-updated");
			} catch {}
		}
	}

	// Poll for external DB changes (cron, MCP, direct SQL)
	private startChangePolling(): void {
		const POLL_INTERVAL = 30000; // 30 seconds
		this.changePollTimer = setInterval(async () => {
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

	private handleSubscribe(ws: WebSocket, channel: string): void {
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

	private handleUnsubscribe(ws: WebSocket, channel: string): void {
		const subs = this.channelSubscriptions.get(ws);
		const unsub = subs?.get(channel);
		if (unsub) {
			unsub();
			subs?.delete(channel);
		}
	}

	private cleanupSubscriptions(ws: WebSocket): void {
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
	): Promise<void> {
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

	private scheduleRoadmapEventsReconnect(): void {
		if (this.stopping || this.roadmapEventsReconnectTimer) return;
		this.roadmapEventsReconnectTimer = setTimeout(() => {
			this.roadmapEventsReconnectTimer = null;
			void this.startRoadmapEventsListener();
		}, 3000);
	}

	private async startRoadmapEventsListener(): Promise<void> {
		if (this.stopping || this.roadmapEventsClient) return;
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
	private async sendProposalSnapshot(ws: WebSocket): Promise<void> {
		try {
			const projectScope = this.wsProjectScope.get(ws) ?? null;
			console.log(
				`[WS] Sending proposal snapshot (project=${projectScope ?? "*"})...`,
			);
			await this.getContentStore();
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
	broadcastProposalUpdate(
		type: "proposal_update" | "proposal_insert" | "proposal_delete",
		data: any,
	): void {
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
}
