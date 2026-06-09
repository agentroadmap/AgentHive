# @agenthive/scan-core

Generic hardcoding scanner engine and CLI core. This package provides the scanning engine, output formatting, and allowlist handling. **It ships with no rules bundled** — import rule packs separately.

## Quick Start

```bash
npm install -g @agenthive/scan-core @agenthive/scan-rules-secrets
scan-hardcoding --format jsonl
```

## Usage

```
scan-hardcoding [paths...] [options]

Options:
  --rules <dir>              Rule directory (default: built-in rules)
  --rule <id>                Run only this rule (repeatable)
  --rule-tag <tag>           Run only rules with this tag
  --min-confidence <lvl>      Minimum confidence (high|medium|low)
  --min-severity <lvl>       Minimum severity (critical|high|medium|low)
  --format <fmt>             Output format (human|jsonl|sarif|mcp)
  --out <file>               Write findings to file
  --fail-on <severity>       Exit code 1 if findings >= severity
  --allowlist <file>         Custom allowlist YAML
  --baseline <file>          Compare against baseline; exit 0 if no NEW findings
  --emit-baseline <file>     Write current findings to baseline file
  --self-test                Run examples_match/examples_no_match for all rules
  --list-rules               Print all loaded rules
  --git-changed              Scan only files changed since main
  --git-staged               Scan only git staged files
  --concurrency <n>          File-walk parallelism (default: CPU count)
```

## Rule Packs

- **@agenthive/scan-rules-secrets** — AWS, GCP, Anthropic, OpenAI, GitHub tokens, bearer tokens, .env
- **@agenthive/scan-rules-multi-tenant** — hardcoded paths, identities, endpoints
- **@agenthive/scan-rules-workflow-states** — RFC states, hotfix/maturity markers
- **@agenthive/scan-rules-agenthive** — AgentHive-specific (model names, agencies, cubic paths)

## Output Formats

### JSONL (Line-Delimited JSON)

```json
{"schema_version":1,"rule":"paths.worktree-root","file":"src/app.ts","line":5,"col":10,"severity":"high","confidence":"high","proposal":"P448","match":"/data/code/worktree","snippet":"...","fix":"...","tags":["paths","multi-tenant"],"acknowledged_debt":false,"context_before":["..."],"context_after":["..."]}
```

Schema defined at `schema/findings.schema.json`.

### Human (default)

Formatted text with color support for severity levels.

### SARIF

Standard OASIS format for CI/CD integration.

### MCP

Emits into AgentHive's proposal event system (requires mcp_scan tool).

## Baseline Comparison

For CI gating during migrations:

```bash
# Generate baseline on clean state
scan-hardcoding --emit-baseline .baseline-clean.jsonl

# Later, compare against baseline; exit 0 if no NEW findings
scan-hardcoding --baseline .baseline-clean.jsonl
```

## Integration with AI Agent CLIs

### Claude Code

```bash
scan-hardcoding --format jsonl --git-changed > /tmp/findings.jsonl
# Agent reads /tmp/findings.jsonl and applies fixes
```

### AgentHive MCP

Use the `mcp_scan` tool to emit findings into proposal events.

## API

```typescript
import { runScan, loadRules } from "@agenthive/scan-core";

const { rules } = await loadRules("./rules");
const result = await runScan({ /* config */ }, rules);
```

See `src/index.ts` for full export API.

## License

MIT
