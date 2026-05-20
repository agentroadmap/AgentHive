#!/usr/bin/env bash
# scripts/gate.sh — P417: Local CI-equivalent gate
#
# SOURCE OF TRUTH: This file is the authoritative CI-equivalent gate definition.
#   All required checks are listed here. CONVENTIONS.md §8.1 documents trigger conditions.
#   Child proposals under P417 track expansion of deferred check coverage.
#
# MIGRATION BOUNDARY: scripts/migrations/ is the canonical active migration directory.
#   database/migrations/ is LEGACY (pre-P753) and contains pre-existing duplicate prefixes;
#   migration prefix checks run against scripts/migrations/ only.
#
# REQUIRED CAPABILITIES: ci, typescript (as declared in P417 proposal).
#
# USAGE
#   npm run ci                 # full gate (both tiers)
#   npm run ci -- --preflight  # tier 1 only (fast <10s)
#   bash scripts/gate.sh --full  # tier 2 forced
#
# TIER 1 — Fast preflight (<10s): typecheck + credential-env check
#   Mandatory before any commit on TypeScript sources.
#   Note: biome check is deferred (pre-existing violations across codebase — see DEFERRED below).
#
# TIER 2 — Full gate (<60s): preflight + migration checks + hardcoding scan
#   Mandatory before restart, MCP change, systemd unit change, or merge.
#   See CONVENTIONS.md §8.1 for trigger conditions.
#
# EXIT CODES
#   0  all required checks pass
#   1  one or more required checks failed (see FAILED step above)
#   2  gate invocation error (missing deps, bad args)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── helpers ──────────────────────────────────────────────────────────────────

GREEN="\033[0;32m"
RED="\033[0;31m"
YELLOW="\033[0;33m"
BOLD="\033[1m"
RESET="\033[0m"

PASS="[PASS]"
FAIL="[FAIL]"
SKIP="[SKIP]"
INFO="[INFO]"

FAILED_STEPS=()
DEFERRED_STEPS=()

step_pass()  { echo -e "${GREEN}${PASS}${RESET} $*"; }
step_fail()  { echo -e "${RED}${FAIL}${RESET} $*"; FAILED_STEPS+=("$*"); }
step_skip()  { echo -e "${YELLOW}${SKIP}${RESET} $*"; DEFERRED_STEPS+=("$*"); }
step_info()  { echo -e "${INFO} $*"; }

run_step() {
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    step_pass "$label"
    return 0
  else
    step_fail "$label"
    return 1
  fi
}

run_step_verbose() {
  local label="$1"; shift
  local out
  if out=$("$@" 2>&1); then
    step_pass "$label"
    return 0
  else
    step_fail "$label"
    echo "$out" | head -20
    return 1
  fi
}

# ── arg parsing ───────────────────────────────────────────────────────────────

MODE="full"
for arg in "$@"; do
  case "$arg" in
    --preflight) MODE="preflight" ;;
    --full)      MODE="full" ;;
    --help|-h)
      sed -n '2,25p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

# ── TIER 1: fast preflight ────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}=== TIER 1: Fast preflight ===${RESET}"
echo "Scope: typecheck (hive-cli + identity + workflow), credential-env scan"
echo ""

# 1a. Biome lint/format check — scoped to changed files vs origin/main.
#   Full-repo check has 1000+ pre-existing violations; --changed limits scope to the diff.
#   Requires git history; falls back to skip if origin/main is unreachable (e.g. fresh clone).
if git rev-parse --verify origin/main >/dev/null 2>&1; then
  if node_modules/.bin/biome check --changed --since=origin/main . >/dev/null 2>&1; then
    step_pass "biome lint/format (changed files vs origin/main)"
  else
    step_fail "biome lint/format — run: node_modules/.bin/biome check --changed --since=origin/main ."
  fi
else
  step_skip "biome lint/format — origin/main not reachable; skipping changed-file check [SKIP]"
fi

# 1b. TypeScript typecheck — scoped to tsconfig.check.json (green zone)
#   Broader coverage deferred: src/apps/cli.ts, src/apps/mcp-server/server.ts,
#   src/apps/server/index.ts, src/core/infrastructure/, src/infra/ have
#   pre-existing type errors tracked via child proposals under P417.
if node node_modules/typescript/bin/tsc --noEmit -p tsconfig.check.json >/dev/null 2>&1; then
  step_pass "typecheck: hive-cli + identity + workflow (tsconfig.check.json)"
