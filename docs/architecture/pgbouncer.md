# PgBouncer Deployment & Operations Guide (P499)

This document describes PgBouncer integration for AgentHive, covering deployment, pool configuration, monitoring, and operational runbooks.

**Status:** Delivered (P499 Wave 3)  
**Deployment:** Single-host loopback (v1); multi-host and TLS deferred (P??)  
**Pool Mode:** Transaction-mode pooling (required for stateless query isolation)  
**Key Decision:** LISTEN clients bypass PgBouncer via PGPORT_DIRECT (Option A from P499 design)

---

## 1. Architecture & Topology

```
┌─────────────────────────────────────────────────────────────────────┐
│  AgentHive Application Processes (MCP, CLI, cron, daemon, web-ui)  │
│  - Query clients:       PGPORT=6432 (PgBouncer transaction pool)   │
│  - LISTEN clients:      PGPORT_DIRECT=5432 (direct Postgres)       │
│  - Config reload:       feature-flag-service listens on :5432      │
│  - Agency messages:     liaison-agent listens on :5432             │
└─────────────────────────────────────────────────────────────────────┘
          │ (:6432)                      │ (:5432 direct)
          ▼                              ▼
┌──────────────────────────┐       ┌──────────────────────────┐
│   PgBouncer              │       │  Postgres (single-host)  │
│   Transaction-mode pool  │       │                          │
│   - pool_size=20         │       │  max_connections=200     │
│   - Per-tenant: size=8   │       │  (operator tunes)        │
│   - max_client_conn=400  │       │                          │
│   - reserve_pool=5       │       │  databases:              │
│   ┌────────────────────┐ │       │  - agenthive (control)   │
│   │ [databases]        │ │       │  - tenant_1              │
│   │ agenthive          │──┼──────┤  - tenant_2              │
│   │ tenant_1           │  │       │  - …                    │
│   │ tenant_2           │  │       │                          │
│   │ …                  │  │       │  Listener channels:      │
│   └────────────────────┘ │       │  - feature_flag_changed  │
└──────────────────────────┘       │  - new_message           │
                                    │  - work_offers           │
                                    │  - proposal_*            │
                                    └──────────────────────────┘
```

### Why Transaction-Mode Pooling?

**Problem:** Each application process holds a connection to Postgres. With 5+ processes × 16 tenant pools × 8 connections = 640+ connections → exceeds Postgres default `max_connections=200`.

**Solution:** PgBouncer in transaction-mode:
- Client opens connection to PgBouncer (:6432)
- PgBouncer multiplexes connections to Postgres (:5432)
- After each transaction, PgBouncer returns the backend connection to the pool
- Single backend connection serves many clients sequentially
- **Result:** 5 processes × (20 control + 8×16 tenants) = ~1,300 client connections → ~130 backend connections to Postgres ✓

