# P307: CLI state-machine commands — replace psql shell-outs with pool.query()

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Fix 6 bugs in `src/apps/commands/state-machine.ts` by replacing all psql shell-outs with `query()` from `pool.ts`, matching the pattern already working in `state-machine-handlers.ts`.

**Architecture:** The MCP handlers (`state-machine-handlers.ts`) already use `query()` from pool.ts correctly — they are the reference implementation. The CLI file should mirror that pattern instead of shelling out to psql with hardcoded credentials.

**Tech Stack:** TypeScript, pg (node-postgres), commander

---

## Root Cause Analysis

`src/apps/commands/state-machine.ts` shells out to `psql` via `execSync` with 3 correlated bugs:

| Bug | Lines | Issue |
|-----|-------|-------|
| B1 | 88, 124, 140 | `PGPASSWORD=*** literal — never interpolates `pgPass` variable |
| B2 | 88, 124, 140 | `-U admin` — no `admin` user exists (valid: xiaomi, andy, claude) |
| B3 | 87, 122, 138 | `pgPass` declared 3 times, never used |
| B4 | 8 | Help text documents `sm register` — no handler exists |
| B5 | 20-25 | `run()` catches all errors, returns `""` — silent failures |
| B6 | 20-22 | `execSync` blocks Node event loop for up to 10s per query |

**Fix eliminates all 6 bugs simultaneously** by using `query()` from `src/infra/postgres/pool.ts`:
- B1+B2+B3: No psql shell-out = no PGPASSWORD/username issues. Pool uses `PG_PASSWORD` env from .env (or any credential source).
- B6: `query()` is async — doesn't block event loop.
- B4: Remove `register` from line 8 help text.
- B5: Throw errors from query failures instead of swallowing.

## Reference Implementation

`src/apps/mcp-server/tools/workforce/state-machine-handlers.ts` already does this correctly:
```typescript
import { query } from "../../../../infra/postgres/pool.ts";
// ...
const result = await query(`SELECT ... FROM roadmap_workforce.agent_registry ...`);
for (const r of result.rows) { ... }
```

---

### Task 1: Rewrite status command to use query()

**Objective:** Replace psql shell-outs in `sm status` handler with `query()` from pool.ts.

**Files:**
- Modify: `src/apps/commands/state-machine.ts:75-117`

**Step 1: Add import for query**

At top of file, add after existing imports:
```typescript
import { query } from "../../../infra/postgres/pool.ts";
```

**Step 2: Rewrite status action handler**

Replace lines 76-117 (the status action). The current code:
- Line 87: declares `pgPass` (unused)
- Line 88: builds `psql` string with `PGPASSWORD=*** and `-U admin`
- Lines 91-116: shells out 3 times for agencies, offers, dispatches

Replace with async handler that uses `query()`:

```typescript
sm.command("status")
  .description("Show service status and offer/dispatch stats")
  .action(async () => {
    // Service status (unchanged)
    console.log("Services:");
    for (const svc of SERVICES) {
      const status = serviceStatus(svc.name);
      const icon = status === "active" ? "✓" : "✗";
      console.log(`  ${icon} ${svc.label}: ${status}`);
    }

    // Agencies
    console.log("\nAgencies:");
    const agencies = await query(
      `SELECT agent_identity || ' (' || agent_type || ', ' || status || ')' as line
       FROM roadmap_workforce.agent_registry ORDER BY agent_identity`
    );
    if (agencies.rows.length > 0) {
      for (const r of agencies.rows) {
        console.log(`  ${r.line}`);
      }
    } else {
      console.log("  (none)");
    }

    // Offers
    console.log("\nOffers:");
    const offers = await query(
      `SELECT offer_status || ': ' || count(*) as line
       FROM roadmap_workforce.squad_dispatch
       GROUP BY offer_status ORDER BY offer_status`
    );
    for (const r of offers.rows) {
      console.log(`  ${r.line}`);
    }

    // Active dispatches
    console.log("\nActive dispatches:");
    const active = await query(
      `SELECT id || ': ' || dispatch_role || ' @ ' ||
              COALESCE(worker_identity, 'unassigned') || ' (' || offer_status || ')' as line
       FROM roadmap_workforce.squad_dispatch
       WHERE offer_status IN ('open','claimed','active')
       ORDER BY id DESC LIMIT 10`
    );
    if (active.rows.length > 0) {
      for (const r of active.rows) {
        console.log(`  ${r.line}`);
      }
    } else {
      console.log("  (none)");
    }
  });
```

**Step 3: Verify compilation**

Run: `cd /data/code/AgentHive && npx tsc --noEmit src/apps/commands/state-machine.ts 2>&1 | head -20`
Expected: No errors (or only unrelated errors).

