# Test DB Helpers — `tests/_helpers/`

Utilities for spinning up ephemeral Postgres databases in test runs. Two modes are supported — **two-tier** (separate `hiveControl` + per-tenant DBs, matching the production topology) and **single-tier** (legacy single-DB mode for the transition window).

---

## Quick Start

```ts
import { setupTwoTier, setupSingleTier, mode } from './_helpers/two-tier-db.ts';

// In your test file:
describe('my feature', () => {
  if (mode() !== 'two-tier') return; // skip in single-tier CI run

  let handles: TwoTierHandles;
  before(async () => { handles = await setupTwoTier(); });
  after(async () => { await handles.cleanup(); });

  it('queries the control DB', async () => {
    const { rows } = await handles.control.query('SELECT 1 AS n');
    assert.equal(rows[0].n, 1);
  });
});
```

---

## Helper API

### `setupTwoTier(opts?)`

```ts
export interface TwoTierHandles {
  control: Pool;                          // ephemeral hiveControl DB
  tenant(slug: string): Pool;             // ephemeral tenant DB for slug
  cleanup(): Promise<void>;              // TRUNCATE-and-pool or DROP on exit
}

export async function setupTwoTier(opts?: {
  controlSchemas?: string[];             // default: ['roadmap', 'roadmap_proposal']
  tenantSeeds?: { slug: string; ddlFiles?: string[] }[];
}): Promise<TwoTierHandles>;
```

- Creates (or pops from the warm pool) an ephemeral `hiveControl`-equivalent DB and one tenant DB per seed entry.
- Applies DDL from `database/ddl/hivecentral/*.sql` (control) and `database/ddl/tenant/*.sql` (tenant) in numeric-prefix order.
- After DDL: runs a parity check against `tests/_helpers/control-schema-manifest.json` (if present). Throws with a diagnostic dump if expected tables are missing.
- If `database/ddl/tenant/000-tenant-bootstrap.sql` does not exist (P508 not yet shipped), tenant pools are returned without bootstrap DDL; a warning is logged. Tests that require bootstrapped tenants must ensure P508 has landed.

### `setupSingleTier()`

```ts
export interface SingleTierHandles {
  db: Pool;                              // ephemeral single DB
  cleanup(): Promise<void>;
}

export async function setupSingleTier(): Promise<SingleTierHandles>;
```

- Creates (or pops from the warm pool) one ephemeral DB applying legacy DDL from `database/ddl/*.sql`.
- **Critical:** sets `process.env.PGDATABASE = <ephemeral_db_name>` and `process.env.PGUSER = <test_role>` before returning, so that existing `src/postgres/pool.ts` calls hit the ephemeral DB without per-test pool injection.
- `cleanup()` restores the original env values and returns the DB pair to the warm pool (TRUNCATE-based reset).

### `mode()`

```ts
export function mode(): 'single' | 'two-tier';
```

Returns the current DB mode, driven by `AGENTHIVE_DB_MODE` (see below).

**Pattern for skipping a describe block in the wrong mode:**

```ts
import { mode } from './_helpers/two-tier-db.ts';

describe('two-tier specific', () => {
  if (mode() !== 'two-tier') return;
  // ...
});
```

---

## Mode Flag

| Env var | Values | Default |
|---|---|---|
| `AGENTHIVE_DB_MODE` | `single` \| `two-tier` | `single` |

`single` mode is the default until P512 retires the legacy schema. CI runs both modes via a matrix (see below). Tests not relevant to two-tier may guard with `if (mode() !== 'two-tier') return`.

---

## Ephemeral DB Naming

DB names follow `agenthive_test_<hostname>-<pid>-<timestamp_ms>-<uuid8>`.

Examples:
```
agenthive_test_bot-12345-1714086000000-a1b2c3d4   (legacy/single)
hiveControl_test_bot-12345-1714086000000-e5f6a7b8  (control)
tenant_audiobook_test_bot-12345-1714086000000-c9d0e1f2 (tenant)
```

The `agenthive_test_` and `hiveControl_test_` and `tenant_*_test_` prefixes are the orphan-cleanup patterns. The timestamp component makes names sortable for age-based cleanup heuristics.

---

## Pool Recycling (4× Speedup)

