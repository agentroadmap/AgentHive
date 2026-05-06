# P236: Quality Control Guidelines and Background E2E Gating

**Type:** Component (Guidelines + Tooling Spec)
**Status:** COMPLETE
**Date:** 2026-05-06
**Documenter:** worker-16139 (claude/agency-bot)

---

## 1. Overview

AgentHive ships 89 e2e files, 123 integration tests, and 46 unit tests. Raw count does not
prove quality or coverage. The 10-minute GitLab CI timeout blocks every merge on the full
suite, creating a false choice between speed and confidence.

P236 establishes:

- A formal test quality **rubric** (7 dimensions, pass/warn/fail).
- A four-tier **category system** (gate, background-e2e, sentinel, exploratory).
- Surface-scoped **merge gate rules** that keep blocking CI under 13 minutes.
- A resumable **background e2e supervisor** (Node.js) that handles slow orchestrated flows
  asynchronously.
- A structured **result event payload** with four communication channels.
- A **coverage review matrix** identifying priority gaps.

---

## 2. Test Quality Rubric (AC-1)

Every test candidate is scored across seven dimensions before promotion.

| # | Dimension | Pass | Warn | Fail |
|---|-----------|------|------|------|
| 1 | Critical-path coverage | Tests at least one primary happy path end-to-end | Tests adjacent to critical path | Does not exercise any known critical path |
| 2 | Boundary coverage | Exercises ≥1 min/max/edge value per parameter | Tests only typical values | All inputs are interior/typical |
| 3 | Failure specificity | Assertion message identifies root cause without reading source | Message identifies symptom | Generic assertion ("expected true") |
| 4 | Determinism | Zero flakes in 10 consecutive local runs | Flakes ≤ 1 in 10 (env-sensitive) | Any unexplained flake in 10 runs |
| 5 | Unique signal | No other test in the suite covers the same failure mode | Overlaps ≤1 other test | Duplicate of an existing test |
| 6 | Maintenance cost | No setup/teardown beyond db seed + cleanup helper | Uses 1 shared helper + custom logic | Bespoke multi-file fixture harness |
| 7 | Runtime budget | ≤ 2 s (unit), ≤ 10 s (e2e shard) | ≤ 5 s (unit), ≤ 20 s (e2e) | Exceeds warn thresholds |

**Gate promotion** requires all seven dimensions to pass.
**Background-e2e promotion** tolerates `warn` on runtime budget (dim 7) and unique signal (dim 5).

---

## 3. Test Categories (AC-2)

### 3.1 Category Definitions

#### Gate
- **Purpose:** Fast, deterministic checks that block merge.
- **Runtime:** ≤ 2 s/unit, ≤ 10 s/e2e shard.
- **Scope:** Tied to changed surface via structural mirror convention.
- **File annotation:** `// @category: gate` in `describe` block header.
- **Examples:** Unit tests for a changed module, thin integration tests for a changed API endpoint.

#### Background E2E
- **Purpose:** Slow or orchestrated flows that would breach the CI timeout.
- **Runtime:** No hard cap; default shard concurrency = 4.
- **Scope:** `tests/e2e/`, `tests/workflow/`, `tests/agency/`, `tests/cubic/`.
- **File annotation:** `// @category: background-e2e`
- **Signal path:** Async via supervisor → JSONL log → MCP roadmap → GitLab artifact.

#### Regression Sentinel
- **Purpose:** Pinned tests that prove a confirmed bug is fixed and stays fixed.
- **Promotion trigger:** Bug confirmed fixed + regression test written to reproduce original failure.
- **Demotion trigger:** Bug re-introduced and test becomes a gate blocker.
- **File annotation:** `// @category: sentinel`

#### Exploratory
- **Purpose:** Spike and hypothesis tests during development.
- **Rubric:** Not required; not tracked in flake history.
- **Promotion path:** Must pass full rubric + ≥5 stable CI runs before gate/sentinel promotion.
- **File annotation:** `// @category: exploratory`

### 3.2 Promotion Rules

| Target category | Requirements |
|-----------------|-------------|
| Gate | All 7 rubric dimensions pass + ≥5 consecutive CI runs with no flake |
| Background E2E | Dimensions 1 (critical-path), 4 (determinism), 3 (specificity) pass |
| Sentinel | Bug confirmed fixed + test reproduces original failure mode |
| Exploratory → Gate/Sentinel | Same as target requirements above |

### 3.3 Demotion Triggers

| Trigger | Action |
|---------|--------|
| Flake rate > 2% over 30 runs | Demote gate → exploratory; file investigation issue |
| Runtime budget breach 3× consecutive CI runs | Demote gate → background-e2e |
| Rubric dimension failure on quarterly review | Demote to exploratory; remediation required before re-promotion |

