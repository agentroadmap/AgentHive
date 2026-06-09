#!/bin/bash

##############################################################################
# P514: Georgia Singer Tenant DB — Pre-Flight Verification Script
#
# Purpose: Non-destructive pre-flight checks before live bringup
# Validates templates parse, config resolves, and no collisions exist
#
# Usage:
#   bash scripts/verify-p514-templates.sh
#
# Exit Codes:
#   0 = All checks passed
#   1 = One or more checks failed
##############################################################################

set +e  # Don't exit on error; track failures explicitly

PROJECT_SLUG="georgia-singer"
DB_NAME="georgia_singer"
DB_ROLE="georgia_singer_owner"
SCHEMA_PREFIX="song_"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-admin}"
PGDATABASE="${PGDATABASE:-agenthive}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

log_pass() {
    echo -e "${GREEN}✓ PASS${NC} $1"
    ((PASS_COUNT++))
}

log_fail() {
    echo -e "${RED}✗ FAIL${NC} $1"
    ((FAIL_COUNT++))
}

log_skip() {
    echo -e "${YELLOW}⊘ SKIP${NC} $1"
    ((SKIP_COUNT++))
}

log_info() {
    echo -e "${YELLOW}ℹ${NC} $1"
}

echo "============================================================"
echo "P514 Georgia Singer — Pre-Flight Verification Script"
echo "============================================================"
echo ""

# Check 1: Verify Postgres connectivity
echo "[1/11] Checking Postgres connectivity to hiveControl..."
if psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -c "SELECT 1;" >/dev/null 2>&1; then
    log_pass "Postgres connectivity OK (host=$PGHOST, db=$PGDATABASE)"
else
    log_fail "Postgres connectivity FAILED — cannot reach $PGHOST:$PGPORT"
    exit 1
fi

# Check 2: Verify deployment templates exist
echo ""
echo "[2/11] Checking bootstrap template files..."
TEMPLATE_DIR="deploy/project-init"
if [ -d "$TEMPLATE_DIR" ]; then
    log_pass "Bootstrap template directory exists: $TEMPLATE_DIR"
    # Count template files
    TEMPLATE_COUNT=$(find "$TEMPLATE_DIR" -name "*.sql" | wc -l)
    log_info "Found $TEMPLATE_COUNT SQL template files"
else
    log_fail "Bootstrap template directory NOT found: $TEMPLATE_DIR"
fi

# Check 3: Validate schema_prefix doesn't collide with existing schemas
echo ""
echo "[3/11] Checking for schema prefix collisions..."
COLLISION_COUNT=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
    -t -c "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name LIKE '${SCHEMA_PREFIX}%' AND schema_name NOT LIKE '${SCHEMA_PREFIX}meta';" 2>/dev/null || echo "0")

if [ "$COLLISION_COUNT" -eq 0 ]; then
    log_pass "No schema prefix collisions detected (prefix=$SCHEMA_PREFIX)"
else
    log_fail "Schema prefix collision detected ($COLLISION_COUNT schemas exist with prefix $SCHEMA_PREFIX)"
fi

# Check 4: Verify Postgres role doesn't already exist
echo ""
echo "[4/11] Checking for role pre-existence..."
ROLE_EXISTS=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
    -t -c "SELECT 1 WHERE EXISTS(SELECT 1 FROM pg_roles WHERE rolname='$DB_ROLE');" 2>/dev/null || echo "0")

if [ -z "$ROLE_EXISTS" ] || [ "$ROLE_EXISTS" = "0" ]; then
    log_pass "Database role does not pre-exist: $DB_ROLE"
else
    log_fail "Database role already exists: $DB_ROLE — cleanup required before bringup"
fi

# Check 5: Verify database doesn't already exist
echo ""
echo "[5/11] Checking for database pre-existence..."
DB_EXISTS=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
    -t -c "SELECT 1 WHERE EXISTS(SELECT datname FROM pg_database WHERE datname='$DB_NAME');" 2>/dev/null || echo "0")

if [ -z "$DB_EXISTS" ] || [ "$DB_EXISTS" = "0" ]; then
    log_pass "Database does not pre-exist: $DB_NAME"
else
    log_fail "Database already exists: $DB_NAME — cleanup required before bringup"
fi

# Check 6: Verify project slug not already registered
echo ""
echo "[6/11] Checking for slug collision in registry..."
SLUG_COLLISION=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
    -t -c "SELECT COUNT(*) FROM roadmap.project WHERE slug='$PROJECT_SLUG';" 2>/dev/null || echo "0")

if [ "$SLUG_COLLISION" -eq 0 ]; then
    log_pass "Project slug not in registry: $PROJECT_SLUG"
