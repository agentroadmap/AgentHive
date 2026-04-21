# P307: CLI state-machine hardcoded PGPASSWORD & pool.ts sentinel fixes

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Fix 9 bugs in state-machine.ts and pool.ts that cause all CLI DB queries to fail authentication silently.

**Architecture:** Replace psql shell-outs in state-machine.ts with `query()` from pool.ts. Fix pool.ts sentinel loading and truncated code. Remove undocumented register subcommand. Add error reporting.

**Tech Stack:** TypeScript, Node.js child_process → pg Pool, Commander.js

---

## Bug Summary

| # | File | Line(s) | Bug | Severity |
|---|------|---------|-----|----------|
| B1 | state-machine.ts | 88,124,140 | `PGPASSWORD=***` literal instead of `${pgPass}` | CRITICAL |
| B2 | state-machine.ts | 88,124,140 | `-U admin` — no admin user exists | CRITICAL |
| B3 | state-machine.ts | 87,122,138 | `pgPass` declared 3x, never used | LOW |
| B4 | state-machine.ts | 8 | `register` subcommand documented, not implemented | MEDIUM |
| B5 | state-machine.ts | 20-26 | `run()` catches all errors, returns `""` | HIGH |
| B6 | state-machine.ts | 13,22 | `execSync` blocks event loop | MEDIUM |
| B7 | pool.ts | 44 | `process.env.PG_PASSWORD=***` literal, not `match[1].trim()` | CRITICAL |
| B8 | pool.ts | 266 | `dbConf...ord` truncated — should be `dbConfig.password` | HIGH |
| B9 | pool.ts | 168,276 | Default user `"admin"` — should be `"xiaomi"` | HIGH |

---

### Task 1: Fix pool.ts line 44 — sentinel loading bug (B7)

**Objective:** Replace literal `***` with `match[1].trim()` so pool.ts correctly reads PG_PASSWORD from .env files.

**Files:**
- Modify: `src/infra/postgres/pool.ts:44`

**Step 1: Fix the assignment**

```typescript
// BEFORE (line 44):
process.env.PG_PASSWORD=***

// AFTER:
process.env.PG_PASSWORD = match[1].trim();
```

**Step 2: Verify**

```bash
cd /data/code/AgentHive
npx tsc --noEmit src/infra/postgres/pool.ts 2>&1 | head -20
```

Expected: No syntax errors.

**Step 3: Commit**

```bash
git add src/infra/postgres/pool.ts
git commit -m "fix(pool.ts): use match[1].trim() instead of literal *** for PG_PASSWORD loading (B7)"
```

---

### Task 2: Fix pool.ts line 266 — truncated variable name (B8)

**Objective:** Fix corrupted `dbConf...ord` to `dbConfig.password`.

**Files:**
- Modify: `src/infra/postgres/pool.ts:266`

**Step 1: Fix the assignment**

```typescript
// BEFORE (line 266):
process.env.__PG_PASSWORD_FROM_CONFIG=dbConf...ord;

// AFTER:
process.env.__PG_PASSWORD_FROM_CONFIG = dbConfig.password;
```

**Step 2: Verify**

```bash
npx tsc --noEmit src/infra/postgres/pool.ts 2>&1 | head -20
```

**Step 3: Commit**

```bash
git add src/infra/postgres/pool.ts
git commit -m "fix(pool.ts): repair truncated dbConf...ord to dbConfig.password (B8)"
```

---

### Task 3: Fix pool.ts lines 168, 276 — default user "admin" (B9)

**Objective:** Change default DB user from "admin" to "xiaomi" (the primary DB user).

**Files:**
- Modify: `src/infra/postgres/pool.ts:168`
- Modify: `src/infra/postgres/pool.ts:276`

**Step 1: Fix both default user fallbacks**

```typescript
// Line 168 — resolvePoolConfig:
config?.user ?? process.env.PG_USER ?? databaseUrlConfig.user ?? "xiaomi",

// Line 276 — initPoolFromConfig:
user: dbConfig.user ?? process.env.PG_USER ?? "xiaomi",
```

**Step 2: Verify**

```bash
npx tsc --noEmit src/infra/postgres/pool.ts 2>&1 | head -20
```

**Step 3: Commit**

```bash
git add src/infra/postgres/pool.ts
git commit -m "fix(pool.ts): change default DB user from 'admin' to 'xiaomi' (B9)"
```

---

### Task 4: Rewrite state-machine.ts status command to use query() (B1,B2,B3,B6)

**Objective:** Replace psql shell-out in the `status` command with `query()` from pool.ts. Eliminates PGPASSWORD literal, wrong username, dead pgPass variable, and execSync blocking.

**Files:**
- Modify: `src/apps/commands/state-machine.ts:75-117`

**Step 1: Add import**

At the top of the file (after line 13), add:

```typescript
import { query } from "../../infra/postgres/pool";
```

**Step 2: Replace the status action handler**

