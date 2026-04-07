/**
 * DaemonClient - HTTP client for communicating with the Roadmap.md daemon.
 *
 * When a daemon is running, CLI and MCP operations can be routed through
 * the daemon API instead of direct filesystem access. The daemon becomes
 * the single source of truth for all proposal mutations.
 */

import type {
	Agent,
	Decision,
	Directive,
	Document,
	Proposal,
	ProposalCreateInput,
	ProposalUpdateInput,
	PulseEvent,
	RoadmapConfig,
	SearchResult,
} from "../../types/index.ts";

export interface DaemonClientOptions {
	/** Base URL of the daemon (e.g., "http://localhost:6420") */
	baseUrl: string;
	/** Request timeout in milliseconds (default: 30000) */
	timeout?: number;
}

export interface DaemonHealthStatus {
	initialized: boolean;
	projectPath: string;
}

/**
 * Client for communicating with the Roadmap.md daemon HTTP API.
 * Used by CLI and MCP tools to route operations through the daemon
 * instead of direct filesystem access.
 */
export class DaemonClient {
	private readonly baseUrl: string;
	private readonly timeout: number;

	constructor(options: DaemonClientOptions) {
		// Remove trailing slash for consistency
		this.baseUrl = options.baseUrl.replace(/\/$/, "");
		this.timeout = options.timeout ?? 30000;
	}

	/**
	 * Check if the daemon is reachable and healthy.
	 */
	async healthCheck(): Promise<DaemonHealthStatus | null> {
		try {
			const response = await this.request<DaemonHealthStatus>(
				"GET",
				"/api/status",
			);
			return response;
		} catch {
			return null;
		}
	}

	/**
	 * Check if the daemon is available (reaches /api/status).
	 */
	async isAvailable(): Promise<boolean> {
		const health = await this.healthCheck();
		return health !== null;
	}

	// ─── Proposal Operations ────────────────────────────────────────────────

	/**
	 * List proposals with optional filtering.
	 */
	async listProposals(filters?: {
		status?: string;
		assignee?: string;
		priority?: string;
		labels?: string[];
	}): Promise<Proposal[]> {
		const params = new URLSearchParams();
		if (filters?.status) params.set("status", filters.status);
		if (filters?.assignee) params.set("assignee", filters.assignee);
		if (filters?.priority) params.set("priority", filters.priority);
		if (filters?.labels) {
			for (const label of filters.labels) {
				params.append("label", label);
			}
		}
		const query = params.toString();
		return this.request<Proposal[]>(
			"GET",
			`/api/proposals${query ? `?${query}` : ""}`,
		);
	}

	/**
	 * Get a single proposal by ID (supports loose IDs like "37" or "STATE-37").
	 */
	async getProposal(id: string): Promise<Proposal | null> {
		try {
			return await this.request<Proposal>(
				"GET",
				`/api/proposal/${encodeURIComponent(id)}`,
			);
		} catch (error: any) {
			if (error?.status === 404) return null;
			throw error;
		}
	}

	/**
	 * Create a new proposal.
	 */
	async createProposal(input: ProposalCreateInput): Promise<Proposal> {
		const payload: Record<string, unknown> = {
			title: input.title,
		};
		if (input.description) payload.description = input.description;
		if (input.status) payload.status = input.status;
		if (input.priority) payload.priority = input.priority;
		if (input.labels) payload.labels = input.labels;
		if (input.assignee) payload.assignee = input.assignee;
		if (input.dependencies) payload.dependencies = input.dependencies;
		if (input.references) payload.references = input.references;
		if (input.directive) payload.directive = input.directive;
		if (input.parentProposalId)
			payload.parentProposalId = input.parentProposalId;
		if (input.implementationPlan)
			payload.implementationPlan = input.implementationPlan;
		if (input.implementationNotes)
			payload.implementationNotes = input.implementationNotes;
		if (input.acceptanceCriteria) {
			payload.acceptanceCriteriaItems = input.acceptanceCriteria.map((ac) => ({
				text: ac.text,
				checked: ac.checked ?? false,
			}));
		}

		return this.request<Proposal>("POST", "/api/proposals", payload);
	}

