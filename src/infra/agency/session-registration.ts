/**
 * P1456: Session-instance identity registration for interactive CLI sessions.
 *
 * Each live interactive CLI session (Claude Code, Codex, Gemini) calls
 * registerSession() on startup to obtain a stable, addressable A2A endpoint
 * parented to the standing agency row. The identity is:
 *
 *   <agency_id>/session/<short-session-id>
 *
 * e.g.  claude-bot-gary.a/session/7f3a2c
 *
 * Non-dispatchable by design: no provider_registry row, no agency row.
 * The standing agency remains the dispatch-eligible lane.
 *
 * On clean exit call reapSession(). If the process crashes, a reaper
 * (P1093 mechanics) marks stale rows inactive.
 *
 * AC-1: upsert agent_registry row with correct fields
 * AC-2: no provider_registry / agency rows → non-dispatchable
 * AC-5: delegation recorded in principal_identity + authority_grant
 * AC-6: reap on exit, revoke principal and grant rows
 * AC-18: 63-byte channel-limit enforced at registration time
 */

import { hostname } from "node:os";
import { query } from "../postgres/pool.ts";
import { agentNotifyChannel } from "../messaging/a2a-access-control.ts";

// PG NAMEDATALEN-1 in bytes
const PG_CHANNEL_MAX = 63;

export interface SessionRegistrationOptions {
    /** Full session identity, e.g. "claude-bot-gary.a/session/7f3a2c". */
    sessionIdentity: string;
    /** Standing agency identity to parent this session to, e.g. "claude-bot-gary.a". */
    standingAgencyIdentity: string;
    /** CLI kind: "claude-code" | "codex" | "gemini". Stored in agent_cli. */
    cliKind: string;
    /** LLM variant, e.g. "claude-sonnet-4-6". Stored in llm_variant. */
    llmVariant?: string;
    /** Delegating principal; defaults to "user/gary". */
    grantorPrincipalId?: string;
    /** Session reap horizon in seconds from now; default 8 hours. */
    expiresInSeconds?: number;
    /** Optional logger; defaults to console. */
    logger?: Pick<Console, "log" | "warn" | "error">;
}

export interface SessionHandle {
    sessionIdentity: string;
    agentRegistryId: number;
    /** Call on clean exit to mark the session inactive and revoke grants. */
    reap: (reason?: string) => Promise<void>;
}

/**
 * Register a CLI session as an addressable (but non-dispatchable) A2A endpoint.
 *
 * Validates the channel limit eagerly (AC-18), then upserts:
 *   1. roadmap_workforce.agent_registry row  (AC-1)
 *   2. roadmap.principal_identity row        (AC-5, step 1)
 *   3. roadmap.authority_grant row           (AC-5, step 2)
 *
 * Does NOT insert into provider_registry or roadmap.agency (AC-2).
 */
