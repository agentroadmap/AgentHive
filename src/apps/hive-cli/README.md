# hive CLI Framework

This is the composition root and common framework for the `hive` CLI. It's command-agnostic; all domain-specific logic lives in `domains/` modules.

## Architecture

- **index.ts** — Main entry point. Wires up Commander, global flags, and the root program.
- **common/** — Shared utilities:
  - `exit-codes.ts` — Exit code enum + mapping per contract §3
  - `error.ts` — Typed error class (HiveError)
  - `envelope.ts` — JSON envelope builder per contract §2
  - `context.ts` — Context resolver (project/agency/host) per contract §5
  - `formatters.ts` — Output formatters (text, json, jsonl, yaml, sarif)
  - `discovery.ts` — Schema registry for `--schema` and `--recipes`
- **domains/** — One directory per domain (proposal, workflow, agency, etc.)
  - Each domain exports a `register(program)` function
  - Function wires up subcommands and returns them to the framework
- **bin/hive** — Executable shim (routes to dist or jiti loader)

## Adding a New Command (Round 3)

### Step 1: Copy the template

```bash
cp src/apps/hive-cli/domains/_template.ts src/apps/hive-cli/domains/MY_DOMAIN/index.ts
```

### Step 2: Replace placeholders

Edit `domains/MY_DOMAIN/index.ts`:

1. Set `DOMAIN_NAME` (lowercase noun, e.g., "proposal")
2. Set `DOMAIN_DESCRIPTION`
3. Update `domainSchema` with your actual commands, parameters, flags
4. Implement command handlers (replace `handleList`, `handleGet`, etc.)
5. Register recipes (optional, but recommended for complex workflows)

Example:

```typescript
const DOMAIN_NAME = "proposal";
const DOMAIN_DESCRIPTION = "Proposal CRUD and lifecycle management";

const domainSchema: DomainSchema = {
  name: DOMAIN_NAME,
  subcommands: [
    {
      name: "create",
      signature: "hive proposal create",
      description: "Create a new proposal",
      parameters: [
        { name: "type", type: "string", required: true, example: "feature" },
      ],
      flags: [
        { name: "title", type: "string", description: "Proposal title" },
        { name: "stdin", type: "boolean", description: "Read body from stdin" },
      ],
      // ... output schema, etc.
    },
    // ... more subcommands
  ],
};
```

### Step 3: Implement command handlers

Replace the stub handlers with real logic. Command handlers:

- Take arguments + options from Commander
- Call MCP or control-plane DB (via `src/apps/hive-cli/common/mcp-client.ts` and `control-plane-client.ts` — these are stubs you'll coordinate with MCP Builder and Backend Architect)
- Return JSON-serializable data (the framework formats it)
- Throw `HiveError` on failure (the framework catches and formats it)

Example:

```typescript
async function handleCreate(options: Record<string, unknown>) {
  const { type, title, stdin } = options;

  if (!type || !title) {
    throw Errors.usage("Missing required flags: --type, --title");
  }

  // Call MCP to create proposal
  const proposal = await mcpClient.createProposal({
    type,
    title,
    body: stdin ? readStdin() : "",
  });

  return proposal;
}
```

### Step 4: Register the domain

In `index.ts`, after domain module exports are ready:

```typescript
// At the top of hive-cli/index.ts
import { register as registerProposal } from "./domains/proposal/index";

// In main() or during program setup
registerProposal(program);
```

### Step 5: Test

Run locally during development:

```bash
node --import jiti/register src/apps/hive-cli/index.ts proposal list --format json
```

## Global Flags (Automatically Inherited)

All commands support:

- `--format text|json|jsonl|yaml|sarif` — Output format (auto-detects TTY for default)
- `--quiet` — Suppress output (exit code only)
- `--explain` — Show resolved context + elapsed time
- `--yes` — Skip confirmation prompts (for destructive ops)
- `--really-yes` — Skip confirmation for panic ops (e.g., freeze global budget)
- `--idempotency-key <uuid>` — For mutations; prevents duplicate work on retry
- `--limit <N>` — Pagination limit (default: 20)
- `--cursor <token>` — Pagination cursor (from previous `next_cursor`)
- `--filter <expr>` — Filter expression (command-specific)
- `--fields <names>` — Comma-separated field names
- `--include <relations>` — Expand relations (repeatable)
- `--schema` — Show schema for this command and exit
- `--project <slug>` — Override project context
- `--agency <identity>` — Override agency context
- `--host <hostname>` — Override host context

## Output Contract

Every command response is wrapped in a JSON envelope (per contract §2):

```json
{
  "schema_version": 1,
  "command": "hive proposal list",
  "context": {
    "project": "agenthive",
    "agency": "hermes/agency-xiaomi",
    "host": "hermes",
    "resolved_at": "2026-04-25T14:30:00Z"
  },
  "ok": true,
  "data": [
    { "id": "P123", "title": "...", "state": "DRAFT" }
  ],
  "warnings": [],
  "next_cursor": null,
  "elapsed_ms": 234
}
```

Errors are wrapped similarly:

```json
{
  "schema_version": 1,
  "command": "hive proposal claim P999",
  "context": { ... },
  "ok": false,
  "error": {
    "code": "NOT_FOUND",
    "message": "Proposal P999 does not exist",
    "hint": "Run `hive proposal list` to see available IDs",
    "detail": { "proposal_id": "P999" },
    "retriable": false,
    "exit_code": 2
  },
  "warnings": [],
  "elapsed_ms": 87
}
```

## Testing Your Domain

### Unit tests (for domain logic)

Create `src/test/hive-cli-MY_DOMAIN.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert";
import { handleCreate } from "../apps/hive-cli/domains/proposal/index";

test("proposal create with missing title throws USAGE error", async () => {
  try {
    await handleCreate({ type: "feature" });
    assert.fail("Expected error");
  } catch (err) {
    assert.equal(err.code, "USAGE");
  }
});
```

### Integration tests

Call the CLI as a subprocess:

```typescript
import { spawn } from "child_process";

const proc = spawn("node", [
  "--import",
  "jiti/register",
  "src/apps/hive-cli/index.ts",
  "proposal",
  "list",
  "--format",
  "json",
]);

let output = "";
proc.stdout.on("data", (data) => (output += data));
proc.on("close", (code) => {
  assert.equal(code, 0);
  const envelope = JSON.parse(output);
  assert.equal(envelope.schema_version, 1);
  assert.equal(envelope.command, "hive proposal list");
});
```

## Exit Codes

All commands exit with one of these codes (per contract §3):

| Code | Meaning | Examples |
|------|---------|----------|
| 0 | SUCCESS | Command completed |
| 1 | USAGE | Invalid flags, missing args |
| 2 | NOT_FOUND | Resource doesn't exist |
| 3 | PERMISSION_DENIED | Insufficient role/permission |
| 4 | CONFLICT | State conflict, already claimed, missing --yes |
| 5 | REMOTE_FAILURE | MCP timeout, DB unreachable |
| 6 | INVALID_STATE | State machine blocks operation |
| 7 | BUDGET_EXHAUSTED | Budget cap exceeded |
| 8 | POLICY_DENIED | Host/provider policy blocks operation |
| 9 | TIMEOUT | Operation exceeded time limit |
| 10 | RATE_LIMITED | API rate limit hit |
| 11 | SCHEMA_DRIFT | CLI schema incompatible with control-plane |
| 12 | MCP_UNREACHABLE | MCP server not reachable; mutation refused |
| 13 | DB_UNREACHABLE | Database not reachable |
| 14 | ENCODING_ERROR | Invalid JSON/YAML input |
| 99 | INTERNAL_ERROR | Unexpected server error (bug) |

## References

- **Contract:** `docs/architecture/cli-hive-contract.md` (normative)
- **Design:** `docs/architecture/cli-hive-design.md` (context + examples)
- **State Names:** `src/core/workflow/state-names.ts` (P453 — load state names at runtime, never hardcode)
- **Commander.js:** https://github.com/tj/commander.js

## Round 3 Coordination

- **MCP Builder:** Implements `src/apps/hive-cli/common/mcp-client.ts` wrapper
- **Backend Architect:** Implements `src/apps/hive-cli/common/control-plane-client.ts` + control-plane DB queries
- **Code Reviewer:** Writes negative test suite for exit codes + error paths
- **API Tester:** Tests context resolution + envelope structure

## Notes for Implementers

1. **Do not hardcode state names.** Load them from control plane via P453 API.
2. **Do not modify global flags.** Each command inherits them automatically.
3. **Do not exit the process in domain modules.** Let the framework handle it.
4. **Do not swallow errors.** Throw `HiveError` with appropriate code + message.
5. **Do use the envelope for output.** The framework formats it per `--format` flag.
6. **Do test context resolution.** It's tricky; the contract has 5 precedence levels.
