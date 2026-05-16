#!/usr/bin/env bash
# P894: agentHive2 partition maintenance — runs daily at 03:00 UTC
# Idempotent: safe to call multiple times per day (no-op if partitions already exist)
# Maintains 12-month forward look-ahead for all 6 partitioned tables
# Enforces retention policy for tables with expiration windows

set -euo pipefail

PSQL="psql -U admin -h 127.0.0.1 -d agentHive2 -v ON_ERROR_STOP=1"
LOG_TAG="agenthive2-partition-maintenance"

logger -t "$LOG_TAG" "Starting partition maintenance"

# Run maintenance function (creates forward + drops expired partitions)
RESULTS=$($PSQL -tAc "SELECT action, schema_name, table_name, partition_name, partition_range FROM core.fn_partition_maintenance(12)")

if [ -n "$RESULTS" ]; then
    while IFS='|' read -r action schema tbl part range; do
        logger -t "$LOG_TAG" "$action $schema.$tbl partition=$part range=$range"
    done <<< "$RESULTS"
else
    logger -t "$LOG_TAG" "No partition changes needed"
fi

# Health check: warn if any table has only default partition
STUCK=$($PSQL -tAc "SELECT schema_name, table_name FROM core.fn_check_default_partitions() WHERE has_only_default = true")
if [ -n "$STUCK" ]; then
    logger -t "$LOG_TAG" "WARNING: tables with only default partition: $STUCK"
fi

logger -t "$LOG_TAG" "Partition maintenance complete"