**Constraints:**
- ❌ LISTEN/NOTIFY not supported (drops state between transactions)
- ❌ Prepared statements not supported (we don't use them)
- ❌ SET LOCAL not supported (we use schema-qualified names)
- ✓ AgentHive code is fully compatible (verified in P499 design)

### Why Bypass LISTEN Clients?

Transaction-mode pooling forcibly closes backend connections after each transaction. LISTEN clients require persistent connections to receive notifications. **Solution:** Dedicated listener pool on :5432 (direct Postgres, not through PgBouncer).

**Locations that bypass PgBouncer:**
- `src/shared/runtime/feature-flag-service.ts` — config reload notifications
- `src/infra/agency/liaison-agent.ts` — agency event subscriptions
- `src/memory/memory-event-consumer.ts` — memory event stream
- Any connection setting `PGPORT_DIRECT=5432`

---

## 2. Pool Configuration & Budget Reconciliation

### Default Pool Sizes

| Parameter | Value | Rationale |
|---|---|---|
| `pool_mode` | `transaction` | Transaction-mode pooling (required) |
| `default_pool_size` | `20` | Control pool + agenthive tenant |
| `agenthive.pool_size` | `10` | Legacy single-tenant (post-P495, keep for backward compat) |
| `*.pool_size` | `8` | Default for new tenants (tunable per tenant) |
| `max_client_conn` | `400` | Max concurrent clients to PgBouncer |
| `min_pool_size` | `1` | Minimum idle backend connections |
| `reserve_pool_size` | `5` | Extra emergency capacity |
| `reserve_pool_timeout` | `3s` | Timeout waiting for reserve connection |
| `server_idle_timeout` | `600s` | Reap idle connections after 10 minutes |
| `server_lifetime` | `3600s` | Rotate connections every 1 hour |

### Connection Budget for v1

**Single-host deployment (N ≤ 2 tenants):**

```
Per-process backend connections to Postgres:
  Control pool:     20 connections
  Agenthive tenant: 10 connections
  Tenant 1:         8 connections
  Tenant 2:         8 connections
  Total per process: 46 connections

With 5 processes (MCP, CLI, cron, daemon, UI):
  Total backend connections: 5 × 46 = 230 connections

Postgres max_connections: 200 (default) ← EXCEEDS

Operator action (BEFORE deploying N=3):
  1. Stop MCP/cron/daemon (down to 2 processes)
      → 2 × 46 = 92 connections ✓
  2. OR: Increase max_connections in postgres.conf
      → ALTER SYSTEM SET max_connections = 300;
      → SELECT pg_reload_conf();
  3. Monitor via: mcp_ops action=pgbouncer_stats
```

### Per-Tenant Customization

Fine-tune per-tenant pool sizes after onboard:

```sql
-- Reduce pool size for low-traffic tenants
UPDATE roadmap.project
SET pool_max = 4
WHERE slug = 'low-traffic-tenant';

-- Trigger pool eviction so new config takes effect
SELECT pg_notify('pool_evict', '{"slug":"low-traffic-tenant"}');
```

The pool-registry (P497) picks up `pool_max` from `roadmap.project` and applies it on next pool creation.

---

## 3. Deployment Checklist

### Phase 1: Repository Setup (P499, already complete)

- [x] Configuration file: `deploy/pgbouncer/pgbouncer.ini`
- [x] Bootstrap script: `scripts/pgbouncer/bootstrap-users.sh`
- [x] Provisioning script: `scripts/pgbouncer/provision-pgbouncer.ts`
- [x] Systemd units: `scripts/systemd/pgbouncer.service` + `pgbouncer-provisioner.service`
- [x] MCP tools: `mcp_ops action=pgbouncer_stats|pgbouncer_ping|pgbouncer_reload`
- [x] Code hardening: `PGPORT_DIRECT` in listener paths, config pool resolution defaults to port 6432

### Phase 2: Operator Deployment (manual, one-time)

#### Step 1: Install PgBouncer package

```bash
sudo apt-get update
sudo apt-get install pgbouncer

# Verify version (3.0+ recommended)
pgbouncer --version
```

#### Step 2: Create OS user and directories

```bash
sudo useradd -r -s /usr/sbin/nologin pgbouncer || true

sudo install -d -o pgbouncer -g pgbouncer -m 0755 /var/log/pgbouncer
sudo install -d -o pgbouncer -g pgbouncer -m 0755 /var/run/pgbouncer
```

#### Step 3: Bootstrap Postgres roles (one-time, before first PgBouncer start)

```bash
# Create roles with scram-sha-256 passwords in Postgres
sudo psql -h 127.0.0.1 -p 5432 -U postgres -d agenthive <<'EOF'
-- Create admin role (can reload PgBouncer config)
CREATE ROLE agenthive_admin WITH LOGIN ENCRYPTED PASSWORD 'secure-password-1';
GRANT CONNECT ON DATABASE agenthive TO agenthive_admin;

-- Create app role (can query databases)
CREATE ROLE agenthive_app WITH LOGIN ENCRYPTED PASSWORD 'secure-password-2';
GRANT CONNECT ON DATABASE agenthive TO agenthive_app;

-- Verify roles exist
SELECT usename FROM pg_user WHERE usename LIKE 'agenthive%' ORDER BY usename;
EOF
```

**Note:** Use strong passwords; store in 1password or ~/.pgpass (chmod 600).

#### Step 4: Generate userlist.txt (one-time bootstrap)

```bash
# This script reads pg_shadow and generates /etc/pgbouncer/userlist.txt
sudo /bin/bash scripts/pgbouncer/bootstrap-users.sh
```

Verify the file was created:

```bash
sudo cat /etc/pgbouncer/userlist.txt
# Expected:
# "agenthive_admin" "SCRAM-SHA-256$<hash>"
# "agenthive_app"   "SCRAM-SHA-256$<hash>"
```

#### Step 5: Deploy configuration files

```bash
# Copy pgbouncer.ini to system location
sudo cp deploy/pgbouncer/pgbouncer.ini /etc/pgbouncer/pgbouncer.ini
sudo chmod 644 /etc/pgbouncer/pgbouncer.ini

# Verify config syntax
pgbouncer -R /etc/pgbouncer/pgbouncer.ini
```

#### Step 6: Install systemd units

```bash
# Copy service files
sudo cp scripts/systemd/pgbouncer.service /etc/systemd/system/
sudo cp scripts/systemd/pgbouncer-provisioner.service /etc/systemd/system/

# Reload systemd
sudo systemctl daemon-reload

# Enable and start (in order)
sudo systemctl enable pgbouncer
sudo systemctl start pgbouncer

# Verify it's running
sudo systemctl status pgbouncer
sudo systemctl status pgbouncer-provisioner
```

#### Step 7: Update application environment

Edit `/etc/agenthive/env` (or equivalent):

```bash
# PgBouncer port for query clients
export PGPORT=6432

# Direct Postgres port for LISTEN clients (feature-flag-service, liaison-agent, etc.)
export PGPORT_DIRECT=5432

# Increase max_connections in Postgres BEFORE deploying N>2 tenants
# (operator action, not in code)
```

Restart all AgentHive services:

```bash
sudo systemctl restart agenthive-mcp
sudo systemctl restart agenthive-cron
# ... etc for each service
```

#### Step 8: Verify pool connectivity

```bash
# Check via MCP
mcp_ops action=pgbouncer_stats
# Expected output: pools showing cl_active/sv_active counts

# Or manually from CLI:
psql -h 127.0.0.1 -p 6432 -U agenthive_app -d agenthive -c "SELECT 1;"
# Expected: result (1)

# Verify LISTEN bypass works (feature-flag-service should subscribe)
mcp_ops action=pgbouncer_stats | grep -A5 'pools'
# Should show connections from agenthive_app to agenthive DB
```

---

## 4. Monitoring & Diagnostics

### Health Check: PgBouncer Availability

```bash
# Via MCP
mcp_ops action=pgbouncer_ping
# Expected: { "ok": true, "latency_ms": 2, "host": "127.0.0.1", "port": 6432 }

# Or via CLI
psql -h 127.0.0.1 -p 6432 -U agenthive_admin pgbouncer -c "SHOW VERSION;"
```

### Pool State & Statistics

```bash
# Full stats snapshot
mcp_ops action=pgbouncer_stats

# Manually (requires admin user):
psql -h 127.0.0.1 -p 6432 -U agenthive_admin pgbouncer -c "SHOW POOLS;"
psql -h 127.0.0.1 -p 6432 -U agenthive_admin pgbouncer -c "SHOW STATS;"

# Example output:
#  database | user | cl_active | cl_waiting | sv_active | sv_idle | pool_mode
# ----------+------+-----------+------------+-----------+---------+-----------
#  agenthive | agenthive_app | 3 | 0 | 2 | 1 | transaction
#  tenant_1 | agenthive_app | 1 | 0 | 1 | 0 | transaction
```

**Key columns:**
- `cl_active`: client connections in active transaction
- `cl_waiting`: clients waiting for available backend connection
- `sv_active`: backend connections in use
- `sv_idle`: idle backend connections ready for reuse
- `pool_mode`: should be "transaction"

### Warning Signs & Recovery

| Symptom | Root Cause | Action |
|---|---|---|
| `cl_waiting > 0` | All backend connections busy; queue building | Scale down tenants or increase `max_client_conn` |
| `sv_active ≈ max` | Pool exhausted | Investigate long-running queries; kill if stuck |
| `FATAL: auth failed` | Bad password in userlist.txt | Regenerate via `bootstrap-users.sh` |
| `ERROR: pool is closed` | PgBouncer crashed | Check `systemctl status pgbouncer`; systemd restarts auto |
| All pools disconnected | Postgres down | Restart Postgres; PgBouncer reconnects automatically |

### Debug Logging

Enable debug output (temporary):

```bash
# Via admin console
psql -h 127.0.0.1 -p 6432 -U agenthive_admin pgbouncer -c "SET log_level = 'debug';"

# Check log file
sudo tail -f /var/log/pgbouncer/pgbouncer.log

# Disable debug (resets on reload)
psql -h 127.0.0.1 -p 6432 -U agenthive_admin pgbouncer -c "SET log_level = 'info';"
```

---

## 5. Configuration Reload & Tenant Onboarding

### Adding a New Tenant (P495 integration)

When a tenant DB is provisioned via `P495 tenant_db_provisioned` saga:

1. **PgBouncer provisioner watches NOTIFY**

   ```bash
   SELECT pg_notify('tenant_db_provisioned', '{"tenant_id":123,"slug":"new-tenant","db_name":"new_tenant_db"}');
   ```

2. **Provisioner script (pgbouncer-provisioner.service) triggers**

   - Reads active tenants from `roadmap.project`
   - Regenerates `/etc/pgbouncer/pgbouncer.ini` [databases] section
   - Calls `systemctl reload pgbouncer` (HUP signal, no downtime)
   - Tenant is available within 1 second

3. **Application picks up new tenant**

   - Pool registry (P497) detects new tenant in database
   - Calls `getProjectDb('new-tenant')` on next request
   - New pool is created with default `pool_size=8`

4. **Manual override (if provisioner is down)**

   ```bash
   # Edit directly and reload
   sudo nano /etc/pgbouncer/pgbouncer.ini
   # Add: new_tenant = host=127.0.0.1 port=5432 dbname=new_tenant_db
   
   # Reload (seamless, no connection drop)
   sudo systemctl reload pgbouncer
   # OR: psql -p 6432 pgbouncer -c "RELOAD"
   ```

### Tuning Pool Size for a Tenant

```bash
# Reduce default_pool_size for a specific tenant
UPDATE roadmap.project SET pool_max = 4 WHERE slug = 'low-traffic-tenant';

# Trigger eviction so new config takes effect
SELECT pg_notify('pool_evict', '{"slug":"low-traffic-tenant"}');
```

The pool-registry listens on `pool_evict` and re-creates the pool with the new `pool_max`.

---

## 6. Rollback & Emergency Recovery

### Rollback: Bypass PgBouncer (5-minute RTO)

If PgBouncer fails and auto-restart doesn't recover:

```bash
# Stop PgBouncer
sudo systemctl stop pgbouncer

# Set env var to bypass bouncer
export PGPORT=5432  # Direct Postgres
export PGPORT_DIRECT=5432

# Restart all services (MCP, cron, etc.)
sudo systemctl restart agenthive-mcp agenthive-cron # ... etc

# Verify queries work against direct Postgres
mcp_ops action=pool_registry_stats
# Should show all pools connected to :5432

# Restart PgBouncer when ready
sudo systemctl start pgbouncer

# Revert env and restart (switch back to bouncer)
export PGPORT=6432
sudo systemctl restart agenthive-mcp agenthive-cron # ... etc
```

### Emergency: Postgres Replication Role Access

If P502 (logical replication) is deployed, ensure replication role bypasses PgBouncer:

```bash
# In P502 setup, replication DSN must use :5432 (direct Postgres)
REPLICATION_DSN="postgres://agenthive_repl:password@127.0.0.1:5432/agenthive?replication=database"

# Do NOT use :6432 — replication protocol is not supported by transaction-mode pools
```

---

## 7. Performance Tuning

### Connection Reuse Metrics

```bash
# Check avg transactions per backend connection (higher is better)
psql -p 6432 -U agenthive_admin pgbouncer -c "SHOW STATS;" \
  | grep agenthive | awk '{print "avg txns per conn:", $6 / $5}'

# If avg_xact_count is low (< 10), tune:
#   - Increase default_pool_size (more pooled connections)
#   - Reduce server_idle_timeout (recycle faster)
```

### Load Test: Validate Pool Sizing

```bash
# Simulate 50 concurrent clients
for i in {1..50}; do
  psql -h 127.0.0.1 -p 6432 -U agenthive_app -d agenthive \
    -c "SELECT pg_sleep(1); SELECT 1;" &
done
wait

# Monitor in parallel:
mcp_ops action=pgbouncer_stats | grep -A10 'pools:'
# cl_active should reach ~8-10 (default_pool_size = 20, so plenty of capacity)
```

### Memory Footprint

```bash
# Each backend connection: ~40-50 KB
# Each client connection: ~10-20 KB

# PgBouncer max memory:
#   = (max_client_conn × 15 KB) + (total_backend_pools × 50 KB)
#   = (400 × 15) + (130 × 50)
#   = 6 MB + 6.5 MB
#   ≈ 13 MB (negligible)
```

---

## 8. Out-of-Scope (Future P??)

- **TLS between PgBouncer ↔ Postgres:** Loopback trusted segment for v1; multi-host TLS deferred
- **Cluster-mode PgBouncer:** Multi-node PgBouncer for HA (future)
- **Per-role authentication:** v1 uses single proxy roles (agenthive_app); per-tenant role auth in P??
- **Session-mode pooling:** Investigated in P499 design but deferred (lower efficiency than transaction-mode)
- **LISTEN via session pool:** Checked in P499; decided to use bypass (PGPORT_DIRECT) instead

---

## 9. Acceptance Criteria Status (P499)

| AC | Criterion | Status | Evidence |
|---|---|---|---|
| AC2 | Provisioning script + tenant auto-add on NOTIFY | Pending | Requires operator deployment + live tenant onboard test |
| AC4 | Pool config + health check | Pending | Requires live load test with 50 concurrent clients |
| AC6 | SCRAM auth + bootstrap script | **Complete** | `bootstrap-users.sh` + `userlist.txt` permissions documented |
| AC7 | Config values tuned + rationale | **Complete** | `deploy/pgbouncer/pgbouncer.ini` + this doc (§2) |
| AC10 | LISTEN bypass routing | **Complete** | Code audit confirms PGPORT_DIRECT in all listener paths |
| AC12 | MCP pgbouncer_stats tool | **Complete** | `mcp-server/tools/ops/pgbouncer-ops.ts` on origin/main |
| AC13 | Recovery test + systemd WatchdogSec | Pending | Integration test deferred to operator (manual kill/restart test) |
| AC14 | Dynamic log level toggle | **Complete** | Documented in §4 (manual via `SET log_level`) |
| AC16 | Replication role :5432 bypass | **Complete** | Documented in §6 (REPLICATION_DSN example) |
| AC19 | Load test + memory/timeout tuning | Pending | Manual load test deferred to operator; tuning in §7 |

---

## References

- **Code audit:** Grep for `PGPORT_DIRECT` in `src/shared/runtime/feature-flag-service.ts`, `src/infra/agency/liaison-agent.ts`
- **Pool registry:** `src/postgres/pool-registry.ts` (P497)
- **PgBouncer docs:** https://www.pgbouncer.org/config.html
- **Postgres max_connections tuning:** PostgreSQL admin manual (connection budgeting)
- **P499 Design:** `roadmap_proposal.proposal` id=499, `proposal_summary` column
- **P495:** Tenant provisioning saga (creates `roadmap.project` + `tenant_db_provisioned` NOTIFY)
- **P497:** Pool registry (pool-registry.ts, connection multiplexing)
- **P518:** Future hiveCentral separation (separate Postgres instance)
