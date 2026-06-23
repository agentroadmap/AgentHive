import type { ProposalStatistics } from "../types/statistics.ts";
import { getStoredOperatorToken } from "./operator-token-storage";
import { getStoredProjectId } from "./project-scope-storage";
import type {
	Agent,
	Channel,
	Decision,
	Directive,
	Document,
	Message,
	Proposal,
	ProposalStatus,
	PulseEvent,
	RoadmapConfig,
	SearchPriorityFilter,
	SearchResult,
	SearchResultType,
} from "../../../shared/types/index.ts";

const API_BASE = "/api";

// ── AgentCentral Document (agentHive3 proposal tree) ────────────────────────
export interface AgcDocAcceptanceCriterion {
	item_number: number;
	criterion_text: string;
	status: string;
}
export interface AgcDocEdge {
	display_id: string;
	title: string;
	edge_type: string;
}
export interface AgcDocNode {
	id: number;
	display_id: string;
	parent_id: number | null;
	type: string;
	status: string;
	maturity: string;
	priority: number;
	title: string;
	summary: string | null;
	motivation: string | null;
	design: string | null;
	drawbacks: string | null;
	alternatives: string | null;
	tags: string[];
	acceptance_criteria: AgcDocAcceptanceCriterion[];
	deps_out: AgcDocEdge[];
	deps_in: AgcDocEdge[];
}
export interface AgcDocPayload {
	tenant: string;
	generated_at: string;
	total: number;
	nodes: AgcDocNode[];
}

export interface ConfigKeyDescriptor {
	name: string;
	class: "secret" | "structural" | "registry" | "flag" | "tenant_dsn";
	category: string | null;
	description: string | null;
	value: unknown;
	default_value: unknown;
	required: boolean;
	db_table: string | null;
	scope: string | null;
	editable: boolean;
	masked: boolean;
}

export interface ConfigMutationResult {
	key_name: string;
	new_value: unknown;
	mutation_id: string;
	applied_at: string;
}

export interface RouteRow {
	id: number;
	model_name: string;
	route_provider: string;
	agent_provider: string;
	agent_cli: string;
	fallback_cli: string;
	is_enabled: boolean;
	priority: number;
	api_spec: string;
	base_url: string;
	cost_per_million_input: number;
	cost_per_million_output: number;
	plan_type: string;
	notes: string;
	created_at: string;
	has_host_policy_match: boolean;
}

export interface ConfigKeyDescriptor {
	name: string;
	class: "secret" | "structural" | "registry" | "flag" | "tenant_dsn";
	category: string | null;
	description: string | null;
	value: unknown;
	default_value: unknown;
	required: boolean;
	db_table: string | null;
	scope: string | null;
	editable: boolean;
	masked: boolean;
}

export interface ConfigMutationResult {
	key_name: string;
	new_value: unknown;
	mutation_id: string;
	applied_at: string;
}

export interface ReorderProposalPayload {
	proposalId: string;
	targetStatus: string;
	orderedProposalIds: string[];
	targetDirective?: string | null;
}

// Enhanced error types for better error handling
export class ApiError extends Error {
	constructor(
		message: string,
		public status?: number,
		public code?: string,
		public data?: unknown,
	) {
		super(message);
		this.name = "ApiError";
	}

	static fromResponse(response: Response, data?: unknown): ApiError {
		const responseError =
			typeof data === "object" &&
			data !== null &&
			"error" in data &&
			typeof (data as { error?: unknown }).error === "string"
				? (data as { error: string }).error
				: null;
		const message = responseError
			? `HTTP ${response.status}: ${responseError}`
			: `HTTP ${response.status}: ${response.statusText}`;
		return new ApiError(message, response.status, response.statusText, data);
	}
}

export type ConfigKeyClass = "secret" | "structural" | "registry" | "flag" | "tenant_dsn";