```typescript
sm.command("status")
  .description("Show service status and offer/dispatch stats")
  .action(async () => {
    // Service status
    console.log("Services:");
    for (const svc of SERVICES) {
      const status = serviceStatus(svc.name);
      const icon = status === "active" ? "✓" : "✗";
      console.log(`  ${icon} ${svc.label}: ${status}`);
    }

    try {
      // DB stats
      console.log("\nAgencies:");
      const agencies = await query(
        `SELECT agent_identity || ' (' || agent_type || ', ' || status || ')' as info
         FROM roadmap_workforce.agent_registry
         ORDER BY agent_identity`
      );
      if (agencies.rows.length > 0) {
        for (const row of agencies.rows) {
          console.log(`  ${row.info}`);
        }
      } else {
        console.log("  (none)");
      }

      console.log("\nOffers:");
      const offers = await query(
        `SELECT offer_status || ': ' || count(*) as info
         FROM roadmap_workforce.squad_dispatch
         GROUP BY offer_status
         ORDER BY offer_status`
      );
      if (offers.rows.length > 0) {
        for (const row of offers.rows) {
          console.log(`  ${row.info}`);
        }
      } else {
        console.log("  (none)");
      }

      console.log("\nActive dispatches:");
      const active = await query(
        `SELECT id || ': ' || dispatch_role || ' @ ' ||
                COALESCE(worker_identity, 'unassigned') || ' (' || offer_status || ')' as info
         FROM roadmap_workforce.squad_dispatch
         WHERE offer_status IN ('open','claimed','active')
         ORDER BY id DESC LIMIT 10`
      );
      if (active.rows.length > 0) {
        for (const row of active.rows) {
          console.log(`  ${row.info}`);
        }
      } else {
        console.log("  (none)");
      }
    } catch (err: any) {
      console.error(`\n  DB query failed: ${err.message}`);
    }
  });
```

**Step 3: Verify**

```bash
npx tsc --noEmit src/apps/commands/state-machine.ts 2>&1 | head -20
```

**Step 4: Test CLI (if possible)**

```bash
cd /data/code/AgentHive && npx tsx src/apps/roadmap.ts sm status
```

**Step 5: Commit**

```bash
git add src/apps/commands/state-machine.ts
git commit -m "fix(sm status): replace psql shell-out with query() — fixes B1,B2,B3,B6"
```

---

### Task 5: Rewrite state-machine.ts agencies command to use query() (B1,B2,B3,B6)

**Objective:** Replace psql shell-out in the `agencies` command.

**Files:**
- Modify: `src/apps/commands/state-machine.ts:119-133`

**Step 1: Replace agencies action handler**

```typescript
sm.command("agencies")
  .description("List registered agencies and their capabilities")
  .action(async () => {
    try {
      const result = await query(
        `SELECT ar.agent_identity, ar.agent_type, ar.status,
                COALESCE(string_agg(ac.capability, ', ' ORDER BY ac.capability), 'none') as capabilities
         FROM roadmap_workforce.agent_registry ar
         LEFT JOIN roadmap_workforce.agent_capability ac ON ac.agent_id = ar.id
         GROUP BY ar.id, ar.agent_identity, ar.agent_type, ar.status
         ORDER BY ar.agent_identity`
      );
      if (result.rows.length === 0) {
        console.log("No agencies registered.");
        return;
      }
      for (const row of result.rows) {
        console.log(`  ${row.agent_identity} [${row.agent_type}, ${row.status}] caps: ${row.capabilities}`);
      }
    } catch (err: any) {
      console.error(`DB query failed: ${err.message}`);
    }
  });
```

**Step 2: Verify**

```bash
npx tsc --noEmit src/apps/commands/state-machine.ts 2>&1 | head -20
```

**Step 3: Commit**

```bash
git add src/apps/commands/state-machine.ts
git commit -m "fix(sm agencies): replace psql shell-out with query() — fixes B1,B2,B3,B6"
```

---

### Task 6: Rewrite state-machine.ts offers command to use query() (B1,B2,B3,B6)

**Objective:** Replace psql shell-out in the `offers` command.

**Files:**
- Modify: `src/apps/commands/state-machine.ts:135-151`

**Step 1: Replace offers action handler**

```typescript
sm.command("offers")
  .description("List open and active offers")
  .action(async () => {
    try {
      const result = await query(
        `SELECT id, proposal_id, dispatch_role, offer_status,
                COALESCE(agent_identity, '-') as agency,
                COALESCE(worker_identity, '-') as worker,
                required_capabilities
         FROM roadmap_workforce.squad_dispatch
         WHERE offer_status IN ('open','claimed','active')
         ORDER BY id`
      );
      if (result.rows.length === 0) {
        console.log("No open/active offers.");
        return;
      }
      for (const row of result.rows) {
        console.log(`  #${row.id} P${row.proposal_id} ${row.dispatch_role} [${row.offer_status}] ${row.agency}/${row.worker} caps=${row.required_capabilities}`);
      }
    } catch (err: any) {
      console.error(`DB query failed: ${err.message}`);
    }
  });
