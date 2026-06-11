# PgBouncer Migration & Connection String Switchover Guide

This document guides operators through migrating from direct Postgres connections to PgBouncer-fronted connections (P499).

**Scope:** Single-host deployments with ≤2 tenants  
**Impact:** Zero downtime (graceful pool drain + reconnect)  
**Duration:** ~5 minutes (verify + update env + restart services)

---

## 1. Pre-Migration Checklist

### Prerequisites

- [ ] PgBouncer installed: `pgbouncer --version`
- [ ] Services running:
  - [ ] Postgres on :5432 (direct access)
  - [ ] AgentHive MCP, cron, daemon, CLI (using existing PGPORT env)
- [ ] No long-running queries expected to hold transactions > 30 seconds (P499 sets `query_wait_timeout=120s`)
- [ ] Operator credentials in ~/.pgpass for both direct Postgres and PgBouncer:

```bash
# ~/.pgpass format
# hostname:port:database:username:password
127.0.0.1:5432:agenthive:xiaomi:***
127.0.0.1:5432:agenthive:agenthive_admin:***
127.0.0.1:5432:agenthive:agenthive_app:***
127.0.0.1:6432:agenthive:agenthive_admin:***
127.0.0.1:6432:agenthive:agenthive_app:***
```

### Risk Assessment

- **Connection limit**: N ≤ 2 tenants on Postgres max_connections=200 ✓
- **Prepared statements**: AgentHive code does not use server-side prepared statements ✓
- **SET LOCAL**: AgentHive code uses schema-qualified names, not search_path ✓
- **LISTEN clients**: Code already checks PGPORT_DIRECT for bypass ✓

**Rollback:** 60 seconds (stop PgBouncer, set PGPORT=5432, restart services)

---

## 2. Migration Steps

### Step 1: Deploy PgBouncer (once, before switchover)

If PgBouncer is not yet running, deploy it first:

```bash
# Install package
sudo apt-get install pgbouncer

# Create OS user and directories
sudo useradd -r -s /usr/sbin/nologin pgbouncer || true
sudo install -d -o pgbouncer -g pgbouncer -m 0755 /var/log/pgbouncer

# Bootstrap Postgres roles (one-time)
sudo psql -h 127.0.0.1 -p 5432 -U postgres -d agenthive <<'EOF'
CREATE ROLE agenthive_admin WITH LOGIN ENCRYPTED PASSWORD 'secure-admin-pwd';
CREATE ROLE agenthive_app WITH LOGIN ENCRYPTED PASSWORD 'secure-app-pwd';
EOF

# Generate userlist.txt
sudo scripts/pgbouncer/bootstrap-users.sh

# Copy config and enable service
sudo cp deploy/pgbouncer/pgbouncer.ini /etc/pgbouncer/
sudo cp scripts/systemd/pgbouncer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable pgbouncer
sudo systemctl start pgbouncer

# Verify
sudo systemctl status pgbouncer
```

### Step 2: Verify PgBouncer Health

```bash
scripts/pgbouncer/verify-health.sh --live

# Expected output:
#  ✓ PgBouncer running
#  ✓ Listening on 127.0.0.1:6432
#  ✓ Config file exists and syntax valid
#  ✓ Admin console accessible
#  ✓ Query via PgBouncer succeeded
#  ✓ LISTEN client bypass working
```

If any check fails, fix before proceeding.

### Step 3: Update Application Environment

Edit `/etc/agenthive/env` (or equivalent systemd EnvironmentFile):

**BEFORE (direct Postgres):**
```bash
export PGHOST=127.0.0.1
export PGPORT=5432          # Direct Postgres
export PGUSER=xiaomi
export PGDATABASE=agenthive
```

**AFTER (PgBouncer + bypass):**
```bash
export PGHOST=127.0.0.1
export PGPORT=6432          # PgBouncer transaction pool
export PGPORT_DIRECT=5432   # Direct Postgres for LISTEN clients
export PGUSER=xiaomi
export PGDATABASE=agenthive
```

Save and verify:

```bash
source /etc/agenthive/env
echo "PGPORT=$PGPORT"          # Should show 6432
echo "PGPORT_DIRECT=$PGPORT_DIRECT"  # Should show 5432
```

### Step 4: Restart Services in Order

Restart services gracefully (one at a time to minimize disruption):

```bash
# 1. Stop MCP server (receives new queries from CLI)
sudo systemctl stop agenthive-mcp
echo "✓ MCP stopped"

# 2. Allow running transactions to drain (max 30 seconds)
sleep 5
echo "✓ Waiting for active transactions..."

# 3. Restart with new env (picks up PGPORT=6432)
sudo systemctl start agenthive-mcp
echo "✓ MCP restarted (now using :6432)"

# 4. Restart other services
sudo systemctl restart agenthive-cron
sudo systemctl restart agenthive-daemon
# ... etc for each service
```

