#!/usr/bin/env bash
# P417 — AgentHive local CI-equivalent gate.
#
# Deterministic, host-assumption-free gate for TypeScript, lint, migrations,
# package hygiene, and optional MCP smoke. Run this before restarts, gate
# decisions, or merges.
#
# Usage:
#   bash scripts/ci/gate.sh                # preflight only (fast, <10s)
#   bash scripts/ci/gate.sh --full         # + integration checks (<60s total)
#   bash scripts/ci/gate.sh --mcp-smoke    # + MCP health probe
#   bash scripts/ci/gate.sh --auto         # auto-enable --full when
#                                          # migration/mcp/systemd files changed
#   bash scripts/ci/gate.sh --full --mcp-smoke   # full + smoke
#
# Environment overrides (CI-friendly):
#   GATE_FULL=1        equivalent to --full
#   GATE_MCP_SMOKE=1   equivalent to --mcp-smoke
#   GATE_AUTO=1        equivalent to --auto
#   BASE_REF=...       git ref for diff base (default: origin/main)
#
# Exit codes:
#   0 — all required checks passed
#   1 — at least one required check failed
#
# Gate categories
# ───────────────
# PREFLIGHT  Typecheck, env-credential guard. Target: <10s.
#            Always mandatory.
#
# INTEGRATION  Migration-drop linkage, legacy migration directory guard,
#              publish-hygiene (scratch file guard), migration-prefix uniqueness.
#              Mandatory when --full or --auto detects migration/mcp/systemd changes.
#
# SMOKE      MCP HTTP health probe. Mandatory when --mcp-smoke; skipped otherwise.
#
# DEFERRED   Checks intentionally excluded from gate due to pre-existing debt
#            or missing prerequisites. Each printed with proposal reference.
#
# Deferred checks (as of P417):
#   - audit:sql       Needs DATABASE_URL; DB-connected audits are out-of-scope
#                     for local gate. Tracked: P677.
#   - biome check     1303 pre-existing lint errors constitute tech debt, not
#                     regressions. Tracked for cleanup: P417 scope note.
#   - check:hardcoded False positives on "roadmap" word in comments; not gating.
#                     Tracked: P417 scope note.
#   - scan:workflow-states  Informational; baseline has 128 drift items. Tracked: P453.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# ── Flag parsing ──────────────────────────────────────────────────────────────

FULL=0
MCP_SMOKE=0
AUTO=0

for arg in "$@"; do
    case "$arg" in
        --full)      FULL=1 ;;
        --mcp-smoke) MCP_SMOKE=1 ;;
        --auto)      AUTO=1 ;;
        --help|-h)
            sed -n '1,/^set -euo/p' "$0" | grep '^#' | sed 's/^# \?//'
            exit 0
            ;;
    esac
done

[[ "${GATE_FULL:-0}" == "1" ]]      && FULL=1
[[ "${GATE_MCP_SMOKE:-0}" == "1" ]] && MCP_SMOKE=1
[[ "${GATE_AUTO:-0}" == "1" ]]      && AUTO=1

BASE_REF="${BASE_REF:-origin/main}"

# ── Auto-detect FULL requirement ──────────────────────────────────────────────

if [[ $AUTO -eq 1 && $FULL -eq 0 ]]; then
    CHANGED=$(git diff --name-only "${BASE_REF}...HEAD" 2>/dev/null || true)
    if echo "$CHANGED" | grep -qE '^scripts/migrations/.*\.sql|^src/apps/mcp-server/|^scripts/systemd/|\.service$'; then
        echo "[GATE] auto: migration/mcp/systemd changes detected — enabling full gate"
        FULL=1
    fi
fi

# ── Step tracking ─────────────────────────────────────────────────────────────

PASS=0
FAIL=0
SKIP=0
FAILED_STEPS=()

step_run() {
    # step_run <label> <cmd...>
    local label="$1"; shift
    local out
    printf "[GATE] %-55s " "$label ..."
    if out=$("$@" 2>&1); then
        echo "PASS"
        PASS=$((PASS+1))
    else
        echo "FAIL"
        echo "$out" | sed 's/^/         | /'
        FAIL=$((FAIL+1))
        FAILED_STEPS+=("$label")
    fi
}

step_skip() {
    local label="$1" reason="$2" ref="${3:-}"
    local suffix=""
    [[ -n "$ref" ]] && suffix=" [deferred: $ref]"
    printf "[GATE] %-55s SKIP  %s%s\n" "$label" "$reason" "$suffix"
    SKIP=$((SKIP+1))
}

step_info() {
    local label="$1"; shift
    local out
    printf "[GATE] %-55s " "$label (informational) ..."
    if out=$("$@" 2>&1); then
        echo "PASS"
    else
        echo "INFO (non-blocking)"
        echo "$out" | tail -5 | sed 's/^/         | /'
    fi
    # informational steps don't count toward PASS/FAIL
}

# ── Banner ────────────────────────────────────────────────────────────────────

MODE="PREFLIGHT"
[[ $FULL -eq 1 ]] && MODE="PREFLIGHT + INTEGRATION"
[[ $MCP_SMOKE -eq 1 ]] && MODE="$MODE + MCP-SMOKE"

