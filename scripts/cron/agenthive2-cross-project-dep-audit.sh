#!/bin/bash
# ============================================================
# agenthive2-cross-project-dep-audit.sh
# Nightly audit of cross-project dependency integrity and
# cycle detection. Writes results to governance.event.
# ============================================================

set -euo pipefail

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-admin}"
PGDATABASE="${PGDATABASE:-agentHive2}"
ACTOR_DID="${ACTOR_DID:-system:audit}"

exec_sql() {
  local sql="$1"
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -c "$sql"
}

exec_json() {
  local sql="$1"
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -t -c "$sql"
}

echo "Starting cross-project dependency audit..."

# Check integrity
echo "Running integrity check..."
ORPHAN_EDGES=$(exec_json "
  SELECT json_agg(
    json_build_object(
      'edge_id', edge_id,
      'from_project_slug', from_project_slug,
      'from_proposal_display_id', from_proposal_display_id,
      'to_project_slug', to_project_slug,
      'to_proposal_display_id', to_proposal_display_id,
      'kind', kind,
      'missing_side', missing_side,
      'declared_at', declared_at
    ) ORDER BY declared_at DESC
  )
  FROM core.fn_check_cross_project_dep_integrity();
")

ORPHAN_COUNT=$(echo "$ORPHAN_EDGES" | grep -o '\"edge_id\"' | wc -l)
echo "Found $ORPHAN_COUNT orphaned edges"

if [ "$ORPHAN_COUNT" -gt 0 ]; then
  exec_sql "
    INSERT INTO governance.event (
      event_type,
      actor_did,
      subject_ref,
      payload_jsonb
    ) VALUES (
      'cross_project_dep_orphan',
      '$ACTOR_DID',
      'cross_project_dependency:integrity',
      '$ORPHAN_EDGES'::JSONB
    );
  "
  echo "  ✅ Logged $ORPHAN_COUNT orphan events to governance.event"
fi

# Check cycles
echo "Running cycle detection..."
CYCLES=$(exec_json "
  SELECT json_agg(
    json_build_object(
      'cycle_path', cycle_path,
      'cycle_nodes', cycle_nodes,
      'detected_at', detected_at
    )
  )
  FROM core.fn_check_cross_project_dep_cycles();
")

CYCLE_COUNT=$(echo "$CYCLES" | grep -o '\"cycle_path\"' | wc -l)
echo "Found $CYCLE_COUNT cycles"

if [ "$CYCLE_COUNT" -gt 0 ]; then
  exec_sql "
    INSERT INTO governance.event (
      event_type,
      actor_did,
      subject_ref,
      payload_jsonb
    ) VALUES (
      'cross_project_dep_cycle_detected',
      '$ACTOR_DID',
      'cross_project_dependency:cycles',
      '$CYCLES'::JSONB
    );
  "
  echo "  ✅ Logged $CYCLE_COUNT cycle events to governance.event"
fi

# Get current edge count for phase 2 upgrade check
EDGE_COUNT=$(exec_sql "SELECT COUNT(*) FROM core.cross_project_dependency;" | tail -n 1 | xargs)
echo "Current cross-project dependency edge count: $EDGE_COUNT"

if [ "$EDGE_COUNT" -gt 50 ]; then
  echo "  ℹ️  Edge count > 50. Phase 2 upgrade (continuous NOTIFY-driven audit) recommended."
  exec_sql "
    INSERT INTO governance.event (
      event_type,
      actor_did,
      subject_ref,
      payload_jsonb
    ) VALUES (
      'cross_project_dep_phase2_upgrade_eligible',
      '$ACTOR_DID',
      'cross_project_dependency:upgrade',
      json_build_object('edge_count', $EDGE_COUNT)
    );
  "
fi

echo "Audit complete."
