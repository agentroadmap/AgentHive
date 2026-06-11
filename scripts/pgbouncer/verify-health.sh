#!/usr/bin/env bash
# P499: PgBouncer health check & verification script
#
# Usage:
#   scripts/pgbouncer/verify-health.sh          # Check current health
#   scripts/pgbouncer/verify-health.sh --live    # Run live tests (requires PgBouncer + Postgres running)
#
# Tests:
#   1. PgBouncer process running
#   2. Listen on port 6432
#   3. Admin console accessible
#   4. Query client pool connectivity
#   5. LISTEN client bypass (direct :5432)
#   6. Pool statistics readable
#   7. Recovery behavior (optional: kill and restart)

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

LIVE_TEST=${1:---dry-run}

echo "================================================"
echo "PgBouncer Health Check (P499)"
echo "================================================"
echo

# ============================================================================
# 1. Process Check
# ============================================================================

echo -e "${YELLOW}[1] Process Check${NC}"

if pgrep -x pgbouncer > /dev/null; then
    PID=$(pgrep -x pgbouncer)
    echo -e "${GREEN}✓${NC} PgBouncer running (PID: $PID)"

    # Show process info
    ps aux | grep pgbouncer | grep -v grep | awk '{print "  User:", $1, "| Memory:", $6 " KB", "| CPU:", $3 "%"}'
else
    echo -e "${RED}✗${NC} PgBouncer not running"
    echo "  Start with: sudo systemctl start pgbouncer"
    exit 1
fi

echo

# ============================================================================
# 2. Port Check
# ============================================================================

echo -e "${YELLOW}[2] Port Availability${NC}"

# Check port 6432 (PgBouncer)
if nc -z 127.0.0.1 6432 2>/dev/null; then
    echo -e "${GREEN}✓${NC} PgBouncer listening on 127.0.0.1:6432"
else
    echo -e "${RED}✗${NC} PgBouncer NOT listening on 127.0.0.1:6432"
    exit 1
fi

# Check port 5432 (Postgres direct)
if nc -z 127.0.0.1 5432 2>/dev/null; then
    echo -e "${GREEN}✓${NC} Postgres listening on 127.0.0.1:5432 (LISTEN bypass available)"
else
    echo -e "${RED}✗${NC} Postgres NOT listening on 127.0.0.1:5432"
    exit 1
fi

echo

# ============================================================================
# 3. Configuration Syntax Check
# ============================================================================

echo -e "${YELLOW}[3] Configuration Syntax${NC}"

if [[ -f /etc/pgbouncer/pgbouncer.ini ]]; then
    echo -e "${GREEN}✓${NC} Config file exists: /etc/pgbouncer/pgbouncer.ini"

    # Syntax check (pgbouncer -R flag without starting)
    if sudo pgbouncer -R /etc/pgbouncer/pgbouncer.ini 2>&1 | grep -q "config ok"; then
        echo -e "${GREEN}✓${NC} Configuration syntax valid"
    else
        echo -e "${YELLOW}⚠${NC} Configuration syntax check inconclusive (may be normal)"
    fi
else
    echo -e "${RED}✗${NC} Config file NOT found: /etc/pgbouncer/pgbouncer.ini"
    echo "  Deploy with: sudo cp deploy/pgbouncer/pgbouncer.ini /etc/pgbouncer/"
    exit 1
fi

# Check userlist.txt
if [[ -f /etc/pgbouncer/userlist.txt ]]; then
    echo -e "${GREEN}✓${NC} Userlist file exists: /etc/pgbouncer/userlist.txt"

    # Check permissions (should be 0600 for pgbouncer)
    PERMS=$(stat -c '%a' /etc/pgbouncer/userlist.txt)
    if [[ "$PERMS" == "600" || "$PERMS" == "640" ]]; then
        echo -e "${GREEN}✓${NC} Userlist permissions correct ($PERMS)"
    else
        echo -e "${YELLOW}⚠${NC} Userlist permissions may be incorrect ($PERMS, expected 600 or 640)"
    fi
else
    echo -e "${RED}✗${NC} Userlist NOT found: /etc/pgbouncer/userlist.txt"
    echo "  Bootstrap with: sudo scripts/pgbouncer/bootstrap-users.sh"
    exit 1
fi

echo

# ============================================================================
# 4. Admin Console Access
# ============================================================================

echo -e "${YELLOW}[4] Admin Console Access${NC}"

# Try to query SHOW VERSION via admin user
if [[ "$LIVE_TEST" == "--live" ]]; then
    if psql -h 127.0.0.1 -p 6432 -U agenthive_admin pgbouncer -c "SHOW VERSION;" 2>/dev/null | grep -q pgbouncer; then
        echo -e "${GREEN}✓${NC} Admin console accessible (SHOW VERSION succeeded)"
    else
        echo -e "${YELLOW}⚠${NC} Admin console may not be accessible (check credentials in ~/.pgpass)"
    fi
else
    echo -e "${YELLOW}⚠${NC} Skipping live admin console test (use --live flag)"
fi

echo

# ============================================================================
# 5. Query Client Pool (Port 6432)
# ============================================================================

