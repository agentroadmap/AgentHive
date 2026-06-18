/**
 * Claims lifecycle helpers (lease acquire / release / renew / prune).
 *
 * Extracted from the `Core` class (P3796 monolith decomposition, Phase 1, AC-15).
 *
 * All public methods mirror the signatures on `Core` so call-sites are
 * unchanged — `Core` delegates to a private `ClaimsService` instance.
 */
import {
	DEFAULT_CLAIM_DURATION_MINUTES,
} from "../../constants/index.ts";
import type { FileSystem } from "../../file-system/operations.ts";
import type { GitOperations } from "../../git/operations.ts";
import * as pg from "../../infra/postgres/proposal-storage-v2.ts";
import type {
	Proposal,
	ProposalClaim,
	ProposalListFilter,
	ProposalUpdateInput,
	PulseEvent,
} from "../../types/index.ts";
import { formatLocalDateTime } from "../../utils/date-time.ts";
import { FileLock } from "../../utils/file-lock.ts";
import type { RateLimiter } from "../infrastructure/rate-limiter.ts";

/** Subset of ProposalQueryOptions required by the claims lifecycle. */
interface ClaimsQueryOptions {
	filters?: ProposalListFilter;
	includeCrossBranch?: boolean;
	status?: string;
}

/** Local budget shape (mirrors the private BudgetConfig in roadmap.ts). */
interface BudgetConfig {
	agents?: Record<
		string,
		{
			dailyLimitUsd: number;
			totalSpentTodayUsd: number;
			isFrozen: boolean;
		}
	>;
}

/**
 * Minimal Core interface required by the claims lifecycle functions.
 * Core passes `this` as the context — all methods here must be accessible
 * (i.e. not `private`) on Core.
 */
export interface ClaimsContext {
	/** @internal Postgres backend detection. */
	isPostgresProposalBackend(): Promise<boolean>;
	/** @internal Ensure Postgres pool is initialised. */
	ensurePgPool(): Promise<void>;
	/** @internal Load a full Proposal by display-id from Postgres. */
	loadPgProposalById(id: string): Promise<Proposal | null>;
	/** @internal Returns the roadmap directory name (always "roadmap"). */
	getRoadmapDirectoryName(): Promise<string>;
	/** Query proposals with optional filters. */
	queryProposals(options?: ClaimsQueryOptions): Promise<Proposal[]>;
	/** Determine whether changes should auto-commit. */
	shouldAutoCommit(override?: boolean): Promise<boolean>;
	/** Returns the per-agent rate-limiter singleton. */
	getRateLimiter(): RateLimiter;
	/** Load local budget config (returns null when unconfigured). */
	loadBudgetConfig(): Promise<BudgetConfig | null>;
	/** Apply a partial update to a proposal. */
	updateProposalFromInput(
		id: string,
		input: ProposalUpdateInput,
		autoCommit?: boolean,
	): Promise<Proposal>;
	/** Emit a pulse event (timestamp added automatically). */
	recordPulse(event: Omit<PulseEvent, "timestamp">): Promise<void>;
	/** Filesystem operations (used for FS-backed proposals). */
	fs: Pick<FileSystem, "loadConfig" | "loadProposal" | "rootDir">;
	/** Git operations (used for FS-backed auto-commit). */
	git: Pick<GitOperations, "stageRoadmapDirectory" | "commitChanges">;
}

export class ClaimsService {
	constructor(private readonly ctx: ClaimsContext) {}