### Step 5: Verify Connectivity

```bash
# Test query through PgBouncer
mcp_ops action=pool_registry_stats
# Expected: pools showing connection via :6432 (PgBouncer)

# Manually verify
psql -h 127.0.0.1 -p 6432 -U agenthive_app -d agenthive -c "SELECT NOW();"
# Expected: current timestamp

# Check pool state
mcp_ops action=pgbouncer_stats
# Expected: pools with sv_active, cl_active counts
```

### Step 6: Monitor for Errors (5-10 minutes)

Watch logs for any connection errors:

```bash
# MCP logs
sudo journalctl -u agenthive-mcp -f

# PgBouncer logs
sudo tail -f /var/log/pgbouncer/pgbouncer.log

# Application logs (if separate)
# ... check your log aggregation system
```

Expected log patterns:
- `CONNECT agenthive (client_address=127.0.0.1:6432)` ← client connecting to bouncer
- `CONNECT agenthive (server_address=127.0.0.1:5432)` ← bouncer connecting to Postgres
- No errors or `FATAL` messages

### Step 7: Load Test (optional, 15 minutes)

```bash
# Simulate realistic load
for i in {1..20}; do
  (
    while true; do
      psql -h 127.0.0.1 -p 6432 -U agenthive_app -d agenthive \
        -c "SELECT pg_sleep(0.5); SELECT COUNT(*) FROM roadmap_proposal.proposal LIMIT 1;" \
        > /dev/null 2>&1
    done
  ) &
done

# Monitor pool state in parallel
watch -n 1 'mcp_ops action=pgbouncer_stats | grep -A10 pools'

# Check for:
#  - sv_active gradually increases to ~8-10 (working connections)
#  - cl_active stays < default_pool_size (no queue buildup)
#  - cl_waiting stays at 0 (no bottleneck)

# Kill background jobs
killall psql 2>/dev/null || true
```

---

## 3. Troubleshooting

### Issue: "connection refused" from application

**Symptom:** Application logs show `ECONNREFUSED 127.0.0.1:6432`

**Root cause:** PgBouncer not running or not listening on :6432

**Solution:**
```bash
# Check PgBouncer status
sudo systemctl status pgbouncer

# If stopped, start it
sudo systemctl start pgbouncer

# Verify listening
netstat -tlnp | grep 6432
# Expected: tcp  0  0  127.0.0.1:6432  0.0.0.0:*  LISTEN  /usr/sbin/pgbouncer

# If still failing, check logs
sudo tail -20 /var/log/pgbouncer/pgbouncer.log
```

### Issue: "auth failed" errors in PgBouncer log

**Symptom:** PgBouncer logs: `FATAL: auth failed for user "agenthive_app"`

**Root cause:** Userlist.txt has wrong hash or doesn't match Postgres roles

**Solution:**
```bash
# Regenerate userlist from Postgres
sudo scripts/pgbouncer/bootstrap-users.sh

# Verify hashes match
sudo cat /etc/pgbouncer/userlist.txt
# Should show SCRAM-SHA-256 hashes for agenthive_admin and agenthive_app

# Reload PgBouncer to pick up new hashes
sudo systemctl reload pgbouncer
```

### Issue: Application hangs or times out

**Symptom:** Queries never return; pool stats show `cl_waiting > 0`

**Root cause:** All backend connections busy (long-running queries blocking pool)

**Solution:**
```bash
# Check pool state
mcp_ops action=pgbouncer_stats
# Look for databases with cl_waiting > 0

# Check long-running queries on Postgres
psql -h 127.0.0.1 -p 5432 -U postgres -d agenthive -c "
  SELECT pid, state, query
  FROM pg_stat_activity
  WHERE state = 'active'
  ORDER BY query_start ASC;
"

# If queries are stuck, kill them
psql -h 127.0.0.1 -p 5432 -U postgres -d agenthive -c "
  SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
  WHERE pid <> pg_backend_pid() AND query LIKE '%<stuck-query>%';
"

# Increase default_pool_size if legitimate high load
# (edit /etc/pgbouncer/pgbouncer.ini and reload)
```

### Issue: LISTEN notifications not arriving

**Symptom:** feature-flag-service or liaison-agent not receiving notifications

**Root cause:** Listener not using PGPORT_DIRECT (trying to LISTEN through PgBouncer)

**Solution:**
```bash
# Verify PGPORT_DIRECT is set
echo $PGPORT_DIRECT
# Should show: 5432

# Check if listener client is using correct port
psql -h 127.0.0.1 -p 5432 -U xiaomi -d agenthive -c "
  LISTEN test_notify;
  -- Should NOT give error about transaction mode
"

# If error occurs, check that direct Postgres on :5432 is accessible
nc -z 127.0.0.1 5432
# Should succeed silently

# Restart services to pick up PGPORT_DIRECT
sudo systemctl restart agenthive-mcp agenthive-cron
```

