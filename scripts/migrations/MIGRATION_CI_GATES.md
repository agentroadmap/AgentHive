# Migration CI Gates (P4626)

Four BLOCKING CI gates protect the migration ledger and the deployed schema.
They build on the P4664 canonical-ledger model (`roadmap.schema_migration` is
the one canonical ledger; `scripts/migrations/` is the one canonical dir).

| Gate | Job (`.gitlab-ci.yml`) | Script | DB needed | Blocking |
|---|---|---|---|---|
| 1+2 Continuity + checksum | `migration-continuity` | `scripts/verify-migration-continuity.ts` | yes (skips if absent) | ✅ |
| 3 Duplicate numeric prefix | `migration-prefix` | `scripts/migrate.ts --check` + `scripts/check-migration-prefixes.ts` | no | ✅ |
| 4 Semantic-writer (multi CREATE-OR-REPLACE) | `migration-semantic-writers` | `scripts/detect-semantic-writers.ts` | no | ✅ |
| Final-schema invariants | `test` | `tests/integration/final-schema-invariants.test.ts` | yes (read-only, skips if absent) | ✅ |

There is exactly ONE continuity job. The prior duplicate `migration-continuity`
job that carried `allow_failure: true` was removed (P4626 AC-7).

## What each gate catches

- **Gate 1+2** — a forward migration file with no row in `roadmap.schema_migration`
  (continuity gap), or an applied migration whose on-disk SHA-256 no longer
  matches the checksum recorded at apply time (an immutability violation). Reads
  the CANONICAL ledger, never the RETIRED `roadmap.migration_history`.
- **Gate 3** — two applicable migration files sharing a numeric prefix with
  different checksums (the `254`-collision bug class).
- **Gate 4** — more than one forward migration `CREATE OR REPLACE`s the SAME
  object (function/procedure/view/trigger). Postgres applies these last-writer-
  wins, so an earlier migration's governance logic can be silently dropped. The
  canonical example is `roadmap_proposal.fn_guard_gate_advance`, rewritten by
  migrations 040/174/189/270/289/299 — the P906 bypass regression was exactly
  this hazard.
- **Final-schema invariants** — asserts the DEPLOYED catalog definition (via
  `pg_get_functiondef`) still holds its governance invariants (e.g. the gate
  guard never reads `app.gate_bypass`, still enforces the 48h governance window,
  still consults `gate_decision_log`). A file-grep gate cannot see the merged
  result; only the catalog can. READ-ONLY; never mutates; runs only under
  `AGENTHIVE_ALLOW_LIVE_DB=1`.

## Rollout: warn → block

Gates 1+2 and 4 ship with the existing backlog grandfathered so the repo is not
red on day one. Each maintains a baseline/allowlist file; entries there are
reported as **WARN** and the gate passes. Anything NOT grandfathered **BLOCKS**.

| Gate | Grandfather file | Seeded from |
|---|---|---|
| 1+2 | `scripts/migration-continuity-baseline.json` | 80 pre-existing drift files (live `schema_migration` at the P4626 baseline) |
| 4 | `scripts/migration-semantic-writers-allowlist.json` | 59 pre-existing multi-writer objects (live migration set at the P4626 baseline) |

**The warn→block path:**

1. **Today (warn for the backlog, block for new):** a NEW continuity gap,
   checksum mismatch, duplicate prefix, or multi-writer fails CI immediately. The
   grandfathered backlog only warns.
2. **Burn down:** when a grandfathered offender is fixed —
   - *Gate 1+2:* re-apply the file via `scripts/migrate.ts` (or re-ledger it) so
     it matches the canonical ledger, then delete its entry from
     `migration-continuity-baseline.json`.
   - *Gate 4:* consolidate the object's many definitions into a single migration
     (the latest authoritative one), then delete its entry from
     `migration-semantic-writers-allowlist.json`.
3. **Fully blocking:** once a grandfather file is empty, the gate is universally
   blocking for that object class. To audit progress at any time, run the gate in
   strict mode (ignores the allowlist):
   `node --import jiti/register scripts/detect-semantic-writers.ts --strict`.

A grandfather entry is a debt marker, not a license — adding a NEW object to
either file requires a written reason and should be a deliberate, reviewed
exception, not the default escape hatch.

## Local commands

```sh
npm run check:migration-continuity     # Gates 1+2 (needs DB; PGPORT=5432 for live, read-only)
npm run migrate:check                  # Gate 3 (DB-free)
npm run check:migrations               # Gate 3 companion (prefix scan)
npm run check:semantic-writers         # Gate 4 (DB-free)
AGENTHIVE_ALLOW_LIVE_DB=1 PGPORT=5432 \
  node --import jiti/register --test tests/integration/final-schema-invariants.test.ts
```