---

## 4. Merge Gate Rules (AC-3)

### 4.1 CI Stage Budget

| Stage | Job(s) | Hard timeout | On fail |
|-------|--------|--------------|---------|
| security | `gitleaks detect`, `npm audit --audit-level=high` | 2 min | Hard fail (blocks merge) |
| check | `tsc`, `biome` (lint) | 3 min | Hard fail |
| test:gate | Surface-scoped gate tests | 5 min | Hard fail |
| build | `npm run build` | 3 min | Hard fail |

Total worst-case: 13 minutes.

### 4.2 Surface Scoping

Changed files are mapped to gate tests using the structural mirror convention:

```
src/foo/bar.ts  →  tests/unit/foo/bar.test.ts
src/core/X.ts   →  tests/unit/core/X.test.ts
```

Additionally, any test annotated with `// @affects: src/foo/bar.ts` is included even if the
mirror path produces no match.

Gate list target: **≤ 60 files**. Reviewed at every major proposal.

### 4.3 Local Pre-Merge Command

```bash
npm run gate -- --surface $(git diff --name-only origin/main)
```

This runs only the gate-tier tests that cover the files changed in your branch.

### 4.4 Current CI Mapping (Implementation Status)

The existing `.gitlab-ci.yml` has security + check + test (monolithic) + build stages.
The `test:gate` surface-scoped stage is pending implementation. Until wired, the gate test
command runs the full `npm test` suite under the 10-minute timeout.

**Implementation gap:** Replace the monolithic `test` job with a surface-scoped `test:gate`
job using `npm run gate -- --surface $(git diff --name-only origin/main...HEAD)`.

---

## 5. Resumable Background E2E Supervisor (AC-4)

### 5.1 Script Location

```
scripts/e2e-supervisor.js
```

### 5.2 Discovery and Sharding

The supervisor discovers all `background-e2e`-annotated files by glob:

```
tests/e2e/**/*.test.ts
tests/workflow/**/*.test.ts
tests/agency/**/*.test.ts
tests/cubic/**/*.test.ts
```

Each file becomes one shard. One shard = one child process, one `TEST_TMP_DIR`.

### 5.3 Manifest Persistence

Before any shard starts, the supervisor writes:

```
tests/.e2e-manifest.json
```

Schema per shard entry:

```json
{
  "run_id": "<uuid>",
  "shard_id": "<file-slug>",
  "test_file": "tests/e2e/foo.test.ts",
  "status": "pending | running | complete | failed",
  "exit_code": null,
  "started_at": null,
  "completed_at": null
}
```

### 5.4 Resume Semantics

On restart with the same `run_id`:

| Manifest status | Action |
|-----------------|--------|
| `complete` | Skip (already done) |
| `running` | Requeue (process may have died) |
| `failed` | Requeue |
| `pending` | Run normally |

The `run_id` is preserved across restarts.

### 5.5 Concurrency and Logging

- Default concurrency: **4 parallel shards**.
- Per-shard stdout + stderr streamed to: `tests/.e2e-logs/<shard-slug>.log`
- SIGINT / SIGTERM: flush manifest → mark in-flight shards as `running` → exit. Safe to resume.

### 5.6 Flake Tracking

Exit codes are appended to:

```
tests/.e2e-flake-history.jsonl
```

Flaky flag triggered when: alternating pass/fail ≥ 2 times in the last 5 runs for a given
shard. Flaky shards are reported in `run_summary` and excluded from hard-fail logic.

---

## 6. Result Event Payload and Communication Path (AC-5)

### 6.1 Event Types

#### `shard_result` — emitted after each shard completes

```typescript
{
  event: "shard_result",
  run_id: string,
  commit: string,
  branch: string,
  test_file: string,
  category: "gate" | "background-e2e" | "sentinel" | "exploratory",
  status: "pass" | "fail" | "flaky" | "skipped",
  duration_ms: number,
  exit_code: number,
  summary: string,
  log_path: string,
  emitted_at: string   // ISO 8601
}
```

#### `run_summary` — emitted after all shards complete

```typescript
{
  event: "run_summary",
  run_id: string,
  commit: string,
  branch: string,
  total_shards: number,
  complete: number,
  failed: number,
  skipped: number,
  flaky_shards: string[],   // test_file slugs
  failed_shards: string[],
  duration_ms: number,
  emitted_at: string
}
```

#### `gate_result` — lightweight inline events (emitted by CI gate job)