```

**Step 2: Verify**

```bash
npx tsc --noEmit src/apps/commands/state-machine.ts 2>&1 | head -20
```

**Step 3: Commit**

```bash
git add src/apps/commands/state-machine.ts
git commit -m "fix(sm offers): replace psql shell-out with query() — fixes B1,B2,B3,B6"
```

---

### Task 7: Remove register subcommand from help text, add stderr to run() (B4, B5)

**Objective:** Remove the documented-but-unimplemented `register` subcommand from usage comments. Fix `run()` to report stderr on failure.

**Files:**
- Modify: `src/apps/commands/state-machine.ts:1-11` (usage comment)
- Modify: `src/apps/commands/state-machine.ts:20-26` (run function)

**Step 1: Update usage comment**

```typescript
/**
 * roadmap state-machine — manage orchestrator, gate-pipeline, and agency lifecycle
 *
 * Usage:
 *   roadmap state-machine start        # Start orchestrator + gate-pipeline
 *   roadmap state-machine stop         # Stop both
 *   roadmap state-machine restart      # Restart both
 *   roadmap state-machine status       # Show service status + offer stats
 *   roadmap state-machine agencies     # List registered agencies
 *   roadmap state-machine offers       # List open/active offers
 */
```

Remove line 8 (`roadmap state-machine register`).

**Step 2: Fix run() to report stderr**

```typescript
function run(cmd: string): string {
  try {
    return execSync(cmd, {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err: any) {
    const stderr = err.stderr?.toString().trim();
    if (stderr) {
      console.error(`  [error] ${stderr}`);
    }
    return "";
  }
}
```

**Step 3: Verify**

```bash
npx tsc --noEmit src/apps/commands/state-machine.ts 2>&1 | head -20
```

**Step 4: Commit**

```bash
git add src/apps/commands/state-machine.ts
git commit -m "fix(sm): remove unimplemented register subcommand from help, add stderr to run() (B4,B5)"
```

---

### Task 8: Clean up dead pgPass variables (B3)

**Objective:** Remove the now-unused `pgPass` variable declarations.

**Files:**
- Modify: `src/apps/commands/state-machine.ts` (lines 87, 122, 138)

**Step 1: Remove dead declarations**

After tasks 4-6, lines 87, 122, 138 will contain `const pgPass = process.env.PG_PASSWORD || "";` that are no longer referenced. Delete all three.

**Step 2: Verify**

```bash
npx tsc --noEmit src/apps/commands/state-machine.ts 2>&1 | head -20
```

**Step 3: Commit**

```bash
git add src/apps/commands/state-machine.ts
git commit -m "cleanup(sm): remove unused pgPass variable declarations (B3)"
```

---

### Task 9: Remove execSync import if no longer needed (B6)

**Objective:** Check if `execSync` is still needed after psql removal. If only `systemctl` commands remain, keep it. If all uses converted to async, remove import.

**Files:**
- Modify: `src/apps/commands/state-machine.ts:13`

**Step 1: Check remaining execSync usage**

After Tasks 4-6, `execSync` is still used in:
- `run()` function (for systemctl start/stop/restart/status calls)
- `serviceStatus()` function

These are fine as sync calls (fast systemctl operations). Keep the import.

**Step 2: No commit needed** — just verify. Document finding:

```bash
echo "execSync still used for systemctl commands — acceptable (fast operations). Keeping import."
```

---

### Task 10: Build and verify full compilation

**Objective:** Ensure entire project compiles without errors after all changes.

**Files:** All modified files.

**Step 1: Full TypeScript check**

```bash
cd /data/code/AgentHive
npx tsc --noEmit 2>&1 | head -50
```

Expected: No errors (or pre-existing errors unrelated to P307).

**Step 2: Run tests if available**

```bash
npm test 2>&1 | head -50
```

**Step 3: Final commit if any adjustments needed**

```bash
git add -A
git commit -m "fix(P307): resolve 9 bugs in state-machine.ts and pool.ts — hardcoded PGPASSWORD, wrong DB user, sentinel loading, truncated code, silent failures"
```

---

## Verification Checklist

- [ ] pool.ts line 44: `match[1].trim()` not `***`
- [ ] pool.ts line 266: `dbConfig.password` not `dbConf...ord`
- [ ] pool.ts lines 168, 276: default user `"xiaomi"` not `"admin"`
- [ ] state-machine.ts: no `PGPASSWORD=***` literals remain
- [ ] state-machine.ts: no `-U admin` psql calls remain
- [ ] state-machine.ts: no `pgPass` dead variables remain
- [ ] state-machine.ts: no `register` subcommand in help text
- [ ] state-machine.ts: `run()` reports stderr on failure
- [ ] `roadmap sm status` shows agencies/offers/dispatches from DB
- [ ] `roadmap sm agencies` lists agencies with capabilities
- [ ] `roadmap sm offers` lists open/active offers
- [ ] All systemctl commands (start/stop/restart) still work
