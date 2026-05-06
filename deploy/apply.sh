#!/usr/bin/env bash
# deploy/apply.sh — Apply agentHive2 schema to a target PostgreSQL server.
#
# Usage:
#   ./deploy/apply.sh [options]
#
# Options:
#   -h HOST        Postgres host          (default: 127.0.0.1)
#   -p PORT        Postgres port          (default: 5432)
#   -U USER        Postgres user          (default: admin)
#   -d DATABASE    Target database        (default: agentHive2)
#   -s SCHEMA      Project schema name    (default: agentHive)
#   --system-only  Apply system-init only (skip project-init)
#   --project-only Apply project-init only (skip system-init)
#
# Examples:
#   ./deploy/apply.sh
#   ./deploy/apply.sh -s hardcodeMiner
#   ./deploy/apply.sh --system-only
#   ./deploy/apply.sh -h db.internal -U agenthive_admin -d agentHive2 -s hardcodeMiner

set -euo pipefail
cd "$(dirname "$0")/.."

HOST=127.0.0.1
PORT=5432
USER=admin
DATABASE=agentHive2
SCHEMA=agentHive
SYSTEM=true
PROJECT=true

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h) HOST="$2";      shift 2 ;;
    -p) PORT="$2";      shift 2 ;;
    -U) USER="$2";      shift 2 ;;
    -d) DATABASE="$2";  shift 2 ;;
    -s) SCHEMA="$2";    shift 2 ;;
    --system-only)  PROJECT=false; shift ;;
    --project-only) SYSTEM=false;  shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

PSQL="psql -h $HOST -p $PORT -U $USER -d $DATABASE"

if $SYSTEM; then
  echo "==> system-init"
  $PSQL -f deploy/system-init/000-roles.sql
  $PSQL -f deploy/system-init/001-core.sql
  $PSQL -f deploy/system-init/002-agency.sql
  $PSQL -f deploy/system-init/003-identity.sql
  $PSQL -f deploy/system-init/004-governance.sql
  $PSQL -f deploy/system-init/006-partition-maintenance.sql
  echo "==> system-init seed"
  $PSQL -f deploy/system-init/seed/hosts.sql
  $PSQL -f deploy/system-init/seed/agencies.sql
fi

if $PROJECT; then
  echo "==> project-init (schema: $SCHEMA)"
  $PSQL -v schema_name="$SCHEMA" -f deploy/project-init/000-schema.sql
  $PSQL -v schema_name="$SCHEMA" -f deploy/project-init/001-proposal.sql
  $PSQL -v schema_name="$SCHEMA" -f deploy/project-init/002-workflow.sql
  $PSQL -v schema_name="$SCHEMA" -f deploy/project-init/003-agent.sql
  $PSQL -v schema_name="$SCHEMA" -f deploy/project-init/004-msg.sql
  $PSQL -v schema_name="$SCHEMA" -f deploy/project-init/005-spend.sql
  $PSQL -v schema_name="$SCHEMA" -f deploy/project-init/006-kb.sql
  echo "==> project-init seed"
  $PSQL -v schema_name="$SCHEMA" -f deploy/project-init/seed/proposal-types.sql
  $PSQL -v schema_name="$SCHEMA" -f deploy/project-init/seed/gate-roles.sql
fi

echo "==> done"