---

## 4. Rollback Procedure

If migration causes critical issues, rollback to direct Postgres (5-minute RTO):

```bash
# 1. Stop services
sudo systemctl stop agenthive-mcp agenthive-cron agenthive-daemon

# 2. Update env to bypass PgBouncer
export PGPORT=5432
export PGPORT_DIRECT=5432
# Update /etc/agenthive/env or systemd EnvironmentFile

# 3. Restart services (now connecting directly to :5432)
sudo systemctl start agenthive-mcp agenthive-cron agenthive-daemon

# 4. Verify
mcp_ops action=pool_registry_stats
# Should show connections on port 5432 (direct Postgres)

# 5. Investigate root cause before re-migrating
sudo tail -100 /var/log/pgbouncer/pgbouncer.log | grep -i error
```

If PgBouncer itself is crashing:

```bash
# Stop PgBouncer
sudo systemctl stop pgbouncer

# Proceed with PGPORT=5432 direct access (above)

# Debug PgBouncer issue
sudo pgbouncer -R /etc/pgbouncer/pgbouncer.ini  # Config check
sudo pgbouncer /etc/pgbouncer/pgbouncer.ini -v  # Verbose mode

# Fix config, restart
sudo systemctl start pgbouncer
```

---

## 5. Post-Migration Tuning (1-2 weeks)

### Monitor Baseline Metrics

Track these metrics over 1-2 weeks to establish normal operation:

```bash
# Daily snapshot
for i in {1..7}; do
  date "+%Y-%m-%d"
  mcp_ops action=pgbouncer_stats | grep -A5 '"pools"'
  sleep 86400  # 24 hours
done
```

**Metrics to track:**
- `avg_xact_time`: average transaction duration (should be < 100ms)
- `avg_query_time`: average query duration
- `avg_wait_time`: time clients spend waiting for connections
- `sv_active`: active backend connections (should be < default_pool_size)
- `cl_active`: active client connections

### Adjust Pool Sizes if Needed

If metrics show bottlenecks:

```bash
# Increase default_pool_size if avg_xact_time is high or cl_waiting > 0
sudo nano /etc/pgbouncer/pgbouncer.ini
# Change: default_pool_size = 25  (was 20)
sudo systemctl reload pgbouncer

# Or tune per-tenant via roadmap.project
UPDATE roadmap.project SET pool_max = 12 WHERE slug = 'high-traffic-tenant';
SELECT pg_notify('pool_evict', '{"slug":"high-traffic-tenant"}');
```

### Verify Postgres max_connections Headroom

Monitor Postgres connection count:

```bash
# Weekly check
psql -h 127.0.0.1 -p 5432 -U postgres -d agenthive -c "
  SELECT
    current_setting('max_connections')::int AS max_connections,
    (SELECT count(*) FROM pg_stat_activity) AS current_connections,
    current_setting('max_connections')::int - (SELECT count(*) FROM pg_stat_activity) AS headroom;
"

# Expected (single-host, N=2 tenants):
# max_connections | current_connections | headroom
# ────────────────┼─────────────────────┼─────────
#       200       |        ~130          |    ~70
```

If headroom drops below 50, increase `max_connections`:

```bash
# On Postgres
ALTER SYSTEM SET max_connections = 300;
SELECT pg_reload_conf();

# Verify
SHOW max_connections;
```

---

## 6. Migration Checklist

- [ ] PgBouncer installed and running
- [ ] Health check passes: `scripts/pgbouncer/verify-health.sh --live`
- [ ] Postgres roles created: agenthive_admin, agenthive_app
- [ ] Userlist.txt generated
- [ ] /etc/agenthive/env updated (PGPORT=6432, PGPORT_DIRECT=5432)
- [ ] Services restarted in order (MCP → cron → daemon)
- [ ] Connectivity verified: queries succeed through :6432
- [ ] LISTEN bypass verified: config reloads arrive
- [ ] Pool stats monitored for 5-10 minutes (no cl_waiting)
- [ ] Load test passed (optional, 20 concurrent clients)
- [ ] Logs checked for errors (none)
- [ ] Baseline metrics collected for tuning

---

## 7. Reference

- **Full guide:** `docs/architecture/pgbouncer.md`
- **Health check:** `scripts/pgbouncer/verify-health.sh`
- **Config file:** `deploy/pgbouncer/pgbouncer.ini` (also in /etc/pgbouncer/ post-deploy)
- **MCP tools:** `mcp_ops action=pgbouncer_stats|pgbouncer_ping|pgbouncer_reload`
- **Code changes:** `src/infra/postgres/pool.ts` (port defaults to 6432)
