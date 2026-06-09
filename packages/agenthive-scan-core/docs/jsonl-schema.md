# JSONL Output Schema

The scanner outputs line-delimited JSON (JSONL) with a versioned schema. Every record includes a `schema_version` field to allow consumers to handle schema evolution.

## Schema Version

**Current: 1** (frozen contract)

The schema_version field appears on every record. Consumers should target a range:

```javascript
if (record.schema_version !== 1) {
  throw new Error(`Unsupported schema version: ${record.schema_version}`);
}
```

Breaking changes (e.g., field removal, type change) bump the schema_version. Forward-incompatible consumers MUST check the version.

## Record Fields

All fields are required unless marked optional.

| Field | Type | Description |
|-------|------|-------------|
| schema_version | number | Schema format version (always 1) |
| rule | string | Rule ID in format "category.name" (e.g. "paths.worktree-root") |
| file | string | Relative path to file containing the finding |
| line | number | 1-indexed line number |
| col | number | 0-indexed column number within the line |
| severity | enum | `critical`, `high`, `medium`, `low` |
| confidence | enum | `high`, `medium`, `low` |
| proposal | string | Proposal ID (e.g. "P448") tied to this rule |
| match | string | The actual matched substring from the file |
| snippet | string | ~100 char context around the match |
| fix | string | Human-readable remediation suggestion |
| tags | array[string] | Rule tags (e.g. `["paths", "multi-tenant"]`) |
| acknowledged_debt | boolean | Whether the finding is suppressed via `.scanignore.yaml` or inline comment |
| context_before | array[string] | 2 lines of code before the match (max 100 chars each) |
| context_after | array[string] | 2 lines of code after the match (max 100 chars each) |
| auto_fix | object | **Optional.** Auto-fix descriptor if applicable |
| auto_fix.transform | string | Transform type: `path-replace`, `model-replace`, `state-name-replace` |
| auto_fix.target_module | string | Module path where the fix target lives |
| auto_fix.target_export | string | Named export to import for the fix |
| auto_fix.safe | boolean | Whether the fix is safe to apply automatically |

## Example Record

```json
{
  "schema_version": 1,
  "rule": "paths.agenthive-worktree-root",
  "file": "src/apps/gateway/handlers/deploy.ts",
  "line": 27,
  "col": 24,
  "severity": "high",
  "confidence": "high",
  "proposal": "P448",
  "match": "/data/code/worktree",
  "snippet": "const root = '/data/code/worktree' // hardcoded",
  "fix": "Replace with getWorktreeRoot() from @agenthive/config/paths.ts; add import.",
  "tags": ["paths", "multi-tenant"],
  "acknowledged_debt": false,
  "context_before": [
    "function deployApp() {",
    "  // Get root directory"
  ],
  "context_after": [
    "  return normalizePath(root);",
    "}"
  ],
  "auto_fix": {
    "transform": "path-replace",
    "target_module": "src/shared/runtime/paths.ts",
    "target_export": "getWorktreeRoot",
    "safe": true
  }
}
```

## JSON Schema File

A JSON Schema definition is maintained at `schema/findings.schema.json` for validation:

```bash
# Validate JSONL output against the schema
jq -e '.schema_version == 1' < findings.jsonl
```

## Consuming JSONL in Code

### Node.js Example

```javascript
import fs from "fs";
import { createReadStream } from "fs";
import { createInterface } from "readline";

const reader = createInterface({
  input: createReadStream("findings.jsonl"),
});

for await (const line of reader) {
  const finding = JSON.parse(line);
  console.log(`${finding.rule}: ${finding.file}:${finding.line}`);
}
```

### Python Example

```python
import json

with open("findings.jsonl", "r") as f:
    for line in f:
        finding = json.loads(line)
        print(f"{finding['rule']}: {finding['file']}:{finding['line']}")
```

## Versioning Policy

If the schema must evolve:

1. **Add a new field**: Always OK. Consumers ignore unknown fields.
2. **Rename a field**: Breaks schema_version. Emit BOTH old and new fields one release, then remove old field in next major version.
3. **Remove a field**: Breaks schema_version. Bump to 2.
4. **Change field type** (e.g., string → object): Breaks schema_version. Bump to 2.

Consumers SHOULD always check `schema_version` before parsing:

```javascript
const finding = JSON.parse(line);
if (finding.schema_version !== 1) {
  // Handle upgrade path or skip
  continue;
}
```

## Integration Points

- **AgentHive MCP**: mcp_scan tool emits findings into proposal_event records.
- **Claude Code**: Bash tool reads JSONL; passes line objects to fix engines.
- **CI/CD**: Parse and emit as SARIF for workflow annotations.
- **Dashboards**: Stream into websocket-fed UI panels.
