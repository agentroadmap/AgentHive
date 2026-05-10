---
title: Agency Deployment Runbook
proposal: P930
last_updated: 2026-05-09
---

# Deploying a New Agency

AgentHive ships a single generic agency runtime (`scripts/start-agency.ts`) shared
across all providers. To add a new agency (codex, gemini, hermes, additional
claude/copilot instances on a host), use the systemd template unit
`agenthive-agency@.service` — no new code, no new shim script, no new unit file.

## TL;DR

```bash
# 1. Pick an identity (no slash, simple kebab-case): claude-agency-bot,
#    codex-agency-bot, gemini-agency-bot, etc.
IDENTITY=codex-agency-bot

# 2. Create per-instance env (optional). Required: AGENTHIVE_AGENT_PROVIDER
#    if it can't be inferred from the identity prefix.
sudo tee /etc/agenthive/agency-${IDENTITY}.env <<EOF
AGENTHIVE_AGENT_PROVIDER=codex
EOF

# 3. Enable + start.
sudo systemctl daemon-reload
sudo systemctl enable --now agenthive-agency@${IDENTITY}.service

# 4. Verify.
sudo systemctl status agenthive-agency@${IDENTITY}.service
psql -h 127.0.0.1 -U admin -d agenthive -c \
  "SELECT agency_id, provider, status, last_heartbeat_at FROM roadmap.agency WHERE agency_id = '${IDENTITY}'"
```

## Identity format

**New agencies use kebab-case without a slash**: `provider-role`, e.g.
`claude-agency-bot`, `codex-agency-bot`, `gemini-agency-bot`,
`claude-agency-mac` (a second claude agency on a different host).

Slashes systemd-escape to `\x2f`, producing ugly instance names like
`agenthive-agency@claude\x2fagency-bot.service`. The kebab-case format is
operator-friendly and behaves cleanly under systemd templating.

**Legacy agencies** (`claude/agency-bot`, `copilot/agency-gary`) keep their
slash identities and continue running on their existing standalone units
(`agenthive-claude-agency.service`, `agenthive-copilot-agency.service`). They
are NOT migrated. P852 immutable-identity rules out renaming live identities.

## Per-instance environment file

Path: `/etc/agenthive/agency-<identity>.env` (filename matches the systemd
instance name verbatim). Optional — the unit uses `EnvironmentFile=-...` so a
missing file is non-fatal.

Common contents:

```bash
# Required if identity prefix doesn't match the provider literal in
# roadmap.model_routes.agent_provider:
AGENTHIVE_AGENT_PROVIDER=codex

# Optional CLI binary override (default: bare provider name on PATH):
# CODEX_BIN=/opt/codex/bin/codex
# CLAUDE_BIN=/opt/claude/bin/claude

# Optional: project opt-in for dispatch eligibility (CSV of project_id):
# AGENTHIVE_AGENT_PROJECTS=1,3
```

The runtime falls through to identity-prefix detection if
`AGENTHIVE_AGENT_PROVIDER` is unset, but explicit pinning is recommended for
operational clarity.

## What happens at boot

1. systemd starts `agenthive-agency@<identity>.service`.
2. `start-agency.ts` reads `AGENTHIVE_AGENT_IDENTITY=<identity>` from the env.
3. `selfRegisterAgency` (P912) upserts `roadmap_workforce.agent_registry` and
   `roadmap.agency`, opens a liaison session, starts the offer_dispatch hub,
   and writes `current_route_id` (P928) via the canonical route resolver.
4. Heartbeat (30s) + dormancy sweep (60s) run for the lifetime of the unit.
5. `runLiaisonAgent` (per-provider A2A reply loop) attaches if the
   `CliInvocationRegistry` (P920) has a handler for the provider.

## Verifying dispatchability

After boot, the agency must show in `roadmap.v_agency_status` with
`dispatchable=true`:

```sql
SELECT agency_id, provider, status, dispatchable
  FROM roadmap.v_agency_status
 WHERE agency_id = 'codex-agency-bot';
```

If `dispatchable=false`:
- Heartbeat may be stale (>90s silence). Check `last_heartbeat_at`.
- Host policy may block the route. Check `roadmap.host_model_policy`
  for the host: `allowed_providers` must include the route_provider for
  this agency's resolved model_route, or be empty (legacy/allow-all).
- No model_route may exist for the provider. Check `roadmap.model_routes
  WHERE agent_provider=<provider> AND is_enabled=true`.

## Removing an agency

```bash
sudo systemctl disable --now agenthive-agency@${IDENTITY}.service
sudo rm /etc/agenthive/agency-${IDENTITY}.env  # if you used one
psql -c "UPDATE roadmap.agency SET status = 'retired' WHERE agency_id = '${IDENTITY}'"
```

The agent_registry row stays for FK integrity (agent_runs, message_ledger may
reference it). To soft-disable, use `status='retired'` rather than DELETE.

## Why this template exists

Pre-P930 history: AgentHive shipped `agenthive-claude-agency.service` and
`agenthive-copilot-agency.service` as separate unit files. The runtime under
both was always the same generic `start-agency.ts` (per P912). Per-provider
units were duplication that this template removes. New agencies ride the
template; legacy units stay during transition.