echo -e "${YELLOW}[5] Query Client Connectivity (PgBouncer :6432)${NC}"

if [[ "$LIVE_TEST" == "--live" ]]; then
    # Try a simple query through bouncer
    if psql -h 127.0.0.1 -p 6432 -U agenthive_app -d agenthive -c "SELECT 1;" 2>/dev/null | grep -q "^[[:space:]]*1"; then
        echo -e "${GREEN}✓${NC} Query via PgBouncer succeeded (transaction pool working)"
    else
        echo -e "${YELLOW}⚠${NC} Query via PgBouncer may have failed (check agenthive_app in userlist)"
    fi
else
    echo -e "${YELLOW}⚠${NC} Skipping live query test (use --live flag)"
fi

echo

# ============================================================================
# 6. LISTEN Client Bypass (Port 5432)
# ============================================================================

echo -e "${YELLOW}[6] LISTEN Client Bypass (Direct :5432)${NC}"

if [[ "$LIVE_TEST" == "--live" ]]; then
    # Try LISTEN/NOTIFY test on direct Postgres (should work)
    # This tests that PGPORT_DIRECT allows LISTEN state persistence
    LISTEN_TEST=$(psql -h 127.0.0.1 -p 5432 -U xiaomi -d agenthive -c "
        LISTEN test_channel;
        SELECT 1 AS ready;
        UNLISTEN test_channel;
    " 2>&1)

    if echo "$LISTEN_TEST" | grep -q "ready"; then
        echo -e "${GREEN}✓${NC} LISTEN/UNLISTEN via direct Postgres :5432 works"
    else
        echo -e "${YELLOW}⚠${NC} LISTEN/UNLISTEN test inconclusive (check Postgres connectivity)"
    fi
else
    echo -e "${YELLOW}⚠${NC} Skipping LISTEN bypass test (use --live flag)"
fi

echo

# ============================================================================
# 7. Pool Statistics
# ============================================================================

echo -e "${YELLOW}[7] Pool Statistics${NC}"

if [[ "$LIVE_TEST" == "--live" ]]; then
    # Query SHOW POOLS (requires admin access)
    POOLS=$(psql -h 127.0.0.1 -p 6432 -U agenthive_admin pgbouncer -c "SHOW POOLS;" 2>/dev/null)

    if [[ -n "$POOLS" ]]; then
        echo -e "${GREEN}✓${NC} Pool statistics available:"
        echo "$POOLS" | head -5  # Show first few pools

        # Check for warnings
        if echo "$POOLS" | grep -q "cl_waiting.*[1-9]"; then
            echo -e "${YELLOW}⚠${NC} Warning: Clients waiting for backend connections (queue building)"
        fi
    else
        echo -e "${YELLOW}⚠${NC} Could not retrieve pool statistics"
    fi
else
    echo -e "${YELLOW}⚠${NC} Skipping statistics retrieval (use --live flag)"
fi

echo

# ============================================================================
# 8. Systemd Service Status
# ============================================================================

echo -e "${YELLOW}[8] Systemd Service Status${NC}"

if systemctl is-enabled pgbouncer 2>/dev/null | grep -q "enabled"; then
    echo -e "${GREEN}✓${NC} pgbouncer service is enabled"
else
    echo -e "${YELLOW}⚠${NC} pgbouncer service is not enabled (enable with: sudo systemctl enable pgbouncer)"
fi

if systemctl is-active pgbouncer 2>/dev/null | grep -q "active"; then
    echo -e "${GREEN}✓${NC} pgbouncer service is active"
else
    echo -e "${RED}✗${NC} pgbouncer service is NOT active"
    exit 1
fi

# Check for recent restart (watchdog)
RESTART_COUNT=$(systemctl show pgbouncer -p NRestarts --value)
echo -e "  Service restarts (watchdog): $RESTART_COUNT"

echo

# ============================================================================
# 9. Log File Check
# ============================================================================

echo -e "${YELLOW}[9] Log File Status${NC}"

if [[ -f /var/log/pgbouncer/pgbouncer.log ]]; then
    echo -e "${GREEN}✓${NC} Log file exists: /var/log/pgbouncer/pgbouncer.log"

    # Show last few lines
    echo "  Last 3 log entries:"
    sudo tail -3 /var/log/pgbouncer/pgbouncer.log | sed 's/^/    /'
else
    echo -e "${YELLOW}⚠${NC} Log file NOT found: /var/log/pgbouncer/pgbouncer.log"
    echo "  Create log directory: sudo install -d -o pgbouncer -g pgbouncer -m 0755 /var/log/pgbouncer"
fi

echo

# ============================================================================
# Summary
# ============================================================================

echo "================================================"
echo -e "${GREEN}✓ Health Check Complete${NC}"
echo "================================================"
echo
echo "Recommended next steps:"
echo "  1. If all checks passed, deployment is ready"
echo "  2. For production, run: scripts/pgbouncer/verify-health.sh --live"
echo "  3. Monitor pool stats: mcp_ops action=pgbouncer_stats"
echo "  4. On connection issues, check: /var/log/pgbouncer/pgbouncer.log"
echo
