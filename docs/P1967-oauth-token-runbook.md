# P1967: Claude Code OAuth Token Setup & Rotation Runbook

## Overview

AgentHive spawns Claude Code processes with `claude --print` for long-running tasks. To eliminate the daemon-refresh-gap 401 storm, this runbook describes how to provision and rotate a long-lived CLAUDE_CODE_OAUTH_TOKEN (1-year subscription OAuth token).

## Prerequisites

- **Access to claude CLI**: `claude setup-token` command must be available on the orchestrator host
- **Subscription account**: The token must be from a subscription-billed Claude account (not free tier)
- **Permissions**: Root or sudo access to `/etc/agenthive/env` file
- **Time**: Token lifetime = 365 days; plan rotations in advance

## Initial Setup

### 1. Generate the OAuth Token

Run on your local machine or the orchestrator host:

```bash
claude setup-token
```

This opens a web browser to authenticate and generates a long-lived OAuth token. The token is stored in `~/.claude/.credentials.json` on your local system by default.

Copy the token value (or extract from the credentials file).

### 2. Store the Token in the Environment

Store the token in a secure location accessible to the orchestrator process. The standard location is `/etc/agenthive/env`:

```bash
sudo tee /etc/agenthive/env <<EOF
CLAUDE_CODE_OAUTH_TOKEN=<your-long-lived-token-here>
EOF

# Secure permissions (owner-read-only)
sudo chmod 600 /etc/agenthive/env
```

**Security Note**: Never commit the token to git or logs. The token is subscription-billed and gives API access.

### 3. Restart the Orchestrator

For the token to be injected into claude spawns, restart the orchestrator service:

```bash
sudo systemctl restart agenthive-orchestrator
```

The token will be read from the environment and injected into `CLAUDE_CODE_OAUTH_TOKEN` for each spawned process.

## Monitoring Token Expiry

The orchestrator monitors token expiry automatically via `src/core/runtime/oauth-token-monitor.ts`:

- **computeExpiryDays(provisioned_at_ms)**: Returns days until the token expires (365-day lifetime)
- **checkOAuthTokenExpiry(provisioned_at_ms, warn_days_threshold)**: Logs a WARN when within 30 days (default) of expiration
- **emitOAuthRotateSignal(status_code, reason)**: Logs an ERROR with structured signal on 401 failures

### Monitoring Logs

Watch for these signals in system logs or observability platform:

```
[OAUTH_TOKEN_EXPIRING] CLAUDE_CODE_OAUTH_TOKEN expires in 25 days (2026-06-29T11:18:24.016Z)
```

When expiry warning appears, plan token rotation immediately. Expiring tokens fail all claude spawns with 401 errors.

## Rotation Procedure

Follow this when the token is near expiry or fails with a 401 error.

### 1. Generate a New Token

```bash
claude setup-token
```

Generate a fresh token and copy the value.

### 2. Update the Token

```bash
sudo tee /etc/agenthive/env <<EOF
CLAUDE_CODE_OAUTH_TOKEN=<new-long-lived-token>
EOF

sudo chmod 600 /etc/agenthive/env
```

### 3. Restart the Orchestrator

```bash
sudo systemctl restart agenthive-orchestrator
```

All new spawns will use the fresh token. In-flight processes will complete under the old token.

### 4. Verify the Rotation

Monitor logs for confirmation:

```bash
journalctl -u agenthive-orchestrator -f
```

Look for new spawns completing successfully without 401 errors.

## Fallback Behavior

If CLAUDE_CODE_OAUTH_TOKEN is absent, spawns fall back to host-inherited auth:

- The `claude` CLI reads `~/.claude/.credentials.json` from HOME directory
- This may trigger the daemon-refresh-gap issue, but spawns continue
- A missing token is NOT fatal; rotation can wait until warning threshold

## Troubleshooting

### 401 UNAUTHORIZED Errors

```
[OAUTH_TOKEN_ROTATE] OAuth token rotation needed: claude --print returned 401 UNAUTHORIZED (status=401)
```

**Cause**: Token is expired or invalid.

**Fix**: Follow the Rotation Procedure above to generate and install a fresh token.

### Token Not Being Injected

**Symptom**: Spawns use host-inherited credentials instead of the token.

**Cause**: Token is not set in `/etc/agenthive/env` or orchestrator was not restarted.

**Fix**:
1. Verify token is set: `cat /etc/agenthive/env | grep CLAUDE_CODE_OAUTH_TOKEN`
2. Restart orchestrator: `sudo systemctl restart agenthive-orchestrator`
3. Check logs for confirmation

### Orchestrator Won't Start

**Cause**: File permissions or environment syntax error.

**Fix**:
1. Check syntax: `echo $CLAUDE_CODE_OAUTH_TOKEN` (should print the token)
2. Verify permissions: `ls -l /etc/agenthive/env` (should be 600)
3. Check orchestrator logs: `journalctl -u agenthive-orchestrator -n 50`

## Architecture

- **Token injection**: `src/core/runtime/cli-builders.ts` — ClaudeCliBuilder.buildEnv()
- **Monitoring**: `src/core/runtime/oauth-token-monitor.ts` — computeExpiryDays(), checkOAuthTokenExpiry()
- **Rotation signals**: `src/core/runtime/oauth-token-monitor.ts` — emitOAuthRotateSignal()

The token sits above `~/.claude/.credentials.json` in Claude Code's auth precedence, eliminating the daemon-refresh-gap issue for long-running spawns.

## References

- P1967: Claude Code OAuth Token env injection
- Claude Code docs: `claude setup-token` command
- Agent spawning: `src/core/orchestration/agent-spawner.ts`
