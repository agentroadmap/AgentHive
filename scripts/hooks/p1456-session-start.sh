#!/usr/bin/env bash
# P1456 AC-1: Session-start hook (SessionStart event)
#
# Registers this interactive CLI session as an addressable A2A endpoint by
# calling registerSession() (src/infra/agency/session-registration.ts).
# Must run BEFORE the ambient-receive or solicited-wake hooks so that
# AGENTHIVE_SESSION_IDENTITY is set and the agent_registry row exists.
#
# REQUIRED ENV (set by the operator in .claude/settings.json or codex config):
#   AGENTHIVE_STANDING_AGENCY   — standing agency identity, e.g. "claude-bot-gary.a"
#   AGENTHIVE_CLI_KIND          — "claude-code" | "codex" | "gemini"
#   AGENTHIVE_LLM_VARIANT       — e.g. "claude-sonnet-4-6" (optional)
#   PGHOST, PGPORT, PGUSER, PGDATABASE — Postgres connection
#
# OPTIONAL ENV:
#   AGENTHIVE_SESSION_IDENTITY  — if already set (e.g. on re-registration after
#                                  crash), skips deriving a new id; uses this value.
#   CLAUDE_SESSION_ID           — Claude Code provides this; used as the raw
#                                  session id before shortening.
#   CODEX_SESSION_ID            — Codex equivalent.
#   GEMINI_SESSION_ID           — Gemini equivalent.
#
# OUTPUT:
#   Writes the derived AGENTHIVE_SESSION_IDENTITY to stdout in Claude Code
#   hook env-export format so downstream hooks receive the value.
#   Exits 1 on fatal errors (prevents turn from starting with a broken session).
#
# NON-DISPATCHABLE:
#   This hook does NOT create a provider_registry or roadmap.agency row.
#   The standing agency remains the only dispatch-eligible lane (AC-2).

set -euo pipefail

STANDING_AGENCY="${AGENTHIVE_STANDING_AGENCY:-claude-bot-gary.a}"
CLI_KIND="${AGENTHIVE_CLI_KIND:-claude-code}"
LLM_VARIANT="${AGENTHIVE_LLM_VARIANT:-}"

PGHOST_V="${PGHOST:-127.0.0.1}"
PGPORT_V="${PGPORT:-5432}"
PGUSER_V="${PGUSER:-admin}"
PGDATABASE_V="${PGDATABASE:-agenthive}"

# ── Derive short session id ──────────────────────────────────────────────────
# Prefer a CLI-supplied stable session id; fall back to a random 12-char hex slug.
RAW_SESSION_ID="${CLAUDE_SESSION_ID:-${CODEX_SESSION_ID:-${GEMINI_SESSION_ID:-}}}"

if [[ -z "$RAW_SESSION_ID" ]]; then
    # No CLI session id available; generate a random 12-char hex slug.
    RAW_SESSION_ID=$(head -c 6 /dev/urandom | xxd -p | tr -d '\n')
fi

# Truncate to 12 hex chars to stay within the 63-byte PG channel limit.
# Mirrors shortSessionId() in session-registration.ts.
SHORT_ID="${RAW_SESSION_ID:0:12}"
SHORT_ID="${SHORT_ID,,}"  # lowercase

SESSION_IDENTITY="${AGENTHIVE_SESSION_IDENTITY:-${STANDING_AGENCY}/session/${SHORT_ID}}"