echo "[GATE] ============================================================="
echo "[GATE] AgentHive local CI gate  (P417)"
echo "[GATE] mode   : $MODE"
echo "[GATE] base   : $BASE_REF"
echo "[GATE] time   : $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "[GATE] ============================================================="
echo ""

# ── PREFLIGHT ─────────────────────────────────────────────────────────────────
echo "[GATE] --- PREFLIGHT (target: <10s) ---"

# TypeScript hot-path check — hive-cli, cubic-agents, gate (P786)
step_run "typecheck (hive-cli, cubic-agents, gate)" \
    node node_modules/typescript/bin/tsc -p tsconfig.check.json --noEmit

# Credential anti-pattern guard (P417)
step_run "check:credential-env" \
    bash scripts/check-credential-env.sh

step_run "audit:dispatch-selects (P1411)" \
    node --import jiti/register scripts/ci/check-dispatch-proposal-selects.ts

step_run "audit:mcp-param-fidelity (P1389)" \
    node --import jiti/register scripts/ci/check-mcp-param-fidelity.ts

echo ""

# ── INTEGRATION ───────────────────────────────────────────────────────────────
if [[ $FULL -eq 1 ]]; then
    echo "[GATE] --- INTEGRATION (target: <60s) ---"

    # Migration drop/rename linkage check — fails if a staged migration's
    # DROP/RENAME still has references in src/ or scripts/ (P677)
    step_run "audit:migrations (DROP/RENAME linkage)" \
        bash scripts/ci/check-migration-drops.sh

    # Legacy migration directory guard — new SQL must not go into
    # database/migrations/ (inactive path); active path is scripts/migrations/ (P690)
    _legacy_guard() {
        local LEGACY_SQL
        LEGACY_SQL=$(git diff --name-only "${BASE_REF}...HEAD" -- 'database/migrations/*.sql' 2>/dev/null || true)
        if [[ -n "$LEGACY_SQL" ]]; then
            echo "New SQL migration(s) in INACTIVE legacy path (database/migrations/)."
            echo "Move them to scripts/migrations/ — they will NEVER be applied from the legacy path."
            printf '%s\n' "$LEGACY_SQL"
            return 1
        fi
        echo "No new SQL files in database/migrations/ — OK."
    }
    step_run "legacy-migration-guard (P690)" _legacy_guard

    # Publish hygiene — blocks scratch/temp files from reaching main (check-publish-hygiene)
    step_run "check:publish" \
        node scripts/check-publish-hygiene.mjs --base "${BASE_REF}"

    # Workflow state literal guard — informational; baseline has drift (P453)
    step_info "scan:workflow-states (P453, informational)" \
        node --import jiti/register scripts/scan-hardcoding.ts \
             --rule-tag workflow --fail-on high \
             --baseline .workflow-states-baseline.jsonl

    # P1290: capability coverage check — fails if any role maps to a capability
    # with zero matching dispatchable agencies in provider_registry.
    if [[ -n "${DATABASE_URL:-}" ]]; then
        step_run "check:capability-coverage (P1290)" \
            node --import jiti/register scripts/orchestrator-capability-coverage-check.ts
    else
        step_skip "check:capability-coverage (P1290)" \
            "requires DATABASE_URL; run 'npm run check:capability-coverage' locally" "P1290"
    fi

    echo ""
fi

# ── MCP SMOKE ─────────────────────────────────────────────────────────────────
if [[ $MCP_SMOKE -eq 1 ]]; then
    echo "[GATE] --- MCP SMOKE ---"

    _mcp_health() {
        local resp
        resp=$(curl -fsS --max-time 5 http://127.0.0.1:6421/health 2>&1)
        echo "$resp"
    }
    step_run "mcp-health (127.0.0.1:6421/health)" _mcp_health

    echo ""
fi

# ── DEFERRED (always printed for transparency) ────────────────────────────────
echo "[GATE] --- DEFERRED ---"

if [[ $FULL -eq 0 ]]; then
    step_skip "audit:migrations + integration checks" \
        "run gate --full for migration/mcp/systemd changes" "P417"
fi

step_skip "audit:sql (SQL column audit)" \
    "requires DATABASE_URL; DB-connected audit is out-of-scope for local gate" "P677"

step_skip "biome check (full lint)" \
    "1303 pre-existing errors constitute tech debt; gating on it would block all work" "P417"

step_skip "scan:workflow-states (gating)" \
    "128 baseline drift items; only informational until P453 delivers state-names module" "P453"

step_skip "check:hardcoded" \
    "false positives on 'roadmap' word in comments; not suitable as gate block" "P417"

step_skip "check:migrations (prefix uniqueness)" \
    "script targets legacy database/migrations/ (inactive path); active scripts/migrations/ also has pre-existing duplicates from parallel branch merges" "P417"

echo ""

# ── Summary ───────────────────────────────────────────────────────────────────
echo "[GATE] ============================================================="
printf "[GATE] Results: %d passed, %d failed, %d skipped/deferred\n" \
    "$PASS" "$FAIL" "$SKIP"

if [[ $FAIL -gt 0 ]]; then
    echo "[GATE] STATUS: FAIL"
    echo "[GATE] Failed steps:"
    for s in "${FAILED_STEPS[@]}"; do
        echo "[GATE]   - $s"
    done
    echo "[GATE] ============================================================="
    exit 1
fi

echo "[GATE] STATUS: PASS"
echo "[GATE] ============================================================="
exit 0
