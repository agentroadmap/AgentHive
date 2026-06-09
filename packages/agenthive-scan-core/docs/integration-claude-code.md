# Integration: Claude Code Agent

This guide shows how to integrate the hardcoding scanner into Claude Code workflows.

## Quick Start

1. Install the scanner:

```bash
npm install -g @agenthive/scan-core @agenthive/scan-rules-secrets
npm install -g @agenthive/scan-rules-multi-tenant @agenthive/scan-rules-workflow-states
```

2. Run a scan in a Bash tool:

```javascript
// Claude Code agent code
const result = await bash("scan-hardcoding --format jsonl --git-changed > /tmp/findings.jsonl");
const findings = readFileSync("/tmp/findings.jsonl", "utf-8")
  .split("\n")
  .filter(line => line.trim())
  .map(line => JSON.parse(line));
```

3. Apply fixes:

```javascript
for (const finding of findings) {
  console.log(`${finding.rule}: ${finding.file}:${finding.line}`);
  console.log(`Fix: ${finding.fix}`);
  // Claude Code agent uses this information to apply the fix
}
```

## Workflow: Hardcoding Fix Run

### Phase 1: Scan

Run the scanner to collect findings:

```bash
scan-hardcoding --format jsonl --git-changed > /tmp/findings.jsonl
```

Options:
- `--git-changed`: Only scan files changed since main
- `--git-staged`: Only scan staged files
- `--min-severity high`: Filter to high+ severity
- `--baseline <file>`: Compare against baseline; exit 0 if no NEW findings

### Phase 2: Triage (Agent Decision)

For each finding, decide:

1. **Auto-fix**: If `auto_fix` field is present, apply the fix engine (Phase 3 only; Phase 0-2 requires manual fix).
2. **Manual fix**: Read `fix` field and apply manually.
3. **Suppress**: Add to `.scanignore.yaml` or inline suppress comment.
4. **Acknowledge debt**: Mark finding as intentional via `acknowledged_debt` comment.

### Phase 3: Verify Progress

Re-run the scan to confirm fixes:

```bash
scan-hardcoding --format jsonl --git-changed > /tmp/findings-after.jsonl
# Compare finding counts or use baseline mode:
scan-hardcoding --baseline /tmp/findings-before.jsonl --fail-on high
```

## Suppression Patterns

### Inline Suppression (Single Line)

```typescript
// scan:allow credentials.aws-key reason="Test fixture, not a real key"
const testKey = "AKIAIOSFODNN7EXAMPLE";
```

### Block Suppression (Multiple Lines)

```typescript
/* scan:allow-block paths.agenthive-worktree-root reason="Legacy integration test setup" */
const testRoot = "/data/code/worktree";
const testPath = path.join(testRoot, "test-file.txt");
// ... more code
/* scan:end-allow */
```

### Allowlist File (Project-Wide)

Create `.scanignore.yaml`:

```yaml
# Ignore specific rules in specific files
paths.worktree-root:
  - "tests/fixtures/*.ts"
  - "src/legacy/**/*"

# Ignore rules by tag
- tag: test-fixtures
  reason: "Test data, not production code"
  files:
    - "tests/**/*"
```

## Fix Suggestion Integration

Each finding includes a `fix` field with human-readable guidance:

```json
{
  "rule": "paths.agenthive-worktree-root",
  "fix": "Replace with getWorktreeRoot() from src/shared/runtime/paths.ts; add import.",
  "auto_fix": {
    "transform": "path-replace",
    "target_module": "src/shared/runtime/paths.ts",
    "target_export": "getWorktreeRoot"
  }
}
```

The Claude Code agent reads these suggestions and applies fixes accordingly.

## Baseline Mode for CI Gating

Use baseline comparison to track progress during a migration:

```bash
# On clean state, emit baseline
scan-hardcoding --emit-baseline .baseline-current.jsonl

# Later, in CI:
scan-hardcoding --baseline .baseline-current.jsonl
# Exits 0 if no NEW findings (resolved findings don't count)
# Exits 1 if NEW findings exist
```

This is useful for:
- Gating PRs during a multi-week hardcoding remediation campaign
- Tracking progress without blocking on total findings
- Rolling back to a known state if regressions occur

## Error Handling

### No findings (clean run)

```bash
$ scan-hardcoding --format jsonl
$ echo $?
0
# No output, exit code 0
```

### Findings exceed severity threshold

```bash
$ scan-hardcoding --format jsonl --fail-on high
# Output JSONL records
$ echo $?
1
# If any finding has severity >= high
```

### Rule load error

```bash
$ scan-hardcoding --rules /nonexistent
Rule load errors:
  /nonexistent: ENOENT
# Exits 1 if NO rules loaded successfully
```

## Performance Notes

- Typical scan: 2000 files → 5 seconds (depends on regex complexity)
- JSONL output is streaming; large finding sets are line-delimited for memory efficiency
- Use `--git-changed` to reduce file count on incremental runs
- `--concurrency <n>` controls parallelism (default: CPU count)

## Next Steps

- See `jsonl-schema.md` for full JSONL field documentation
- See `rule-authoring.md` for creating custom rules
- See `../../rules-agenthive/` for AgentHive-specific rules
