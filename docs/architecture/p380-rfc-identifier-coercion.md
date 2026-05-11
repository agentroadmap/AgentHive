# P380 — RFC Tool Identifier Type Coercion

> **Type:** bug-fix  **Status:** COMPLETE  **Source-of-truth:** Postgres `roadmap_proposal.proposal` row P380

This file documents the root cause, fix, and contract boundary introduced to resolve type crashes in the RFC MCP tools (`add_discussion`, `list_ac`, and all sibling handlers that call `parseNumericIdentifier`).

---

## Problem

Multiple RFC workflow MCP tools crashed at runtime when a client passed `proposal_id` as a JavaScript number rather than a string.  Observed errors:

| Tool | Error |
|---|---|
| `add_discussion` | `identifier.trim is not a function` |
| `list_ac` | `Cannot read properties of undefined (reading 'trim')` |

These errors surfaced in gate/review agent runs, silently blocking the entire workflow step because the crash propagated before the tool could return a structured MCP error response.

---

## Root Cause

`parseNumericIdentifier` in `src/apps/mcp-server/tools/rfc/pg-handlers.ts` called `.trim()` directly on its argument:

```typescript
// BEFORE (broken)
function parseNumericIdentifier(identifier: string): number | null {
    const trimmed = identifier.trim();  // ← throws if identifier is a number
```

Some MCP clients (and the MCP SDK itself under certain schema coercions) pass numeric `proposal_id` values as JS `number` primitives.  Numbers do not have a `.trim()` method, so the call threw immediately — before the handler could reach the DB query or return any useful error.

A secondary failure mode: `args.proposal_id` could arrive as `null` or `undefined` when schema validation is bypassed (e.g., partial tool calls from agents that omit optional-but-expected fields).

---

## Fix

A `coerceIdentifier` helper normalises the raw argument to a `string` before any string operations are applied.  This is the canonical entry-point for all identifier normalisation in the RFC handler module.

```typescript
// src/apps/mcp-server/tools/rfc/pg-handlers.ts  lines 81-96

function coerceIdentifier(identifier: string | number | null | undefined): string {
    if (identifier === null || identifier === undefined) return "";
    if (typeof identifier === "number") {
        return Number.isFinite(identifier) ? String(identifier) : "";
    }
    return identifier;
}

function parseNumericIdentifier(identifier: string | number): number | null {
    const trimmed = coerceIdentifier(identifier).trim();
    if (!/^\d+$/.test(trimmed)) {
        return null;
    }
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
}
```

`resolveProposalRecord` and `resolveProposalId` both pass their argument through `coerceIdentifier` before forwarding to `parseNumericIdentifier`, so all downstream DB queries are protected.

---

## Normalisation Contract

The following input forms are all accepted at the MCP tool boundary and resolve to the same proposal:

| `proposal_id` input | Resolved as |
|---|---|
| `"P375"` | display_id lookup |
| `"375"` | numeric id lookup |
| `375` (number) | numeric id lookup via `String(375)` |
| `null` / `undefined` | returns empty string → "not found" response |
| `Infinity` / `NaN` | returns empty string → "not found" response |

No tool panics; every path returns a structured MCP `CallToolResult`.

---

## Affected Tools

All RFC tools route through `resolveProposalId` or `resolveProposalRecord`, so the fix covers the full tool surface:

- `transition_proposal`
- `add_acceptance_criteria`
- `verify_ac`
- `list_ac`
- `delete_ac`
- `add_dependency`
- `get_dependencies`
- `submit_review`
- `list_reviews`
- `add_discussion`

---

## Contract Tests

Integration tests for these tools should assert the following at the MCP boundary, without mocking the DB:

1. **String display_id**: `proposal_id: "P375"` → resolves to the correct proposal row and returns `200 OK`-equivalent content.
2. **Numeric string**: `proposal_id: "375"` → same resolution.
3. **Number literal**: `proposal_id: 375` → same resolution (tests the coercion path explicitly).
4. **Unknown ID**: `proposal_id: "P99999"` → returns "not found" text, no exception.
5. **Null/undefined**: omitted or explicitly `null` → returns "not found" text, no exception.
6. **`list_ac` empty result**: valid proposal with no AC rows → returns "No acceptance criteria" text, no exception.
7. **`add_discussion` alias fields**: passing `discussion: "..."` instead of `content: "..."` → body stored correctly.

These tests must run against a real DB connection (not mocked) because the coercion contract includes the DB lookup, not just the string normalisation step.

---

## See Also

- `src/apps/mcp-server/tools/rfc/pg-handlers.ts` — implementation
- P156 — AC criteria normalisation (parallel fix: string vs array coercion)
- P157 — `verify_ac` required-field validation
- P521 — `submit_review` reviewer auto-registration
