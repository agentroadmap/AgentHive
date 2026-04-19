import type { ProposalStatistics } from "../../../core/infrastructure/statistics.ts";
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
		const message = `HTTP ${response.status}: ${response.statusText}`;
		return new ApiError(message, response.status, response.statusText, data);
	}
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

				const response = await fetch(url, {
					...options,
					signal: controller.signal,
					headers: {
						"Content-Type": "application/json",
						...options.headers,
					},
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

	async fetchDocs(): Promise<Document[]> {
		const response = await fetch(`${API_BASE}/docs`);
		if (!response.ok) {
			throw new Error("Failed to fetch documentation");
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

	async fetchRoutes(): Promise<any[]> {
		const result = await this.fetchJson<{ routes: any[] }>(`${API_BASE}/routes`);
		return result.routes;
	}

	async fetchDispatches(): Promise<any[]> {
		const result = await this.fetchJson<{ dispatches: any[] }>(`${API_BASE}/dispatches`);
		return result.dispatches;
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
}

export const apiClient = new ApiClient();
