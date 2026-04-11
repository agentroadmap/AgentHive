/**
 * Content Store — The Soul of the System
 *
 * SpacetimeDB is the PRIMARY source of truth ("the soul").
 * Filesystem serves as a read-only mirror for offline/fallback scenarios.
 *
 * Architecture:
 *   Reads  → SpacetimeDB (real-time subscriptions) → FS (offline fallback)
 *   Writes → FS (git-tracked markdown) → SpacetimeDB reducers (sync)
 *
 * The ContentStore is the single gateway all roadmap queries flow through.
 */

import { FileSystem } from "../file-system/operations.ts";
import type { Proposal } from "../types/index.ts";
import { SDBContentStore, createSDBContentStore } from "./sdb-content-store.ts";

type ProposalLoader = () => Promise<Proposal[]>;

/**
 * Content Store — SDB-Native with FS Mirror
 *
 * SpacetimeDB is the soul. FS is the mirror.
 * All reads flow through here. SDB provides real-time state;
 * FS provides git-tracked durability and offline resilience.
 */
export class ContentStore {
	private sdbStore: SDBContentStore | null = null;
	private fs: FileSystem;
	private fsLoader: ProposalLoader;
	private proposals: Proposal[] = [];
	private initialized = false;
	private usingSDB = false;

	constructor(fs: FileSystem, fsLoader: ProposalLoader, _enableWatchers?: boolean) {
		this.fs = fs;
		this.fsLoader = fsLoader;
	}

	/**
	 * Initialize: SDB is the soul, FS is the mirror.
	 * SDB first. Always.
	 */
	async ensureInitialized(): Promise<void> {
		if (this.initialized) return;

		// Soul first: SpacetimeDB (live subscriptions)
		try {
			this.sdbStore = createSDBContentStore();
			await this.sdbStore.ensureInitialized();

			if (this.sdbStore.isConnected()) {
				this.proposals = this.sdbStore.getProposals();
				this.usingSDB = true;
				this.initialized = true;
				console.log(`[ContentStore:Soul] SpacetimeDB connected (${this.proposals.length} proposals)`);
				return;
			}
		} catch (error) {
			console.warn(`[ContentStore:Soul] SDB unavailable, FS mirror fallback: ${error}`);
		}

		// Mirror fallback: Filesystem (read-only, offline resilience)
		try {
			this.proposals = await this.fsLoader();
			this.usingSDB = false;
			this.initialized = true;
			console.log(`[ContentStore:Mirror] FS fallback active (${this.proposals.length} proposals)`);
		} catch (error) {
			console.error(`[ContentStore] Both soul and mirror failed: ${error}`);
			this.proposals = [];
			this.initialized = true;
		}
	}

	/**
	 * Get all proposals. SDB returns live state; FS returns cached snapshot.
	 */
	getProposals(): Proposal[] {
		// Soul: refresh from live SDB state every call
		if (this.usingSDB && this.sdbStore) {
			this.proposals = this.sdbStore.getProposals();
		}
		return this.proposals;
	}

	/**
	 * Check if the soul (SDB) is connected.
	 */
	isUsingSDB(): boolean {
		return this.usingSDB;
	}

	/**
	 * Insert or update a proposal in the local cache.
	 * Used to keep UI fresh after FS writes before SDB sync catches up.
	 */
	upsertProposal(proposal: Proposal): void {
		const idx = this.proposals.findIndex(p => p.id === proposal.id);
		if (idx >= 0) {
			this.proposals[idx] = proposal;
		} else {
			this.proposals.push(proposal);
		}
	}

	/**
	 * Clean up SDB connection.
	 */
	dispose(): void {
		if (this.sdbStore) {
			this.sdbStore.dispose();
		}
	}
}