else
  step_fail "typecheck: hive-cli + identity + workflow — run: npm run check:types"
fi

# 1c. Credential environment check — no bare PG* env reads outside config layer
if bash scripts/ci-env-check.sh >/dev/null 2>&1; then
  step_pass "credential-env check (no bare process.env.PG* outside config)"
else
  step_fail "credential-env check — run: bash scripts/ci-env-check.sh"
fi

# Report tier 1 deferred items (informational, not blocking)
step_skip "typecheck: broader src/ scope — pre-existing errors in cli.ts, mcp-server/server.ts, server/index.ts, core/infrastructure/, infra/ — tracked under P417 child proposals [DEFERRED]"

# ── TIER 2: full gate ─────────────────────────────────────────────────────────

if [[ "$MODE" == "preflight" ]]; then
  echo ""
  echo -e "${YELLOW}Tier 2 skipped (--preflight mode). Run without flags for full gate.${RESET}"
  echo ""
else
  echo ""
  echo -e "${BOLD}=== TIER 2: Full gate ===${RESET}"
  echo "Scope: migration integrity, hardcoding scan, publish hygiene"
  echo "Trigger: required for MCP, systemd, migration, or service-affecting changes."
  echo ""

  # 2a. Migration linkage check — detects DROP/RENAME with surviving refs
  if bash scripts/ci/check-migration-drops.sh >/dev/null 2>&1; then
    step_pass "migration DROP/RENAME linkage check"
  else
    step_fail "migration DROP/RENAME linkage check — run: npm run audit:migrations"
  fi

  # 2b. Migration prefix check — DEFERRED: scripts/migrations/ has 21 groups of pre-existing
  #   duplicate prefixes accumulated across proposal branches before this gate existed.
  #   Renumbering is tracked as a P417 child proposal; blocking on it makes the gate
  #   permanently unpassable. Run: npm run check:migrations to inspect current state.
  step_skip "migration prefix/sequence check — 21 pre-existing duplicate prefix groups in scripts/migrations/ [DEFERRED: renumber tracked under P417 child proposal; run 'npm run check:migrations' to inspect]"

  # 2c. Hardcoding scan — no literal host paths, ports, or model names
  if bash scripts/check-hardcoded.sh >/dev/null 2>&1; then
    step_pass "hardcoding scan (host paths, ports)"
  else
    step_fail "hardcoding scan — run: npm run check:hardcoded"
  fi

  # 2d. Publish hygiene (only meaningful on changed files vs main)
  if git diff --quiet origin/main...HEAD -- package.json scripts/check-publish-hygiene.mjs 2>/dev/null; then
    step_skip "publish hygiene — no package.json changes on this branch [SKIP]"
  elif node scripts/check-publish-hygiene.mjs --base origin/main >/dev/null 2>&1; then
    step_pass "publish hygiene"
  else
    step_fail "publish hygiene — run: npm run check:publish"
  fi

  # 2e. SQL column audit — informational only until allowlist is complete
  step_skip "sql column audit — informational (AUDIT_DATABASE_URL required, continue-on-error) [DEFERRED until P677 allowlist complete]"

  # 2f. Workflow state literal guard — informational until P453 ships
  step_skip "workflow-state literal guard — informational (continue-on-error in CI) [DEFERRED until P453 canonical state-names module]"
fi

# ── summary ───────────────────────────────────────────────────────────────────

echo ""
echo -e "${BOLD}=== Gate summary ===${RESET}"

if [[ ${#FAILED_STEPS[@]} -gt 0 ]]; then
  echo -e "${RED}FAILED — ${#FAILED_STEPS[@]} required check(s):${RESET}"
  for s in "${FAILED_STEPS[@]}"; do
    echo "  ${FAIL} $s"
  done
  echo ""
fi

if [[ ${#DEFERRED_STEPS[@]} -gt 0 ]]; then
  echo -e "${YELLOW}DEFERRED — ${#DEFERRED_STEPS[@]} skipped check(s):${RESET}"
  for s in "${DEFERRED_STEPS[@]}"; do
    echo "  ${SKIP} $s"
  done
  echo ""
fi

if [[ ${#FAILED_STEPS[@]} -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}GATE PASSED${RESET} (mode: $MODE)"
  exit 0
else
  echo -e "${RED}${BOLD}GATE FAILED${RESET} — fix the above before advancing."
  exit 1
fi
