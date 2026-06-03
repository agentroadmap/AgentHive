#!/usr/bin/env bash
# Enforces: no bare process.env.PG* reads outside config.ts, config-keys.ts, and pool initialization.
#
# Allowlist exceptions (add comment explaining WHY each is exempt):
#   config.ts / config-keys.ts         — the config resolution layer itself
#   pool.ts / pool-registry.ts         — pool initialization (legitimate bootstrap)
#   init.ts                            — infrastructure bootstrap
#   context.ts (hive-cli)              — CLI bootstrap, reads PG vars for direct connections
#   feature-flag-service.ts            — LISTEN bypass: PgBouncer doesn't support NOTIFY LISTEN;
#                                        needs a direct pg.Client connection (architectural necessity)
#   liaison-agent.ts                   — LISTEN bypass: direct PG Client for A2A notification (P916)
#   liaison-message-service.ts         — LISTEN bypass: direct PG Client for NOTIFY channels (P916)
#   pgbouncer-ops.ts                   — PgBouncer admin diagnostics tool; uses PGBOUNCER_* vars
#                                        by design (different connection layer)
#   agenthive-cli.ts                   — CLI diagnostic tool; bootstrap reads for direct connections
set -euo pipefail

VIOLATIONS=$(grep -rn 'process\.env\.PG' src/ \
    --include='*.ts' \
    | grep -v 'src/shared/runtime/config\.ts' \
    | grep -v 'src/shared/runtime/config-keys\.ts' \
    | grep -v 'src/infra/postgres/pool\.ts' \
    | grep -v 'src/postgres/pool-registry\.ts' \
    | grep -v 'src/core/infrastructure/init\.ts' \
    | grep -v 'src/apps/hive-cli/common/context\.ts' \
    | grep -v 'src/shared/runtime/feature-flag-service\.ts' \
    | grep -v 'src/infra/agency/liaison-agent\.ts' \
    | grep -v 'src/infra/agency/liaison-message-service\.ts' \
    | grep -v 'src/apps/mcp-server/tools/ops/pgbouncer-ops\.ts' \
    | grep -v 'src/apps/agenthive-cli\.ts' \
    | grep -v '\.test\.ts' \
    || true)

if [[ -n "$VIOLATIONS" ]]; then
    echo "ERROR: Bare process.env.PG* reads found outside config/pool initialization layer:"
    echo "$VIOLATIONS"
    echo ""
    echo "Use ConfigResolver.resolvePasswordSync() or config.get(StructuralKeys.*) instead."
    exit 1
fi

echo "OK: No bare process.env.PG* reads outside config/pool initialization layer."
