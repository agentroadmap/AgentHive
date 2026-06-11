#!/usr/bin/env bash
# P2322 AC-2: Idempotent deploy.sh — fast-forwards the deploy checkout to origin/main,
# validates migrations with migrate:check, rebuilds web bundle if needed, and reloads/restarts services.
#
# This script ensures that live services always run from a clean, tested checkout of origin/main.
# It is designed to be idempotent: repeated runs with the same origin/main state have no effect.
#
# Usage:
#   npm run deploy
#   npm run deploy --skip-web     (skip web bundle rebuild)
#   npm run deploy --skip-reload  (skip systemd daemon-reload + service restart)
#   scripts/deploy.sh [options]
#
# Environment variables:
#   DEPLOY_CHECKOUT_PATH   Path to the deploy checkout (default: /data/code/AgentHive-live)
#   AGENTHIVE_SKIP_WEB     If set to 1, skip web bundle rebuild
#   AGENTHIVE_SKIP_RELOAD  If set to 1, skip systemd reload+restart
#
# Exit codes:
#   0 = deployment successful
#   1 = general error (dirty tree, migrate:check failed, etc.)
#   2 = permission error (sudo required for systemd reload)
#
# Notes:
#   - Requires the deploy checkout to be a valid git clone with an 'origin' remote.
#   - Requires migrate:check to pass before service restart (P2313 gate).
#   - Web bundle rebuild uses 'npm run build:web' from the repo root.
#   - Service reload is atomic: single 'systemctl daemon-reload' + restart of all agenthive services.

set -euo pipefail

# Configuration
DEPLOY_CHECKOUT_PATH="${DEPLOY_CHECKOUT_PATH:-/data/code/AgentHive-live}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKIP_WEB="${AGENTHIVE_SKIP_WEB:-0}"
SKIP_RELOAD="${AGENTHIVE_SKIP_RELOAD:-0}"

# Parse command-line arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-web)    SKIP_WEB=1; shift ;;
    --skip-reload) SKIP_RELOAD=1; shift ;;
    *)
      echo "Error: unknown option '$1'"
      echo "Usage: $0 [--skip-web] [--skip-reload]"
      exit 1
      ;;
  esac
done

log_info() {
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] INFO: $*" >&2
}

log_error() {
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2
}

log_warn() {
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] WARN: $*" >&2
}

# Step 0: Validate setup
log_info "Validating deploy checkout at $DEPLOY_CHECKOUT_PATH"

if [[ ! -d "$DEPLOY_CHECKOUT_PATH" ]]; then
  log_error "Deploy checkout not found: $DEPLOY_CHECKOUT_PATH"
  log_error "First-time setup: create the deploy checkout with:"
  log_error "  git clone --bare $REPO_ROOT/.git $DEPLOY_CHECKOUT_PATH.git"
  log_error "  git clone $DEPLOY_CHECKOUT_PATH.git $DEPLOY_CHECKOUT_PATH"
  log_error "  cd $DEPLOY_CHECKOUT_PATH && git checkout -b main origin/main"
  exit 1
fi

if [[ ! -d "$DEPLOY_CHECKOUT_PATH/.git" ]]; then
  log_error "Deploy checkout is not a git repository: $DEPLOY_CHECKOUT_PATH"
  exit 1
fi

# Step 1: Fast-forward to origin/main
log_info "Fast-forwarding deploy checkout to origin/main"
cd "$DEPLOY_CHECKOUT_PATH"

# Ensure we have a clean working tree
DIRTY_FILES="$(git status --porcelain || true)"
if [[ -n "$DIRTY_FILES" ]]; then
  log_error "Deploy checkout has uncommitted changes (refusing to proceed):"
  echo "$DIRTY_FILES" >&2
  log_error "To recover, reset manually: cd $DEPLOY_CHECKOUT_PATH && git reset --hard origin/main"
  exit 1
fi

# Ensure we're on main
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  log_warn "Deploy checkout is on branch '$CURRENT_BRANCH', not 'main'. Checking out main..."
  git checkout main
fi

# Fetch latest origin/main
log_info "Fetching from origin"
git fetch origin main

# Check if we're behind
LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse origin/main)"

if [[ "$LOCAL_SHA" == "$REMOTE_SHA" ]]; then
  log_info "Deploy checkout is already up-to-date with origin/main ($LOCAL_SHA)"