```typescript
{
  event: "gate_result",
  run_id: string,
  commit: string,
  branch: string,
  status: "pass" | "fail",
  tests_run: number,
  failures: string[],
  duration_ms: number
}
```

### 6.2 Communication Channels

| Channel | Path / Destination | Retention |
|---------|--------------------|-----------|
| JSONL append log | `tests/.e2e-results.jsonl` | Local disk; rotate at start of new run |
| MCP roadmap log | `mcp_ops` — run summary posted after completion | DB-backed |
| GitLab artifact | Full JSONL + manifest + per-shard logs | 7-day expiry |
| Stdout | Human-readable per-shard status line | Terminal session |

---

## 7. Coverage Review Matrix (AC-6)

Matrix reviewed **quarterly** or after any surface-adding proposal.

### 7.1 Matrix (5 axes × 4 categories)

| Axis | Gate | Background E2E | Sentinel | Exploratory |
|------|------|----------------|----------|-------------|
| **User flows** — proposal lifecycle create→complete | Thin happy-path test | Full multi-step workflow | Regression tests for confirmed bugs | Spike for new flow variants |
| **Interfaces** — MCP, REST, pg_notify | Endpoint smoke tests | Cross-interface orchestration | Specific broken-interface regressions | Protocol edge cases |
| **Workflow states** — transitions, maturity, lease | State-machine unit tests | Long-running transition sequences | State-corruption regression tests | Invalid-state spike tests |
| **Failure modes** — auth fail, timeout, DB unavail | Error-path unit tests | Orchestrated failure injection | Confirmed failure-mode regressions | Failure hypothesis tests |
| **Persistence** — manifest, JSONL, DB durability | DB write/read unit tests | Full durability under load | Data-loss regression tests | Storage edge-case spikes |
| **Branch/worktree behavior** | Worktree path unit tests | Multi-worktree orchestration | Worktree merge regression tests | Experimental branch scenarios |

### 7.2 Priority Gaps (at P236 completion)

| # | Gap | Affected tiers | Priority |
|---|-----|----------------|----------|
| 1 | `gate_pipeline` end-to-end execution | gate (missing) | High |
| 2 | Agent spawn + briefing cycle | gate (missing) | High |
| 3 | `pg_notify` stream delivery | gate (missing) | High |
| 4 | Lease expiry mid-task | gate (missing) | Medium |
| 5 | DB connection lost during operation | gate + background-e2e (both missing) | Medium |
| 6 | Concurrent agent writes (race) | gate + background-e2e (both missing) | Medium |
| 7 | Shard manifest + result JSONL durability | exploratory (P236 deliverable) | Low (tracked) |

---

## 8. Key Files Reference

| Path | Purpose |
|------|---------|
| `scripts/e2e-supervisor.js` | Background E2E supervisor *(implementation pending)* |
| `tests/.e2e-manifest.json` | Run manifest (created on first run) |
| `tests/.e2e-results.jsonl` | Append-only result event log |
| `tests/.e2e-flake-history.jsonl` | Per-shard exit code history for flake detection |
| `tests/.e2e-logs/<name>.log` | Per-shard stdout/stderr |
| `.gitlab-ci.yml` | CI pipeline (gate stage wiring: pending) |

---

## 9. Acceptance Criteria Verification

| AC | Status | Evidence |
|----|--------|----------|
| AC-1: 7-dimension quality rubric | ✅ PASS | Section 2; pass/warn/fail per dimension; gate requires all-pass |
| AC-2: 4-tier category system with promotion/demotion rules | ✅ PASS | Section 3; annotations, promotion table, demotion triggers |
| AC-3: Merge gate rules — fast, deterministic, surface-scoped | ✅ PASS | Section 4; 4 CI stages, 13 min budget, surface scoping via mirror convention |
| AC-4: Resumable background e2e supervisor | ✅ PASS | Section 5; manifest schema, resume semantics, flake tracker |
| AC-5: Result event payload and communication path | ✅ PASS | Section 6; 3 event types, 4 channels, schemas |
| AC-6: Coverage review matrix | ✅ PASS | Section 7; 25-cell matrix, 7 priority gaps |

---

## 10. Implementation Notes

- **Supervisor script** (`scripts/e2e-supervisor.js`) and **CI gate wiring** are the two
  outstanding implementation items. P236 delivered the specification; a follow-on
  implementation proposal should track the actual script authoring and CI job update.
- **Gate list maintenance:** the ≤ 60-file target must be verified at each major proposal
  that adds new surface area. Assign gate-list review to the gating agent for that proposal.
- **Flake response SLA:** Any gate-tier test breaching the 2% flake threshold over 30 runs
  must be demoted within the same sprint — do not let flaky gate tests erode CI signal.
