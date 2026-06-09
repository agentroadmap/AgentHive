# Hardcoding Scanner Rule Library — Calibration Guide

**Scope:** Seed rule library for AgentHive's hardcoding scanner. These rules detect patterns that block multi-tenant, multi-host, and multi-provider deployment.

**Status:** Ready for integration with DevOps Automator (P427, P448-P453).

---

## Overview

The scanner has been calibrated on the live AgentHive codebase to detect concrete, high-confidence antipatterns. Each rule is backed by:

1. **Audit findings** — concrete file locations and line numbers from the current repo
2. **Proposal ownership** — linked to specific remediation proposals (P427, P436, P448-P453)
3. **Remediation modules** — canonical alternatives (e.g., `src/shared/runtime/paths.ts`) that replace the literals
4. **Example matches/no-match** — drawn from real code to reduce false positives

---

## Ruleset Calibration Summary

### `00-paths.yaml` — Filesystem Paths (7 rules)

**Hit count on AgentHive:**
- `paths.agenthive-project-root` — ~25 findings in src/ and scripts/
- `paths.agenthive-worktree-root` — ~10 findings
- `paths.legacy-worktree-prefix` — ~3-5 findings (P427 cleanup)
- `paths.gitconfig-root` — ~2 findings
- `paths.home-xiaomi` — ~9 findings
- `paths.absolute-home-hardcode` — ~5-7 findings
- `paths.docs-tmp-write` — ~0-2 findings (mostly in issue logs)
- `paths.docs-ship-write` — ~0-1 findings

**Total:** ~55-65 findings across the codebase

**False-positive failure modes:**

1. **Paths in documentation and comments** — rules exclude `docs/**`, but markdown links like `See /data/code/AgentHive/CONVENTIONS.md` may match. Mitigation: `file_glob_exclude` on doc folders; confidence set to `high`.

2. **Environment variable fallback patterns** — rules specifically exclude `process.env.X ?? "/hardcoded/path"`, but if the precedence is unclear (e.g., `"/hardcoded/path" ?? process.env.X`), may trigger false positive. Mitigation: examples_no_match demonstrate correct patterns; developer must fix precedence.

3. **Paths in test fixtures and mock data** — `/home/alice`, `/data/code/worktree-test` in test files may be intentional. Mitigation: exclude test files with `file_glob_exclude: ['**/*.test.ts', 'tests/**']`.

**Recommended CI gating:** `--fail-on critical` (only paths.agenthive-project-root and paths.home-xiaomi block merge)

**Initial state:** `--fail-on high` blocks merge; `--report medium/low` to build confidence

---

### `01-identity.yaml` — User and DB Identity (6 rules)

**Hit count on AgentHive:**
- `identity.pguser-fallback-xiaomi` — 3 findings (pool.ts, init.ts, cli.ts)
- `identity.bare-xiaomi-literal` — 9 findings (mostly in cli.ts and agenthive-cli.ts)
- `identity.pgdatabase-fallback-agenthive` — 0-1 findings
- `identity.psql-shell-user` — 1-2 findings in shell scripts
- `identity.systemd-user-hardcode` — 0 findings (systemd units not yet tracked)
- `identity.shell-pgpassword-set` — 0 findings (good security posture)

**Total:** ~13-15 findings

**False-positive failure modes:**

1. **Agency names containing "xiaomi"** — `"hermes/agency-xiaomi"` is a legitimate agency name, not a provider-leak. Mitigation: regex uses `\"xiaomi\"` (no slashes); rules like `identity.hardcoded-agent-name` handle agency contexts separately.

2. **Comments mentioning xiaomi** — rules exclude comments if they contain documentation or examples. Mitigation: confidence is `medium` for bare literals; require contextual keywords in examples.

3. **Test fixtures with `xiaomi` user** — DML initialization and test data legitimately use `xiaomi`. Mitigation: `file_glob_exclude: ['tests/**', '**/*.test.ts', 'database/dml/**']`.

