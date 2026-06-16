#!/usr/bin/env bash
# P1456 AC-9: Solicited-wake hook (Stop / after-turn)
#
# After the AI turn completes, poll the inbox once for an arriving DM reply
# on the msg_<session-identity> channel. Used when this session sent a DM to
# another agent and wants to pick up the reply without waiting for the next
# human turn.
#
# REQUIRED ENV:
#   AGENTHIVE_SESSION_IDENTITY   — e.g. "claude-bot-gary.a/session/7f3a2c"
#   PGHOST, PGPORT, PGUSER, PGDATABASE
#
# OPTIONAL ENV:
#   AGENTHIVE_SOLICITED_WAIT_MS  — poll deadline in ms (default: 30000)
#   AGENTHIVE_SOLICITED_WATCH_FROM  — only surface messages from this sender
#
# WAKE BOUNDARY (AC-10):
#   This hook runs a bounded LISTEN loop (up to WAIT_MS). pg_notify fires on
#   msg_<identity> when a message is inserted. If a reply arrives within the
#   window, this hook exits 2 to force-continue the turn (Claude Code protocol).
#   If no reply arrives within the window, exits 0 (turn ends cleanly).
#   For unsolicited cold wake, the standing agency liaison lane remains the
#   authoritative fallback.

set -euo pipefail

IDENTITY="${AGENTHIVE_SESSION_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
    exit 0
fi

WAIT_MS="${AGENTHIVE_SOLICITED_WAIT_MS:-30000}"
WATCH_FROM="${AGENTHIVE_SOLICITED_WATCH_FROM:-}"

CHANNEL="msg_${IDENTITY}"
WAIT_SECS=$(( WAIT_MS / 1000 ))

# Use psql LISTEN to wait for a notification, then read the newest message.
# If a message arrives within WAIT_SECS, output it and exit 2 (force-continue).
# psql \watch is not suitable here; use a node/bun one-shot listener instead.

LISTENER_SCRIPT=$(cat <<'NODEEOF'
import { Client } from 'pg';

const channel = process.env.PG_CHANNEL;
const waitMs  = parseInt(process.env.WAIT_MS ?? '30000', 10);
const watchFrom = process.env.WATCH_FROM ?? '';
const identity  = process.env.IDENTITY ?? '';

const client = new Client({
  host:     process.env.PGHOST     ?? '127.0.0.1',
  port:     parseInt(process.env.PGPORT ?? '5432', 10),
  user:     process.env.PGUSER     ?? 'admin',
  database: process.env.PGDATABASE ?? 'agenthive',
});

await client.connect();
await client.query(`LISTEN "${channel}"`);

let resolved = false;
const timer = setTimeout(async () => {
  if (!resolved) { resolved = true; await client.end(); process.exit(0); }
}, waitMs);

client.on('notification', async (n) => {
  if (resolved) return;
  resolved = true;
  clearTimeout(timer);

  // Read the triggering message from the DB to get full content
  const filter = watchFrom ? 'AND from_agent = $2' : '';
  const params = watchFrom ? [identity, watchFrom] : [identity];
  const { rows } = await client.query(
    `SELECT from_agent, body, sent_at
       FROM roadmap.a2a_messages
      WHERE to_agent = $1
        AND read_at IS NULL
        ${filter}
      ORDER BY sent_at DESC
      LIMIT 1`,
    params,
  );
  await client.end();

  if (rows.length === 0) { process.exit(0); }
  const msg = rows[0];
  process.stdout.write(JSON.stringify({
    user_message_injections: [
      `[A2A reply from ${msg.from_agent} at ${msg.sent_at}]\n${msg.body}`
    ]
  }));
  // Exit 2 = force-continue (Claude Code hook protocol)
  process.exit(2);
});
NODEEOF
)

PG_CHANNEL="$CHANNEL" \
WAIT_MS="$WAIT_MS" \
WATCH_FROM="$WATCH_FROM" \
IDENTITY="$IDENTITY" \
  bun --eval "$LISTENER_SCRIPT" 2>/dev/null

# bun exits with 0 (no message) or 2 (message found, force-continue)
exit $?
