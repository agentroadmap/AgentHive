/**
 * SpacetimeDB CLI Adapter
 *
 * Implements STATE-77: SpacetimeDB CLI Integration Layer
 *
 * Bridges the existing roadmap CLI to SpacetimeDB backend.
 * Provides gradual migration from file-based to database-backed storage.
 *
 * AC#1: SpacetimeDBAdapter class implementing ProposalStorage interface
 * AC#2: Config option for storage backend selection (file | spacetimedb)
 * AC#3: Proposal CRUD operations via SpacetimeDB reducers
 * AC#4: Query operations (get_ready_work, get_by_agent, get_by_status)
 * AC#5: Connection management with exponential backoff reconnection
 * AC#6: Adapter tests for interface compliance and error handling
 */

import type {
	DatabaseProposalStatus,
	RoadmapProposalRow,
	ProposalQueryFilter,
	ProposalQueryOptions,
	CreateProposalInput,
	UpdateProposalInput,
} from "./proposal-types.ts";
import { SpacetimeDBProposalStorage, globalProposalStorage } from "./proposal-storage.ts";

// ===================== Proposal Interface (matches CLI types) =====================

/** Minimal Proposal interface matching CLI expectations */
export interface CLIProposal {
	id: string;
	title: string;
	status: string;
	assignee?: string[];
	createdDate: string;
	updatedDate?: string;
	labels?: string[];
	directive?: string;
	dependencies?: string[];
	body?: string;
	content?: string;
	type?: string;
	proposalType?: string;
	domainId?: string;
	category?: string;
	ready?: boolean;
	priority?: string;
	maturity?: string;
}

/** Query filter for CLI operations */
export interface CLIProposalQuery {
	status?: string;
	assignee?: string;
	labels?: string[];
	priority?: string;
	maturity?: string;
}

// ===================== Storage Configuration =====================

/** Storage backend type */
export type StorageBackend = "file" | "spacetimedb";

/** SpacetimeDB connection configuration */
export interface SpacetimeDBConfig {
	uri?: string;
	dbName?: string;
	autoConnect?: boolean;
	reconnectOnFailure?: boolean;
	maxReconnectAttempts?: number;
	reconnectDelayMs?: number;
}

/** Full storage configuration */
export interface StorageConfig {
	backend: StorageBackend;
	spacetimedb?: SpacetimeDBConfig;
}

// ===================== SpacetimeDB Adapter =====================

/**
 * SpacetimeDB Adapter for CLI Integration
 *
 * Implements AC#1: ProposalStorage-like interface for SpacetimeDB backend
 * Implements AC#5: Connection management with exponential backoff
 */
export class SpacetimeDBAdapter {
	private storage: SpacetimeDBProposalStorage;
	private connected = false;
	private reconnectAttempts = 0;
	private maxReconnectAttempts: number;
	private reconnectDelayMs: number;

	constructor(config: SpacetimeDBConfig = {}) {
		// Create fresh storage instance for isolation
		// When real SpacetimeDB is available, this would connect to remote server
		this.storage = new SpacetimeDBProposalStorage();
		this.maxReconnectAttempts = config.maxReconnectAttempts ?? 5;
		this.reconnectDelayMs = config.reconnectDelayMs ?? 1000;
	}

	// ===================== Connection Management (AC#5) =====================

	/**
	 * Connect to SpacetimeDB backend
	 * AC#5: Connection management
	 */
	async connect(): Promise<void> {
		// In current in-memory implementation, connection is instant
		// Real implementation would connect to SpacetimeDB server
		this.connected = true;
		this.reconnectAttempts = 0;
		return Promise.resolve();
	}

	/**
	 * Disconnect from SpacetimeDB backend
	 * AC#5: Connection management
	 */
	async disconnect(): Promise<void> {
		this.connected = false;
		return Promise.resolve();
	}

	/**
	 * Check if adapter is connected
	 */
	isConnected(): boolean {
		return this.connected;
	}

	/**
	 * Ensure connected, reconnecting if necessary
	 * AC#5: Reconnection with exponential backoff
	 */
	private async ensureConnected(): Promise<void> {
		if (this.connected) return;

		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			throw new Error(`SpacetimeDB: Max reconnect attempts (${this.maxReconnectAttempts}) exceeded`);
		}

		const delay = Math.min(
			this.reconnectDelayMs * 2 ** this.reconnectAttempts,
			30000 // Cap at 30 seconds
		);
		this.reconnectAttempts++;