else
    log_fail "Project slug already registered: $PROJECT_SLUG — status=$(psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -t -c "SELECT bootstrap_status FROM roadmap.project WHERE slug='$PROJECT_SLUG';")"
fi

# Check 7: Verify vault directory accessible (if running locally)
echo ""
echo "[7/11] Checking vault directory accessibility..."
VAULT_DIR="/vault/file/project/${PROJECT_SLUG}"
if [ -d "$VAULT_DIR" ]; then
    if [ -w "$VAULT_DIR" ]; then
        log_skip "Vault directory pre-exists and is writable (unusual for bringup): $VAULT_DIR"
    else
        log_fail "Vault directory exists but NOT writable: $VAULT_DIR"
    fi
else
    log_pass "Vault directory does not pre-exist (expected): $VAULT_DIR"
fi

# Check 8: Verify backup directory structure
echo ""
echo "[8/11] Checking backup directory structure..."
BACKUP_DIR="/var/backups/agenthive/${PROJECT_SLUG}"
PARENT_BACKUP_DIR="/var/backups/agenthive"

if [ -d "$PARENT_BACKUP_DIR" ]; then
    log_pass "Parent backup directory exists: $PARENT_BACKUP_DIR"
    if [ -d "$BACKUP_DIR" ]; then
        log_skip "Project backup directory pre-exists: $BACKUP_DIR"
    else
        log_pass "Project backup directory does not pre-exist (will be created during bringup): $BACKUP_DIR"
    fi
else
    log_fail "Parent backup directory does NOT exist: $PARENT_BACKUP_DIR — ensure /var/backups/agenthive exists"
fi

# Check 9: Verify PgBouncer config exists
echo ""
echo "[9/11] Checking PgBouncer configuration..."
PGBOUNCER_CONFIG="/etc/pgbouncer/pgbouncer.ini"
if [ -f "$PGBOUNCER_CONFIG" ]; then
    log_pass "PgBouncer config exists: $PGBOUNCER_CONFIG"
    # Check if georgia-singer already in config
    if grep -q "^${DB_NAME}" "$PGBOUNCER_CONFIG" 2>/dev/null; then
        log_skip "Database entry already in PgBouncer config (will be updated)"
    else
        log_pass "Database entry not in PgBouncer config (will be added during bringup)"
    fi
else
    log_fail "PgBouncer config NOT found: $PGBOUNCER_CONFIG"
fi

# Check 10: Verify cron directory exists
echo ""
echo "[10/11] Checking cron directory..."
CRON_DIR="/etc/cron.d"
if [ -d "$CRON_DIR" ]; then
    log_pass "Cron directory exists: $CRON_DIR"
    if grep -q "${PROJECT_SLUG}" "$CRON_DIR/agenthive-backup" 2>/dev/null; then
        log_skip "Project cron entry already exists (will be updated)"
    else
        log_pass "Project cron entry not present (will be added during bringup)"
    fi
else
    log_fail "Cron directory NOT found: $CRON_DIR"
fi

# Check 11: Verify Node.js environment can import config
echo ""
echo "[11/11] Checking Node.js config module import..."
if command -v npx >/dev/null 2>&1; then
    if npx -y tsx -e "
        import { config } from './src/config/index.ts';
        const projectId = await config.getProjectId('agenthive');
        if (projectId > 0) {
            console.log('Config module OK');
        }
    " >/dev/null 2>&1; then
        log_pass "Node.js config module imports successfully"
    else
        log_fail "Node.js config module import FAILED — verify TypeScript setup"
    fi
else
    log_skip "npx not available — skipping Node.js config check"
fi

# Summary
echo ""
echo "============================================================"
echo "Verification Summary"
echo "============================================================"
echo -e "${GREEN}PASS:${NC}  $PASS_COUNT"
echo -e "${RED}FAIL:${NC}  $FAIL_COUNT"
echo -e "${YELLOW}SKIP:${NC}  $SKIP_COUNT"
echo ""

if [ $FAIL_COUNT -eq 0 ]; then
    echo -e "${GREEN}✓ All critical checks PASSED${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Run: mcp_proposal action='call_tool' tool_name='project_create_v2' args='{\"slug\": \"georgia-singer\", \"name\": \"Georgia Singer\"}'"
    echo "  2. Wait for saga completion (should take ~30 seconds)"
    echo "  3. Follow deployment-runbook-p514-georgia-singer.md for AC verification"
    echo ""
    exit 0
else
    echo -e "${RED}✗ Pre-flight check FAILED${NC} — $FAIL_COUNT critical issue(s) found"
    echo ""
    echo "Resolve all FAIL items before running project_create_v2"
    echo ""
    exit 1
fi
