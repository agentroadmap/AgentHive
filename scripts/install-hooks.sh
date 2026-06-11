#!/usr/bin/env bash
# P677 — Install git hooks for SQL auditing.
#
# This script sets up the pre-commit hook by installing core.hooksPath.
# It should be run during local development setup (not in CI).
#
# Usage:
#   bash scripts/install-hooks.sh
#
# The hook will then run scripts/ci/check-migration-drops.sh on any staged
# migration files before commit.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Install the hook path
git config core.hooksPath scripts/git-hooks

echo "✓ Git hooks installed. Pre-commit SQL guard will run on staged migrations."
echo "  (Run 'git config --get core.hooksPath' to verify)"