		await new Promise(resolve => setTimeout(resolve, delay));
		await this.connect();
	}

	// ===================== CRUD Operations (AC#3) =====================

	/**
	 * Get a single proposal by ID
	 * AC#3: Read operation
	 */
	async getProposal(id: string): Promise<CLIProposal | null> {
		await this.ensureConnected();
		const row = this.storage.getProposal(id);
		return row ? this.rowToCLIProposal(row) : null;
	}

	/**
	 * Create a new proposal
	 * AC#3: Create operation
	 */
	async createProposal(input: {
		id: string;
		title: string;
		status?: string;
		priority?: string;
		maturity?: string;
		assignee?: string[];
		content?: string;
		dependencies?: string[];
		labels?: string[];
		type?: string;
		proposalType?: string;
		domainId?: string;
		category?: string;
		ready?: boolean;
		directive?: string;
	}): Promise<CLIProposal> {
		await this.ensureConnected();

		const createInput: CreateProposalInput = {
			id: input.id,
			title: input.title,
			status: input.status as DatabaseProposalStatus,
			priority: input.priority as any,
			maturity: input.maturity as any,
			assignee: input.assignee,
			content: input.content,
			dependencies: input.dependencies,
			labels: input.labels,
			type: input.type as any,
			proposalType: input.proposalType,
			domainId: input.domainId,
			category: input.category,
			ready: input.ready,
			directive: input.directive,
		};

		const row = this.storage.createProposal(createInput);
		return this.rowToCLIProposal(row);
	}

	/**
	 * Update an existing proposal
	 * AC#3: Update operation
	 */
	async updateProposal(id: string, updates: {
		title?: string;
		status?: string;
		priority?: string;
		maturity?: string;
		assignee?: string[];
		content?: string;
		dependencies?: string[];
		labels?: string[];
		type?: string;
		proposalType?: string;
		domainId?: string;
		category?: string;
		ready?: boolean;
		directive?: string;
	}): Promise<CLIProposal> {
		await this.ensureConnected();

		const updateInput: UpdateProposalInput = {
			title: updates.title,
			status: updates.status as DatabaseProposalStatus,
			priority: updates.priority as any,
			maturity: updates.maturity as any,
			assignee: updates.assignee,
			content: updates.content,
			dependencies: updates.dependencies,
			labels: updates.labels,
			type: updates.type as any,
			proposalType: updates.proposalType,
			domainId: updates.domainId,
			category: updates.category,
			ready: updates.ready,
			directive: updates.directive,
		};

		const row = this.storage.updateProposal(id, updateInput);
		return this.rowToCLIProposal(row);
	}

	/**
	 * Delete a proposal
	 * AC#3: Delete operation
	 */
	async deleteProposal(id: string): Promise<void> {
		await this.ensureConnected();
		this.storage.deleteProposal(id);
	}

	/**
	 * Transition proposal status
	 * AC#3: Status transition operation
	 */
	async transitionProposal(id: string, newStatus: string): Promise<CLIProposal> {
		await this.ensureConnected();
		const row = this.storage.transitionProposal(id, newStatus as DatabaseProposalStatus);
		return this.rowToCLIProposal(row);
	}

	// ===================== Query Operations (AC#4) =====================

	/**
	 * Get all proposals matching a filter
	 * AC#4: Generic query operation
	 */
	async getProposals(options?: {
		filter?: CLIProposalQuery;
		sort?: { field: string; direction: "asc" | "desc" };
		limit?: number;
		offset?: number;
	}): Promise<CLIProposal[]> {
		await this.ensureConnected();

		const queryOptions: ProposalQueryOptions = {};

		if (options?.filter) {
			queryOptions.filter = {} as ProposalQueryFilter;
			if (options.filter.status) {
				queryOptions.filter!.status = options.filter.status as DatabaseProposalStatus;
			}
			if (options.filter.assignee) {
				queryOptions.filter!.assignee = options.filter.assignee;
			}
			if (options.filter.priority) {
				queryOptions.filter!.priority = options.filter.priority as any;
			}
			if (options.filter.maturity) {
				queryOptions.filter!.maturity = options.filter.maturity as any;
			}
		}

		if (options?.sort) {
			queryOptions.sort = {
				field: options.sort.field as any,
				direction: options.sort.direction,
			};
		}

		if (options?.limit || options?.offset) {
			queryOptions.pagination = {
				limit: options.limit,
				offset: options.offset,
			};
		}

		const rows = this.storage.getProposals(queryOptions);
		return rows.map(row => this.rowToCLIProposal(row));
	}

	/**
	 * Get ready work proposals (unassigned, Ready status)
	 * AC#4: Common query pattern
	 */
	async getReadyWork(): Promise<CLIProposal[]> {
		await this.ensureConnected();
		const rows = this.storage.getReadyWork();
		return rows.map(row => this.rowToCLIProposal(row));
	}

	/**
	 * Get proposals assigned to an agent
	 * AC#4: Agent-specific query
	 */
	async getProposalsByAgent(agentId: string): Promise<CLIProposal[]> {
		await this.ensureConnected();
		const rows = this.storage.getByAgent(agentId);
		return rows.map(row => this.rowToCLIProposal(row));
	}

	/**
	 * Get proposals by status
	 * AC#4: Status-based query
	 */
	async getProposalsByStatus(status: string): Promise<CLIProposal[]> {
		await this.ensureConnected();
		const rows = this.storage.getByStatus(status as DatabaseProposalStatus);
		return rows.map(row => this.rowToCLIProposal(row));
	}

	/**
	 * Get proposals by label
	 */
	async getProposalsByLabel(label: string): Promise<CLIProposal[]> {
		await this.ensureConnected();
		const rows = this.storage.getByLabel(label);
		return rows.map(row => this.rowToCLIProposal(row));
	}

	// ===================== Subscription Operations =====================

	/**
	 * Subscribe to proposal changes
	 */
	subscribe(callback: (type: "insert" | "update" | "delete", proposal: CLIProposal, oldProposal?: CLIProposal) => void): { id: number } {
		return this.storage.subscribe((type, row, oldRow) => {
			callback(type, this.rowToCLIProposal(row), oldRow ? this.rowToCLIProposal(oldRow) : undefined);
		});
	}

	/**
	 * Unsubscribe from proposal changes
	 */
	unsubscribe(handle: { id: number }): boolean {
		return this.storage.unsubscribe({ id: handle.id, callback: () => {} });
	}

	// ===================== Utility Operations =====================

	/**
	 * Get total proposal count
	 */
	async getTotalCount(): Promise<number> {
		await this.ensureConnected();
		return this.storage.getTotalCount();
	}

	/**
	 * Get status counts
	 */
	async getStatusCounts(): Promise<Map<string, number>> {
		await this.ensureConnected();
		const counts = this.storage.getStatusCounts();
		const result = new Map<string, number>();
		for (const [status, count] of counts) {
			result.set(status, count);
		}
		return result;
	}

	/**
	 * Get all labels
	 */
	async getAllLabels(): Promise<string[]> {
		await this.ensureConnected();
		return this.storage.getAllLabels();
	}

	/**
	 * Get activity log for a proposal
	 */
	async getActivityLog(proposalId: string): Promise<Array<{
		id: number;
		proposalId: string;
		timestamp: number;
		action: string;
		agentId: string;
		details: string | null;
	}>> {
		await this.ensureConnected();
		return this.storage.getActivityLog(proposalId);
	}

	// ===================== Conversion Helpers =====================

	/**
	 * Convert database row to CLI proposal format
	 */
	private rowToCLIProposal(row: RoadmapProposalRow): CLIProposal {
		const createdDate = new Date(row.createdDate).toISOString();
		const updatedDate = new Date(row.updatedDate).toISOString();

		return {
			id: row.id,
			title: row.title,
			status: row.status,
			assignee: row.assignee ? row.assignee.split(",") : [],
			createdDate,
			updatedDate,
			labels: [], // Would need to query labels table
			directive: row.directive ?? undefined,
			dependencies: row.dependencies ? row.dependencies.split(",") : [],
			body: row.content,
			content: row.content,
			type: row.type,
			proposalType: row.proposalType,
			domainId: row.domainId,
			category: row.category,
			ready: row.ready,
			priority: row.priority,
			maturity: row.maturity,
		};
	}
}

