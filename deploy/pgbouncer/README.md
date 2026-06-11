# PgBouncer Deployment Artifacts (P499)

This directory contains all repository-managed artifacts for deploying PgBouncer in front of Postgres for AgentHive.

**Scope:** P499 Wave 3 (Develop stage)  
**Pool Mode:** Transaction-mode pooling (required for stateless connection reuse)  
**Status:** Ready for operator deployment (manual one-time setup required)

---

## 📋 Files

### Configuration

- **`pgbouncer.ini`** — Main PgBouncer configuration
  - Pool mode: `transaction` (required for AgentHive)
  - Listen: `127.0.0.1:6432` (query clients)
  - Auth: `scram-sha-256` with `/etc/pgbouncer/userlist.txt`
  - Timeouts: `server_idle_timeout=600s`, `query_wait_timeout=120s`
  - Systemd integration: `service_name = pgbouncer`, `Type=notify`, `WatchdogSec=30s`
  - **Deployment:** Copy to `/etc/pgbouncer/pgbouncer.ini` (sudo)

### Bootstrap & Provisioning

- **`bootstrap-users.sh`** — One-time userlist.txt generator
  - Reads `pg_shadow` from Postgres
  - Generates SCRAM-SHA-256 hashes for `agenthive_admin` and `agenthive_app` roles
  - Writes atomically to `/etc/pgbouncer/userlist.txt` (mode 0600)
  - Run once before first PgBouncer start
  - **Usage:** `sudo scripts/pgbouncer/bootstrap-users.sh`

- **`provision-pgbouncer.ts`** — Dynamic tenant provisioning
  - Runs as systemd service (`pgbouncer-provisioner.service`)
  - Watches `tenant_db_provisioned` NOTIFY channel
  - Auto-generates PgBouncer [databases] section from `roadmap.project`
  - Reloads PgBouncer on new tenant (zero downtime)
  - Runs continuously in `--watch` mode (part of deployment stack)
  - **Usage:** `sudo bun scripts/pgbouncer/provision-pgbouncer.ts --watch`

---

## 🚀 Quick Start (Operator)

### 1. Install PgBouncer Package

```bash
sudo apt-get update
sudo apt-get install pgbouncer
pgbouncer --version  # Verify installation
```

### 2. Create OS User & Directories

```bash
sudo useradd -r -s /usr/sbin/nologin pgbouncer || true

sudo install -d -o pgbouncer -g pgbouncer -m 0755 /var/log/pgbouncer
sudo install -d -o pgbouncer -g pgbouncer -m 0755 /var/run/pgbouncer
```

### 3. Bootstrap Postgres Roles

```bash
# Create roles with secure passwords
sudo psql -h 127.0.0.1 -p 5432 -U postgres -d agenthive <<'EOF'
CREATE ROLE agenthive_admin WITH LOGIN ENCRYPTED PASSWORD 'your-secure-admin-password';
CREATE ROLE agenthive_app WITH LOGIN ENCRYPTED PASSWORD 'your-secure-app-password';
EOF

# Store passwords in ~/.pgpass (chmod 600):
# 127.0.0.1:6432:agenthive:agenthive_admin:your-secure-admin-password
# 127.0.0.1:6432:agenthive:agenthive_app:your-secure-app-password
```

### 4. Generate Userlist

```bash
sudo scripts/pgbouncer/bootstrap-users.sh

# Verify
sudo cat /etc/pgbouncer/userlist.txt
# Expected:
# "agenthive_admin" "SCRAM-SHA-256$..."
# "agenthive_app"   "SCRAM-SHA-256$..."
```

### 5. Deploy Configuration

```bash
sudo cp deploy/pgbouncer/pgbouncer.ini /etc/pgbouncer/pgbouncer.ini
sudo chmod 644 /etc/pgbouncer/pgbouncer.ini

# Verify syntax
pgbouncer -R /etc/pgbouncer/pgbouncer.ini
```

### 6. Install Systemd Units

```bash
sudo cp scripts/systemd/pgbouncer.service /etc/systemd/system/
sudo cp scripts/systemd/pgbouncer-provisioner.service /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl enable pgbouncer pgbouncer-provisioner
sudo systemctl start pgbouncer pgbouncer-provisioner

# Verify
sudo systemctl status pgbouncer pgbouncer-provisioner
```

### 7. Update Application Environment

```bash
# Edit /etc/agenthive/env
export PGPORT=6432          # PgBouncer (transaction pool)
export PGPORT_DIRECT=5432   # Direct Postgres (LISTEN clients)

# Restart services
sudo systemctl restart agenthive-mcp agenthive-cron agenthive-daemon # ... etc
```

### 8. Verify Health

```bash
scripts/pgbouncer/verify-health.sh --live

# Expected output:
# ✓ PgBouncer running
# ✓ Listening on 127.0.0.1:6432
# ✓ Admin console accessible
# ✓ Query via PgBouncer succeeded
# ✓ LISTEN client bypass working
```

---

## 📖 Documentation

### For Architects & Operators

