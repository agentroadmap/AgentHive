#!/bin/bash
# ============================================================
# agenthive2-backfill-cross-project-deps.sh
# Migrate in-flight cross-project dependencies from per-schema
# pdependency.depends_on_ref to core.cross_project_dependency.
# Idempotent: safe to run multiple times.
# ============================================================

set -euo pipefail

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-admin}"
PGDATABASE="${PGDATABASE:-agentHive2}"

# Use .pgpass for credentials (chmod 600)
# Example: localhost:5432:agentHive2:admin:password

exec_sql() {
  local sql="$1"
  psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -c "$sql"
}

echo "Starting cross-project dependency backfill..."

# Get list of all project schemas
PROJECT_SCHEMAS=$(exec_sql "
  SELECT schema_name FROM core.project WHERE lifecycle_status = 'active'
  ORDER BY schema_name;
" | tail -n +3 | head -n -1 | tr -d ' ')

echo "Found active project schemas: $PROJECT_SCHEMAS"

TOTAL_MIGRATED=0

for schema in $PROJECT_SCHEMAS; do
  echo "Processing schema: $schema"

  # Find proposals in this schema that have cross-project refs
  CROSS_PROJ_DEPS=$(exec_sql "
    SELECT
      p.id AS proposal_id,
      p.display_id AS from_display_id,
      pd.depends_on_ref AS to_display_id,
      pd.dep_type AS kind,
      pd.created_at,
      COALESCE(pd.notes, '') AS notes
    FROM $schema.proposal p
    JOIN $schema.pdependency pd ON p.id = pd.proposal_id
    WHERE pd.depends_on_id IS NULL
      AND pd.depends_on_ref IS NOT NULL
      AND pd.depends_on_ref ~ '^[A-Z][0-9]+$';
  " | tail -n +3 | head -n -1)

  if [ -z "$CROSS_PROJ_DEPS" ]; then
    echo "  No cross-project dependencies found in $schema"
    continue
  fi

  while IFS='|' read -r proposal_id from_display_id to_display_id kind created_at notes; do
    from_display_id=$(echo "$from_display_id" | xargs)
    to_display_id=$(echo "$to_display_id" | xargs)
    kind=$(echo "$kind" | xargs)
    created_at=$(echo "$created_at" | xargs)

    echo "  Checking: $from_display_id -> $to_display_id ($kind)"

    # Determine target project from the display_id prefix
    TO_PROJECT_ID=$(exec_sql "
      SELECT id FROM core.project
      WHERE schema_name IN (
        SELECT DISTINCT schema_name FROM core.project
        WHERE id IN (
          SELECT to_project_id FROM core.cross_project_dependency
          WHERE to_proposal_display_id LIKE '${to_display_id}%'
        )
        UNION
        SELECT schema_name FROM core.project
      )
      LIMIT 1;
    " | tail -n +3 | head -n -1 | xargs)

    if [ -z "$TO_PROJECT_ID" ]; then
      echo "    ⚠️  Target project not found for $to_display_id, skipping"
      continue
    fi

    FROM_PROJECT_ID=$(exec_sql "
      SELECT id FROM core.project WHERE schema_name = '$schema';
    " | tail -n +3 | head -n -1 | xargs)

    # Insert into cross_project_dependency (idempotent via UNIQUE constraint)
    exec_sql "
      INSERT INTO core.cross_project_dependency (
        from_project_id,
        from_proposal_display_id,
        to_project_id,
        to_proposal_display_id,
        kind,
        declared_by_did,
        declared_at,
        metadata_jsonb
      ) VALUES (
        $FROM_PROJECT_ID,
        '$from_display_id',
        $TO_PROJECT_ID,
        '$to_display_id',
        '$kind',
        'system:backfill',
        '$created_at'::TIMESTAMPTZ,
        COALESCE('{\"notes\": \"' || '$notes' || '\"}'::JSONB, '{}')
      )
      ON CONFLICT DO NOTHING;
    "

    if [ $? -eq 0 ]; then
      echo "    ✅ Migrated $from_display_id -> $to_display_id"
      ((TOTAL_MIGRATED++))
    else
      echo "    ❌ Failed to migrate $from_display_id -> $to_display_id"
    fi

  done <<< "$CROSS_PROJ_DEPS"

done

echo ""
echo "Backfill complete. Total migrated: $TOTAL_MIGRATED"
