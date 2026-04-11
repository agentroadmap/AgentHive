/**
 * SpacetimeDB Sandbox Registry - In-Memory Implementation
 *
 * Implements STATE-84: SpacetimeDB Core Test Suite
 * AC#2: SandboxRegistry token generation and heartbeat
 *
 * This module provides the sandbox registry logic that maps to SpacetimeDB tables/reducers.
 * Can be swapped for a real SpacetimeDB backend when available.
 */

/** Sandbox container statuses */
export type SandboxStatus = "provisioning" | "running" | "stale";

/** Sandbox container record */
export interface SandboxRecord {
	containerId: string;
	agentId: string;
	token: string;
	status: SandboxStatus;
	createdAt: number;
	expiresAt: number;
}

/** Configuration for sandbox TTL */
export interface SandboxConfig {
	/** Default TTL in minutes */
	defaultTtlMinutes: number;
	/** Extension duration on heartbeat in minutes */
	heartbeatExtensionMinutes: number;
}

const DEFAULT_CONFIG: SandboxConfig = {
	defaultTtlMinutes: 60,
	heartbeatExtensionMinutes: 30,
};

/**
 * Sandbox Registry - In-memory implementation of SpacetimeDB sandbox registry.
 *
 * Manages sandbox container tokens, status, and lifecycle.
 */
export class SandboxRegistry {
	private sandboxes: Map<string, SandboxRecord> = new Map();
	private config: SandboxConfig;
	private timeProvider: () => number;

	constructor(
		config?: Partial<SandboxConfig>,
		timeProvider?: () => number,
	) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.timeProvider = timeProvider ?? Date.now;
	}

	/**
	 * AC#2: Generate a new sandbox token.
	 *
	 * @param agentId - The agent requesting the sandbox
	 * @param containerId - The container identifier
	 * @param ttlMinutes - Time-to-live in minutes (optional, uses default if not provided)
	 * @returns The generated sandbox record
	 * @throws Error if containerId already exists and is not stale
	 */
	generateToken(
		agentId: string,
		containerId: string,
		ttlMinutes?: number,
	): SandboxRecord {
		const now = this.timeProvider();

		// Check if container already exists
		const existing = this.sandboxes.get(containerId);
		if (existing && existing.status !== "stale") {
			throw new Error(
				`Container ${containerId} already exists with status ${existing.status}`,
			);
		}

		const effectiveTtl = ttlMinutes ?? this.config.defaultTtlMinutes;
		const ttlMs = effectiveTtl * 60_000;

		// Generate token: sbx_<containerId>_<timestamp>_<random>
		const random = Math.random().toString(36).substring(2, 10);
		const token = `sbx_${containerId}_${now}_${random}`;

		const record: SandboxRecord = {
			containerId,
			agentId,
			token,
			status: "provisioning",
			createdAt: now,
			expiresAt: now + ttlMs,
		};

		this.sandboxes.set(containerId, record);
		return { ...record };
	}

	/**
	 * AC#2: Send a heartbeat to keep the sandbox alive.
	 *
	 * Updates status to 'running' and extends the expiry time.
	 *
	 * @param containerId - The container to heartbeat
	 * @returns Updated sandbox record, or null if not found
	 */
	heartbeat(containerId: string): SandboxRecord | null {
		const sandbox = this.sandboxes.get(containerId);
		if (!sandbox) return null;

		const now = this.timeProvider();
		const extensionMs = this.config.heartbeatExtensionMinutes * 60_000;

		sandbox.status = "running";
		sandbox.expiresAt = now + extensionMs;

		this.sandboxes.set(containerId, sandbox);
		return { ...sandbox };
	}

	/**
	 * Mark expired sandboxes as stale.
	 *
	 * @returns Number of sandboxes marked as stale
	 */
	expireStale(): number {
		const now = this.timeProvider();
		let expired = 0;

		for (const [containerId, sandbox] of this.sandboxes) {
			if (sandbox.status !== "stale" && sandbox.expiresAt < now) {
				sandbox.status = "stale";
				this.sandboxes.set(containerId, sandbox);
				expired++;
			}
		}

		return expired;
	}

	/**
	 * Find a sandbox by container ID.
	 *
	 * @param containerId - The container to find
	 * @returns The sandbox record, or null if not found
	 */
	findByContainer(containerId: string): SandboxRecord | null {
		const sandbox = this.sandboxes.get(containerId);
		return sandbox ? { ...sandbox } : null;
	}

	/**
	 * Find all sandboxes for an agent.
	 *
	 * @param agentId - The agent to find sandboxes for
	 * @returns Array of sandbox records
	 */
	findByAgent(agentId: string): SandboxRecord[] {
		const results: SandboxRecord[] = [];
		for (const sandbox of this.sandboxes.values()) {
			if (sandbox.agentId === agentId) {
				results.push({ ...sandbox });
			}
		}
		return results;
	}

	/**
	 * Find all sandboxes with a given status.
	 *
	 * @param status - The status to filter by
	 * @returns Array of sandbox records
	 */
	findByStatus(status: SandboxStatus): SandboxRecord[] {
		const results: SandboxRecord[] = [];
		for (const sandbox of this.sandboxes.values()) {
			if (sandbox.status === status) {
				results.push({ ...sandbox });
			}
		}
		return results;
	}

	/**
	 * Get the total number of sandboxes.
	 */
	get size(): number {
		return this.sandboxes.size;
	}

	/**
	 * Remove a sandbox from the registry.
	 *
	 * @param containerId - The container to remove
	 * @returns true if removed, false if not found
	 */
	remove(containerId: string): boolean {
		return this.sandboxes.delete(containerId);
	}

	/**
	 * Get all sandboxes (for testing/debugging).
	 */
	getAll(): SandboxRecord[] {
		return Array.from(this.sandboxes.values()).map((s) => ({ ...s }));
	}

	/**
	 * Update configuration.
	 */
	updateConfig(config: Partial<SandboxConfig>): SandboxConfig {
		this.config = { ...this.config, ...config };
		return this.config;
	}

	/**
	 * Get current configuration.
	 */
	getConfig(): SandboxConfig {
		return { ...this.config };
	}
}

/**
 * Create a sandbox registry.
 */
export function createSandboxRegistry(
	config?: Partial<SandboxConfig>,
): SandboxRegistry {
	return new SandboxRegistry(config);
}
