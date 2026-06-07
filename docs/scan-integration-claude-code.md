# scan-hardcoding: Claude Code Integration

Claude Code agents can invoke the scanner via the Bash tool to get a structured list of hardcoding
findings without re-grepping the whole codebase.

## Quick start

```bash
# Scan only files changed on this branch
bun scripts/scan-hardcoding.ts --git-changed --format jsonl > /tmp/findings.jsonl

# Or scan everything (slower, ~5s for 2 000 files)
bun scripts/scan-hardcoding.ts --format jsonl > /tmp/findings.jsonl
```

Each line in `findings.jsonl` is a self-contained JSON object (schema_version=1):

```json
{"schema_version":1,"rule":"paths.agenthive-worktree-root","file":"src/foo.ts","line":27,"col":24,
 "severity":"high","confidence":"high","proposal":"P448","match":"/data/code/worktree",
 "snippet":"const root = \"/data/code/worktree\";","fix":"Replace with getWorktreeRoot()…",
 "tags":["paths","multi-tenant"],"acknowledged_debt":false,"context_before":["…"],"context_after":["…"]}
```

## Workflow for fixing findings

1. Run the scanner and save findings:
   ```bash
   bun scripts/scan-hardcoding.ts --git-changed --format jsonl --out /tmp/findings.jsonl
   ```

2. Read `/tmp/findings.jsonl`, group by `rule`, apply the `fix` field instruction to each file.

3. Confirm progress:
   ```bash
   bun scripts/scan-hardcoding.ts --git-changed --format jsonl | wc -l
   ```

4. Gate check (exit 1 if any `critical` or `high` findings remain):
   ```bash
   bun scripts/scan-hardcoding.ts --git-changed --fail-on high
   ```

## Baseline mode (CI / PR gate)

Capture a baseline at the start of a PR and gate on regressions only:

```bash
# Capture once
bun scripts/scan-hardcoding.ts --emit-baseline /tmp/baseline.jsonl

# Gate in CI (exit 0 only if no NEW findings since baseline)
bun scripts/scan-hardcoding.ts --baseline /tmp/baseline.jsonl
```

## Useful flags

| Flag | Description |
|------|-------------|
| `--git-changed` | Only files changed since main (fast for iterative fixes) |
| `--git-staged` | Only staged files (pre-commit hook use) |
| `--format jsonl` | Machine-readable JSONL output |
| `--format sarif` | SARIF for editor diagnostics panels |
| `--fail-on <sev>` | Exit 1 if any finding >= severity (critical/high/medium/low) |
| `--rule-tag <tag>` | Filter to one category (paths, credentials, models, …) |
| `--min-severity low` | Show all findings including low-severity |
| `--self-test` | Verify all rules' examples_match / examples_no_match |
| `--list-rules` | Print every loaded rule id and description |
| `--explain <id>` | Full detail for one rule |

## Schema contract

The JSONL output is versioned. Consumers must check `schema_version` and reject records with an
unknown major version. The JSON Schema is at `src/tools/scanner/schema/findings.schema.json`.
Breaking changes bump `schema_version`; non-breaking additions do not.

## Suppressing a false positive

Add a single-line comment to the source file:

```typescript
const url = "http://127.0.0.1:6421"; // scan:allow endpoints.mcp-url reason="test-only fixture"
```

Or use a block suppression for multi-line false positives:

```typescript
/* scan:allow-block credentials.anthropic-api-key reason="example in docs, not a real key" */
const exampleKey = "sk-ant-api03-XXXX";
/* scan:end-allow */
```

## Acknowledged debt

Tag a TODO with the proposal ID to reduce a finding's severity by one level and mark it as
`acknowledged_debt: true` in the JSONL output:

```typescript
// TODO(P448): remove this hardcoded path once getWorktreeRoot() is wired up
const root = "/data/code/worktree";
```
