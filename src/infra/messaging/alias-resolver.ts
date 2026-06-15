/**
 * P1456 AC-7: display-alias → agent_identity resolution for the A2A send path.
 *
 * msg_send addresses a recipient by `to_agent`. Today that value is stored
 * verbatim, so a reserved alias like `orchestrator` (or any session's
 * `display_alias`) never resolves to the concrete `agent_identity` that owns
 * it — the message would be delivered to the literal channel `msg_orchestrator`
 * which nobody LISTENs on.
 *
 * This resolver maps an alias to its single active owner via the partial unique
 * index `idx_agent_alias_active`:
 *
 *   UNIQUE (display_alias) WHERE status = 'active' AND display_alias IS NOT NULL
 *
 * Because the index is UNIQUE over active rows, at most one row can hold a given
 * alias at a time — so resolution is unambiguous by construction. A stale alias
 * (owner went inactive) simply has no active row and resolves to nothing, which
 * the caller treats as "not an alias" and leaves the identity untouched.
 */

import { query } from "../postgres/pool.ts";

export interface AliasResolution {
    /** The identity the caller should actually route to. */
    identity: string;
    /** True if `input` matched an active display_alias and was rewritten. */
    resolvedFromAlias: boolean;
    /** The owning agent_identity when resolvedFromAlias is true. */
    owner?: string;
}

/**
 * Resolve `input` to a concrete agent_identity.
 *
 * Resolution order (AC-7):
 *  1. If `input` is itself an exact, active `agent_identity`, it is returned
 *     unchanged (identities win over aliases — an alias can never shadow a
 *     real identity).
 *  2. Otherwise, if `input` matches an active `display_alias`, the owning
 *     `agent_identity` is returned.
 *  3. Otherwise `input` is returned unchanged (not an alias; let the existing
 *     ACL / delivery path handle an unknown recipient as it does today).
 *
 * Ambiguity is impossible for active aliases due to idx_agent_alias_active.
 * If the alias is held only by an inactive/reaped row, it does NOT resolve —
 * a moved or revoked alias never silently routes to its old owner.
 */
export async function resolveAliasForSend(input: string): Promise<AliasResolution> {
    // Step 1: exact active identity short-circuits (no alias lookup needed).
    const identityHit = await query<{ agent_identity: string }>(
        `SELECT agent_identity
           FROM roadmap_workforce.agent_registry
          WHERE agent_identity = $1
            AND status = 'active'
          LIMIT 1`,
        [input],
    );
    if (identityHit.rows.length > 0) {
        return { identity: input, resolvedFromAlias: false };
    }

    // Step 2: active display_alias → owner. UNIQUE-active index guarantees ≤1.
    const aliasHit = await query<{ agent_identity: string }>(
        `SELECT agent_identity
           FROM roadmap_workforce.agent_registry
          WHERE display_alias = $1
            AND status = 'active'
          LIMIT 1`,
        [input],
    );
    if (aliasHit.rows.length === 1) {
        const owner = aliasHit.rows[0].agent_identity;
        return { identity: owner, resolvedFromAlias: true, owner };
    }

    // Step 3: not an active identity or alias — leave untouched.
    return { identity: input, resolvedFromAlias: false };
}
