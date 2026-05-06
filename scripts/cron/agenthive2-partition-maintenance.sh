#!/usr/bin/env bash
# scripts/cron/agenthive2-partition-maintenance.sh
# Daily partition maintenance job for agentHive2 time-series tables.
# Scheduled: 03:00 UTC via cron.
# Maintains monthly partitions for agency.session, agency.msg, governance.decision,
# governance.complianceCheck, governance.event, identity.auditAction.
# Creates 12 forward partitions; drops old partitions per retention policy.
# Alarms if _default partition contains data (should be empty in steady state).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOG_DIR="${PROJECT_ROOT}/logs/partition-maintenance"
LOG_FILE="${LOG_DIR}/$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"

# Database connection parameters
DBHOST="${AGENTHIVE2_DBHOST:-127.0.0.1}"
DBPORT="${AGENTHIVE2_DBPORT:-5432}"
DBUSER="${AGENTHIVE2_DBUSER:-admin}"
DATABASE="agentHive2"

# Docker-aware psql invocation
if [[ "$DBHOST" == "postgres-db" ]]; then
  PSQL_CMD="sudo docker exec postgres-db psql -U $DBUSER -d $DATABASE"
else
  PSQL_CMD="psql -h $DBHOST -p $DBPORT -U $DBUSER -d $DATABASE"
fi

log_message() {
  local level="$1"
  local msg="$2"
  local timestamp=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
  echo "[$timestamp] [$level] $msg" | tee -a "$LOG_FILE"
}

log_message "INFO" "Starting partition maintenance job (lookahead: 12 months)"

# Phase 1: Create forward partitions and drop old partitions per retention policy
if output=$($PSQL_CMD -t -c "SELECT * FROM core.fn_partition_maintenance(12);" 2>&1); then
  log_message "INFO" "Partition maintenance completed:"
  echo "$output" | tee -a "$LOG_FILE"
else
  log_message "ERROR" "Partition maintenance failed: $output"
  exit 1
fi

# Phase 2: Check default partitions for data (alarm condition)
log_message "INFO" "Checking default partitions for data..."

alarm_rows=$(mktemp)
if $PSQL_CMD -t -c "SELECT schema_name, table_name, default_partition_name, row_count FROM core.fn_check_default_partitions() WHERE row_count > 0;" > "$alarm_rows" 2>&1; then
  line_count=$(wc -l < "$alarm_rows")
  if [[ $line_count -gt 0 ]]; then
    log_message "ALARM" "Default partition contains data (non-steady-state):"
    cat "$alarm_rows" | tee -a "$LOG_FILE"
    rm -f "$alarm_rows"
    log_message "ERROR" "Alarm: _default partition has tuples; investigate and redistribute"
    exit 1
  else
    log_message "INFO" "Default partitions are empty (healthy)"
    rm -f "$alarm_rows"
  fi
else
  log_message "ERROR" "Default partition check failed"
  exit 1
fi

log_message "INFO" "Partition maintenance job completed successfully"
exit 0