// ===================== Storage Factory (AC#2) =====================

/**
 * Create storage based on configuration
 * AC#2: Config option for storage backend selection
 */
export function createStorage(config?: StorageConfig): SpacetimeDBAdapter | null {
	const backend = config?.backend ?? "file";

	if (backend === "spacetimedb") {
		return new SpacetimeDBAdapter(config?.spacetimedb);
	}

	// Return null for file backend (use existing file-based storage)
	return null;
}

/**
 * Get storage backend from roadmap config
 * Reads from roadmap config file to determine backend
 */
export function getStorageBackend(): StorageBackend {
	// Check environment variable first
	const envBackend = process.env.ROADMAP_STORAGE_BACKEND;
	if (envBackend === "spacetimedb" || envBackend === "file") {
		return envBackend;
	}

	// Default to file for backward compatibility
	return "file";
}

// ===================== Singleton Instance =====================

/** Default adapter instance for convenience */
export let defaultAdapter: SpacetimeDBAdapter | null = null;

/**
 * Initialize the default adapter
 */
export function initDefaultAdapter(config?: SpacetimeDBConfig): SpacetimeDBAdapter {
	defaultAdapter = new SpacetimeDBAdapter(config);
	return defaultAdapter;
}

/**
 * Get or create the default adapter
 */
export function getDefaultAdapter(): SpacetimeDBAdapter {
	if (!defaultAdapter) {
		defaultAdapter = new SpacetimeDBAdapter();
	}
	return defaultAdapter;
}
