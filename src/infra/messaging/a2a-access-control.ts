/**
 * P199: Secure A2A Communication — Access Control Enforcement
 *
 * AC#2: Enforces that senders may only deliver messages to agents for which
 * they hold an active ACL entry (roadmap.message_acl) or an explicit
 * capability grant ('*' wildcard).
 *
 * AC#4 (spoofing): agentNotifyChannel() produces the canonical per-agent
 * pg_notify channel name. Listeners LISTEN on this channel; only messages
 * routed by the DB trigger (which checks to_agent) reach them.
 */

import { query } from "../postgres/pool.ts";
import type { ACLCheckResult, ACLGrantType, MessageACLEntry } from "./a2a-types.ts";

/** Agent identities that bypass ACL checks (infrastructure-level senders). */
const SYSTEM_AGENTS = new Set(["system", "orchestrator"]);

// ─── Channel naming ───────────────────────────────────────────────────────────

/**
 * Canonical pg_notify channel for an agent's direct-message inbox.
 *
 * MUST match the channel name produced by `roadmap.fn_a2a_message_notify`
 * (database/migrations/096-a2a-message-notify.sql). The trigger emits
 *   pg_notify('a2a_msg_' || NEW.to_agent, ...)
 * with the raw identity, and downstream consumers (msg-wait-reply,
 * msg-reply, agent-liveness probe, server/index operator listener,
 * scripts/start-message-agent) all LISTEN on `a2a_msg_<raw>`. This
 * function MUST emit the same name or low-latency wake-ups break and
 * msg_read(wait_ms=...) silently falls through to its no-message branch.
 *
 * Identities are validated against an allow-list of safe characters
 * because the channel name is interpolated into a quoted LISTEN
 * identifier (see MessageNotificationListener.start). PostgreSQL also
 * truncates channel names to 63 bytes.
 *
 * Example: 'claude/agency-bot' → 'a2a_msg_claude/agency-bot'
 */
const AGENT_IDENTITY_RE = /^[A-Za-z0-9_./:\-]+$/;
const PG_CHANNEL_MAX_BYTES = 63;

export function agentNotifyChannel(agentIdentity: string): string {
    if (typeof agentIdentity !== "string" || agentIdentity.length === 0) {
        throw new Error(`Invalid agent identity: must be a non-empty string`);
    }
    if (!AGENT_IDENTITY_RE.test(agentIdentity)) {
        throw new Error(
            `Invalid agent identity '${agentIdentity}': only [A-Za-z0-9_./:-] allowed`,
        );
    }
    const channel = "a2a_msg_" + agentIdentity;
    // PostgreSQL truncates LISTEN channel names beyond NAMEDATALEN-1 (63 bytes
    // by default). Truncating silently would re-introduce the alignment bug
    // for long identities, so reject loudly instead.
    if (Buffer.byteLength(channel, "utf8") > PG_CHANNEL_MAX_BYTES) {
        throw new Error(
            `Invalid agent identity '${agentIdentity}': channel name exceeds ${PG_CHANNEL_MAX_BYTES} bytes`,
        );
    }
    return channel;
}

// ─── ACL checks ───────────────────────────────────────────────────────────────

/**
 * Checks whether `fromAgent` is authorised to send to `toAgent`
 * (or post to a channel) under the given grant type.
 *
 * Rules:
 *  1. System agents (system, orchestrator) always pass.
 *  2. An active ACL row with matching (from_agent, to_agent | '*', grant_type) passes.
 *  3. Everything else is denied.
 */
export async function checkMessageACL(
    fromAgent: string,
    toAgent: string | null,
    grantType: ACLGrantType = "dm",
): Promise<ACLCheckResult> {
    if (SYSTEM_AGENTS.has(fromAgent)) {
        return { allowed: true, reason: "system_agent_bypass" };
    }

    const { rows } = await query<{ id: number }>(
        `SELECT id
         FROM   roadmap.message_acl
         WHERE  from_agent = $1
           AND  (to_agent  = $2 OR to_agent = '*')
           AND  grant_type = $3
           AND  revoked_at IS NULL
         LIMIT  1`,
        [fromAgent, toAgent ?? "*", grantType],
    );

    if (rows.length > 0) {
        return { allowed: true, reason: "acl_grant_found", entryId: rows[0].id };
    }

    return {
        allowed: false,
        reason: `acl_denied:${fromAgent}->${toAgent ?? "channel"}(${grantType})`,
    };
}

// ─── ACL management ───────────────────────────────────────────────────────────

/**
 * Creates or re-activates an ACL entry granting `fromAgent` permission
 * to send to `toAgent`. Idempotent — conflicting rows are re-activated.
 */
export async function createACLEntry(entry: {
    fromAgent: string;
    toAgent: string;
    grantType: ACLGrantType;
    grantedBy: string;
}): Promise<MessageACLEntry> {
    const { rows } = await query<{
        id: number;
        from_agent: string;
        to_agent: string;
        grant_type: string;
        granted_by: string;
        granted_at: Date;
        revoked_at: Date | null;
    }>(
        `INSERT INTO roadmap.message_acl (from_agent, to_agent, grant_type, granted_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ON CONSTRAINT message_acl_pair_uq DO UPDATE
             SET revoked_at = NULL,
                 granted_by = EXCLUDED.granted_by,
                 granted_at = now()
         RETURNING *`,
        [entry.fromAgent, entry.toAgent, entry.grantType, entry.grantedBy],
    );

    const row = rows[0];
    return {
        id: row.id,
        fromAgent: row.from_agent,
        toAgent: row.to_agent,
        grantType: row.grant_type as ACLGrantType,
        grantedBy: row.granted_by,
        grantedAt: row.granted_at,
        revokedAt: row.revoked_at,
    };
}

/**
 * Revokes an existing ACL entry (soft-delete via revoked_at timestamp).
 * Returns true if a row was updated, false if no matching active entry.
 */
export async function revokeACLEntry(
    fromAgent: string,
    toAgent: string,
    grantType: ACLGrantType,
): Promise<boolean> {
    const { rowCount } = await query(
        `UPDATE roadmap.message_acl
         SET    revoked_at = now()
         WHERE  from_agent = $1
           AND  to_agent   = $2
           AND  grant_type = $3
           AND  revoked_at IS NULL`,
        [fromAgent, toAgent, grantType],
    );
    return (rowCount ?? 0) > 0;
}

/**
 * Lists all active ACL entries for a given sender.
 */
export async function listACLEntries(fromAgent: string): Promise<MessageACLEntry[]> {
    const { rows } = await query<{
        id: number;
        from_agent: string;
        to_agent: string;
        grant_type: string;
        granted_by: string;
        granted_at: Date;
        revoked_at: Date | null;
    }>(
        `SELECT id, from_agent, to_agent, grant_type, granted_by, granted_at, revoked_at
         FROM   roadmap.message_acl
         WHERE  from_agent = $1
           AND  revoked_at IS NULL
         ORDER  BY granted_at`,
        [fromAgent],
    );

    return rows.map((row) => ({
        id: row.id,
        fromAgent: row.from_agent,
        toAgent: row.to_agent,
        grantType: row.grant_type as ACLGrantType,
        grantedBy: row.granted_by,
        grantedAt: row.granted_at,
        revokedAt: row.revoked_at,
    }));
}
