#!/usr/bin/env bash
# scripts/cron/agenthive2-tenant-provision.sh
# Tenant provisioning orchestrator for agentHive2 (schema-per-project topology).
# Executes the 10-step provisioning flow with idempotent steps and advisory lock.
#
# Usage:
#   ./agenthive2-tenant-provision.sh [-d DATABASE] [-h HOST] [-U USER] PROJECT_ID SCHEMA_NAME OWNER_DID
#
# This script implements P893's provisioning flow:
#   1. Acquire advisory lock on project_id
#   2. Initialize tenant_lifecycle row (requested state)
#   3. Transition to provisioning
#   4. Execute 10 provisioning steps (idempotent)
#   5. Transition to active on success
#   6. On failure, cleanup and transition to failed
#

set -euo pipefail

DATABASE="${DATABASE:-agentHive2}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-5432}"
USER="${USER:-admin}"

# Helper to run psql with project schema
run_psql() {
  psql -h "$HOST" -p "$PORT" -U "$USER" -d "$DATABASE" "$@"
}

# Helper to run psql with project schema set
run_psql_schema() {
  local schema="$1"
  shift
  run_psql -v schema_name="$schema" "$@"
}

# Log with timestamp
log() {
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*" >&2
}

# Error handler: transition to failed, cleanup
on_provision_failure() {
  local project_id="$1"
  local step="$2"
  local reason="$3"

  log "ERROR at step $step: $reason"

  # Try to transition to failed state
  run_psql <<EOF || log "WARNING: failed to transition to failed state"
SELECT core.tenant_lifecycle_transition(
  $project_id,
  'failed',
  'Provisioning failed at step $step: $reason',
  'provision-orchestrator'
);
EOF

  # Attempt cleanup: DROP SCHEMA if empty (best effort)
  log "Attempting cleanup..."
  run_psql <<EOF || log "WARNING: cleanup failed (schema may have been partially created)"
DROP SCHEMA IF EXISTS "$schema_name" CASCADE;
EOF

  exit 1
}

# Validate arguments
if [[ $# -lt 3 ]]; then
  echo "Usage: $0 PROJECT_ID SCHEMA_NAME OWNER_DID" >&2
  exit 1
fi

PROJECT_ID="$1"
SCHEMA_NAME="$2"
OWNER_DID="$3"

log "Starting tenant provisioning: project_id=$PROJECT_ID schema=$SCHEMA_NAME owner=$OWNER_DID"

# Step 0: Validate project_id exists in core.project
PROJECT_SLUG=$(run_psql -tA <<EOF
SELECT slug FROM core.project WHERE id = $PROJECT_ID;
EOF
)

if [[ -z "$PROJECT_SLUG" ]]; then
  on_provision_failure "$PROJECT_ID" "0-validate" "project_id $PROJECT_ID not found in core.project"
fi

log "Validated project: slug=$PROJECT_SLUG"

# Step 1: Acquire advisory lock on project_id (holds for entire transaction)
log "Step 1: Acquiring advisory lock on project_id=$PROJECT_ID"
run_psql <<EOF || on_provision_failure "$PROJECT_ID" "1-lock" "Failed to acquire advisory lock"
SELECT pg_advisory_lock($PROJECT_ID);
EOF

# Step 2: Initialize tenant_lifecycle row if not exists
log "Step 2: Initialize tenant_lifecycle row"
run_psql <<EOF || on_provision_failure "$PROJECT_ID" "2-init-lifecycle" "Failed to initialize tenant_lifecycle"
SELECT core.tenant_lifecycle_initialize(
  $PROJECT_ID,
  '$OWNER_DID',
  '{"schedule": "0 2 * * 0", "retention_days": 30, "target": "file:///var/lib/agentHive/backups"}',
  '{"max_connections": 100, "max_schema_size_gb": 50, "statement_timeout_ms": 300000}'
);
EOF

# Step 3: Transition to provisioning state
log "Step 3: Transition to provisioning state"
run_psql <<EOF || on_provision_failure "$PROJECT_ID" "3-transition-provisioning" "Failed to transition to provisioning"
SELECT core.tenant_lifecycle_transition(
  $PROJECT_ID,
  'provisioning',
  NULL,
  'provision-orchestrator'
);
EOF

# Step 4: CREATE SCHEMA IF NOT EXISTS
log "Step 4: Creating project schema $SCHEMA_NAME"
run_psql <<EOF || on_provision_failure "$PROJECT_ID" "4-create-schema" "Failed to create schema"
CREATE SCHEMA IF NOT EXISTS "$SCHEMA_NAME";
COMMENT ON SCHEMA "$SCHEMA_NAME" IS 'Project schema for $PROJECT_SLUG';
EOF

# Step 5: Apply project-init DDL (via deploy/apply.sh)
log "Step 5: Applying project-init DDL"
(
  cd "$(dirname "$0")/../../"
  ./deploy/apply.sh \
    -h "$HOST" \
    -p "$PORT" \
    -U "$USER" \
    -d "$DATABASE" \
    -s "$SCHEMA_NAME" \
    --project-only
) || on_provision_failure "$PROJECT_ID" "5-apply-ddl" "Failed to apply project-init DDL"

log "Step 5: Project-init DDL applied successfully"

# Step 6: Smoke test — insert and delete a probe row in the new schema
log "Step 6: Running smoke test"
PROBE_ID=$(run_psql_schema "$SCHEMA_NAME" -tA <<EOF
INSERT INTO "$SCHEMA_NAME".proposal (title, summary, motivation, design, status, type)
VALUES ('probe', 'smoke test', 'test', 'test', 'DRAFT', 'epic')
RETURNING id;
EOF
)

if [[ -z "$PROBE_ID" ]]; then
  on_provision_failure "$PROJECT_ID" "6-smoke-test-insert" "Failed to insert probe proposal"
fi

# Verify we can read it back
PROBE_READ=$(run_psql_schema "$SCHEMA_NAME" -tA <<EOF
SELECT id FROM "$SCHEMA_NAME".proposal WHERE id = $PROBE_ID;
EOF
)

if [[ "$PROBE_READ" != "$PROBE_ID" ]]; then
  on_provision_failure "$PROJECT_ID" "6-smoke-test-read" "Failed to read back probe proposal"
fi

# Clean up probe row
run_psql_schema "$SCHEMA_NAME" <<EOF || on_provision_failure "$PROJECT_ID" "6-smoke-test-delete" "Failed to delete probe proposal"
DELETE FROM "$SCHEMA_NAME".proposal WHERE id = $PROBE_ID;
EOF

log "Step 6: Smoke test passed"

# Step 7: Register tenant_lifecycle row as active
log "Step 7: Transition to active state"
run_psql <<EOF || on_provision_failure "$PROJECT_ID" "7-transition-active" "Failed to transition to active"
SELECT core.tenant_lifecycle_transition(
  $PROJECT_ID,
  'active',
  NULL,
  'provision-orchestrator'
);
EOF

# Step 8: Notify via pg_notify
log "Step 8: Emitting pg_notify event"
run_psql <<EOF
SELECT pg_notify(
  'tenant_provisioned',
  json_build_object(
    'project_id', $PROJECT_ID,
    'slug', '$PROJECT_SLUG',
    'schema', '$SCHEMA_NAME'
  )::text
);
EOF

log "SUCCESS: Tenant provisioning completed for project_id=$PROJECT_ID schema=$SCHEMA_NAME"
exit 0
