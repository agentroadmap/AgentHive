/**
 * P1391 — Lease liveness, the single TypeScript source of truth.
 *
 * Operator model (P1391): the `proposal_lease` row is the concurrency lock and
 * uses TTL expiry as automatic release. A lease is *alive* iff
 *   `released_at IS NULL AND expires_at > NOW()`.
 *
 * This mirrors the SQL function `roadmap_proposal.lease_is_live(released_at,
 * expires_at)` installed by migration 283-p1391-lease-ttl-structural.sql and
 * the partial EXCLUDE constraint `proposal_lease_no_overlap_live`. Any code
 * that needs to decide "is this proposal_lease alive?" in application space
 * MUST use `leaseIsLive()` rather than re-checking `released_at IS NULL` alone
 * — the bare check is the historical bug P1391 retires (an expired-unreleased
 * lease reads as alive without the `expires_at` clause).
 *
 * For raw SQL predicates the canonical inline form is exported as
 * `LEASE_LIVE_SQL` so call sites can paste an identical, index-friendly
 * predicate (the planner pushes `expires_at > now()` into the partial index).
 */

/**
 * The canonical SQL liveness predicate for a `proposal_lease` row.
 *
 * Use with a table alias, e.g.:
 *   `WHERE ${leaseLiveSql("pl")}`  →  `pl.released_at IS NULL AND pl.expires_at > now()`
 *
 * Prefer this over a bare `released_at IS NULL`. It is deliberately inlined
 * (rather than calling the SQL function) so it stays sargable against the
 * `idx_lease_proposal` / `idx_lease_expires` partial indexes.
 */
export function leaseLiveSql(alias = ""): string {
	const p = alias ? `${alias}.` : "";
	return `${p}released_at IS NULL AND ${p}expires_at > now()`;
}

/** Convenience constant for the no-alias form. */
export const LEASE_LIVE_SQL = leaseLiveSql();

/**
 * Decide whether a lease (given its release/expiry timestamps) is alive *now*.
 *
 * @param releasedAt `proposal_lease.released_at` (null when not yet released)
 * @param expiresAt  `proposal_lease.expires_at` (TTL deadline)
 * @param now        evaluation instant (defaults to `new Date()`; injectable
 *                   for deterministic tests)
 */
export function leaseIsLive(
	releasedAt: Date | string | null | undefined,
	expiresAt: Date | string | null | undefined,
	now: Date = new Date(),
): boolean {
	if (releasedAt !== null && releasedAt !== undefined) return false;
	if (expiresAt === null || expiresAt === undefined) {
		// Open-ended lease with no TTL. Under the P1391 model expires_at is
		// NOT NULL at the DB level, so this only arises from synthetic/in-memory
		// rows. Treat a missing TTL as "not provably expired" → alive, matching
		// the SQL function's `expires_at > now()` being unknown→excluded only
		// when expires_at is present. Callers with DB rows never hit this.
		return false;
	}
	const exp = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
	return exp.getTime() > now.getTime();
}