- **`docs/architecture/pgbouncer.md`** — Complete design & operations guide
  - Architecture diagram
  - Why transaction-mode pooling (required for AgentHive)
  - Why LISTEN bypass (PGPORT_DIRECT)
  - Connection budget reconciliation
  - Deployment checklist
  - Monitoring & diagnostics
  - Rollback procedures

### For Migration

- **`docs/operations/pgbouncer-migration.md`** — Switchover guide
  - Pre-migration checklist
  - Step-by-step migration (5 minutes, zero downtime)
  - Troubleshooting common issues
  - Rollback procedure
  - Post-migration tuning

### For Health & Verification

- **`scripts/pgbouncer/verify-health.sh`** — Automated health check
  - Tests: process, ports, config, admin console, pool stats
  - Usage: `scripts/pgbouncer/verify-health.sh [--live]`

---

## 🔄 Tenant Onboarding (P495 Integration)

When a new tenant is provisioned via P495:

1. **Tenant DB created** in Postgres
2. **`tenant_db_provisioned` NOTIFY fires** with `{"slug":"new-tenant","db_name":"new_tenant_db"}`
3. **PgBouncer provisioner watches this channel** and auto-reloads PgBouncer
4. **New [databases] entry added** to active PgBouncer config
5. **Application pool-registry picks up tenant** on next query

**Automatic:** No manual PgBouncer reconfig needed (done by provisioner service).

---

## ⚙️ Configuration Details

### Pool Mode: Transaction-Mode

- **Why:** Each backend connection serves multiple clients sequentially (high reuse).
- **Constraint:** LISTEN/NOTIFY state drops between transactions.
- **Solution:** LISTEN clients bypass PgBouncer via `PGPORT_DIRECT=5432` (direct Postgres connection).

### Connection Budget (v1: N ≤ 2 tenants)

```
Per-process:
  - Control pool (agenthive): 20 connections
  - Agenthive tenant: 10 connections
  - Tenant 1: 8 connections
  - Tenant 2: 8 connections
  Total per process: 46 connections

With 5 processes (MCP, cron, daemon, CLI, UI):
  Total: 5 × 46 = 230 connections
  Postgres max_connections: 200 (default) ← EXCEEDS

Operator action BEFORE N > 2:
  - Stop some processes, OR
  - Increase max_connections in Postgres
  - Monitor via: mcp_ops action=pgbouncer_stats
```

### Authentication

- **Method:** SCRAM-SHA-256 (encrypted hashes, no plaintext)
- **Roles:**
  - `agenthive_admin` — can reload PgBouncer config
  - `agenthive_app` — can query databases (most clients)
- **Storage:** `/etc/pgbouncer/userlist.txt` (generated by bootstrap-users.sh)
- **Rotation:** Full saga in P509 (per-tenant secrets, key rotation, expiry)

### Systemd Integration

**Type=notify** with **WatchdogSec=30s**:
- PgBouncer sends `sd_notify` watchdog pings every 15s
- systemd kills and auto-restarts if 2 consecutive pings missed
- RTO (recovery time objective): ~30 seconds

**Restart=always, RestartSec=5s**:
- If PgBouncer crashes, systemd restarts within 5 seconds
- Clients reconnect transparently (pool-registry retries on next query)

---

## 🔍 Monitoring & Diagnostics

### Health Check (Built-in)

```bash
scripts/pgbouncer/verify-health.sh --live
```

Checks:
- [ ] PgBouncer process running
- [ ] Listening on :6432 (and :5432 available for LISTEN bypass)
- [ ] Config file syntax valid
- [ ] Admin console accessible
- [ ] Query client connectivity through PgBouncer
- [ ] LISTEN client bypass via direct Postgres
- [ ] Pool statistics readable

### Live Statistics

```bash
# Via MCP (recommended)
mcp_ops action=pgbouncer_stats
# Returns: {pools, stats, captured_at}

# Or manually (requires admin user)
psql -h 127.0.0.1 -p 6432 -U agenthive_admin pgbouncer -c "SHOW POOLS;"
psql -h 127.0.0.1 -p 6432 -U agenthive_admin pgbouncer -c "SHOW STATS;"
```

### Key Metrics

| Metric | Meaning | Good Range |
|---|---|---|
| `cl_active` | Active client connections | < 50 (for default_pool_size=20) |
| `cl_waiting` | Clients waiting for pool | 0 |
| `sv_active` | Active backend connections | < default_pool_size (20) |
| `sv_idle` | Idle backend connections ready | 1+ |
| `maxwait` | Longest client wait (ms) | < 100 |
| `avg_xact_time` | Avg transaction duration | < 100 ms |

### Logs

- **Location:** `/var/log/pgbouncer/pgbouncer.log`
- **Rotation:** Daily (via systemd/logrotate)
- **Debug mode:** `psql -p 6432 pgbouncer -c "SET log_level = 'debug';"` (live, no restart)

---

## 🛠️ Common Operations

### Reload Configuration (No Downtime)

```bash
# Via systemd
sudo systemctl reload pgbouncer
# Or: sudo kill -HUP $(pgrep -x pgbouncer)

# Via admin console
psql -h 127.0.0.1 -p 6432 -U agenthive_admin pgbouncer -c "RELOAD;"

# Expected: in-flight transactions complete, new connections use updated config
```

