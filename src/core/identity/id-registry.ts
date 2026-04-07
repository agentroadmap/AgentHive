/**
 * Proposal ID Registry - Centralized ID allocation to prevent collisions.
 *
 * This module provides:
 * 1. Centralized ID allocation via daemon API (AC#1)
 * 2. ID range reservation per agent session (AC#2)
 * 3. Collision detection and recovery (AC#3)
 * 4. Audit trail logging for all allocations (AC#4)
 *
 * When multiple agents create proposals concurrently, they request IDs
 * from the registry instead of computing max(existing) + 1 locally.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface IdRangeReservation {
	/** Session/agent identifier */
	sessionId: string;
	/** First ID in reserved range */
	rangeStart: number;
	/** Last ID in reserved range */
	rangeEnd: number;
	/** When reservation expires (ISO string) */
	expiresAt: string;
	/** Prefix (STATE, DRAFT, etc.) */
	prefix: string;
}

export interface IdAllocationRecord {
	/** Allocated ID (e.g., "STATE-56") */
	id: string;
	/** Session that requested it */
	sessionId: string;
	/** Allocation timestamp */
	timestamp: string;
	/** Prefix used */
	prefix: string;
}

export interface RegistryProposal {
	/** Next available ID number */
	nextId: number;
	/** Currently active reservations */
	reservations: IdRangeReservation[];
	/** History of all allocations (last 1000) */
	allocationLog: IdAllocationRecord[];
	/** Total allocations ever made */
	totalAllocations: number;
}

const RESERVATION_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_LOG_SIZE = 1000;
const DEFAULT_RANGE_SIZE = 1;

/**
 * Centralized ID Registry that prevents collisions across concurrent agents.
 */
export class IdRegistry {
	private proposal: RegistryProposal;
	private proposalPath: string;
	private lock: Promise<void> = Promise.resolve();
	private projectPath: string;

	constructor(projectPath: string) {
		this.projectPath = projectPath;
		this.proposalPath = join(
			projectPath,
			"roadmap",
			".cache",
			"id-registry.json",
		);
		this.proposal = this.loadProposal();
	}

	/**
	 * Load persisted registry proposal from disk.
	 */
	private loadProposal(): RegistryProposal {
		if (existsSync(this.proposalPath)) {
			try {
				const data = JSON.parse(readFileSync(this.proposalPath, "utf-8"));
				// Clean up expired reservations on load
				const now = new Date().toISOString();
				data.reservations = data.reservations.filter(
					(r: IdRangeReservation) => r.expiresAt > now,
				);
				return data;
			} catch {
				// Corrupted file, start fresh
			}
		}

		return {
			nextId: 1,
			reservations: [],
			allocationLog: [],
			totalAllocations: 0,
		};
	}

	/**
	 * Persist registry proposal to disk.
	 */
	private saveProposal(): void {
		const dir = join(this.projectPath, "roadmap", ".cache");
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		writeFileSync(this.proposalPath, JSON.stringify(this.proposal, null, 2));
	}

