#!/usr/bin/env bash
# PM Gating Script — 2026-05-01
# Reads DRAFT/mature and REVIEW proposals, evaluates them, and advances via direct SQL.
# Uses: psql (direct SQL) + curl /mcp (proposal reads)
# Author: product-manager (Alex)
set -euo pipefail

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-admin}"
PGDATABASE="${PGDATABASE:-agenthive}"
export PGPASSWORD="${PGPASSWORD:?PGPASSWORD must be set (use ~/.pgpass or set the env var)}"

MCP_URL="${MCP_URL:-http://127.0.0.1:6421}"

log()  { echo "[gate] $*"; }
psql_cmd() { psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -At -c "$1"; }
psql_file() { psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -f "$1"; }

mcp_call() {
  local tool="$1" args="$2"
  curl -sS -X POST "$MCP_URL/mcp" \
    -H "Content-Type: application/json" \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}"
}

prop_get() {
  mcp_call "prop_get" "{\"id\":\"$1\"}" | \
    python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('result',{}).get('content',[{}])[0].get('text','{}'))"
}

# ─────────────────────────────────────────────
# STEP 1 — FETCH DRAFT/MATURE PROPOSALS
# ─────────────────────────────────────────────
log "=== PRIORITY 1: DRAFT/mature proposals ==="