	/**
	 * Update an existing proposal.
	 */
	async updateProposal(
		id: string,
		updates: ProposalUpdateInput,
	): Promise<Proposal | null> {
		try {
			const payload: Record<string, unknown> = {};
			if (updates.title !== undefined) payload.title = updates.title;
			if (updates.description !== undefined)
				payload.description = updates.description;
			if (updates.status !== undefined) payload.status = updates.status;
			if (updates.priority !== undefined) payload.priority = updates.priority;
			if (updates.labels !== undefined) payload.labels = updates.labels;
			if (updates.assignee !== undefined) payload.assignee = updates.assignee;
			if (updates.dependencies !== undefined)
				payload.dependencies = updates.dependencies;
			if (updates.references !== undefined)
				payload.references = updates.references;
			if (updates.directive !== undefined)
				payload.directive = updates.directive;
			if (updates.implementationPlan !== undefined)
				payload.implementationPlan = updates.implementationPlan;
			if (updates.implementationNotes !== undefined)
				payload.implementationNotes = updates.implementationNotes;
			if (updates.finalSummary !== undefined)
				payload.finalSummary = updates.finalSummary;
			if (updates.acceptanceCriteria !== undefined) {
				payload.acceptanceCriteriaItems = updates.acceptanceCriteria.map(
					(ac) => ({
						text: ac.text,
						checked: ac.checked ?? false,
					}),
				);
			}

			return await this.request<Proposal>(
				"PUT",
				`/api/proposals/${encodeURIComponent(id)}`,
				payload,
			);
		} catch (error: any) {
			if (error?.status === 404) return null;
			throw error;
		}
	}

	/**
	 * Delete (archive) a proposal.
	 */
	async deleteProposal(id: string): Promise<boolean> {
		try {
			await this.request<{ success: boolean }>(
				"DELETE",
				`/api/proposals/${encodeURIComponent(id)}`,
			);
			return true;
		} catch (error: any) {
			if (error?.status === 404) return false;
			throw error;
		}
	}