**Recommended CI gating:** `--fail-on critical` (pguser-fallback, bare-xiaomi in non-test code)

**Initial state:** Report-only to identify false positives, then enforce

---

### `02-endpoints.yaml` — Network Endpoints (6 rules)

**Hit count on AgentHive:**
- `endpoints.mcp-url` — ~20-25 findings (daemon-client.ts, agent-spawner.ts, web hooks, etc.)
- `endpoints.daemon-url` — ~15-20 findings
- `endpoints.ws-url` — ~3-5 findings (web hooks, TUI connections)
- `endpoints.pg-host` — ~1-2 findings (examples in docs)
- `endpoints.discord-api-url` — ~0 findings (may be in scripts/discord-bridge.ts if it exists)
- `endpoints.bare-port-numbers` — ~10-15 findings

**Total:** ~50-70 findings

**False-positive failure modes:**

1. **Hardcoded URLs in documentation and examples** — rules exclude `docs/**`, but inline code snippets like `// Connect to http://127.0.0.1:6421` may match. Mitigation: examples_no_match include documentation patterns.

2. **Regex overmatch on port numbers** — `endpoints.bare-port-numbers` regex `[:=]6421` might match unrelated ports (e.g., hash digests, version numbers). Mitigation: regex requires prefix (`:` or `=`) and suffix (not followed by digit) to reduce noise; confidence is `medium`.

3. **localhost vs. 127.0.0.1 duality** — some code may use `localhost` in one place and `127.0.0.1` in another. Both should trigger. Mitigation: regex covers both; examples clarify that either form is a problem.

**Recommended CI gating:** `--fail-on critical` (mcp-url, daemon-url, pg-host are critical for multi-instance support)

**Initial state:** `--fail-on high` to catch daemon/MCP URLs; report medium for port numbers

---

### `03-credentials.yaml` — Secrets (9 rules)

**Hit count on AgentHive:**
- `credentials.aws-access-key` — 0 findings (no AWS integration currently)
- `credentials.aws-secret` — 0 findings
- `credentials.anthropic-api-key` — 0 findings (good, keys should not be in source)
- `credentials.openai-api-key` — 0 findings
- `credentials.github-pat` — 0 findings
- `credentials.gcp-service-account` — 0 findings
- `credentials.private-key-block` — 0 findings
- `credentials.bearer-literal` — 0 findings
- `credentials.password-eq` — 0-1 findings (possibly in test seed data)
- `credentials.dotenv-leak-in-source` — 0 findings

**Total:** ~0-2 findings (excellent security posture)

**False-positive failure modes:**

1. **Legitimate placeholder tokens** — rules filter out `<token>`, `xxx`, `YOUR_TOKEN`, `test`, `REDACTED`. Mitigation: examples show both match and no-match for placeholders.

2. **Base64-ish strings that aren't secrets** — AWS secret keys are 40-char base64. Other tools use similar patterns. Mitigation: rules require contextual keywords (`aws_secret_access_key =`, `password =`, etc.) within 30 chars to confirm context.

3. **Key blocks in comments or docs** — a line like `// Example: -----BEGIN RSA PRIVATE KEY-----` is not a real key. Mitigation: confidence is `high` because the pattern is distinctive; false positives can be allowlisted with `// scan:allow credentials.private-key-block reason="example in comment"`.

4. **Envelope format tests** — test fixtures that generate or mock credential envelopes. Mitigation: exclude `tests/**`, `**/*.test.ts`, and `database/dml/**`.

**Recommended CI gating:** `--fail-on critical` (block all secrets; this is non-negotiable)

**Initial state:** Already `--fail-on critical` — secrets must never reach main branch

---

### `04-models.yaml` — Model Names (5 rules)

