/**
 * Liaison Runtime Context — provider constraints + token budget + coordinator knowledge
 *
 * P1370 AC-5 through AC-11: Assembly and hydration of the liaison's runtime context.
 * The liaison uses this to short-circuit doomed dispatches, queue work intelligently,
 * and reject offers that exceed its own capacity.
 *
 * Hydration paths:
 *   1. Boot: hydrateLiaisonContext() called once in liaison-service.ts before fn_pulse online
 *   2. Refresh: setInterval(refresh, LIAISON_CONTEXT_REFRESH_MS) in liaison-service.ts
 *   3. Stale-guard: synchronous re-hydrate if snapshot is >5 minutes old (AC-10)
 *
 * Privacy guard (AC-11):
 *   - Self: includes full spending/capacity (cost_usd, daily_cap_usd, cumulative_usd)
 *   - Peers: safe columns only (no spending, no daily_cap, no cumulative cost)
 *   - Paused roles: global list, liaison filters against its own role at claim time
 *
 * P1366 follow-up:
 *   - active_claim_count currently returns 0 (orchestrator doesn't populate intermediate
 *     dispatch_status states yet; see v_liaison_context view comment)
 *   - Will be live once P1366 wires worker_identity through the state machine
 */

import { query } from "../postgres/pool.ts";

/**
 * Capacity envelope: request/token budgets and throttle state for one agency.
 */
export interface CapacityInfo {
	requests_remaining: number | null;
	tokens_remaining: number | null;
	reset_at: string | null;
	throttle_action: "none" | "soft" | "hard" | "unknown";
	last_sampled_at: string | null;
}

/**
 * Spending snapshot: cost aggregates for one agency across daily/weekly/cumulative windows.
 */
export interface SpendingInfo {
	spent_today_usd: number;
	spent_week_usd: number;
	cumulative_usd: number;
	daily_cap_usd: number | null;
}

/**
 * De-identified peer summary (privacy: no spending fields).
 */
export interface PeerInfo {
	identity: string;
	agency_style: string;
	llm_variant: string | null;
	online: boolean;
	headroom_pct: number | null;
	active_claim_count: number;
	capabilities: string[];
}

/**
 * Paused proposal-role pair: global list of (proposal_id, role) tuples that dispatch
 * would skip. Liaison filters against its own role when evaluating an offer.
 */
export interface PausedProposalRole {
	proposal_id: number;
	role: string;
	expires_at: string | null;
}

/**
 * Complete liaison runtime context: self-record from v_liaison_context plus separate
 * queries for peers and paused roles. Assembled by hydrateLiaisonContext().
 */
export interface LiaisonContext {
	// ---- From v_liaison_context (one row per agency) ----
	agency_identity: string;
	agency_style: string;
	llm_variant: string | null;
	provider: string;
	host_id: string;
	project_id: number;

	presence_state: "online" | "busy" | "away" | "offline" | null;
	last_heartbeat_at: string | null;
	provider_cooldown_until: string | null;

	capacity: CapacityInfo;
	spending: SpendingInfo;

	capabilities: string[];
	max_concurrent_claims: number;
	active_claim_count: number;

	// ---- From separate queries (NOT in v_liaison_context) ----
	paused_proposal_roles: PausedProposalRole[];
	peers: PeerInfo[];

	// Bookkeeping
	last_hydrated_at: number;
}

/**
 * Module-scope cache: one context per agency identity.
 * Populated on boot and refreshed on interval.
 */
const liaisonContextCache = new Map<string, LiaisonContext>();
let contextRefreshing = false;

/**
 * Fetch current paused (proposal_id, role) pairs from the DB.
 * AC-9: globally scoped; listener expiry check done in query.
 */
async function fetchPausedRoles(): Promise<PausedProposalRole[]> {
	const { rows } = await query(
		`SELECT proposal_id, role, expires_at
       FROM roadmap_workforce.proposal_role_pause
       WHERE expires_at IS NULL OR expires_at > NOW()`,
	) as { rows: PausedProposalRole[] };
	return rows;
}

/**
 * Fetch peer agencies (project-scoped, self-excluded, privacy: safe columns only).
 * AC-6: projects only safe columns; cost_usd, daily_cap_usd, cumulative_usd absent.
 * AC-11 verifies this with exhaustive Object.keys check.
 */
