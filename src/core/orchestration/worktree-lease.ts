/**
 * P1445 (Layer 2): atomic worktree allocation for concurrent dispatches.
 *
 * One row per registered git worktree in roadmap.worktree_lease. The
 * orchestrator claims a FREE worktree for a dispatch via the C1 pattern
 * (`FOR UPDATE SKIP LOCKED`) so two concurrent dispatches can NEVER share a
 * working directory — the root cause of the "merge landed on the wrong branch"
 * and shared-checkout-hijack incidents.
 *
 * Lease state:
 *   free    → released_at IS NOT NULL  (is_active = false, claimable)
 *   claimed → released_at IS NULL      (is_active = true)
 *
 * The claim/release pair is deliberately tiny and DB-side: the atomicity lives
 * in the single UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED),
 * never in application logic that an LLM could "forget".
 */

/** Minimal query interface — pg.Client / pg.Pool both satisfy it. */
export type QueryFn = <T = Record<string, unknown>>(
	sql: string,
	params?: unknown[],
) => Promise<{ rows: T[] }>;

export interface WorktreeLease {
	id: number;
	worktree_name: string;
	worktree_path: string;
	dispatch_id: number | null;
	proposal_id: number | null;
	agent_identity: string | null;
	claimed_at: string | null;
	expires_at: string | null;
}

export interface ClaimArgs {
	dispatchId?: number | null;
	proposalId?: number | null;
	agentIdentity?: string | null;
	/** Lease TTL in seconds; expires_at = now()+ttl. Default 3600 (1h). */
	ttlSeconds?: number;
}

/**
 * Register a worktree so it can be claimed. Idempotent on worktree_name: an
 * existing row's path is refreshed and the row is left in whatever lease state
 * it currently holds (re-registering does NOT free a claimed worktree).
 */
export async function registerWorktree(
	query: QueryFn,
	worktreeName: string,
	worktreePath: string,
): Promise<void> {
	await query(
		`INSERT INTO roadmap.worktree_lease (worktree_name, worktree_path, released_at)
		 VALUES ($1, $2, NOW())
		 ON CONFLICT (worktree_name)
		 DO UPDATE SET worktree_path = EXCLUDED.worktree_path`,
		[worktreeName, worktreePath],
	);
}

/**
 * Atomically claim the next FREE worktree. Returns the claimed lease, or null
 * when every registered worktree is busy (caller must back off / queue).
 *
 * Concurrency-safe by construction: the inner SELECT takes a row lock with
 * SKIP LOCKED, so N racing callers each grab a DISTINCT free row (or null) —
 * no two callers ever receive the same worktree.
 */
export async function claimWorktreeForDispatch(
	query: QueryFn,
	args: ClaimArgs = {},
): Promise<WorktreeLease | null> {
	const ttl = args.ttlSeconds ?? 3600;
	const { rows } = await query<WorktreeLease>(
		`UPDATE roadmap.worktree_lease AS wl
		    SET dispatch_id    = $1,
		        proposal_id    = $2,
		        agent_identity = $3,
		        claimed_at     = NOW(),
		        expires_at     = NOW() + ($4 || ' seconds')::interval,
		        released_at    = NULL,
		        release_reason = NULL
		  WHERE wl.id = (
		        SELECT id FROM roadmap.worktree_lease
		         WHERE released_at IS NOT NULL
		         ORDER BY worktree_name
		         LIMIT 1
		         FOR UPDATE SKIP LOCKED
		  )
		  RETURNING id, worktree_name, worktree_path, dispatch_id,
		            proposal_id, agent_identity, claimed_at, expires_at`,
		[
			args.dispatchId ?? null,
			args.proposalId ?? null,
			args.agentIdentity ?? null,
			String(ttl),
		],
	);
	return rows[0] ?? null;
}

/**
 * Release a worktree back to the free pool. Idempotent: releasing an already
 * free worktree is a no-op. Keyed by worktree_name so a completion handler that
 * only knows the directory can still release it.
 */
export async function releaseWorktreeLease(
	query: QueryFn,
	worktreeName: string,
	releaseReason = "work_delivered",
): Promise<void> {
	await query(
		`UPDATE roadmap.worktree_lease
		    SET released_at    = NOW(),
		        release_reason = $2,
		        dispatch_id    = NULL,
		        agent_identity = NULL,
		        expires_at     = NULL
		  WHERE worktree_name = $1
		    AND released_at IS NULL`,
		[worktreeName, releaseReason],
	);
}

/**
 * Reap stale claimed worktrees whose lease expired — returns the count freed.
 * Mirrors the proposal-lease reaper: a crashed dispatch must not pin a worktree
 * forever (cf. the zombie-lease incident on proposal claims).
 */
export async function reapExpiredWorktreeLeases(
	query: QueryFn,
): Promise<number> {
	const { rows } = await query<{ id: number }>(
		`UPDATE roadmap.worktree_lease
		    SET released_at    = NOW(),
		        release_reason = 'lease_expired',
		        dispatch_id    = NULL,
		        agent_identity = NULL,
		        expires_at     = NULL
		  WHERE released_at IS NULL
		    AND expires_at IS NOT NULL
		    AND expires_at < NOW()
		  RETURNING id`,
	);
	return rows.length;
}