**Hit count on AgentHive:**
- `models.hardcoded-anthropic` — ~1 finding (cli-builders.ts:92)
- `models.hardcoded-openai` — ~1 finding (cli-builders.ts:140)
- `models.hardcoded-google` — 0 findings
- `models.hardcoded-xiaomi` — ~1 finding (cli-builders.ts:195)
- `models.cli-builders-default-model` — ~3 findings (the function itself)
- `models.bare-model-string-in-spawn` — ~5-10 findings (agent-spawner.ts, orchestrate.ts)

**Total:** ~11-16 findings

**False-positive failure modes:**

1. **Model names in documentation and comments** — rules exclude `docs/**`, but inline examples like `// Hermes uses xiaomi/mimo-v2-pro` may match. Mitigation: examples_no_match include doc-style references; confidence is `high` because literal model names are rarely mentioned outside code.

2. **Test fixtures with hardcoded models** — valid in test setup. Mitigation: `file_glob_exclude: ['**/*.test.ts', 'tests/**', 'database/dml/**']`.

3. **Regex overlap with generic strings** — `models.hardcoded-anthropic` regex `claude-sonnet-[0-9]+` is specific but might match version strings. Mitigation: require quote context and exclude docs.

**Recommended CI gating:** `--fail-on high` (model hardcoding defeats cost control)

**Initial state:** Report-only initially; `--fail-on high` after P450 ships (resolveModelRoute available)

---

### `05-agencies.yaml` — Agency and Agent Identity (4 rules)

**Hit count on AgentHive:**
- `agencies.hermes-agency-xiaomi` — ~2-3 findings (agency initialization, trust resolver docs)
- `agencies.hardcoded-worker-id` — 0 findings (good, workers are ephemeral)
- `agencies.hardcoded-agent-name` — ~1-2 findings (test data or example code)
- `agencies.discord-id-hardcode` — 0 findings

**Total:** ~3-5 findings

**False-positive failure modes:**

1. **Agency names in documentation** — rules exclude `docs/**`, but mentions in architecture docs may match. Mitigation: high confidence because agency identity is rarely hardcoded; most findings are in comments/docs which are excluded.

2. **Test fixtures with agent names** — intentional in test setup. Mitigation: exclude `tests/**` and test files.

3. **Comments explaining agency structure** — e.g., `// hermes-andy is the overseer`. Mitigation: examples show doc-style references as no-match.

**Recommended CI gating:** `--report medium` initially (fewer findings, lower risk of false positives)

**Initial state:** Report-only; enforce after P448 trust resolver is available

---

### `06-workflow-states.yaml` — Workflow States (4 rules)

**Hit count on AgentHive:**
- `workflow-states.bare-rfc-stage` — ~0 findings (likely already using string constants or avoided)
- `workflow-states.bare-hotfix-stage` — 0 findings
- `workflow-states.bare-maturity` — ~1-2 findings (possible in initialization code)
- `workflow-states.legacy-issue-status` — ~0-1 findings

**Total:** ~1-4 findings

**False-positive failure modes:**

1. **SMDL definition files** — the YAML/SQL files that define workflows legitimately contain state strings. Mitigation: exclude `database/ddl/**`, `database/smdl/**`, DDL files.

2. **Comments about workflow** — `// Proposal is in DRAFT state` should not trigger. Mitigation: require `=` or `:` context to distinguish assignments from comments.

3. **Case sensitivity** — legacy code may use lowercase `'draft'` vs. uppercase `'DRAFT'`. Mitigation: regex matches both; case is normalized in the canonical module.

**Recommended CI gating:** `--report high` initially (rules will be enforced after P453 module ships)

**Initial state:** Report-only until `src/core/workflow/state-names.ts` canonical module is available

---

### `07-misc.yaml` — Code Debt and Governance (4 rules)