**Step 4: Commit**

```bash
git add src/apps/commands/state-machine.ts
git commit -m "fix(sm): replace status command psql shell-out with pool.query()

Eliminates PGPASSWORD=*** literal, -U admin, dead pgPass variable,
and event-loop-blocking execSync. Mirrors state-machine-handlers.ts pattern.

Refs: P307"
```

---

### Task 2: Rewrite agencies command to use query()

**Objective:** Replace psql shell-out in `sm agencies` handler.

**Files:**
- Modify: `src/apps/commands/state-machine.ts:119-133`

**Step 1: Replace agencies action handler**

Replace lines 119-133:

```typescript
sm.command("agencies")
  .description("List registered agencies and their capabilities")
  .action(async () => {
    const result = await query(
      `SELECT ar.agent_identity, ar.agent_type, ar.status,
              COALESCE(string_agg(ac.capability, ', ' ORDER BY ac.capability), 'none') as capabilities
       FROM roadmap_workforce.agent_registry ar
       LEFT JOIN roadmap_workforce.agent_capability ac ON ac.agent_id = ar.id
       GROUP BY ar.id, ar.agent_identity, ar.agent_type, ar.status
       ORDER BY ar.agent_identity`
    );
    if (result.rows.length > 0) {
      for (const r of result.rows) {
        console.log(`${r.agent_identity} (${r.agent_type}, ${r.status}) — ${r.capabilities}`);
      }
    } else {
      console.log("No agencies registered.");
    }
  });
```

**Step 2: Verify compilation**

Run: `cd /data/code/AgentHive && npx tsc --noEmit src/apps/commands/state-machine.ts 2>&1 | head -20`

**Step 3: Commit**

```bash
git add src/apps/commands/state-machine.ts
git commit -m "fix(sm): replace agencies command psql shell-out with pool.query()

Refs: P307"
```

---

### Task 3: Rewrite offers command to use query()

**Objective:** Replace psql shell-out in `sm offers` handler.

**Files:**
- Modify: `src/apps/commands/state-machine.ts:135-150`

**Step 1: Replace offers action handler**

Replace lines 135-150:

```typescript
sm.command("offers")
  .description("List open and active offers")
  .action(async () => {
    const result = await query(
      `SELECT id, proposal_id, dispatch_role, offer_status,
              COALESCE(agent_identity, '-') as agency,
              COALESCE(worker_identity, '-') as worker,
              required_capabilities
       FROM roadmap_workforce.squad_dispatch
       WHERE offer_status IN ('open','claimed','active')
       ORDER BY id`
    );
    if (result.rows.length > 0) {
      for (const r of result.rows) {
        console.log(`#${r.id}: P${r.proposal_id} ${r.dispatch_role} — ${r.offer_status} (agency=${r.agency}, worker=${r.worker})`);
      }
    } else {
      console.log("No open/active offers.");
    }
  });
```

**Step 2: Verify compilation**

Run: `cd /data/code/AgentHive && npx tsc --noEmit src/apps/commands/state-machine.ts 2>&1 | head -20`

**Step 3: Commit**

```bash
git add src/apps/commands/state-machine.ts
git commit -m "fix(sm): replace offers command psql shell-out with pool.query()

Refs: P307"
```

---

### Task 4: Remove register subcommand from help text and fix run() error reporting

**Objective:** Fix B4 (phantom register subcommand) and B5 (silent failures).

**Files:**
- Modify: `src/apps/commands/state-machine.ts:8,20-25`

**Step 1: Remove register from help text**

Change line 8 from:
```
 *   roadmap state-machine register     # Register this host as an agency
```
to:
```
 *   roadmap state-machine agencies     # List registered agencies
```

(Remove the register line entirely since it's the 4th entry — just delete it.)

**Step 2: Improve run() error reporting**

Replace lines 20-25:
```typescript
function run(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", timeout: 10_000 }).trim();
  } catch {
    return "";
  }
}
```

With:
```typescript
function run(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8", timeout: 10_000 }).trim();
  } catch (e: any) {
    const stderr = e.stderr?.toString()?.trim();
    if (stderr) {
      console.error(`[sm] command failed: ${stderr}`);
    }
    return "";
  }
}
```

Note: `run()` is still used for `systemctl` commands (start/stop/restart/status) — those are appropriate shell-outs. Only the psql calls needed replacing.

**Step 3: Verify compilation**

Run: `cd /data/code/AgentHive && npx tsc --noEmit src/apps/commands/state-machine.ts 2>&1 | head -20`

**Step 4: Commit**

```bash
git add src/apps/commands/state-machine.ts
git commit -m "fix(sm): remove phantom register subcommand, add stderr to run()