export interface ConfigKeyDescriptor {
	name: string;
	class: ConfigKeyClass;
	category: string;
	description: string | null;
	value: unknown;
	default_value: unknown;
	required: boolean;
	editable: boolean;
	masked: boolean;
}

export interface ConfigMutationResult {
	key_name: string;
	scope: string;
	new_value: unknown;
	operator: string;
}

export class NetworkError extends Error {
	constructor(message = "Network request failed") {
		super(message);
		this.name = "NetworkError";
	}
}

// Request configuration interface
interface RequestConfig {
	retries?: number;
	timeout?: number;
	Headers?: Record<string, string>;
}

// Default configuration
const DEFAULT_CONFIG: RequestConfig = {
	retries: 3,
	timeout: 10000,
};

export class ApiClient {
	private config: RequestConfig;

	constructor(config: RequestConfig = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	// Enhanced fetch with retry logic and better error handling
	private async fetchWithRetry(
		url: string,
		options: RequestInit = {},
	): Promise<Response> {
		const { retries = 3, timeout = 10000 } = this.config;
		let lastError: Error | undefined;

		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				// Add timeout to the request
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), timeout);

				// P477 AC-2: every API request inherits the operator's
				// project scope from localStorage so the server's
				// resolveProjectScope picks the right tenant.
				const projectId = getStoredProjectId();
				const mergedHeaders: Record<string, string> = {
					"Content-Type": "application/json",
					...((options.headers as Record<string, string>) ?? {}),
				};
				if (projectId != null && !mergedHeaders["X-Project-Id"]) {
					mergedHeaders["X-Project-Id"] = String(projectId);
				}
				// Operator bearer token for requireOperator-gated mutations
				// (agency pause/resume/drain/retire, control stop/suspend/…).
				// Without it the server is fail-closed → "operator token is
				// missing". Read-only GETs ignore it server-side.
				const operatorToken = getStoredOperatorToken();
				if (operatorToken && !mergedHeaders.Authorization) {
					mergedHeaders.Authorization = `Bearer ${operatorToken}`;
				}

				const response = await fetch(url, {
					...options,
					signal: controller.signal,
					headers: mergedHeaders,
				});

				clearTimeout(timeoutId);

				if (!response.ok) {
					let errorData: unknown = null;
					try {
						errorData = await response.json();
					} catch {
						// Ignore JSON parse errors for error data
					}
					throw ApiError.fromResponse(response, errorData);
				}

