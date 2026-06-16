/**
 * P1456: Session-instance identities for concurrent interactive CLI sessions.
 *
 * Adds a session-instance layer below the standing agency identity so that
 * multiple concurrent Claude Code / Codex / Gemini sessions launched by the
 * same operator can each be addressed as an independent A2A endpoint WITHOUT
 * becoming dispatchable offer targets.
 *
 * Identity format: `<agencyIdentity>/session/<shortSid>`
 *   e.g. `claude.a/session/7f3a2c1b`
 *
 * Non-dispatchable invariant: no `roadmap_workforce.provider_registry` row is
 * created for session identities.  The agency-resolver also explicitly excludes
 * `role = 'interactive-session'` (belt-and-suspenders).
 *
 * Delegation bootstrap (AC-5):
 *   Step 1 — upsert `roadmap.principal_identity` with credential_kind='delegated'
 *             (requires migration 256-p1456-credential-kind-delegated).
 *   Step 2 — upsert `roadmap.authority_grant` linking grantor user/gary → session.
 *
 * AC-1  Session registration on boot.
 * AC-2  Non-dispatchable guard (resolver exclusion — see agency-resolver.ts).
 * AC-5  Delegation via principal_identity + authority_grant.
 * AC-6  Lifecycle reaping: status→inactive, revoked_at on grant + principal.
 * AC-18 Channel-limit negative test lives in tests/core/session-instance.test.ts.
 */

import { query } from "../../infra/postgres/pool.ts";
import { agentNotifyChannel } from "../../infra/messaging/a2a-access-control.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Maximum raw session ID characters kept for the short slug. */
const SHORT_SID_LENGTH = 8;

/** Session reap horizon grace period (ms beyond session start). */
const SESSION_GRACE_MS = 24 * 60 * 60 * 1000; // 24 h

/** authority_level value for session delegation — never 'authority'. */
const SESSION_AUTHORITY_LEVEL = "trusted" as const;

// ── Public types ──────────────────────────────────────────────────────────────

export interface SessionRegistrationOpts {
	/** Full identity of the standing agency row, e.g. `claude.a`. */
	agencyIdentity: string;
	/**
	 * Raw session/transcript ID from the CLI (UUID or similar). Will be
	 * shortened to SHORT_SID_LENGTH chars to keep `msg_<identity>` ≤ 63 bytes.
	 */
	rawSessionId: string;
	/**
	 * CLI kind — stored in agent_cli column, e.g. `claude-code`, `codex`, `gemini`.
	 * NOT used as agent_type (live schema rejects those values there).
	 */
	cliKind: string;
	/** LLM variant string e.g. `claude-sonnet-4-6`. */
	llmVariant?: string;
	/** Physical host name, e.g. `bot`. */
	hostAffinity?: string;
	/** Principal ID of the delegating principal, e.g. `user/gary`. */
	grantorPrincipalId?: string;
	/** Numeric agent_registry.id of the parent standing agency row. */
	parentAgencyId?: number;
}

export interface SessionRegistrationResult {
	/** Full session identity, e.g. `claude.a/session/7f3a2c1b`. */
	identity: string;
	/** Canonical pg_notify channel, e.g. `msg_claude.a/session/7f3a2c1b`. */
	channel: string;
}

// ── Identity helpers ──────────────────────────────────────────────────────────

/**
 * Derive a short slug from a raw session ID.
 * Only keeps ASCII alphanumeric chars — safe for the channel-name allow-list.
 */
export function shortenSessionId(rawSid: string): string {
	return rawSid.replace(/[^A-Za-z0-9]/g, "").substring(0, SHORT_SID_LENGTH);
}

/**
 * Build and validate the full session identity.
 *
 * Calls `agentNotifyChannel()` which enforces:
 *   - Character allow-list: [A-Za-z0-9_./:-]
 *   - Channel byte length ≤ 63 (PostgreSQL NAMEDATALEN-1)
 *
 * Throws if the composed identity would produce an overlong channel name.
 * This is the AC-18 registration-time guard.
 */
export function buildSessionIdentity(
	agencyIdentity: string,
	rawSessionId: string,
): string {
	const shortSid = shortenSessionId(rawSessionId);
	if (!shortSid) {
		throw new Error(
			`Cannot derive short session slug from rawSessionId '${rawSessionId}'`,
		);
	}
	const identity = `${agencyIdentity}/session/${shortSid}`;
	// AC-18: validate now — throws if overlong or unsafe characters.
	agentNotifyChannel(identity);
	return identity;
}

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Register a session instance on CLI startup.
 *
 * Writes:
 *   1. `roadmap_workforce.agent_registry` upsert (AC-1)
 *   2. `roadmap.principal_identity` upsert (AC-5 Step 1)
 *   3. `roadmap.authority_grant` upsert (AC-5 Step 2)
 *
 * Idempotent — safe to call on reconnect/restart for the same session.
 */