	/**
	 * Complete a proposal (move to completed folder).
	 */
	async completeProposal(id: string): Promise<boolean> {
		try {
			await this.request<{ success: boolean }>(
				"POST",
				`/api/proposals/${encodeURIComponent(id)}/complete`,
			);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Release a proposal claim.
	 */
	async releaseProposal(id: string): Promise<boolean> {
		try {
			await this.request<{ success: boolean }>(
				"POST",
				`/api/proposals/${encodeURIComponent(id)}/release`,
			);
			return true;
		} catch {
			return false;
		}
	}

	// ─── Search Operations ───────────────────────────────────────────────

	/**
	 * Search proposals, documents, and decisions.
	 */
	async search(params: {
		query?: string;
		limit?: number;
		types?: Array<"proposal" | "document" | "decision">;
		filters?: {
			status?: string | string[];
			priority?: string | string[];
			labels?: string | string[];
		};
	}): Promise<SearchResult[]> {
		const searchParams = new URLSearchParams();
		if (params.query) searchParams.set("query", params.query);
		if (params.limit) searchParams.set("limit", String(params.limit));
		if (params.types) {
			for (const type of params.types) searchParams.append("type", type);
		}
		if (params.filters?.status) {
			const statuses = Array.isArray(params.filters.status)
				? params.filters.status
				: [params.filters.status];
			for (const s of statuses) searchParams.append("status", s);
		}
		if (params.filters?.priority) {
			const priorities = Array.isArray(params.filters.priority)
				? params.filters.priority
				: [params.filters.priority];
			for (const p of priorities) searchParams.append("priority", p);
		}
		if (params.filters?.labels) {
			const labels = Array.isArray(params.filters.labels)
				? params.filters.labels
				: [params.filters.labels];
			for (const l of labels) searchParams.append("label", l);
		}
		return this.request<SearchResult[]>(
			"GET",
			`/api/search?${searchParams.toString()}`,
		);
	}

	// ─── Document Operations ─────────────────────────────────────────────

	/**
	 * List documents.
	 */
	async listDocs(): Promise<
		Array<{ id: string; title: string; type: string }>
	> {
		return this.request("GET", "/api/docs");
	}

	/**
	 * Get a document by ID.
	 */
	async getDoc(id: string): Promise<Document | null> {
		try {
			return await this.request<Document>(
				"GET",
				`/api/doc/${encodeURIComponent(id)}`,
			);
		} catch (error: any) {
			if (error?.status === 404) return null;
			throw error;
		}
	}

	// ─── Decision Operations ─────────────────────────────────────────────

	/**
	 * List decisions.
	 */
	async listDecisions(): Promise<Decision[]> {
		return this.request<Decision[]>("GET", "/api/decisions");
	}

	// ─── Directive Operations ────────────────────────────────────────────

	/**
	 * List directives.
	 */
	async listDirectives(): Promise<Directive[]> {
		return this.request<Directive[]>("GET", "/api/directives");
	}

	// ─── Configuration ───────────────────────────────────────────────────

	/**
	 * Get the current configuration.
	 */
	async getConfig(): Promise<RoadmapConfig | null> {
		try {
			return await this.request<RoadmapConfig>("GET", "/api/config");
		} catch {
			return null;
		}
	}

	// ─── Agent Operations ────────────────────────────────────────────────

	/**
	 * List registered agents.
	 */
	async listAgents(): Promise<Agent[]> {
		return this.request<Agent[]>("GET", "/api/agents");
	}

	// ─── Pulse/Activity ──────────────────────────────────────────────────

	/**
	 * List recent pulse events.
	 */
	async listPulse(limit?: number): Promise<PulseEvent[]> {
		const params = limit ? `?limit=${limit}` : "";
		return this.request<PulseEvent[]>("GET", `/api/pulse${params}`);
	}

	// ─── Version & Statistics ────────────────────────────────────────────

	/**
	 * Get the server version.
	 */
	async getVersion(): Promise<string> {
		const result = await this.request<{ version: string }>(
			"GET",
			"/api/version",
		);
		return result.version;
	}

	// ─── Proposal ID Allocation (STATE-55) ──────────────────────────────────

	/**
	 * Allocate proposal ID(s) from the daemon's centralized registry.
	 * Returns reserved IDs that are guaranteed unique.
	 */
	async allocateProposalId(request: {
		sessionId: string;
		count?: number;
		prefix?: string;
	}): Promise<{
		ids: string[];
		rangeStart: number;
		rangeEnd: number;
		timestamp: string;
	} | null> {
		try {
			return await this.request("POST", "/api/id-registry/allocate", {
				sessionId: request.sessionId,
				count: request.count ?? 1,
				prefix: request.prefix ?? "STATE",
			});
		} catch {
			return null;
		}
	}

	/**
	 * Release allocated ID range back to the pool (e.g., on session end or error).
	 */
	async releaseIdRange(sessionId: string): Promise<boolean> {
		try {
			await this.request<{ success: boolean }>(
				"POST",
				"/api/id-registry/release",
				{ sessionId },
			);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Get current ID registry status (for debugging/monitoring).
	 */
	async getIdRegistryStatus(): Promise<{
		nextId: number;
		reservedRanges: Array<{
			sessionId: string;
			rangeStart: number;
			rangeEnd: number;
			expiresAt: string;
		}>;
		totalAllocations: number;
	} | null> {
		try {
			return await this.request("GET", "/api/id-registry/status");
		} catch {
			return null;
		}
	}

	/**
	 * Check if a specific ID is already in use.
	 */
	async checkIdCollision(
		id: string,
	): Promise<{ exists: boolean; proposal?: Proposal }> {
		try {
			return await this.request(
				"GET",
				`/api/id-registry/check/${encodeURIComponent(id)}`,
			);
		} catch {
			return { exists: false };
		}
	}

	// ─── Private Helpers ─────────────────────────────────────────────────

	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<T> {
		const url = `${this.baseUrl}${path}`;
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeout);

		try {
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
			};

			const response = await fetch(url, {
				method,
				headers,
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal: controller.signal,
			});

			if (!response.ok) {
				const errorBody = await response.text().catch(() => "");
				const error = new Error(
					`Daemon API error: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody}` : ""}`,
				);
				(error as any).status = response.status;
				(error as any).statusText = response.statusText;
				throw error;
			}

			// Handle 204 No Content
			if (response.status === 204) {
				return undefined as T;
			}

			return (await response.json()) as T;
		} finally {
			clearTimeout(timeoutId);
		}
	}
}

/**
 * Detect daemon URL from environment or config.
 * Priority:
 * 1. ROADMAP_DAEMON_URL environment variable
 * 2. Config file daemonUrl setting
 * 3. Default localhost:6420 (if daemon is expected)
 */
export function resolveDaemonUrl(
	configDaemonUrl?: string,
	envUrl?: string,
): string | null {
	// Environment variable takes highest priority
	const envValue =
		envUrl ??
		(typeof process !== "undefined"
			? process.env.ROADMAP_DAEMON_URL
			: undefined);
	if (envValue) {
		return envValue;
	}

	// Then config
	if (configDaemonUrl) {
		return configDaemonUrl;
	}

	return null;
}

/**
 * Create a DaemonClient from config, returning null if no daemon URL is configured.
 */
export function createDaemonClientFromConfig(
	config?: RoadmapConfig & { daemonUrl?: string },
): DaemonClient | null {
	const url = resolveDaemonUrl(config?.daemonUrl);
	if (!url) {
		return null;
	}
	return new DaemonClient({ baseUrl: url });
}