Each process maintains a warm pool of **3 pre-created ephemeral DB pairs**. On `setupTwoTier()`:

1. Pop a pair from the warm pool; if the pool is empty, create a new pair (~200 ms).
2. TRUNCATE all tables in the popped pair (~50 ms vs. 200 ms for full recreation).
3. Re-seed any per-test fixtures.
4. Return handles.

On `cleanup()`: TRUNCATE + push back to the warm pool (no DROP). On process exit: actual DROP of all pooled DBs.

**Net cost:** ~50 ms/setup vs. ~200 ms. For 200 test files this saves ~30 s per CI run.

Pool size is fixed at 3 per process. Three empty schemas ≈ 15 MB total — negligible.

---

## Orphan Cleanup

### `tests/_helpers/cleanup-orphans.ts`

Standalone script that drops test DBs older than 1 hour. Run it as a pre-test hook in CI and as a nightly cron on dev machines.

```bash
tsx tests/_helpers/cleanup-orphans.ts
```

The script:
1. Connects to the default admin DB (`agenthive`, or `hiveControl` post-P507).
2. Queries `pg_database` for names matching `agenthive_test_%`, `hiveControl_test_%`, or `tenant_%_test_%`.
3. Parses the timestamp component from each name; drops DBs where timestamp is older than 1 hour.
4. Logs each drop with pre-drop row counts for forensics.

**CI hook:** add to the test step `if: always()` so it runs even when tests fail:

```yaml
- run: tsx tests/_helpers/cleanup-orphans.ts
  if: always()
```

---

## PgBouncer Override

By default the helpers connect via `AGENTHIVE_PG_PORT` (default `6432`, the PgBouncer port). For tests requiring session-mode features (LISTEN/NOTIFY, prepared statements, transaction-spanning state), override the port:

```bash
AGENTHIVE_TEST_PG_PORT=5432 npm test
```

Both `setupTwoTier` and `setupSingleTier` honour this override. Document any test that requires direct Postgres access with a comment explaining why.

---

## CI Matrix

Both modes must pass before merge:

```yaml
strategy:
  fail-fast: false
  matrix:
    db_mode: [single, two-tier]
steps:
  - run: npm test
    env:
      AGENTHIVE_DB_MODE: ${{ matrix.db_mode }}
  - run: tsx tests/_helpers/cleanup-orphans.ts
    if: always()
```

`fail-fast: false` ensures both mode reports surface even if one fails.

---

## Multi-Project Phase 1 Tests

`tests/multi-project/phase1-registry.test.ts`, `phase1-allowlist.test.ts`, and `phase1-lifecycle.test.ts` are the canonical examples of helper usage. They call `mode()` and dispatch to `setupTwoTier` or `setupSingleTier` accordingly — use them as a template when migrating other test files.

---

## Schema Parity Manifest

`tests/_helpers/control-schema-manifest.json` (optional) lists the minimum set of tables expected in the control schema after DDL application. If the file is present and DDL application produces fewer tables, `setupTwoTier` throws with a diagnostic dump identifying the missing tables.

Generate the manifest after a clean DDL apply:

```bash
psql -At -c "SELECT tablename FROM pg_tables WHERE schemaname IN ('roadmap','roadmap_proposal') ORDER BY tablename" | \
  jq -Rs 'split("\n") | map(select(. != ""))' > tests/_helpers/control-schema-manifest.json
```

---

## DDL Application Order

1. Files without a numeric prefix (e.g., `roadmap-baseline.sql`) are applied first (assumed to be the baseline).
2. Numerically prefixed files (e.g., `000-roles.sql`, `001-core.sql`) are applied in ascending order.
3. After each file: the helper verifies the SQL succeeded (errors throw immediately).
4. After all files: parity check runs if the manifest is present.

---

## Related Proposals

| Proposal | Relationship |
|---|---|
| P429 | Umbrella — two-tier DB migration; P500 is Stage A6 |
| P507 | hiveControl migration — post-P507, orphan reaper connects to `hiveControl` instead of `agenthive` |
| P508 | Tenant DDL templates — required for full tenant bootstrap in two-tier mode |
| P512 | Retires single-DB mode; until then, CI runs both modes |
| P519 | Converted multi-project Phase 1 tests from vitest to node:test (prerequisite) |