	/**
	 * Remove claims that have exceeded their heartbeat timeout.
	 * Returns the list of recovered proposal IDs.
	 */
	async pruneClaims(options?: {
		timeoutMinutes?: number;
		autoCommit?: boolean;
	}): Promise<string[]> {
		if (await this.ctx.isPostgresProposalBackend()) {
			await this.ctx.ensurePgPool();
			const releasedProposalIds = await pg.releaseExpiredLeases();
			const recoveredIds = (
				await Promise.all(
					releasedProposalIds.map(
						async (proposalId) =>
							(await pg.getProposal(proposalId))?.display_id,
					),
				)
			).filter((proposalId): proposalId is string => Boolean(proposalId));
			return recoveredIds;
		}

		const config = await this.ctx.fs.loadConfig();
		const timeout =
			options?.timeoutMinutes ?? (config as any)?.activeBranchDays ?? 30;
		const now = new Date();
		const recoveredIds: string[] = [];

		const proposals = await this.ctx.queryProposals({
			includeCrossBranch: false,
		});
		const claimedProposals = proposals.filter((s) => s.claim);

		for (const proposal of claimedProposals) {
			if (!proposal.claim) continue;

			const lastHeartbeat = proposal.claim.lastHeartbeat
				? new Date(proposal.claim.lastHeartbeat.replace(" ", "T"))
				: new Date(proposal.claim.created.replace(" ", "T"));

			const diffMinutes =
				(now.getTime() - lastHeartbeat.getTime()) / 60000;

			if (diffMinutes > timeout) {
				await this.releaseClaim(proposal.id, proposal.claim.agent, {
					force: true,
					autoCommit: false,
				});
				recoveredIds.push(proposal.id);

				await this.ctx.recordPulse({
					type: "proposal_created",
					agent: proposal.claim.agent,
					id: proposal.id,
					title: proposal.title,
					impact: `STALE LEASE RECOVERED: Agent ${proposal.claim.agent} missed heartbeat for ${Math.round(diffMinutes)} minutes.`,
				});
			}
		}

		if (
			recoveredIds.length > 0 &&
			(await this.ctx.shouldAutoCommit(options?.autoCommit))
		) {
			const roadmapDir = await this.ctx.getRoadmapDirectoryName();
			const repoRoot = await this.ctx.git.stageRoadmapDirectory(roadmapDir);
			await this.ctx.git.commitChanges(
				`roadmap: Recovered ${recoveredIds.length} stale leases: ${recoveredIds.join(", ")}`,
				repoRoot,
			);
		}

		return recoveredIds;
	}

	/**
	 * Claim a proposal for an agent with a short-lived lease.
	 * Throws if the proposal is already claimed by another agent and the claim
	 * has not expired. Also checks rate limits (STATE-44) unless force=true.
	 */
	async claimProposal(
		proposalId: string,
		agent: string,
		options?: {
			durationMinutes?: number;
			message?: string;
			force?: boolean;
			autoCommit?: boolean;
		},
	): Promise<Proposal> {
		if (await this.ctx.isPostgresProposalBackend()) {
			const proposal = await this.ctx.loadPgProposalById(proposalId);
			if (!proposal) {
				throw new Error(`Proposal not found: ${proposalId}`);
			}

			if (!options?.force) {
				const priority = proposal.priority ?? "medium";
				const rateLimiter = this.ctx.getRateLimiter();
				const check = rateLimiter.canClaim(agent, proposal.id, priority);

				if (!check.allowed) {
					throw new Error(
						check.reason ??
							`Rate limited: too many claims. Retry after ${check.retryAfter}.`,
					);
				}

				rateLimiter.recordClaim(agent, proposal.id, priority);
			}

			await this.ctx.ensurePgPool();
			const resolvedProposalId = await pg.resolveProposalId(proposalId);
			if (resolvedProposalId === null) {
				throw new Error(`Proposal not found: ${proposalId}`);
			}

			const currentSummary = await pg.getProposalSummary(resolvedProposalId);
			const activeLeaseHeld =
				Boolean(currentSummary?.leased_by) &&
				(currentSummary?.lease_expires === null ||
					currentSummary?.lease_expires === undefined ||
					new Date(currentSummary.lease_expires) > new Date());
			const expiresAt = new Date(
				Date.now() +
					(options?.durationMinutes ?? DEFAULT_CLAIM_DURATION_MINUTES) *
						60 *
						1000,
			);

			if (!activeLeaseHeld && currentSummary?.leased_by) {
				// P934: legacy 'expired' replaced with canonical 'lease_expired'.
				await pg.releaseLease(
					resolvedProposalId,
					currentSummary.leased_by,
					"lease_expired",
				);
			}

			if (
				activeLeaseHeld &&
				currentSummary?.leased_by &&
				currentSummary.leased_by !== agent
			) {
				if (!options?.force) {
					throw new Error(
						`Proposal ${proposalId} is already claimed by ${currentSummary.leased_by}${currentSummary.lease_expires ? ` until ${currentSummary.lease_expires.toISOString()}` : ""}`,
					);
				}
				await pg.releaseLease(
					resolvedProposalId,
					currentSummary.leased_by,
					"reassigned",
				);
			}

			if (activeLeaseHeld && currentSummary?.leased_by === agent) {
				await pg.renewLease(resolvedProposalId, agent, expiresAt);
			} else {
				const claimed = await pg.claimLease(
					resolvedProposalId,
					agent,
					expiresAt,
				);
				if (!claimed) {
					throw new Error(`Proposal ${proposalId} could not be claimed.`);
				}
			}

			const refreshed = await this.ctx.loadPgProposalById(proposalId);
			if (!refreshed) {
				throw new Error(`Proposal not found after claim: ${proposalId}`);
			}

			await this.ctx.recordPulse({
				type: "proposal_claimed",
				id: refreshed.id,
				title: refreshed.title,
				agent,
			});

			return refreshed;
		}

		// Check budget before claiming (unless force=true)
		if (!options?.force) {
			const proposal = await this.ctx.fs.loadProposal(proposalId);

			if (proposal?.budgetLimitUsd && proposal.budgetLimitUsd > 0) {
				const budgetConfig = await this.ctx.loadBudgetConfig();
				if (budgetConfig) {
					const agentBudget = budgetConfig.agents?.[agent];
					if (agentBudget?.isFrozen) {
						throw new Error(`Budget: Agent '${agent}' spending is frozen`);
					}
					if (agentBudget && agentBudget.dailyLimitUsd > 0) {
						const remaining =
							agentBudget.dailyLimitUsd - agentBudget.totalSpentTodayUsd;
						if (proposal.budgetLimitUsd > remaining) {
							throw new Error(
								`Budget exceeded for '${agent}': $${agentBudget.totalSpentTodayUsd.toFixed(2)} spent of $${agentBudget.dailyLimitUsd.toFixed(2)} daily limit (need $${proposal.budgetLimitUsd.toFixed(2)})`,
							);
						}
					}
				}
			}

			// STATE-44: Check rate limit before claiming
			const priority = proposal?.priority ?? "medium";
			const rateLimiter = this.ctx.getRateLimiter();
			const check = rateLimiter.canClaim(agent, proposalId, priority);

			if (!check.allowed) {
				throw new Error(
					check.reason ??
						`Rate limited: too many claims. Retry after ${check.retryAfter}.`,
				);
			}

			rateLimiter.recordClaim(agent, proposalId, priority);
		}

		return await FileLock.withLock(
			this.ctx.fs.rootDir,
			"coordination",
			async () => await this._executeClaimProposal(proposalId, agent, options),
		);
	}