export async function registerSession(
    opts: SessionRegistrationOptions,
): Promise<SessionHandle> {
    const {
        sessionIdentity,
        standingAgencyIdentity,
        cliKind,
        llmVariant,
        grantorPrincipalId = "user/gary",
        expiresInSeconds = 8 * 60 * 60,
        logger = console,
    } = opts;

    // AC-18: reject overlong identities before any DB write
    const channelName = agentNotifyChannel(sessionIdentity); // throws if > 63 bytes
    if (Buffer.byteLength(channelName, "utf8") > PG_CHANNEL_MAX) {
        throw new Error(
            `Session identity '${sessionIdentity}' produces channel '${channelName}' ` +
            `(${Buffer.byteLength(channelName, "utf8")} bytes) which exceeds the ` +
            `${PG_CHANNEL_MAX}-byte PostgreSQL LISTEN channel limit. ` +
            `Shorten or hash the session id.`,
        );
    }

    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    const host = hostname();

    // ── 1. Resolve the standing agency row id ────────────────────────────────
    const agencyRowRes = await query<{ id: number }>(
        `SELECT id FROM roadmap_workforce.agent_registry
          WHERE agent_identity = $1
          LIMIT 1`,
        [standingAgencyIdentity],
    );
    const parentAgencyId = agencyRowRes.rows[0]?.id ?? null;

    // ── 2. Upsert agent_registry (AC-1) ─────────────────────────────────────
    const regRes = await query<{ id: number }>(
        `INSERT INTO roadmap_workforce.agent_registry
           (agent_identity, agent_type, role, status, trust_tier,
            host_affinity, last_seen_at, agency_id,
            agent_cli, llm_variant)
         VALUES ($1, 'llm', 'interactive-session', 'active', 'trusted',
                 $2, now(), $3,
                 $4, $5)
         ON CONFLICT (agent_identity) DO UPDATE SET
           status        = 'active',
           trust_tier    = 'trusted',
           host_affinity = EXCLUDED.host_affinity,
           last_seen_at  = now(),
           agency_id     = EXCLUDED.agency_id,
           agent_cli     = EXCLUDED.agent_cli,
           llm_variant   = EXCLUDED.llm_variant,
           reaped_at     = NULL,
           reap_reason   = NULL,
           updated_at    = now()
         RETURNING id`,
        [sessionIdentity, host, parentAgencyId, cliKind, llmVariant ?? null],
    );
    const agentRegistryId = regRes.rows[0]?.id;
    if (!agentRegistryId) {
        throw new Error(
            `[registerSession] agent_registry upsert returned no row for ${sessionIdentity}`,
        );
    }

    // ── 3. Upsert session principal_identity (AC-5 step 1) ──────────────────
    // Requires migration 283-p1456 to have added 'delegated' to the
    // principal_identity.credential_kind CHECK constraint.
    const principalId = sessionIdentity;
    await query(
        `INSERT INTO roadmap.principal_identity
           (principal_id, principal_kind, credential_kind,
            parent_principal_id, expires_at, revoked_at)
         VALUES ($1, 'agent', 'delegated', $2, $3, NULL)
         ON CONFLICT (principal_id) DO UPDATE SET
           credential_kind     = 'delegated',
           parent_principal_id = EXCLUDED.parent_principal_id,
           expires_at          = EXCLUDED.expires_at,
           revoked_at          = NULL`,
        [principalId, grantorPrincipalId, expiresAt],
    );

    // ── 4. Upsert authority_grant (AC-5 step 2) ─────────────────────────────
    await query(
        `INSERT INTO roadmap.authority_grant
           (grantor_id, grantee_id, scope_category, scope_ref,
            authority_level, can_override, reason, expires_at, revoked_at)
         VALUES ($1, $2, 'session-delegation', 'a2a-messaging',
                 'trusted', false,
                 $3, $4, NULL)
         ON CONFLICT (grantor_id, grantee_id, scope_category, scope_ref)
         DO UPDATE SET
           expires_at = EXCLUDED.expires_at,
           revoked_at = NULL`,
        [
            grantorPrincipalId,
            principalId,
            `Interactive ${cliKind} CLI session on ${host}`,
            expiresAt,
        ],
    );

    logger.log(
        `[P1456] Session registered: ${sessionIdentity} ` +
        `(registry_id=${agentRegistryId}, channel=${channelName}, expires=${expiresAt.toISOString()})`,
    );

    // ── 5. Return handle with reap callback (AC-6) ──────────────────────────
    return {
        sessionIdentity,
        agentRegistryId,
        reap: async (reason = "clean-exit") => {
            await reapSession(sessionIdentity, principalId, grantorPrincipalId, reason);
            logger.log(`[P1456] Session reaped: ${sessionIdentity} (reason=${reason})`);
        },
    };
}

/**
 * Mark a session as inactive and revoke its delegation records (AC-6).
 * Idempotent — safe to call multiple times.
 */