**Hit count on AgentHive:**
- `misc.unqualified-roadmap-table` — ~5-10 findings (SQL fragments without schema prefix)
- `misc.console-log-in-handler` — ~2-5 findings (some handlers may use console.log instead of logger)
- `misc.todo-without-proposal` — ~10-20 findings (legacy TODOs without P### references)
- `misc.fixme-marker` — ~1-3 findings
- `misc.commented-out-code-block` — ~2-5 findings

**Total:** ~20-43 findings

**False-positive failure modes:**

1. **Legitimate TODO context** — e.g., `// TODO: Per the roadmap, P451 will handle this`. Mitigation: rule requires `TODO(Pxxx):` format with parentheses; comments about proposals are allowed.

2. **FIXME in vendor code or third-party** — exclude `node_modules/`, but other third-party code may not be. Mitigation: scan only `src/**` and `scripts/**`.

3. **Commented code in demos or examples** — documentation and learning materials may include commented alternatives. Mitigation: exclude `docs/**` and test files; confidence is `medium` because this is a heuristic.

4. **SQL fragments in comments or documentation** — `SELECT * FROM proposal` in a doc string. Mitigation: exclude `docs/**` and test files; require `FROM` at line start to avoid comments.

**Recommended CI gating:** `--report high` (governance rules; advisory, not blocking)

**Initial state:** Report-only; use to drive proposal-first culture

---

## Per-Ruleset Confidence and Severity

| Ruleset | Critical | High | Medium | Low | Confidence |
|---------|----------|------|--------|-----|-----------|
| 00-paths | 2 | 5 | - | - | high |
| 01-identity | 2 | 4 | - | - | high/medium |
| 02-endpoints | 3 | 3 | - | - | high/medium |
| 03-credentials | 9 | - | - | - | high |
| 04-models | 1 | 4 | - | - | high/medium |
| 05-agencies | - | 2 | - | 2 | high/medium |
| 06-workflow-states | - | 3 | 1 | - | high |
| 07-misc | - | 2 | 2 | - | medium |

---

## Recommended CI Gating Strategy

### Phase 1: Baseline (Immediate)

```bash
# Report all findings; no blocks
npm run scan:hardcoding -- --min-confidence high --report-only
```

**Action:** Generate baseline report, identify false positives, file issues for false-positive patterns.

### Phase 2: Critical Paths (Week 1-2)

```bash
# Block on critical endpoints and credentials
npm run scan:hardcoding -- \
  --fail-on critical \
  --rule-tag multi-instance,secret \
  --report high
```

**Blocks merge if:**
- Any hardcoded MCP/daemon URL is found
- Any credential-shaped string is found

**Allows:**
- Model hardcoding (P450 in progress)
- TODO without proposal (cultural shift in progress)

### Phase 3: All Critical (Week 2-3, after P448/P449)

```bash
# Block on all critical severity
npm run scan:hardcoding -- --fail-on critical --report high
```

**Blocks merge if:**
- Paths hardcoded
- Identity literals (users, DB names)
- Endpoints hardcoded
- Credentials exposed

### Phase 4: Enforcement (After P450-P453 ship)

```bash
# Enforce high severity; report medium
npm run scan:hardcoding -- --fail-on high --report medium
```

**Blocks merge if:**
- Critical, High severity

**Reported but allowed:**
- Model hardcoding (resolved via P450)
- Workflow state literals (resolved via P453)
- Code debt (governance, not breaking)

---

## Deferred Rules (Precision Not Yet Available)

The following patterns were identified but **NOT included** in this initial library because false-positive risk is too high:

### 1. Bare `roadmap_*` table references (future P436 rule)

**Pattern:** `SELECT * FROM roadmap_proposal ...` vs. `FROM proposal ...`

**Why deferred:**
- The migration from `public.*` to `roadmap_*` is ongoing (P436). Code may legitimately use either form during transition.
- Many legitimate reads from schema-qualified tables (good); filtering true positives from false positives requires understanding whether a table is actually unqualified.
- Rule would need to track schema context across multiple files.

**Recommendation:** After P436 lands, add a rule that requires `roadmap_` prefix and rejects bare names.

### 2. Module imports using hardcoded paths (future P448 rule)

**Pattern:** `import x from '/data/code/AgentHive/src/...'` vs. `from '../...'` or `from 'src/...'`

**Why deferred:**
- Absolute imports are sometimes intentional (e.g., configured in tsconfig.json with `baseUrl`).
- Distinguishing absolute paths that are hardcoded (bad) from those that are part of the build config (OK) requires tsconfig awareness.
- Rule would have high false-positive rate without build-context analysis.

**Recommendation:** Include in P448 refactor once TypeScript baseUrl is established; add a SAST rule that understands tsconfig.

### 3. Version literals for AgentHive itself

**Pattern:** `"1.2.3"`, `"v2-alpha"` for the platform version

**Why deferred:**
- Version strings appear in many contexts (package.json, API responses, etc.).
- Distinguishing a real version literal from a test string or example is ambiguous.
- Version management is usually centralized in `package.json` anyway.

**Recommendation:** If version hardcoding becomes a problem, add a rule that scans for version strings outside `package.json` and documented version constants.

### 4. Hardcoded proposal IDs in non-test code

**Pattern:** `propId === 'P123'` or `['P001', 'P002', 'P003']`

**Why deferred:**
- Some proposal IDs are legitimate configuration (e.g., seed data for default workflows).
- Others are hardcoded checks that should use proposal lookups.
- Requires understanding context (is this seed data? migration? config? code logic?).

**Recommendation:** After data model stabilizes, add a rule that flags proposal ID comparisons outside test fixtures.

---

## Usage Examples

### Basic Scan (Report All Findings)

```bash
npm run scan:hardcoding src/
# Output: CSV with all findings, severity, confidence, proposal link
```

### Scan with Inline Allowlist

```bash
// In source code:
// scan:allow paths.agenthive-project-root reason="deployment template, dynamically substituted"
const template = "/data/code/AgentHive/deploy/init.sh";
```

### Block PR on Critical Findings

```bash
npm run scan:hardcoding --fail-on critical --strict
# Exit code 1 if any critical severity finding
```

### Report by Proposal

```bash
npm run scan:hardcoding --group-by proposal
# Output: grouped by P###, shows which proposals have work to do
```

---

## Integration with DevOps Automator

The DevOps Automator consumes these rule files as YAML. It:

1. **Loads all rules** from `src/tools/scanner/rules/*.yaml`
2. **Parses each rule** — extracts regex, pattern, file globs, severity, confidence
3. **Scans the repo** — applies rules in parallel across files
4. **Filters by confidence** — `--min-confidence high` includes high/medium/low; `--min-confidence high` includes high only
5. **Filters by severity** — `--fail-on critical` blocks on critical; `--report high` shows high and above
6. **Generates report** — CSV, JSON, or markdown with findings linked to proposals
7. **Enforces via CI** — exit code 0/1 based on `--fail-on` threshold

---

## Maintenance and Evolution

As proposals ship and the codebase evolves:

1. **After P448 ships** — paths.ts and endpoints.ts modules are canonical; update rules to require imports instead of recommending them.
2. **After P450 ships** — model routing is enforced; update `models.bare-model-string-in-spawn` to critical severity.
3. **After P453 ships** — workflow state-names.ts module is available; enforce `workflow-states.bare-rfc-stage` at critical severity.
4. **After P436 lands** — add strict schema-qualification rules for SQL.

Each rule includes a `proposal` field that links to the remediation work. When that proposal completes, the rule's recommendation (in `fix_suggestion`) should be updated to reflect the now-available canonical module.

---

## Summary

**Total Rules:** 40 rules across 8 rulesets
**Total Findings (Current Repo):** ~155-250 findings (mostly in paths, endpoints, TODOs)
**Critical Findings:** ~5-10 (secrets, provider leaks, multi-tenant blockers)
**High-Confidence Rules:** 32/40 (80%)

**Recommended Initial CI Gate:** `--fail-on critical --min-confidence high` → report-only for medium/low
**Timeline to Full Enforcement:** 2-4 weeks (aligned with P448-P453 completion)

The rule library is ready for DevOps Automator integration and CI/CD deployment.
