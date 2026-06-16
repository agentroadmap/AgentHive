#!/usr/bin/env bash
# P1456 AC-8: Ambient-receive hook (UserPromptSubmit / before-turn)
#
# Read unread A2A DMs for the current session identity and inject them
# into the next turn's context. Claude Code fires this on "UserPromptSubmit";
# Codex fires the equivalent "UserPromptSubmit" / "input_received" hook.
#
# REQUIRED ENV:
#   AGENTHIVE_SESSION_IDENTITY  — e.g. "claude-bot-gary.a/session/7f3a2c"
#   PGHOST, PGPORT, PGUSER, PGDATABASE  — Postgres connection (from .claude/settings.json)
#
# OUTPUT (stdout, Claude Code hook protocol):
#   JSON with optional "user_message_injections" or exits 0 with no output if
#   no messages. Exit 2 blocks the turn (do not use for ambient receive).
#
# WAKE BOUNDARY (AC-10):
#   msg_send() triggers pg_notify on msg_<identity> immediately, but this hook
#   is NOT a LISTEN loop. It reads the inbox synchronously before each turn.
#   A session blocked on stdin between turns does not receive the pg_notify.
#   For unsolicited cold wake, the standing agency liaison lane is the fallback.

set -euo pipefail

IDENTITY="${AGENTHIVE_SESSION_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
    # Not in a session-instance context; no-op.
    exit 0
fi

INBOX_LIMIT="${AGENTHIVE_INBOX_LIMIT:-10}"

# Query unread messages via psql
MESSAGES=$(psql \
    --host="${PGHOST:-127.0.0.1}" \
    --port="${PGPORT:-5432}" \
    --username="${PGUSER:-admin}" \
    --dbname="${PGDATABASE:-agenthive}" \
    --tuples-only --no-align \
    --command="
        SELECT from_agent || ' | ' || sent_at::text || E'\n' || body
          FROM roadmap.a2a_messages
         WHERE to_agent = '${IDENTITY}'
           AND read_at IS NULL
         ORDER BY sent_at ASC
         LIMIT ${INBOX_LIMIT};
    " 2>/dev/null || true)

if [[ -z "$MESSAGES" ]]; then
    exit 0
fi

# Mark messages as read so they don't re-appear next turn
psql \
    --host="${PGHOST:-127.0.0.1}" \
    --port="${PGPORT:-5432}" \
    --username="${PGUSER:-admin}" \
    --dbname="${PGDATABASE:-agenthive}" \
    --tuples-only --no-align \
    --command="
        UPDATE roadmap.a2a_messages
           SET read_at = now()
         WHERE to_agent = '${IDENTITY}'
           AND read_at IS NULL;
    " 2>/dev/null || true

# Emit injection block to stdout (Claude Code hook stdin-prepend format)
# Claude Code will prepend this to the user's next message.
cat <<EOF
{
  "user_message_injections": [
    "--- Unread A2A messages for ${IDENTITY} ---\n${MESSAGES}\n--- End A2A messages ---"
  ]
}
EOF
