# P676 — Role-split rollout & rollback runbook (2026-04-29)

**Migration:** `scripts/migrations/067-p676-pg-role-decomposition.sql`
**Rollback SQL:** `scripts/migrations/067-p676-rollback.sql`
**Affected services:** all 10 `agenthive-*` units.

## Pre-flight

1. **Generate three strong passwords** (one per role). Store in your secret
   manager. The migration reads them from psql variables — they never enter
   commit history:
   ```bash
   RO_PASS=$(openssl rand -base64 32)
   APP_PASS=$(openssl rand -base64 32)
   ADMIN_PASS=$(openssl rand -base64 32)
   ```

2. **Snapshot pg_stat_activity** for sanity-check baseline:
   ```bash
   PGPASSWORD=$ADMIN_BREAKGLASS psql -h 127.0.0.1 -U admin -d agenthive \
     -c "SELECT usename, count(*) FROM pg_stat_activity GROUP BY usename;" \
     > /tmp/p676-pre.txt
   ```

3. **Backup `/etc/agenthive/env`** and the discord-bridge-only env file:
   ```bash
   sudo cp /etc/agenthive/env /etc/agenthive/env.bak.$(date +%s)
   sudo cp /home/xiaomi/.agenthive.env /home/xiaomi/.agenthive.env.bak.$(date +%s)
   ```

## Apply

1. **Run the bootstrap migration** as the existing `admin` superuser:
   ```bash
   PGPASSWORD=$ADMIN_BREAKGLASS psql -h 127.0.0.1 -U admin -d agenthive \
     -v ro_pass="'$RO_PASS'" -v app_pass="'$APP_PASS'" -v admin_pass="'$ADMIN_PASS'" \
     -f scripts/migrations/067-p676-pg-role-decomposition.sql
   ```
   Watch for `NOTICE: smoke: …` lines confirming the in-transaction smoke
   tests passed.

2. **Verify roles**:
   ```sql
   SELECT rolname, rolconnlimit, rolsuper, rolcreaterole, rolcanlogin
   FROM pg_roles
   WHERE rolname IN ('roadmap_ro','roadmap_app','roadmap_admin','admin')
   ORDER BY rolname;
   ```
   Expected: 4 rows. `roadmap_admin` rolcreaterole=t, rolsuper=f, rolconnlimit=5.
   `roadmap_app` rolconnlimit=80. `roadmap_ro` rolconnlimit=30. `admin`
   rolconnlimit still -1 (lowered in step 8).

3. **Write env files** (chmod 600 for `env.admin`):
   ```bash
   sudo install -m 644 -o root -g root /dev/stdin /etc/agenthive/env.ro <<EOF
   PGHOST=127.0.0.1
   PGPORT=5432
   PGDATABASE=agenthive
   PGUSER=roadmap_ro
   PGSCHEMA=roadmap
   PGPASSWORD=$RO_PASS
   DATABASE_URL=postgresql://roadmap_ro:$RO_PASS@127.0.0.1:5432/agenthive
   EOF

   sudo install -m 644 -o root -g root /dev/stdin /etc/agenthive/env.app <<EOF
   PGHOST=127.0.0.1
   PGPORT=5432
   PGDATABASE=agenthive
   PGUSER=roadmap_app
   PGSCHEMA=roadmap
   PGPASSWORD=$APP_PASS
   DATABASE_URL=postgresql://roadmap_app:$APP_PASS@127.0.0.1:5432/agenthive
   EOF

   sudo install -m 600 -o root -g root /dev/stdin /etc/agenthive/env.admin <<EOF
   PGHOST=127.0.0.1
   PGPORT=5432
   PGDATABASE=agenthive
   PGUSER=roadmap_admin
   PGSCHEMA=roadmap
   PGPASSWORD=$ADMIN_PASS
   DATABASE_URL=postgresql://roadmap_admin:$ADMIN_PASS@127.0.0.1:5432/agenthive
   EOF
   ```

4. **Update discord-bridge env** (special path):
   ```bash
   sudo install -m 600 -o xiaomi -g xiaomi /dev/stdin /home/xiaomi/.agenthive.env <<EOF
   PGHOST=127.0.0.1
   PGPORT=5432
   PGDATABASE=agenthive
   PGUSER=roadmap_ro
   PGPASSWORD=$RO_PASS
   DATABASE_URL=postgresql://roadmap_ro:$RO_PASS@127.0.0.1:5432/agenthive
   EOF
   ```

5. **Update systemd unit `EnvironmentFile=` lines**.
   Read-only services point at `env.ro`; everything else at `env.app`.
   See `scripts/systemd/p676-env-rewrite.sh` for the per-unit edits.