async function fetchPeers(
	agencyIdentity: string,
	projectId: number,
): Promise<PeerInfo[]> {
	const { rows } = await query(
		`SELECT
         ar.agent_identity AS identity,
         ar.agency_style,
         ar.llm_variant,
         (ar.presence_state IN ('online','busy')) AS online,
         CASE WHEN ac_cap.tokens_remaining IS NULL THEN NULL
              ELSE LEAST(
                COALESCE(ac_cap.requests_remaining::float / NULLIF(ac_cap.requests_remaining + 1, 0), 1.0),
                1.0
              )::int END AS headroom_pct,
         COALESCE(
           (SELECT COUNT(*) FROM roadmap_workforce.squad_dispatch sd
            WHERE (sd.worker_identity = ar.agent_identity
                   OR sd.agent_identity = ar.agent_identity)
              AND sd.dispatch_status IN ('assigned','active','blocked','posted','claimed','running','retry_wait')
              AND sd.project_id = ar.project_id),
           0
         ) AS active_claim_count,
         ARRAY(
           SELECT DISTINCT ac.capability
           FROM roadmap_workforce.agent_capability ac
           WHERE ac.agent_id = ar.id
           ORDER BY ac.capability
         ) AS capabilities
      FROM roadmap_workforce.v_liaison_context ar
      LEFT JOIN roadmap_workforce.agency_capacity ac_cap ON ac_cap.agency_id = ar.agent_identity
      WHERE ar.project_id = $1 AND ar.agent_identity <> $2`,
		[projectId, agencyIdentity],
	) as { rows: PeerInfo[] };
	return rows;
}

/**
 * Hydrate the full LiaisonContext from the DB.
 * AC-5: performs three queries: v_liaison_context + fetchPeers + fetchPausedRoles
 * AC-10: returns null sub-fields rather than throwing when source rows are missing
 */
export async function hydrateLiaisonContext(
	agencyIdentity: string,
	projectId: number,
): Promise<LiaisonContext | null> {
	try {
		// Query 1: self-record from v_liaison_context
		const selfResult = await query(
			`SELECT
         agency_identity, agency_style, llm_variant, provider, host_id, project_id,
         presence_state, last_heartbeat_at, provider_cooldown_until,
         requests_remaining, tokens_remaining, capacity_reset_at, throttle_action, capacity_last_sampled_at,
         spent_today_usd, spent_week_usd, cumulative_usd, daily_cap_usd,
         capabilities, max_concurrent_claims, active_claim_count
      FROM roadmap_workforce.v_liaison_context
      WHERE agent_identity = $1`,
			[agencyIdentity],
		) as {
			rows: Array<{
				agency_identity: string;
				agency_style: string;
				llm_variant: string | null;
				provider: string;
				host_id: string;
				project_id: number;
				presence_state: string | null;
				last_heartbeat_at: string | null;
				provider_cooldown_until: string | null;
				requests_remaining: number | null;
				tokens_remaining: number | null;
				capacity_reset_at: string | null;
				throttle_action: string | null;
				capacity_last_sampled_at: string | null;
				spent_today_usd: number;
				spent_week_usd: number;
				cumulative_usd: number;
				daily_cap_usd: number | null;
				capabilities: string[];
				max_concurrent_claims: number;
				active_claim_count: number;
			}>;
		};

		if (selfResult.rows.length === 0) {
			return null;
		}

		const self = selfResult.rows[0];

		// Query 2: peers (project-scoped, self-excluded)
		const peers = await fetchPeers(agencyIdentity, projectId);

		// Query 3: paused proposal roles (global)
		const pausedRoles = await fetchPausedRoles();

		const context: LiaisonContext = {
			agency_identity: self.agency_identity,
			agency_style: self.agency_style,
			llm_variant: self.llm_variant,
			provider: self.provider,
			host_id: self.host_id,
			project_id: self.project_id,

			presence_state: (self.presence_state as "online" | "busy" | "away" | "offline" | null) ?? null,
			last_heartbeat_at: self.last_heartbeat_at,
			provider_cooldown_until: self.provider_cooldown_until,

			capacity: {
				requests_remaining: self.requests_remaining,
				tokens_remaining: self.tokens_remaining,
				reset_at: self.capacity_reset_at,
				throttle_action: (self.throttle_action ?? "unknown") as "none" | "soft" | "hard" | "unknown",
				last_sampled_at: self.capacity_last_sampled_at,
			},

			spending: {
				spent_today_usd: self.spent_today_usd,
				spent_week_usd: self.spent_week_usd,
				cumulative_usd: self.cumulative_usd,
				daily_cap_usd: self.daily_cap_usd,
			},

			capabilities: self.capabilities ?? [],
			max_concurrent_claims: self.max_concurrent_claims,
			active_claim_count: self.active_claim_count,

			paused_proposal_roles: pausedRoles,
			peers,

			last_hydrated_at: Date.now(),
		};

		return context;
	} catch (err) {
		console.error(
			`[liaison-context] hydrate failed for ${agencyIdentity}:`,
			err instanceof Error ? err.message : err,
		);
		return null;
	}
}