	/**
	 * Acquire a simple lock for atomic operations.
	 */
	private async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
		const previous = this.lock;
		let release!: () => void;
		this.lock = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await fn();
		} finally {
			release();
		}
	}

	/**
	 * Clean up expired reservations.
	 */
	private cleanupExpired(): void {
		const now = new Date().toISOString();
		this.proposal.reservations = this.proposal.reservations.filter(
			(r) => r.expiresAt > now,
		);
	}

	/**
	 * Allocate ID(s) for a session.
	 * Returns guaranteed-unique IDs.
	 */
	async allocateId(params: {
		sessionId: string;
		count?: number;
		prefix?: string;
	}): Promise<{
		ids: string[];
		rangeStart: number;
		rangeEnd: number;
		timestamp: string;
	}> {
		return this.withLock(() => {
			this.cleanupExpired();

			const count = params.count ?? 1;
			const prefix = params.prefix ?? "STATE";
			const rangeSize = Math.max(count, DEFAULT_RANGE_SIZE);

			// Find a range that doesn't overlap with any existing reservation
			let rangeStart = this.proposal.nextId;
			while (this.hasOverlap(rangeStart, rangeStart + rangeSize - 1)) {
				rangeStart++;
			}

			const rangeEnd = rangeStart + rangeSize - 1;
			const now = new Date();
			const expiresAt = new Date(
				now.getTime() + RESERVATION_TTL_MS,
			).toISOString();

			// Reserve the range
			const reservation: IdRangeReservation = {
				sessionId: params.sessionId,
				rangeStart,
				rangeEnd,
				expiresAt,
				prefix,
			};
			this.proposal.reservations.push(reservation);

			// Generate the requested IDs
			const ids: string[] = [];
			for (let i = 0; i < count; i++) {
				const idNum = rangeStart + i;
				const id = `${prefix}-${idNum}`;
				ids.push(id);

				// Log allocation
				this.proposal.allocationLog.push({
					id,
					sessionId: params.sessionId,
					timestamp: now.toISOString(),
					prefix,
				});
			}

			// Trim log if too large
			if (this.proposal.allocationLog.length > MAX_LOG_SIZE) {
				this.proposal.allocationLog = this.proposal.allocationLog.slice(
					-MAX_LOG_SIZE,
				);
			}

			// Update nextId pointer
			this.proposal.nextId = rangeEnd + 1;
			this.proposal.totalAllocations += count;

			this.saveProposal();

			return {
				ids,
				rangeStart,
				rangeEnd,
				timestamp: now.toISOString(),
			};
		});
	}

	/**
	 * Check if a range overlaps with existing reservations.
	 */
	private hasOverlap(start: number, end: number): boolean {
		for (const r of this.proposal.reservations) {
			if (start <= r.rangeEnd && end >= r.rangeStart) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Release all reservations for a session (cleanup on disconnect/error).
	 */
	async releaseRange(sessionId: string): Promise<boolean> {
		return this.withLock(() => {
			const before = this.proposal.reservations.length;
			this.proposal.reservations = this.proposal.reservations.filter(
				(r) => r.sessionId !== sessionId,
			);
			this.saveProposal();
			return this.proposal.reservations.length < before;
		});
	}

	/**
	 * Get current registry status (for monitoring/debugging).
	 */
	getStatus(): {
		nextId: number;
		reservedRanges: IdRangeReservation[];
		totalAllocations: number;
	} {
		this.cleanupExpired();
		return {
			nextId: this.proposal.nextId,
			reservedRanges: [...this.proposal.reservations],
			totalAllocations: this.proposal.totalAllocations,
		};
	}

	/**
	 * Check if a specific ID is already in use (AC#3 - collision detection).
	 * Used by agents before fallback allocation.
	 */
	async checkCollision(id: string): Promise<{
		exists: boolean;
		reason?: "reserved" | "allocated";
	}> {
		const match = id.match(/^(?:STATE|DRAFT)-(\d+)$/i);
		if (!match) return { exists: false };

		const idNum = Number.parseInt(match[1], 10);

		// Check reservations
		for (const r of this.proposal.reservations) {
			if (idNum >= r.rangeStart && idNum <= r.rangeEnd) {
				return { exists: true, reason: "reserved" };
			}
		}

		// Check allocation log
		for (const entry of this.proposal.allocationLog) {
			if (entry.id.toUpperCase() === id.toUpperCase()) {
				return { exists: true, reason: "allocated" };
			}
		}

		return { exists: false };
	}

	/**
	 * Get allocation log for audit trail (AC#4).
	 */
	getAuditLog(limit?: number): IdAllocationRecord[] {
		const log = this.proposal.allocationLog;
		return limit ? log.slice(-limit) : [...log];
	}
}