				return response;
			} catch (error) {
				lastError = error as Error;

				// Don't retry on client errors (4xx) or specific cases
				if (
					error instanceof ApiError &&
					error.status &&
					error.status >= 400 &&
					error.status < 500
				) {
					throw error;
				}

				// For network errors or server errors, retry with exponential backoff
				if (attempt < retries) {
					const delay = Math.min(1000 * 2 ** attempt, 10000);
					await new Promise((resolve) => setTimeout(resolve, delay));
				}
			}
		}

		// If we get here, all retries failed
		if (lastError instanceof ApiError) {
			throw lastError;
		}
		throw new NetworkError(
			`Request failed after ${retries + 1} attempts: ${lastError?.message}`,
		);
	}

	// Helper method for JSON responses
	private async fetchJson<T>(
		url: string,
		options: RequestInit = {},
	): Promise<T> {
		const response = await this.fetchWithRetry(url, options);
		return response.json();
	}
	async fetchProposals(options?: {
		status?: string;
		assignee?: string;
		parent?: string;
		priority?: SearchPriorityFilter;
		labels?: string[];
		crossBranch?: boolean;
	}): Promise<Proposal[]> {
		const params = new URLSearchParams();
		if (options?.status) params.append("status", options.status);
		if (options?.assignee) params.append("assignee", options.assignee);
		if (options?.parent) params.append("parent", options.parent);
		if (options?.priority) params.append("priority", options.priority);
		if (options?.labels) {
			for (const label of options.labels) {
				if (label && label.trim().length > 0) {
					params.append("label", label.trim());
				}
			}
		}
		// Default to true for cross-branch loading to match TUI behavior
		if (options?.crossBranch !== false) params.append("crossBranch", "true");

		const url = `${API_BASE}/proposals${params.toString() ? `?${params.toString()}` : ""}`;
		return this.fetchJson<Proposal[]>(url);
	}

	async search(
		options: {
			query?: string;
			types?: SearchResultType[];
			status?: string | string[];
			priority?: SearchPriorityFilter | SearchPriorityFilter[];
			labels?: string[];
			limit?: number;
		} = {},
	): Promise<SearchResult[]> {
		const params = new URLSearchParams();
		if (options.query) {
			params.set("query", options.query);
		}
		if (options.types && options.types.length > 0) {
			for (const type of options.types) {
				params.append("type", type);
			}
		}
		if (options.status) {
			const statuses = Array.isArray(options.status)
				? options.status
				: [options.status];
			for (const status of statuses) {
				params.append("status", status);
			}
		}
		if (options.priority) {
			const priorities = Array.isArray(options.priority)
				? options.priority
				: [options.priority];
			for (const priority of priorities) {
				params.append("priority", priority);
			}
		}
		if (options.labels) {
			for (const label of options.labels) {
				if (label && label.trim().length > 0) {
					params.append("label", label.trim());
				}
			}
		}
		if (options.limit !== undefined) {
			params.set("limit", String(options.limit));
		}

		const url = `${API_BASE}/search${params.toString() ? `?${params.toString()}` : ""}`;
		return this.fetchJson<SearchResult[]>(url);
	}

	async fetchProposal(id: string): Promise<Proposal> {
		return this.fetchJson<Proposal>(`${API_BASE}/proposal/${id}`);
	}

	async fetchProposalDecisions(proposalId: string): Promise<Array<{
		id: number;
		decision: string;
		authority: string;
		rationale: string | null;
		binding: boolean;
		decided_at: string;
	}>> {
		const data = await this.fetchJson<{ decisions: any[] }>(
			`${API_BASE}/proposals/${encodeURIComponent(proposalId)}/decisions`,
		);
		return data.decisions;
	}

	async fetchProposalReviews(proposalId: string): Promise<Array<{
		id: number;
		reviewer_identity: string;
		verdict: string;
		notes: string | null;
		findings: string | null;
		is_blocking: boolean;
		reviewed_at: string;
	}>> {
		const data = await this.fetchJson<{ reviews: any[] }>(
			`${API_BASE}/proposals/${encodeURIComponent(proposalId)}/reviews`,
		);
		return data.reviews;
	}

	async fetchProposalDiscussions(proposalId: string): Promise<Array<{
		id: number;
		author_identity: string;
		context_prefix: string | null;
		body_markdown: string;
		created_at: string;
	}>> {
		const data = await this.fetchJson<{ notes: any[] }>(
			`${API_BASE}/proposals/${encodeURIComponent(proposalId)}/notes`,
		);
		return data.notes;
	}

	async createProposal(
		proposal: Omit<Proposal, "id" | "createdDate">,
	): Promise<Proposal> {
		return this.fetchJson<Proposal>(`${API_BASE}/proposals`, {
			method: "POST",
			body: JSON.stringify(proposal),
		});
	}

	async updateProposal(
		id: string,
		updates: Omit<Partial<Proposal>, "directive"> & {
			directive?: string | null;
		},
	): Promise<Proposal> {
		return this.fetchJson<Proposal>(`${API_BASE}/proposals/${id}`, {
			method: "PUT",
			body: JSON.stringify(updates),
		});
	}

	async reorderProposal(
		payload: ReorderProposalPayload,
	): Promise<{ success: boolean; proposal: Proposal }> {
		return this.fetchJson<{ success: boolean; proposal: Proposal }>(
			`${API_BASE}/proposals/reorder`,
			{
				method: "POST",
				body: JSON.stringify(payload),
			},
		);
	}

	async archiveProposal(id: string): Promise<void> {
		await this.fetchWithRetry(`${API_BASE}/proposals/${id}`, {
			method: "DELETE",
		});
	}

	async completeProposal(id: string): Promise<void> {
		await this.fetchWithRetry(`${API_BASE}/proposals/${id}/complete`, {
			method: "POST",
		});
	}

	async releaseProposal(id: string): Promise<void> {
		await this.fetchWithRetry(`${API_BASE}/proposals/${id}/release`, {
			method: "POST",
		});
	}

	async demoteProposal(id: string): Promise<void> {
		await this.fetchWithRetry(`${API_BASE}/proposals/${id}/demote`, {
			method: "POST",
		});
	}

	async getCleanupPreview(age: number): Promise<{
		count: number;
		proposals: Array<{
			id: string;
			title: string;
			updatedDate?: string;
			createdDate: string;
		}>;
	}> {
		return this.fetchJson<{
			count: number;
			proposals: Array<{
				id: string;
				title: string;
				updatedDate?: string;
				createdDate: string;
			}>;
		}>(`${API_BASE}/proposals/cleanup?age=${age}`);
	}

	async executeCleanup(age: number): Promise<{
		success: boolean;
		movedCount: number;
		totalCount: number;
		message: string;
		failedProposals?: string[];
	}> {
		return this.fetchJson<{
			success: boolean;
			movedCount: number;
			totalCount: number;
			message: string;
			failedProposals?: string[];
		}>(`${API_BASE}/proposals/cleanup/execute`, {
			method: "POST",
			body: JSON.stringify({ age }),
		});
	}

	async updateProposalStatus(
		id: string,
		status: ProposalStatus,
	): Promise<Proposal> {
		return this.updateProposal(id, { status });
	}

	async fetchStatuses(): Promise<string[]> {
		const response = await fetch(`${API_BASE}/statuses`);
		if (!response.ok) {
			throw new Error("Failed to fetch statuses");
		}
		return response.json();
	}

	async fetchConfigKeys(category?: string): Promise<{ keys: ConfigKeyDescriptor[]; count: number }> {
		const params = category ? `?category=${encodeURIComponent(category)}` : "";
		const response = await this.fetchWithRetry(`${API_BASE}/config/keys${params}`);
		if (!response.ok) {
			throw new Error("Failed to fetch config keys");
		}
		return response.json();
	}

	async mutateConfigKey(
		keyName: string,
		value: unknown,
		scope?: string,
	): Promise<ConfigMutationResult> {
		const response = await this.fetchWithRetry(`${API_BASE}/config/keys/${encodeURIComponent(keyName)}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ value, scope }),
		});
		if (!response.ok) {
			const data = await response.json().catch(() => ({ error: "Mutation failed" }));
			throw new Error(data.error || "Failed to update config key");
		}
		return response.json();
	}

	async fetchConfig(): Promise<RoadmapConfig> {
		const response = await fetch(`${API_BASE}/config`);
		if (!response.ok) {
			throw new Error("Failed to fetch config");
		}
		return response.json();
	}

	async updateConfig(config: RoadmapConfig): Promise<RoadmapConfig> {
		const response = await fetch(`${API_BASE}/config`, {
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(config),
		});
		if (!response.ok) {
			throw new Error("Failed to update config");
		}
		return response.json();
	}

	async fetchConfigKeys(category?: string): Promise<ConfigKeyDescriptor[]> {
		const url =
			category != null
				? `${API_BASE}/config/keys?category=${encodeURIComponent(category)}`
				: `${API_BASE}/config/keys`;
		const response = await this.fetchWithRetry(url);
		const data = (await response.json()) as { keys: ConfigKeyDescriptor[] };
		return data.keys;
	}

	async mutateConfigKey(keyName: string, value: unknown, scope?: string): Promise<ConfigMutationResult> {
		const response = await this.fetchWithRetry(`${API_BASE}/config/keys/${encodeURIComponent(keyName)}`, {
			method: "PUT",
			body: JSON.stringify({ value, ...(scope != null ? { scope } : {}) }),
		});
		return response.json() as Promise<ConfigMutationResult>;
	}

	async fetchDocs(): Promise<Document[]> {
		const response = await fetch(`${API_BASE}/docs`);
		if (!response.ok) {
			throw new Error("Failed to fetch documentation");
		}
		return response.json();
	}

	async fetchAgentCentralDocument(): Promise<AgcDocPayload> {
		const response = await fetch(`${API_BASE}/agentcentral/document`);
		if (!response.ok) {
			let detail = "";
			try {
				const body = await response.json();
				detail = body?.detail || body?.error || "";
			} catch {
				/* ignore */
			}
			throw new Error(
				detail || `Failed to fetch AgentCentral document (${response.status})`,
			);
		}
		return response.json();
	}

	async fetchDoc(filename: string): Promise<Document> {
		const response = await fetch(
			`${API_BASE}/docs/${encodeURIComponent(filename)}`,
		);
		if (!response.ok) {
			throw new Error("Failed to fetch document");
		}
		return response.json();
	}

	async fetchDocument(id: string): Promise<Document> {
		const response = await fetch(`${API_BASE}/doc/${encodeURIComponent(id)}`);
		if (!response.ok) {
			throw new Error("Failed to fetch document");
		}
		return response.json();
	}

	async updateDoc(
		filename: string,
		content: string,
		title?: string,
	): Promise<void> {
		const payload: Record<string, unknown> = { content };
		if (typeof title === "string") {
			payload.title = title;
		}

		const response = await fetch(
			`${API_BASE}/docs/${encodeURIComponent(filename)}`,
			{
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify(payload),
			},
		);
		if (!response.ok) {
			throw new Error("Failed to update document");
		}
	}

	async createDoc(filename: string, content: string): Promise<{ id: string }> {
		const response = await fetch(`${API_BASE}/docs`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ filename, content }),
		});
		if (!response.ok) {
			throw new Error("Failed to create document");
		}
		return response.json();
	}

	async fetchDecisions(): Promise<Decision[]> {
		const response = await fetch(`${API_BASE}/decisions`);
		if (!response.ok) {
			throw new Error("Failed to fetch decisions");
		}
		return response.json();
	}

	async fetchDecision(id: string): Promise<Decision> {
		const response = await fetch(
			`${API_BASE}/decisions/${encodeURIComponent(id)}`,
		);
		if (!response.ok) {
			throw new Error("Failed to fetch decision");
		}
		return response.json();
	}

	async fetchDecisionData(id: string): Promise<Decision> {
		const response = await fetch(
			`${API_BASE}/decision/${encodeURIComponent(id)}`,
		);
		if (!response.ok) {
			throw new Error("Failed to fetch decision");
		}
		return response.json();
	}

	async updateDecision(id: string, content: string): Promise<void> {
		const response = await fetch(
			`${API_BASE}/decisions/${encodeURIComponent(id)}`,
			{
				method: "PUT",
				headers: {
					"Content-Type": "text/plain",
				},
				body: content,
			},
		);
		if (!response.ok) {
			throw new Error("Failed to update decision");
		}
	}

	async createDecision(title: string): Promise<Decision> {
		const response = await fetch(`${API_BASE}/decisions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ title }),
		});
		if (!response.ok) {
			throw new Error("Failed to create decision");
		}
		return response.json();
	}

	async fetchDirectives(): Promise<Directive[]> {
		const response = await fetch(`${API_BASE}/directives`);
		if (!response.ok) {
			throw new Error("Failed to fetch directives");
		}
		return response.json();
	}

	async fetchArchivedDirectives(): Promise<Directive[]> {
		const response = await fetch(`${API_BASE}/directives/archived`);
		if (!response.ok) {
			throw new Error("Failed to fetch archived directives");
		}
		return response.json();
	}

	async fetchDirective(id: string): Promise<Directive> {
		const response = await fetch(
			`${API_BASE}/directives/${encodeURIComponent(id)}`,
		);
		if (!response.ok) {
			throw new Error("Failed to fetch directive");
		}
		return response.json();
	}

	async createDirective(
		title: string,
		description?: string,
	): Promise<Directive> {
		const response = await fetch(`${API_BASE}/directives`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ title, description }),
		});
		if (!response.ok) {
			const data = await response.json().catch(() => ({}));
			throw new Error(data.error || "Failed to create directive");
		}
		return response.json();
	}

	async archiveDirective(
		id: string,
	): Promise<{ success: boolean; directive?: Directive | null }> {
		const response = await fetch(
			`${API_BASE}/directives/${encodeURIComponent(id)}/archive`,
			{
				method: "POST",
			},
		);
		if (!response.ok) {
			const data = await response.json().catch(() => ({}));
			throw new Error(data.error || "Failed to archive directive");
		}
		return response.json();
	}

	async fetchStatistics(): Promise<
		ProposalStatistics & {
			statusCounts: Record<string, number>;
			priorityCounts: Record<string, number>;
		}
	> {
		return this.fetchJson<
			ProposalStatistics & {
				statusCounts: Record<string, number>;
				priorityCounts: Record<string, number>;
			}
		>(`${API_BASE}/statistics`);
	}

	async checkStatus(): Promise<{ initialized: boolean; projectPath: string }> {
		return this.fetchJson<{ initialized: boolean; projectPath: string }>(
			`${API_BASE}/status`,
		);
	}

	async initializeProject(options: {
		projectName: string;
		integrationMode: "mcp" | "cli" | "none";
		mcpClients?: ("claude" | "codex" | "gemini" | "kiro" | "guide")[];
		agentInstructions?: (
			| "CLAUDE.md"
			| "AGENTS.md"
			| "GEMINI.md"
			| ".github/copilot-instructions.md"
		)[];
		installClaudeAgent?: boolean;
		advancedConfig?: {
			checkActiveBranches?: boolean;
			remoteOperations?: boolean;
			activeBranchDays?: number;
			bypassGitHooks?: boolean;
			autoCommit?: boolean;
			zeroPaddedIds?: number;
			proposalPrefix?: string;
			defaultEditor?: string;
			defaultPort?: number;
			autoOpenBrowser?: boolean;
		};
	}): Promise<{
		success: boolean;
		projectName: string;
		mcpResults?: Record<string, string>;
	}> {
		return this.fetchJson<{
			success: boolean;
			projectName: string;
			mcpResults?: Record<string, string>;
		}>(`${API_BASE}/init`, {
			method: "POST",
			body: JSON.stringify(options),
		});
	}

	async fetchAgents(): Promise<Agent[]> {
		return this.fetchJson<Agent[]>(`${API_BASE}/agents`);
	}

	async fetchRoutes(): Promise<RouteRow[]> {
		const result = await this.fetchJson<{ routes: RouteRow[] }>(`${API_BASE}/routes`);
		return result.routes;
	}

	async toggleRoute(id: number, isEnabled: boolean): Promise<{ id: number; is_enabled: boolean }> {
		return this.fetchJson<{ id: number; is_enabled: boolean }>(`${API_BASE}/routes/${id}`, {
			method: "PATCH",
			body: JSON.stringify({ is_enabled: isEnabled }),
		});
	}

	async fetchDispatches(): Promise<any[]> {
		const result = await this.fetchJson<{ dispatches: any[] }>(`${API_BASE}/dispatches`);
		return result.dispatches;
	}

	async fetchAgencies(options?: {
		proposal?: string;
		agency?: string;
		route?: string;
		severity?: string;
	}): Promise<Array<Record<string, unknown>>> {
		const params = new URLSearchParams();
		if (options?.proposal) params.set("proposal", options.proposal);
		if (options?.agency) params.set("agency", options.agency);
		if (options?.route) params.set("route", options.route);
		if (options?.severity) params.set("severity", options.severity);
		const qs = params.toString();
		const result = await this.fetchJson<{ agencies: Array<Record<string, unknown>> }>(
			`${API_BASE}/agencies${qs ? `?${qs}` : ""}`,
		);
		return result.agencies;
	}

	async sendAgencyAction(
		agencyId: string,
		body: {
			action: "liaison_pause" | "liaison_resume" | "liaison_drain" | "claim_revoke" | "agency_retire";
			claim_id?: string;
			reason?: string;
			until_iso?: string | null;
		},
	): Promise<Record<string, unknown>> {
		return this.fetchJson<Record<string, unknown>>(
			`${API_BASE}/agencies/${encodeURIComponent(agencyId)}/action`,
			{
				method: "POST",
				body: JSON.stringify(body),
			},
		);
	}

	async fetchTeams(): Promise<any[]> {
		return this.fetchJson<any[]>(`${API_BASE}/teams`);
	}

	async fetchKnowledge(options?: { query?: string; type?: string }): Promise<any[]> {
		const params = new URLSearchParams();
		if (options?.query) params.set("query", options.query);
		if (options?.type) params.set("type", options.type);
		const qs = params.toString();
		return this.fetchJson<any[]>(`${API_BASE}/knowledge${qs ? `?${qs}` : ""}`);
	}

	async markKnowledgeHelpful(id: string): Promise<void> {
		await this.fetchWithRetry(`${API_BASE}/knowledge/${id}/helpful`, { method: "POST" });
	}

	async fetchPulse(limit?: number): Promise<PulseEvent[]> {
		const params = limit ? `?limit=${limit}` : "";
		return this.fetchJson<PulseEvent[]>(`${API_BASE}/pulse${params}`);
	}

	async fetchChannels(): Promise<Channel[]> {
		return this.fetchJson<Channel[]>(`${API_BASE}/channels`);
	}

	async fetchMessages(channel: string, since?: string): Promise<Message[]> {
		const params = new URLSearchParams({ channel });
		if (since) params.set("since", since);
		const result = await this.fetchJson<{
			channel: string;
			messages: Message[];
		}>(`${API_BASE}/messages?${params}`);
		return result.messages;
	}

	async sendMessage(channel: string, text: string, from = "@operator"): Promise<void> {
		await this.fetchWithRetry(`${API_BASE}/messages`, {
			method: "POST",
			body: JSON.stringify({ channel, text, from }),
		});
	}

	// ── P435: Operator Control API ────────────────────────────────────────────

	async fetchControlDispatches(projectId?: number): Promise<any[]> {
		const params = projectId != null ? `?project_id=${projectId}` : "";
		const result = await this.fetchJson<{ dispatches: any[] }>(
			`${API_BASE}/operator/control/dispatches${params}`,
		);
		return result.dispatches ?? [];
	}

	async fetchControlAgencies(status?: string): Promise<any[]> {
		const params = status ? `?status=${encodeURIComponent(status)}` : "";
		const result = await this.fetchJson<{ agencies: any[] }>(
			`${API_BASE}/operator/control/agencies${params}`,
		);
		return result.agencies ?? [];
	}

	async fetchControlWorkers(opts?: { agencyId?: string; dispatchId?: number }): Promise<any[]> {
		const params = new URLSearchParams();
		if (opts?.agencyId) params.set("agency_id", opts.agencyId);
		if (opts?.dispatchId != null) params.set("dispatch_id", String(opts.dispatchId));
		const qs = params.toString();
		const result = await this.fetchJson<{ workers: any[] }>(
			`${API_BASE}/operator/control/workers${qs ? `?${qs}` : ""}`,
		);
		return result.workers ?? [];
	}

	async operatorStop(body: {
		scope_type: string;
		scope_id: string;
		reason?: string;
	}): Promise<{ result: string }> {
		return this.fetchJson<{ result: string }>(`${API_BASE}/operator/control/stop`, {
			method: "POST",
			body: JSON.stringify(body),
		});
	}

	async suspendAgency(agencyId: string, reason?: string): Promise<{ result: string }> {
		return this.fetchJson<{ result: string }>(
			`${API_BASE}/operator/control/suspend-agency`,
			{ method: "POST", body: JSON.stringify({ agency_id: agencyId, reason }) },
		);
	}

	async drainHost(hostId: string, graceSeconds?: number, reason?: string): Promise<{ result: string }> {
		return this.fetchJson<{ result: string }>(
			`${API_BASE}/operator/control/drain-host`,
			{
				method: "POST",
				body: JSON.stringify({ host_id: hostId, grace_seconds: graceSeconds ?? 0, reason }),
			},
		);
	}

	async cancelDispatch(dispatchId: number, reason?: string): Promise<{ result: string }> {
		return this.fetchJson<{ result: string }>(
			`${API_BASE}/operator/control/cancel-dispatch`,
			{ method: "POST", body: JSON.stringify({ dispatch_id: dispatchId, reason }) },
		);
	}

	async terminateWorker(workerId: string, signal?: string, reason?: string): Promise<{ result: string }> {
		return this.fetchJson<{ result: string }>(
			`${API_BASE}/operator/control/terminate-worker`,
			{ method: "POST", body: JSON.stringify({ worker_id: workerId, signal, reason }) },
		);
	}

	async fetchControlFeed(opts?: {
		projectId?: number;
		proposalId?: number;
		dispatchId?: number;
		eventClass?: string;
		since?: string;
		limit?: number;
	}): Promise<any[]> {
		const params = new URLSearchParams();
		if (opts?.projectId != null) params.set("project_id", String(opts.projectId));
		if (opts?.proposalId != null) params.set("proposal_id", String(opts.proposalId));
		if (opts?.dispatchId != null) params.set("dispatch_id", String(opts.dispatchId));
		if (opts?.eventClass) params.set("event_class", opts.eventClass);
		if (opts?.since) params.set("since", opts.since);
		if (opts?.limit != null) params.set("limit", String(opts.limit));
		const qs = params.toString();
		const result = await this.fetchJson<{ events: any[] }>(
			`${API_BASE}/operator/control/feed${qs ? `?${qs}` : ""}`,
		);
		return result.events ?? [];
	}

	async fetchControlReplay(dispatchId: number): Promise<any[]> {
		const result = await this.fetchJson<{ events: any[] }>(
			`${API_BASE}/operator/control/replay/${dispatchId}`,
		);
		return result.events ?? [];
	}

	// P3784/P3785: Config key registry
	async fetchConfigKeys(category?: string): Promise<ConfigKeyDescriptor[]> {
		const url = category
			? `${API_BASE}/config/keys?category=${encodeURIComponent(category)}`
			: `${API_BASE}/config/keys`;
		const result = await this.fetchJson<{ keys: ConfigKeyDescriptor[] }>(url);
		return result.keys ?? [];
	}

	async mutateConfigKey(
		keyName: string,
		value: unknown,
		scope?: string,
	): Promise<ConfigMutationResult> {
		return this.fetchJson<ConfigMutationResult>(
			`${API_BASE}/config/keys/${encodeURIComponent(keyName)}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ value, scope }),
			},
		);
	}

	// P705 Phase 4: Mark notification as seen
	async markNotificationSeen(notificationId: string): Promise<{
		success: boolean;
		notification: {
			id: string;
			severity: string;
			title: string;
			message: string;
			created_at: string;
			seen: boolean;
		};
	}> {
		return this.fetchJson<{
			success: boolean;
			notification: {
				id: string;
				severity: string;
				title: string;
				message: string;
				created_at: string;
				seen: boolean;
			};
		}>(`${API_BASE}/notifications/${encodeURIComponent(notificationId)}/seen`, {
			method: "PATCH",
		});
	}
}

export const apiClient = new ApiClient();