	/** Internal claim logic without lock acquisition (must be called within a lock). */
	private async _executeClaimProposal(
		proposalId: string,
		agent: string,
		options?: {
			durationMinutes?: number;
			message?: string;
			force?: boolean;
			autoCommit?: boolean;
		},
	): Promise<Proposal> {
		const proposal = await this.ctx.fs.loadProposal(proposalId);
		if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);

		const now = new Date();
		if (!options?.force && proposal.claim && proposal.claim.agent !== agent) {
			const expires = new Date(proposal.claim.expires.replace(" ", "T"));
			if (expires > now) {
				throw new Error(
					`Proposal ${proposalId} is already claimed by ${proposal.claim.agent} until ${proposal.claim.expires}`,
				);
			}
		}

		const duration = options?.durationMinutes || DEFAULT_CLAIM_DURATION_MINUTES;
		const expiresAt = new Date(now.getTime() + duration * 60000);

		const claim: ProposalClaim = {
			agent,
			created: formatLocalDateTime(now),
			expires: formatLocalDateTime(expiresAt),
			lastHeartbeat: formatLocalDateTime(now),
			message: options?.message,
		};

		return await this.ctx.updateProposalFromInput(
			proposalId,
			{
				claim,
				assignee: [agent],
			},
			options?.autoCommit,
		);
	}

	/**
	 * Release a claim on a proposal.
	 * Throws if the claim is held by another agent unless force is used.
	 *
	 * P934: `releaseReason` MUST be a canonical caller-facing reason from
	 * `src/core/proposal/release-reasons.ts`. When unspecified AND `force`
	 * is set, defaults to `"force_reclaimed"`. Otherwise the underlying
	 * `pg.releaseLease` call rejects with InvalidReleaseReasonError.
	 */
	async releaseClaim(
		proposalId: string,
		agent: string,
		options?: {
			force?: boolean;
			autoCommit?: boolean;
			releaseReason?: string;
		},
	): Promise<Proposal> {
		if (await this.ctx.isPostgresProposalBackend()) {
			const proposal = await this.ctx.loadPgProposalById(proposalId);
			if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);

			const resolvedProposalId = await pg.resolveProposalId(proposalId);
			if (resolvedProposalId === null) {
				throw new Error(`Proposal not found: ${proposalId}`);
			}

			const summary = await pg.getProposalSummary(resolvedProposalId);
			const activeLeaseHeld =
				Boolean(summary?.leased_by) &&
				(summary?.lease_expires === null ||
					summary?.lease_expires === undefined ||
					new Date(summary.lease_expires) > new Date());
			if (!activeLeaseHeld || !summary?.leased_by) {
				return proposal;
			}

			if (!options?.force && summary.leased_by !== agent) {
				throw new Error(
					`Proposal ${proposalId} claim is held by ${summary.leased_by}, not ${agent}`,
				);
			}

			const releaseReason =
				options?.releaseReason ??
				(options?.force ? "force_reclaimed" : "manual_release");
			const released = await pg.releaseLease(
				resolvedProposalId,
				options?.force ? summary.leased_by : agent,
				releaseReason,
			);
			if (!released) {
				throw new Error(
					`Proposal ${proposalId} claim could not be released.`,
				);
			}

			return (
				(await this.ctx.loadPgProposalById(proposalId)) ?? proposal
			);
		}

		const proposal = await this.ctx.fs.loadProposal(proposalId);
		if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);

		if (!proposal.claim) {
			return proposal;
		}

		if (!options?.force && proposal.claim.agent !== agent) {
			throw new Error(
				`Proposal ${proposalId} claim is held by ${proposal.claim.agent}, not ${agent}`,
			);
		}

		return await this.ctx.updateProposalFromInput(
			proposalId,
			{ claim: null },
			options?.autoCommit,
		);
	}

	/**
	 * Renew an existing claim, extending its expiration.
	 */
	async renewClaim(
		proposalId: string,
		agent: string,
		options?: { durationMinutes?: number; autoCommit?: boolean },
	): Promise<Proposal> {
		if (await this.ctx.isPostgresProposalBackend()) {
			const proposal = await this.ctx.loadPgProposalById(proposalId);
			if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);

			const resolvedProposalId = await pg.resolveProposalId(proposalId);
			if (resolvedProposalId === null) {
				throw new Error(`Proposal not found: ${proposalId}`);
			}

			const summary = await pg.getProposalSummary(resolvedProposalId);
			const activeLeaseHeld =
				Boolean(summary?.leased_by) &&
				(summary?.lease_expires === null ||
					summary?.lease_expires === undefined ||
					new Date(summary.lease_expires) > new Date());
			if (!activeLeaseHeld || !summary?.leased_by) {
				throw new Error(
					`Proposal ${proposalId} has no active claim to renew`,
				);
			}
			if (summary.leased_by !== agent) {
				throw new Error(
					`Proposal ${proposalId} claim is held by ${summary.leased_by}, not ${agent}`,
				);
			}

			const renewed = await pg.renewLease(
				resolvedProposalId,
				agent,
				new Date(
					Date.now() +
						(options?.durationMinutes || DEFAULT_CLAIM_DURATION_MINUTES) *
							60000,
				),
			);
			if (!renewed) {
				throw new Error(
					`Proposal ${proposalId} claim could not be renewed.`,
				);
			}

			return (
				(await this.ctx.loadPgProposalById(proposalId)) ?? proposal
			);
		}

		const proposal = await this.ctx.fs.loadProposal(proposalId);
		if (!proposal) throw new Error(`Proposal not found: ${proposalId}`);

		if (!proposal.claim) {
			throw new Error(`Proposal ${proposalId} has no active claim to renew`);
		}

		if (proposal.claim.agent !== agent) {
			throw new Error(
				`Proposal ${proposalId} claim is held by ${proposal.claim.agent}, not ${agent}`,
			);
		}

		const now = new Date();
		const duration = options?.durationMinutes || DEFAULT_CLAIM_DURATION_MINUTES;
		const expiresAt = new Date(now.getTime() + duration * 60000);

		const claim: ProposalClaim = {
			...proposal.claim,
			expires: formatLocalDateTime(expiresAt),
			lastHeartbeat: formatLocalDateTime(now),
		};
		return await this.ctx.updateProposalFromInput(
			proposalId,
			{ claim },
			options?.autoCommit,
		);
	}
}
