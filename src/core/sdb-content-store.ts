/**
 * SpacetimeDB Content Store
 *
 * Queries SpacetimeDB as the primary source of truth.
 * Filesystem serves as read-only mirror for offline/fallback scenarios.
 */

import { type DbConnection } from "../bindings/index.ts";
import type { Proposal } from "../types/index.ts";

/** SDB connection config */
export interface SDBContentStoreConfig {
	serverUri: string;
	dbName: string;
}

/** Proposal row from SpacetimeDB (matches generated binding types) */
interface SDBProposalRow {
	id: bigint;
	displayId: string;
	parentId: bigint | null;
	proposalType: string;
	category: string;
	domainId: string;
	title: string;
	status: string;
	priority: string;
	bodyMarkdown: string | null;
	processLogic: string | null;
	maturityLevel: number | null;
	repositoryPath: string | null;
	budgetLimitUsd: number;
	tags: string | null;
	createdAt: bigint;
	updatedAt: bigint;
}

/**
 * Convert an SDB proposal row to the CLI Proposal type.
 */
function sdbRowToProposal(row: SDBProposalRow): Proposal {
	const createdMs = Number(row.createdAt) / 1000; // microseconds to ms
	const updatedMs = Number(row.updatedAt) / 1000;

	return {
		id: `PROP-${row.id}`,
		title: row.title,
		status: row.status,
		createdDate: new Date(createdMs).toISOString().split("T")[0],
		updatedDate: new Date(updatedMs).toISOString().split("T")[0],
		description: row.bodyMarkdown ?? "",
		labels: row.tags ? row.tags.split(",").map((t: string) => t.trim()) : [],
		priority: row.priority.toLowerCase() as Proposal["priority"],
		// Map SDB fields to CLI fields
		type: row.proposalType.toLowerCase(),
		category: row.category.toLowerCase(),
		domain: row.domainId,
		displayId: row.displayId,
		parentId: row.parentId ? `PROP-${row.parentId}` : undefined,
		body: row.bodyMarkdown ?? undefined,
		budgetLimit: row.budgetLimitUsd,
	} as unknown as Proposal;
}

/**
 * SpacetimeDB Content Store
 *
 * Primary source of truth. Queries SDB for all proposal operations.
 */
export class SDBContentStore {
	private conn: DbConnection | null = null;
	private proposals: Map<string, Proposal> = new Map();
	private initialized = false;
	private config: SDBContentStoreConfig;

	constructor(config: SDBContentStoreConfig) {
		this.config = config;
	}

	/**
	 * Connect to SpacetimeDB and subscribe to proposal table.
	 */
	async ensureInitialized(): Promise<void> {
		if (this.initialized) return;

		try {
			// Dynamic import to avoid hard dependency
			const { DbConnection } = await import("../bindings/index.ts");

			// Build connection
			this.conn = await DbConnection.builder()
				.withUri(this.config.serverUri)
				.withDatabaseName(this.config.dbName)
				.onConnect((conn: DbConnection) => {
					// Subscribe to all proposals
					conn.subscriptionBuilder()
						.onApplied(() => {
							this.refreshProposals();
						})
						.subscribe("SELECT * FROM proposal");
				})
				.build();

			// Wait for initial subscription to be applied
			await this.waitForSubscription();

			this.initialized = true;
		} catch (error) {
			console.warn(`[SDB] Connection failed, will use FS fallback: ${error}`);
			this.initialized = false;
		}
	}

	/**
	 * Wait for the subscription to be applied (up to 5s).
	 */
	private async waitForSubscription(): Promise<void> {
		return new Promise((resolve) => {
			const timeout = setTimeout(() => resolve(), 5000);

			if (this.conn) {
				this.conn.subscriptionBuilder()
					.onApplied(() => {
						clearTimeout(timeout);
						this.refreshProposals();
						resolve();
					})
					.subscribe("SELECT * FROM proposal");
			} else {
				clearTimeout(timeout);
				resolve();
			}
		});
	}

	/**
	 * Refresh proposals from SDB table state.
	 */
	private refreshProposals(): void {
		if (!this.conn) return;

		this.proposals.clear();
		for (const row of this.conn.db.proposal.iter()) {
			const proposal = sdbRowToProposal(row as unknown as SDBProposalRow);
			this.proposals.set(proposal.id, proposal);
		}
	}

	/**
	 * Get all proposals from SpacetimeDB.
	 */
	getProposals(): Proposal[] {
		return Array.from(this.proposals.values());
	}

	/**
	 * Get a single proposal by ID.
	 */
	getProposal(id: string): Proposal | undefined {
		return this.proposals.get(id);
	}

	/**
	 * Check if connected to SDB.
	 */
	isConnected(): boolean {
		return this.initialized && this.conn !== null;
	}

	/**
	 * Clean up connection.
	 */
	dispose(): void {
		if (this.conn) {
			this.conn.disconnect();
			this.conn = null;
		}
		this.initialized = false;
	}
}

/**
 * Create an SDB content store with default config.
 */
export function createSDBContentStore(
	serverUri = "http://127.0.0.1:3000",
	dbName = "roadmap2",
): SDBContentStore {
	return new SDBContentStore({ serverUri, dbName });
}