export async function registerSessionInstance(
	opts: SessionRegistrationOpts,
): Promise<SessionRegistrationResult> {
	const {
		agencyIdentity,
		rawSessionId,
		cliKind,
		llmVariant,
		hostAffinity = "bot",
		grantorPrincipalId = "user/gary",
		parentAgencyId,
	} = opts;

	const identity = buildSessionIdentity(agencyIdentity, rawSessionId);
	const channel = agentNotifyChannel(identity);
	const expiresAt = new Date(Date.now() + SESSION_GRACE_MS);

	// Step 1: Upsert workforce agent_registry row (non-dispatchable — no provider_registry row).
	await query(
		`INSERT INTO roadmap_workforce.agent_registry
		   (agent_identity, agent_type, role, agent_cli, llm_variant,
		    host_affinity, status, trust_tier, last_seen_at,
		    agency_id)
		 VALUES ($1, 'llm', 'interactive-session', $2, $3,
		         $4, 'active', 'trusted', now(),
		         $5)
		 ON CONFLICT (agent_identity) DO UPDATE SET
		   status        = 'active',
		   agent_cli     = EXCLUDED.agent_cli,
		   llm_variant   = EXCLUDED.llm_variant,
		   host_affinity = EXCLUDED.host_affinity,
		   last_seen_at  = now()`,
		[identity, cliKind, llmVariant ?? null, hostAffinity, parentAgencyId ?? null],
	);

	// Step 2a: Upsert principal_identity for the session (AC-5 Step 1).
	// Requires migration 256: credential_kind CHECK must include 'delegated'.
	await query(
		`INSERT INTO roadmap.principal_identity
		   (principal_id, principal_kind, parent_principal_id,
		    credential_kind, expires_at, revoked_at)
		 VALUES ($1, 'agent', $2, 'delegated', $3, NULL)
		 ON CONFLICT (principal_id) DO UPDATE SET
		   expires_at  = EXCLUDED.expires_at,
		   revoked_at  = NULL`,
		[identity, grantorPrincipalId, expiresAt],
	);

	// Step 2b: Upsert authority_grant from grantor → session (AC-5 Step 2).
	await query(
		`INSERT INTO roadmap.authority_grant
		   (grantor_id, grantee_id, scope_category, scope_ref,
		    authority_level, can_override, reason, expires_at, revoked_at)
		 VALUES ($1, $2, 'session-delegation', 'a2a-messaging',
		         $3, false,
		         'interactive CLI session ' || $4,
		         $5, NULL)
		 ON CONFLICT (grantor_id, grantee_id, scope_category, scope_ref)
		 DO UPDATE SET
		   expires_at = EXCLUDED.expires_at,
		   revoked_at = NULL`,
		[
			grantorPrincipalId,
			identity,
			SESSION_AUTHORITY_LEVEL,
			cliKind,
			expiresAt,
		],
	);

	return { identity, channel };
}

// ── Reaping ───────────────────────────────────────────────────────────────────

export interface SessionReapOpts {
	/** Session identity returned by registerSessionInstance. */
	identity: string;
	/** Human-readable reason for the reap, stored in agent_registry. */
	reason?: string;
}

/**
 * Reap a session on clean exit or detected PID death.
 *
 * Marks the agent_registry row inactive, sets revoked_at on the
 * authority_grant and principal_identity rows (AC-6).
 *
 * Idempotent — safe to call even if the row was already reaped.
 */
export async function reapSessionInstance(
	opts: SessionReapOpts,
): Promise<void> {
	const { identity, reason = "clean_exit" } = opts;
	const now = new Date();

	await query(
		`UPDATE roadmap_workforce.agent_registry
		 SET status     = 'inactive',
		     last_seen_at = now()
		 WHERE agent_identity = $1`,
		[identity],
	);

	await query(
		`UPDATE roadmap.authority_grant
		 SET revoked_at = $2
		 WHERE grantee_id = $1
		   AND revoked_at IS NULL`,
		[identity, now],
	);

	await query(
		`UPDATE roadmap.principal_identity
		 SET revoked_at         = $2,
		     revocation_reason  = $3
		 WHERE principal_id = $1
		   AND revoked_at IS NULL`,
		[identity, now, reason],
	);
}