export async function reapSession(
    sessionIdentity: string,
    principalId?: string,
    grantorPrincipalId = "user/gary",
    reason = "clean-exit",
): Promise<void> {
    const resolvedPrincipal = principalId ?? sessionIdentity;

    // Soft-delete the agent_registry row
    await query(
        `UPDATE roadmap_workforce.agent_registry
            SET status      = 'inactive',
                reaped_at   = now(),
                reap_reason = $2,
                updated_at  = now()
          WHERE agent_identity = $1
            AND status = 'active'`,
        [sessionIdentity, reason],
    );

    // Revoke principal_identity.
    // NOTE: roadmap.principal_identity has a CHECK constraint
    // pi_revoke_requires_reason: (revoked_at IS NULL OR revocation_reason IS NOT NULL).
    // We MUST set revocation_reason in the same UPDATE or the revoke fails.
    await query(
        `UPDATE roadmap.principal_identity
            SET revoked_at        = now(),
                revocation_reason = $2
          WHERE principal_id = $1
            AND revoked_at IS NULL`,
        [resolvedPrincipal, `session-reap: ${reason}`],
    );

    // Revoke authority_grant
    await query(
        `UPDATE roadmap.authority_grant
            SET revoked_at = now()
          WHERE grantor_id = $1
            AND grantee_id = $2
            AND scope_category = 'session-delegation'
            AND revoked_at IS NULL`,
        [grantorPrincipalId, resolvedPrincipal],
    );
}

export interface StaleSessionReapResult {
    /** Session identities that were reaped this sweep. */
    reaped: string[];
}

/**
 * Crash-recovery reaper for interactive-session rows (AC-6 crash path).
 *
 * The clean-exit path (reapSession) handles graceful shutdown. When a CLI
 * process is SIGKILLed or its host dies, no clean-exit fires and the
 * agent_registry row, session principal_identity, and authority_grant rows
 * linger as `active`/un-revoked. The existing P269 unified reaper
 * (reap-stale-rows.ts) and the stale-agency poke watchdog do NOT touch
 * agent_registry rows by last_seen_at, so session rows need their own sweep.
 *
 * This marks any `role='interactive-session'` + `status='active'` row whose
 * last_seen_at is older than `staleAfterSeconds` as inactive, then revokes
 * its delegation records — mirroring reapSession() exactly so a crashed
 * session leaves the same audit trail as a clean exit.
 *
 * Idempotent and safe to call on an interval. Returns the identities reaped.
 */
export async function reapStaleSessions(
    staleAfterSeconds = 15 * 60,
    reason = "stale-heartbeat",
): Promise<StaleSessionReapResult> {
    // Select-then-reap so we can revoke the matching principal/grant rows and
    // report exactly which identities were swept.
    const staleRes = await query<{ agent_identity: string }>(
        `SELECT agent_identity
           FROM roadmap_workforce.agent_registry
          WHERE role = 'interactive-session'
            AND status = 'active'
            AND last_seen_at < now() - ($1 || ' seconds')::interval`,
        [String(staleAfterSeconds)],
    );

    const reaped: string[] = [];
    for (const { agent_identity } of staleRes.rows) {
        // reapSession is idempotent and sets all three rows consistently.
        // grantor defaults to user/gary; principalId defaults to the identity.
        await reapSession(agent_identity, agent_identity, "user/gary", reason);
        reaped.push(agent_identity);
    }
    return { reaped };
}

/**
 * Derive a short session id from a CLI session/transcript id.
 * Truncates to 12 hex chars (6 bytes) if the raw id is longer.
 * The result stays within the channel name limit for any sane agency_id.
 */
export function shortSessionId(rawId: string): string {
    if (/^[0-9a-f]{8,}$/i.test(rawId)) {
        return rawId.slice(0, 12).toLowerCase();
    }
    // For non-hex ids (e.g. Claude transcript paths), take first 12 alphanumeric chars
    const cleaned = rawId.replace(/[^A-Za-z0-9]/g, "");
    return cleaned.slice(0, 12).toLowerCase();
}