DRAFT_MATURE=$(psql_cmd "
  SELECT id, display_id, title, status, maturity
  FROM roadmap_proposal.proposal
  WHERE UPPER(status)='DRAFT' AND maturity='mature'
  ORDER BY id;
")

log "DRAFT/mature proposals found:"
echo "$DRAFT_MATURE"

# ─────────────────────────────────────────────
# STEP 2 — FETCH REVIEW PROPOSALS
# ─────────────────────────────────────────────
log ""
log "=== PRIORITY 2: REVIEW proposals ==="

REVIEW=$(psql_cmd "
  SELECT id, display_id, title, status, maturity
  FROM roadmap_proposal.proposal
  WHERE UPPER(status)='REVIEW'
  ORDER BY id;
")

log "REVIEW proposals found:"
echo "$REVIEW"

# ─────────────────────────────────────────────
# STEP 2b — FK SAFETY: ensure roadmap.proposal view exists
# gate_decision_log has FK → roadmap.proposal(id)
# The actual table is roadmap_proposal.proposal; a view makes the FK resolvable.
# ─────────────────────────────────────────────
psql_cmd "
  CREATE OR REPLACE VIEW roadmap.proposal AS
    SELECT * FROM roadmap_proposal.proposal;
" >/dev/null
log "roadmap.proposal view ensured (FK safety)"

# ─────────────────────────────────────────────
# STEP 3 — GATE EACH DRAFT/MATURE PROPOSAL
# ─────────────────────────────────────────────
log ""
log "=== Gating DRAFT/mature proposals (DRAFT → REVIEW) ==="

while IFS='|' read -r pid display_id title status maturity; do
  [[ -z "$pid" ]] && continue
  pid=$(echo "$pid" | xargs)
  display_id=$(echo "$display_id" | xargs)
  title=$(echo "$title" | xargs)

  log ""
  log "--- $display_id: $title ---"

  # Read proposal via MCP
  PROP_JSON=$(prop_get "$display_id" 2>/dev/null || echo '{}')

  # Extract key sections
  HAS_MOTIVATION=$(echo "$PROP_JSON" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print('yes' if d.get('motivation') else 'no')" 2>/dev/null || echo "no")
  HAS_DESIGN=$(echo "$PROP_JSON" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print('yes' if d.get('design') else 'no')" 2>/dev/null || echo "no")
  HAS_ALT=$(echo "$PROP_JSON" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print('yes' if d.get('alternatives') else 'no')" 2>/dev/null || echo "no")

  # Check ACs via MCP
  AC_JSON=$(mcp_call "list_ac" "{\"proposalId\":\"$display_id\"}" 2>/dev/null || echo '{}')
  HAS_ACS=$(echo "$AC_JSON" | python3 -c "
import sys,json
try:
  r=json.load(sys.stdin)
  txt=r.get('result',{}).get('content',[{}])[0].get('text','[]')
  items=json.loads(txt)
  print('yes' if isinstance(items,list) and len(items)>0 else 'no')
except:
  print('no')
" 2>/dev/null || echo "no")

  log "  Motivation: $HAS_MOTIVATION | Design: $HAS_DESIGN | Alternatives: $HAS_ALT | ACs: $HAS_ACS"

  if [[ "$HAS_MOTIVATION" == "yes" && "$HAS_DESIGN" == "yes" && "$HAS_ACS" == "yes" ]]; then
    RATIONALE="Enhancement complete: motivation, design, and acceptance criteria all present. Advancing to REVIEW for full design scrutiny."
    log "  DECISION: ADVANCE → REVIEW"

    psql_cmd "
      INSERT INTO roadmap.gate_decision_log
        (proposal_id, from_state, to_state, gate_level, decided_by, decision, rationale)
      VALUES
        ($pid, 'DRAFT', 'REVIEW', 'D1', 'product-manager', 'approve',
         '$(echo "$RATIONALE" | sed "s/'/''/g")');
    " >/dev/null

    psql_cmd "
      UPDATE roadmap_proposal.proposal
      SET status='REVIEW', modified_at=NOW()
      WHERE id=$pid;
    " >/dev/null

    log "  ✅ $display_id advanced to REVIEW"
  else
    MISSING=""
    [[ "$HAS_MOTIVATION" == "no" ]] && MISSING="${MISSING}motivation "
    [[ "$HAS_DESIGN" == "no" ]] && MISSING="${MISSING}design "
    [[ "$HAS_ACS" == "no" ]] && MISSING="${MISSING}acceptance-criteria "
    RATIONALE="Incomplete enhancement — missing: ${MISSING}. Left in DRAFT for enhancement agent."
    log "  DECISION: HOLD (missing: $MISSING)"

    psql_cmd "
      INSERT INTO roadmap.gate_decision_log
        (proposal_id, from_state, to_state, gate_level, decided_by, decision, rationale)
      VALUES
        ($pid, 'DRAFT', 'DRAFT', 'D1', 'product-manager', 'defer',
         '$(echo "$RATIONALE" | sed "s/'/''/g")');
    " >/dev/null

    log "  ⏸ $display_id held in DRAFT — needs: $MISSING"
  fi
done <<< "$DRAFT_MATURE"

# ─────────────────────────────────────────────
# STEP 4 — GATE EACH REVIEW PROPOSAL → DEVELOP
# ─────────────────────────────────────────────
log ""
log "=== Gating REVIEW proposals (REVIEW → DEVELOP) ==="

while IFS='|' read -r pid display_id title status maturity; do
  [[ -z "$pid" ]] && continue
  pid=$(echo "$pid" | xargs)
  display_id=$(echo "$display_id" | xargs)
  title=$(echo "$title" | xargs)

  log ""
  log "--- $display_id: $title ---"

  PROP_JSON=$(prop_get "$display_id" 2>/dev/null || echo '{}')

  HAS_MOTIVATION=$(echo "$PROP_JSON" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print('yes' if d.get('motivation') else 'no')" 2>/dev/null || echo "no")
  HAS_DESIGN=$(echo "$PROP_JSON" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print('yes' if d.get('design') else 'no')" 2>/dev/null || echo "no")

  AC_JSON=$(mcp_call "list_ac" "{\"proposalId\":\"$display_id\"}" 2>/dev/null || echo '{}')
  AC_COUNT=$(echo "$AC_JSON" | python3 -c "
import sys,json
try:
  r=json.load(sys.stdin)
  txt=r.get('result',{}).get('content',[{}])[0].get('text','[]')
  items=json.loads(txt)
  print(len(items) if isinstance(items,list) else 0)
except:
  print(0)
" 2>/dev/null || echo "0")

  log "  Motivation: $HAS_MOTIVATION | Design: $HAS_DESIGN | AC count: $AC_COUNT"

  if [[ "$HAS_MOTIVATION" == "yes" && "$HAS_DESIGN" == "yes" && "$AC_COUNT" -ge 3 ]]; then
    RATIONALE="Design complete with $AC_COUNT acceptance criteria. Motivation and design sections present. Ready to enter DEVELOP."
    log "  DECISION: ADVANCE → DEVELOP"

    psql_cmd "
      INSERT INTO roadmap.gate_decision_log
        (proposal_id, from_state, to_state, gate_level, decided_by, decision, rationale)
      VALUES
        ($pid, 'REVIEW', 'DEVELOP', 'D2', 'product-manager', 'approve',
         '$(echo "$RATIONALE" | sed "s/'/''/g")');
    " >/dev/null

    psql_cmd "
      UPDATE roadmap_proposal.proposal
      SET status='DEVELOP', modified_at=NOW()
      WHERE id=$pid;
    " >/dev/null

    log "  ✅ $display_id advanced to DEVELOP"
  else
    MISSING=""
    [[ "$HAS_MOTIVATION" == "no" ]] && MISSING="${MISSING}motivation "
    [[ "$HAS_DESIGN" == "no" ]] && MISSING="${MISSING}design "
    [[ "$AC_COUNT" -lt 3 ]] && MISSING="${MISSING}sufficient-ACs(found:${AC_COUNT}) "
    RATIONALE="Design insufficient for DEVELOP — missing: ${MISSING}. Held in REVIEW."
    log "  DECISION: HOLD (missing: $MISSING)"

    psql_cmd "
      INSERT INTO roadmap.gate_decision_log
        (proposal_id, from_state, to_state, gate_level, decided_by, decision, rationale)
      VALUES
        ($pid, 'REVIEW', 'REVIEW', 'D2', 'product-manager', 'defer',
         '$(echo "$RATIONALE" | sed "s/'/''/g")');
    " >/dev/null

    log "  ⏸ $display_id held in REVIEW — needs: $MISSING"
  fi
done <<< "$REVIEW"

# ─────────────────────────────────────────────
# STEP 5 — FINAL SUMMARY QUERY
# ─────────────────────────────────────────────
log ""
log "=== POST-GATE STATUS SUMMARY ==="

psql_cmd "
  SELECT status, maturity, COUNT(*) AS cnt
  FROM roadmap_proposal.proposal
  WHERE UPPER(status) IN ('DRAFT','REVIEW','DEVELOP')
  GROUP BY status, maturity
  ORDER BY status, maturity;
"

log ""
log "=== GATE DECISION LOG (today) ==="
psql_cmd "
  SELECT p.display_id, g.from_state, g.to_state, g.gate_level, g.decision, g.rationale
  FROM roadmap.gate_decision_log g
  JOIN roadmap_proposal.proposal p ON p.id = g.proposal_id
  WHERE g.decided_by = 'product-manager'
    AND g.created_at >= NOW() - INTERVAL '1 hour'
  ORDER BY g.created_at;
"

log ""
log "Gate run complete."