6. **Restart in waves** (catches grant-misses early without taking the whole
   system down):
   - Wave 1 (read-only): `state-feed`, `discord-bridge`. Watch 30 min:
     ```bash
     sudo journalctl -fu agenthive-state-feed agenthive-discord-bridge | grep -i "permission denied\|42501"
     ```
   - Wave 2: `board`, `mcp` (10-min gap, watch).
   - Wave 3: `orchestrator`, `gate-pipeline`, `notification-router`.
   - Wave 4: `claude-agency`, `copilot-agency`, `a2a`.
   At each wave, confirm `pg_stat_activity` shows the new role:
   ```sql
   SELECT usename, count(*) FROM pg_stat_activity
   WHERE pid != pg_backend_pid()
   GROUP BY usename;
   ```

7. **Verify `admin` is no longer used by services**:
   ```sql
   SELECT application_name, count(*)
   FROM pg_stat_activity
   WHERE usename='admin'
     AND pid != pg_backend_pid()
   GROUP BY application_name;
   ```
   Expected: 0 rows (or only DBA/DBeaver tools).

8. **Lower admin connection limit** (last step, runs OUTSIDE transaction):
   ```sql
   ALTER ROLE admin CONNECTION LIMIT 5;
   ```
   ⚠️ **Partial-success window**: if step 1 (the migration) committed but
   this final step fails, `admin` retains `rolconnlimit=-1` until manually
   corrected. A repeat of `ALTER ROLE admin CONNECTION LIMIT 5;` is safe and
   idempotent; re-run after fixing the underlying cause.

## Rollback (per-service, fast)

If a service fails to start with a permission error, revert that one service:
```bash
sudo sed -i 's|EnvironmentFile=/etc/agenthive/env\.\(ro\|app\)|EnvironmentFile=/etc/agenthive/env|' \
  /etc/systemd/system/agenthive-<svc>.service
sudo systemctl daemon-reload
sudo systemctl restart agenthive-<svc>
```
Time-to-recover: <5 min per service.

## Rollback (full teardown)

If the whole role split must be undone:

1. Revert all systemd unit `EnvironmentFile=` lines to `/etc/agenthive/env`,
   `daemon-reload`, restart all services.
2. Confirm no service connections remain as `roadmap_ro/app/admin`:
   ```sql
   SELECT usename, count(*) FROM pg_stat_activity
   WHERE usename IN ('roadmap_ro','roadmap_app','roadmap_admin')
   GROUP BY usename;
   ```
   Expected: 0 rows.
3. Run the rollback SQL:
   ```bash
   PGPASSWORD=$ADMIN_BREAKGLASS psql -h 127.0.0.1 -U admin -d agenthive \
     -f scripts/migrations/067-p676-rollback.sql
   ```
4. Restore `admin` connection limit:
   ```sql
   ALTER ROLE admin CONNECTION LIMIT -1;
   ```
5. Optionally remove env files:
   ```bash
   sudo rm /etc/agenthive/env.{ro,app,admin}
   sudo cp /home/xiaomi/.agenthive.env.bak.<ts> /home/xiaomi/.agenthive.env
   ```

## Verification (post-rollout)

Run all 6 acceptance-criteria queries from P676:

```sql
-- AC-1: roles + connection limits
SELECT rolname, rolconnlimit, rolsuper, rolcreaterole, rolcanlogin
FROM pg_roles
WHERE rolname IN ('roadmap_ro','roadmap_app','roadmap_admin','admin')
ORDER BY rolname;

-- AC-2: ro boundary
SET ROLE roadmap_ro;
SELECT id FROM roadmap_proposal.proposal LIMIT 1;       -- must succeed
INSERT INTO roadmap_proposal.proposal(title) VALUES('test');  -- must FAIL: 42501
LISTEN test_channel;                                     -- must succeed
RESET ROLE;

-- AC-3: app boundary
SET ROLE roadmap_app;
INSERT INTO roadmap_workforce.squad_dispatch(...) VALUES(...);  -- succeeds (rollback)
CREATE TABLE roadmap.x(id int);                          -- must FAIL: 42501
GRANT SELECT ON roadmap_proposal.proposal TO public;     -- must FAIL: 42501
CREATE ROLE ghost;                                       -- must FAIL: 42501
RESET ROLE;

-- AC-9: no admin in service steady-state
SELECT usename, count(*) FROM pg_stat_activity
WHERE pid != pg_backend_pid()
GROUP BY usename;

-- AC-14: ALTER DEFAULT PRIVILEGES propagates
SET ROLE roadmap_admin;
CREATE TABLE roadmap.test_priv_check (id int);
RESET ROLE;
\z roadmap.test_priv_check
-- Expected: roadmap_ro=r, roadmap_app=arwd (no explicit GRANT needed)
DROP TABLE roadmap.test_priv_check;
```

## Open work (NOT in this rollout)

- Replace `discord-bridge`'s home-dir env file with `/etc/agenthive/env.ro`
  (will require updating the systemd unit to drop the user-specific path).
- Migrate any remaining ad-hoc tools that hardcode `admin` credentials.
- Add CI smoke-test job that runs the AC queries against a fresh DB.
