#!/usr/bin/env bash
# Enforces: no bare process.env.PG* reads outside config.ts, config-keys.ts, and pool initialization
set -euo pipefail

VIOLATIONS=$(grep -rn 'process\.env\.PG' src/ \
    --include='*.ts' \
    | grep -v 'src/shared/runtime/config\.ts' \
    | grep -v 'src/shared/runtime/config-keys\.ts' \
    | grep -v 'src/infra/postgres/pool\.ts' \
    | grep -v 'src/postgres/pool-registry\.ts' \
    | grep -v 'src/core/infrastructure/init\.ts' \
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