- Remove 'register' from help text (no handler exists)
- run() now logs stderr on failure instead of silent return
- run() retained for systemctl commands (appropriate shell-outs)

Refs: P307"
```

---

### Task 6: Fix pool.ts bugs (same root cause chain)

**Objective:** Fix 3 bugs in pool.ts that compound the state-machine credential issues.

**Files:**
- Modify: `src/infra/postgres/pool.ts`

**Step 1: Fix line 44 — literal *** instead of match[1].trim()**

Replace:
```typescript
process.env.PG_PASSWORD=***
```
With:
```typescript
process.env.PG_PASSWORD = match[1].trim();
```

This is the root cause of the sentinel `***` being loaded as the actual password. The `.env` file has `PG_PASSWORD=***` as a placeholder, and the code loads the literal string instead of extracting the matched value.

**Step 2: Fix line 168 — default user "admin"**

Replace:
```typescript
config?.user ?? process.env.PG_USER ?? databaseUrlConfig.user ?? "admin",
```
With:
```typescript
config?.user ?? process.env.PG_USER ?? databaseUrlConfig.user ?? "xiaomi",
```

**Step 3: Fix line 266 — truncated variable name**

Replace:
```typescript
process.env.__PG_PASSWORD_FROM_CONFIG=dbConf...ord;
```
With:
```typescript
process.env.__PG_PASSWORD_FROM_CONFIG = dbConfig.password;
```

**Step 4: Fix line 276 — default user "admin" in initPoolFromConfig**

Replace:
```typescript
user: dbConfig.user ?? process.env.PG_USER ?? "admin",
```
With:
```typescript
user: dbConfig.user ?? process.env.PG_USER ?? "xiaomi",
```

**Step 5: Verify compilation** Run: `cd /data/code/AgentHive && npx tsc --noEmit src/infra/postgres/pool.ts 2>&1 | head -20`

**Step 6: Commit**

```bash
git add src/infra/postgres/pool.ts
git commit -m "fix(pool): literal ***, truncated var, wrong default user

- Line 44: match[1].trim() instead of literal ***
- Line 266: dbConfig.password instead of dbConf...ord
- Lines 168/276: default user xiaomi instead of admin

Refs: P307"
```

---

### Task 7: Verify all changes work together

**Objective:** Full integration test of the rewritten CLI.

**Files:**
- Read: `src/apps/commands/state-machine.ts`

**Step 1: Final compilation check**

Run: `cd /data/code/AgentHive && npx tsc --noEmit 2>&1 | head -30`
Expected: No errors from state-machine.ts.

**Step 2: Review final file**

Read the full file to verify:
- No `PGPASSWORD=*** literals remain
- No `-U admin` remains
- No unused `pgPass` variables
- All DB queries use `await query()` from pool.ts
- `run()` only used for systemctl commands
- Help text has no `register` entry

**Step 3: Functional test (if possible)**

Run: `cd /data/code/AgentHive && npx tsx src/apps/commands/state-machine.ts status 2>&1 | head -20`
Expected: Service status + DB stats (or clear DB connection error, not silent failure).

**Step 4: Commit (if any final fixes needed)**

```bash
git add src/apps/commands/state-machine.ts
git commit -m "fix(sm): final verification for P307

All psql shell-outs replaced with pool.query(). 6 bugs fixed:
- PGPASSWORD=*** literal eliminated
- Wrong -U admin eliminated
- Dead pgPass variable removed
- Phantom register subcommand removed from help
- Silent failures now report stderr
- execSync blocking replaced with async query()

Refs: P307"
```

---

## Summary

| Before | After |
|--------|-------|
| `PGPASSWORD=*** psql -U admin ...` | `await query(...)` |
| `execSync` (blocks event loop) | `async/await` (non-blocking) |
| `pgPass` declared but unused | Removed |
| `run()` swallows errors | `run()` logs stderr |
| `register` in help, no handler | Removed from help |
| pool.ts: literal `***` loaded as password | `match[1].trim()` |
| pool.ts: truncated `dbConf...ord` | `dbConfig.password` |
| pool.ts: default user `admin` | default user `xiaomi` |

**Files changed:** `src/apps/commands/state-machine.ts` + `src/infra/postgres/pool.ts`

The fix mirrors the working pattern in `state-machine-handlers.ts` which already uses `query()` from pool.ts for identical queries. No new dependencies, no schema changes, no MCP tool changes needed.

**Architect note (2026-04-20):** The original plan only covered state-machine.ts (5 tasks). During review, 3 additional pool.ts bugs were discovered as part of the same root cause chain: literal `***` loading (line 44), truncated variable (line 266), and wrong default user (lines 168, 276). These are now included as Task 6. Total: 7 tasks.
