#!/usr/bin/env bash
# P417 — credential anti-pattern guard.
#
# Fails if any tracked source file uses PGPASSWORD= to pass a hardcoded
# literal credential inline (e.g. PGPASSWORD=mypassword psql ...). This
# pattern exposes the credential in ps/procfs and violates our policy.
#
# Legitimate relay patterns are intentionally excluded:
#   PGPASSWORD="${SOME_VAR}"    — relay from env var (OK)
#   PGPASSWORD=""               — explicit empty (OK for scratch/DR tests)
#   PGPASSWORD=                 — unset/empty (OK)
#
# See memory note: "No PGPASSWORD in Bash" (2026-05-04 incident).
#
# Usage:
#   bash scripts/check-credential-env.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Find lines that look like inline credential passing:
#   PGPASSWORD=<word-chars>  (not $-variable, not empty, not quoting start)
# Then filter out:
#   - Comment lines (lines whose non-space content starts with # or //)
#   - The check script itself (would match its own examples)
#   - Files that only reference the pattern as a regex/search string
VIOLATIONS=$(grep -rn \
    --include='*.sh' --include='*.ts' --include='*.tsx' \
    --include='*.cjs' --include='*.mjs' \
    --exclude='check-credential-env.sh' \
    --exclude='migrate-principal-identity.ts' \
    'PGPASSWORD=[A-Za-z0-9_]' \
    scripts/ src/ 2>/dev/null \
    | grep -v '^\s*#' \
    | grep -v '^\s*//' \
    || true)

if [[ -n "$VIOLATIONS" ]]; then
    echo "check-credential-env: FAIL — inline PGPASSWORD literal found:"
    echo "$VIOLATIONS"
    echo ""
    echo "Use PGPASSWORD=\"\${SOME_VAR}\" or ~/.pgpass (chmod 600) instead."
    exit 1
fi

echo "check-credential-env: OK — no inline PGPASSWORD literals found."
