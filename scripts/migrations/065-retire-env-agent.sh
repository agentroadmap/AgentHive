#!/usr/bin/env bash
# P289 AC6 — Retire .env.agent from all worktrees.
#
# After migration 065 lands, OfferProvider sources provider config from
# provider_registry (DB) rather than .env.agent files.  This script removes
# any remaining .env.agent files from known worktrees so the old code path
# cannot be accidentally re-activated.
#
# Run once per host after deploying the P289 changes:
#   bash scripts/migrations/065-retire-env-agent.sh

set -euo pipefail

WORKTREE_ROOT="${WORKTREE_ROOT:-/data/code/worktree}"

echo "[retire-env-agent] Scanning $WORKTREE_ROOT for .env.agent files..."

removed=0
for f in "$WORKTREE_ROOT"/*/.env.agent; do
  if [[ -f "$f" ]]; then
    echo "  Removing: $f"
    rm "$f"
    ((removed++)) || true
  fi
done

if [[ $removed -eq 0 ]]; then
  echo "[retire-env-agent] No .env.agent files found — nothing to do."
else
  echo "[retire-env-agent] Removed $removed .env.agent file(s)."
fi

echo "[retire-env-agent] Done."