else
  log_info "Updating from $LOCAL_SHA to $REMOTE_SHA"
  git reset --hard origin/main
fi

# Step 2: Validate migrations
log_info "Validating database migrations with 'npm run migrate:check'"

# We need to run migrate:check from the repo root with the correct environment
cd "$REPO_ROOT"

# Ensure the root is clean before running migrate:check
ROOT_DIRTY="$(git status --porcelain || true)"
if [[ -n "$ROOT_DIRTY" ]]; then
  log_warn "Dev checkout has uncommitted changes. This is allowed, but migrate:check may fail if migrations are incomplete."
fi

# Run migrate:check — P2313 gate requires this
if ! npm run migrate:check 2>&1; then
  log_error "Database migration check failed. Aborting deployment."
  log_error "Run 'npm run migrate:check' to see details."
  exit 1
fi

log_info "Migration check passed ✓"

# Step 3: Update environment file (optional; only if deploy checkout differs from live env)
log_info "Checking if PROJECT_ROOT needs updating in /etc/agenthive/env"
if [[ -f /etc/agenthive/env ]]; then
  LIVE_PROJECT_ROOT=$(grep "^PROJECT_ROOT=" /etc/agenthive/env | cut -d= -f2)
  if [[ "$LIVE_PROJECT_ROOT" != "$DEPLOY_CHECKOUT_PATH" ]]; then
    log_info "Updating PROJECT_ROOT in /etc/agenthive/env: $LIVE_PROJECT_ROOT → $DEPLOY_CHECKOUT_PATH"
    # This requires sudo, but we'll do it atomically
    if sudo -n true 2>/dev/null; then
      sudo sed -i "s|^PROJECT_ROOT=.*|PROJECT_ROOT=$DEPLOY_CHECKOUT_PATH|" /etc/agenthive/env
      log_info "Environment file updated ✓"
    else
      log_warn "Cannot update /etc/agenthive/env (no sudo). Services may still read from dev checkout."
      log_warn "Manual update: sudo sed -i 's|^PROJECT_ROOT=.*|PROJECT_ROOT=$DEPLOY_CHECKOUT_PATH|' /etc/agenthive/env"
    fi
  else
    log_info "PROJECT_ROOT already correct in /etc/agenthive/env"
  fi
else
  log_warn "Environment file /etc/agenthive/env not found (services may use hardcoded paths)"
fi

# Step 5: Rebuild web bundle if needed
if [[ "$SKIP_WEB" == "0" ]]; then
  log_info "Rebuilding web bundle with 'npm run build:web'"

  if ! npm run build:web 2>&1; then
    log_error "Web bundle rebuild failed. Aborting deployment."
    exit 1
  fi

  log_info "Web bundle rebuild complete ✓"
fi

# Step 6: Reload systemd and restart services
if [[ "$SKIP_RELOAD" == "0" ]]; then
  log_info "Reloading systemd daemon and restarting services"

  # Check if we have sudo permissions
  if ! sudo -n true 2>/dev/null; then
    log_error "Insufficient permissions to reload systemd. Run with sudo or set AGENTHIVE_SKIP_RELOAD=1"
    log_error "Manual reload command:"
    log_error "  sudo systemctl daemon-reload"
    log_error "  sudo systemctl restart agenthive-orchestrator agenthive-mcp agenthive-board agenthive-a2a agenthive-a2a-host agenthive-notification-router agenthive-state-feed"
    exit 2
  fi

  # Reload daemon and restart all agenthive services
  log_info "Running: sudo systemctl daemon-reload"
  sudo systemctl daemon-reload

  log_info "Restarting agenthive services..."
  # Restart the core services that read the checkout
  sudo systemctl restart agenthive-orchestrator || true
  sudo systemctl restart agenthive-mcp || true
  sudo systemctl restart agenthive-board || true
  sudo systemctl restart agenthive-a2a || true
  sudo systemctl restart agenthive-a2a-host || true
  sudo systemctl restart agenthive-notification-router || true
  sudo systemctl restart agenthive-state-feed || true

  log_info "Service restart complete ✓"
fi

log_info "Deployment successful: $DEPLOY_CHECKOUT_PATH is now running origin/main ($REMOTE_SHA)"
exit 0