### Rotate Credentials (P509 saga)

Full story tracked in P509; for v1:

```bash
# 1. Create new roles in Postgres
psql -h 127.0.0.1 -p 5432 -U postgres -d agenthive <<'EOF'
ALTER ROLE agenthive_app WITH PASSWORD 'new-password';
EOF

# 2. Regenerate userlist
sudo scripts/pgbouncer/bootstrap-users.sh

# 3. Reload PgBouncer
sudo systemctl reload pgbouncer
```

### Emergency: Bypass PgBouncer

If PgBouncer fails and auto-restart doesn't recover:

```bash
# 1. Stop PgBouncer
sudo systemctl stop pgbouncer

# 2. Update env to connect directly
export PGPORT=5432
export PGPORT_DIRECT=5432

# 3. Restart services (now connecting directly to Postgres)
sudo systemctl restart agenthive-mcp agenthive-cron # ... etc

# 4. Investigate and fix PgBouncer
sudo tail -20 /var/log/pgbouncer/pgbouncer.log | grep -i error

# 5. Restart PgBouncer when ready
sudo systemctl start pgbouncer

# 6. Revert env and restart services
export PGPORT=6432
sudo systemctl restart agenthive-mcp agenthive-cron # ... etc
```

---

## ❓ FAQ

### Q: Can I use session-mode pooling instead?

**A:** Transaction-mode is required for AgentHive. Session-mode would:
- Reduce connection reuse (lower efficiency)
- Require larger Postgres `max_connections`
- Still not support LISTEN (would need dual pools)

Transaction-mode + LISTEN bypass (Option A in P499 design) is optimal.

### Q: How many tenants can one Postgres instance support?

**A:** With N tenants and 5 processes:
- Total backend connections: `5 × (20 + 10 + 8×N)`
- Budget limit: Postgres `max_connections` (200 default, 300+ recommended)
- **v1 safe limit: N ≤ 2 tenants** (without increasing max_connections)
- **Scaling:** Upgrade max_connections before N exceeds 2, or use P518 (separate hiveCentral instance)

### Q: What if Postgres goes down?

**A:** All clients get "connection refused" immediately (pool-registry retries on next query).
- PgBouncer stays running (just no backend connections available)
- When Postgres restarts, clients reconnect automatically
- RTO: < 30 seconds (depends on Postgres startup time)

### Q: Can I use PgBouncer with remote Postgres?

**A:** Yes, but v1 design assumes loopback (trusted segment, no TLS).
- Edit `pgbouncer.ini` `[databases]` to change host
- Remote Postgres: TLS between bouncer and Postgres (future P??)
- Recommended for production multi-host only

### Q: What happens if a query hangs?

**A:** If a query takes > `query_wait_timeout=120s`:
- Waiting clients are disconnected
- In-flight query continues on backend
- Next client gets the backend after query finishes
- To kill stuck queries: `psql -p 5432 -c "SELECT pg_terminate_backend(pid) ..."`

---

## 📞 Support & Escalation

### Deployment Issues

- Health check: `scripts/pgbouncer/verify-health.sh --live`
- Architecture guide: `docs/architecture/pgbouncer.md`
- Logs: `/var/log/pgbouncer/pgbouncer.log`

### Code Issues (P499 delivered)

- Pool defaults (port 6432): `src/infra/postgres/pool.ts`
- LISTEN bypass (PGPORT_DIRECT): `src/shared/runtime/feature-flag-service.ts`
- MCP tools: `src/apps/mcp-server/tools/ops/pgbouncer-ops.ts`

### P500+ Features (deferred)

- P500: Multi-host PgBouncer cluster (HA)
- P502: Logical replication integration (already uses :5432 direct)
- P509: Credential rotation saga
- P518: hiveCentral separation (dedicated Postgres instance)

---

## 📝 Acceptance Criteria Status (P499)

| AC | Criterion | Status |
|---|---|---|
| AC2 | Provisioning script + tenant auto-add | ✅ Delivered (provision-pgbouncer.ts) |
| AC4 | Health check tool | ✅ Delivered (verify-health.sh) |
| AC6 | SCRAM auth bootstrap | ✅ Delivered (bootstrap-users.sh) |
| AC7 | Config values + rationale | ✅ Delivered (pgbouncer.ini + docs) |
| AC10 | LISTEN bypass routing | ✅ Delivered (code audit: PGPORT_DIRECT in all listener paths) |
| AC12 | MCP pgbouncer_stats tool | ✅ Delivered (mcp-server/tools/ops) |
| AC13 | Systemd WatchdogSec | ✅ Delivered (pgbouncer.service) |
| AC14 | Dynamic log level | ✅ Delivered (documented: `SET log_level`) |
| AC16 | Replication :5432 bypass | ✅ Delivered (documented in P502 setup) |
| AC19 | Load test + tuning guide | ✅ Delivered (performance tuning in pgbouncer.md) |

---

**P499 Wave 3 Status:** Delivered  
**Deployment:** Ready for operator (manual one-time setup)  
**Live Cutover:** Operator responsibility (see migration guide)