# ── Validate channel length (AC-18) ─────────────────────────────────────────
CHANNEL="msg_${SESSION_IDENTITY}"
CHANNEL_LEN=${#CHANNEL}
if (( CHANNEL_LEN > 63 )); then
    echo "[p1456-session-start] ERROR: channel '${CHANNEL}' is ${CHANNEL_LEN} bytes (max 63). Shorten AGENTHIVE_STANDING_AGENCY or the session id." >&2
    exit 1
fi

# ── Upsert agent_registry row (AC-1) ────────────────────────────────────────
# Mirrors registerSession() in session-registration.ts so the hook is
# self-contained and does not require bun/node at SessionStart time.
EXPIRES_AT=$(date -u -d "+8 hours" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
          || date -u -v+8H +"%Y-%m-%dT%H:%M:%SZ")  # GNU vs BSD date

PARENT_AGENCY_ID=$(psql \
    --host="${PGHOST_V}" --port="${PGPORT_V}" \
    --username="${PGUSER_V}" --dbname="${PGDATABASE_V}" \
    --tuples-only --no-align \
    --command="SELECT id FROM roadmap_workforce.agent_registry WHERE agent_identity = '${STANDING_AGENCY}' LIMIT 1;" \
    2>/dev/null || echo "")
PARENT_AGENCY_ID="${PARENT_AGENCY_ID// /}"

psql \
    --host="${PGHOST_V}" --port="${PGPORT_V}" \
    --username="${PGUSER_V}" --dbname="${PGDATABASE_V}" \
    --tuples-only --no-align \
    --command="
        INSERT INTO roadmap_workforce.agent_registry
          (agent_identity, agent_type, role, status, trust_tier,
           host_affinity, last_seen_at, agency_id, agent_cli, llm_variant)
        VALUES (
          '${SESSION_IDENTITY}', 'llm', 'interactive-session', 'active', 'trusted',
          '$(hostname)', now(),
          $([ -n "${PARENT_AGENCY_ID}" ] && echo "${PARENT_AGENCY_ID}" || echo "NULL"),
          '${CLI_KIND}',
          $([ -n "${LLM_VARIANT}" ] && echo "'${LLM_VARIANT}'" || echo "NULL")
        )
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
          updated_at    = now();
    " 2>/dev/null

# ── Upsert session principal_identity (AC-5 step 1) ─────────────────────────
psql \
    --host="${PGHOST_V}" --port="${PGPORT_V}" \
    --username="${PGUSER_V}" --dbname="${PGDATABASE_V}" \
    --tuples-only --no-align \
    --command="
        INSERT INTO roadmap.principal_identity
          (principal_id, principal_kind, credential_kind,
           parent_principal_id, expires_at, revoked_at)
        VALUES ('${SESSION_IDENTITY}', 'agent', 'delegated', 'user/gary', '${EXPIRES_AT}', NULL)
        ON CONFLICT (principal_id) DO UPDATE SET
          credential_kind     = 'delegated',
          parent_principal_id = 'user/gary',
          expires_at          = '${EXPIRES_AT}',
          revoked_at          = NULL;
    " 2>/dev/null

# ── Upsert authority_grant (AC-5 step 2) ────────────────────────────────────
psql \
    --host="${PGHOST_V}" --port="${PGPORT_V}" \
    --username="${PGUSER_V}" --dbname="${PGDATABASE_V}" \
    --tuples-only --no-align \
    --command="
        INSERT INTO roadmap.authority_grant
          (grantor_id, grantee_id, scope_category, scope_ref,
           authority_level, can_override, reason, expires_at, revoked_at)
        VALUES (
          'user/gary', '${SESSION_IDENTITY}',
          'session-delegation', 'a2a-messaging',
          'trusted', false,
          'Interactive ${CLI_KIND} CLI session on $(hostname)',
          '${EXPIRES_AT}', NULL
        )
        ON CONFLICT (grantor_id, grantee_id, scope_category, scope_ref)
        DO UPDATE SET
          expires_at = '${EXPIRES_AT}',
          revoked_at = NULL;
    " 2>/dev/null

# ── Export session identity for downstream hooks ─────────────────────────────
# Claude Code hook protocol: emit JSON with env vars to inject into the session.
cat <<HOOKEOF
{
  "env": {
    "AGENTHIVE_SESSION_IDENTITY": "${SESSION_IDENTITY}"
  }
}
HOOKEOF

echo "[p1456-session-start] Registered ${SESSION_IDENTITY} (channel=${CHANNEL})" >&2