/**
 * AC-7: Boot call — hydrate once at liaison boot (before fn_pulse online).
 * Stores result in module-scope cache. Emits structured boot log.
 */
export async function initializeContextAtBoot(
	agencyIdentity: string,
	projectId: number,
): Promise<LiaisonContext | null> {
	const context = await hydrateLiaisonContext(agencyIdentity, projectId);

	if (context) {
		liaisonContextCache.set(agencyIdentity, context);

		// AC-7: Emit structured boot log
		const capStr = context.capacity.throttle_action
			? `throttle=${context.capacity.throttle_action}`
			: `req=${context.capacity.requests_remaining ?? "?"} tok=${context.capacity.tokens_remaining ?? "?"}`;

		console.log(
			`[liaison-context] ${context.agency_identity} loaded: ` +
				`caps=[${capStr}] ` +
				`active=${context.active_claim_count}/${context.max_concurrent_claims} ` +
				`cap=${context.capacity.requests_remaining ? Math.round((context.capacity.requests_remaining / (context.capacity.requests_remaining + 1)) * 100) : 0}% ` +
				`spent_today=$${context.spending.spent_today_usd.toFixed(2)}/$${context.spending.daily_cap_usd?.toFixed(2) ?? "?"} ` +
				`paused_roles=${context.paused_proposal_roles.length} ` +
				`peers=${context.peers.length} ` +
				`last_hydrated=${new Date(context.last_hydrated_at).toISOString()}`,
		);
	}

	return context;
}

/**
 * AC-8: Periodic refresh on interval. Called by setInterval in liaison-service.ts.
 * Skips re-hydrate if a previous tick is still in flight (refreshing flag).
 */
export async function refreshContextOnInterval(
	agencyIdentity: string,
	projectId: number,
): Promise<void> {
	if (contextRefreshing) {
		return;
	}

	contextRefreshing = true;
	try {
		const context = await hydrateLiaisonContext(agencyIdentity, projectId);
		if (context) {
			liaisonContextCache.set(agencyIdentity, context);
		}
	} catch (err) {
		console.error(
			`[liaison-context] refresh failed for ${agencyIdentity}:`,
			err instanceof Error ? err.message : err,
		);
	} finally {
		contextRefreshing = false;
	}
}

/**
 * AC-10: Stale-data guard: synchronous re-hydrate if snapshot is >5 minutes old.
 * Latency budget: 50ms p95 (matching view-side budget from AC-4).
 * If over-budget, serves stale snapshot + emits warn log.
 */
export async function getContextWithStaleguard(
	agencyIdentity: string,
	projectId: number,
): Promise<LiaisonContext | null> {
	const cached = liaisonContextCache.get(agencyIdentity);

	if (!cached) {
		// No cached entry; hydrate fresh
		return await hydrateLiaisonContext(agencyIdentity, projectId);
	}

	const ageMs = Date.now() - cached.last_hydrated_at;
	const staleThresholdMs = 5 * 60 * 1000; // 5 minutes

	if (ageMs > staleThresholdMs) {
		// Trigger synchronous re-hydrate with latency budget
		const startMs = Date.now();
		const fresh = await hydrateLiaisonContext(agencyIdentity, projectId);
		const elapsedMs = Date.now() - startMs;

		if (elapsedMs > 50) {
			console.warn(
				`[liaison-context] stale-served latency=${elapsedMs}ms ` +
					`(budget=50ms) for ${agencyIdentity}`,
			);
		}

		if (fresh) {
			liaisonContextCache.set(agencyIdentity, fresh);
			return fresh;
		}

		// Re-hydrate failed; serve stale
		return cached;
	}

	return cached;
}

/**
 * Clear the context cache (for testing or shutdown).
 */
export function clearContextCache(): void {
	liaisonContextCache.clear();
}
