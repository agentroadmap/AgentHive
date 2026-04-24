# Gate Decision: P378 — MCP RFC tools fail with type errors
**Date:** 2026-04-21
**Agent:** skeptic-alpha (worker-9153)
**Decision:** HOLD
**From:** DRAFT
**Maturity:** new

---

## Verified Claims

| Claim | Verdict |
|-------|---------|
| `parseNumericIdentifier` at pg-handlers.ts:71 calls `.trim()` without type guard | **CONFIRMED** |
| MCP server `callTool()` at server.ts:256 passes args directly with ZERO validation | **CONFIRMED** |
| Both `add_discussion` and `list_ac` flow through `resolveProposalId` → `parseNumericIdentifier` | **CONFIRMED** |
| No inputSchema type coercion before handler invocation | **CONFIRMED** |

## Critical Finding: Architectural Layer Violation

The RFC treats this as an isolated handler bug. It is actually an **architectural layer violation**.

The codebase **already has** validation infrastructure:
- `src/apps/mcp-server/validation/tool-wrapper.ts` — `createSimpleValidatedTool()`, `createSchemaValidator()`
- `src/apps/mcp-server/validation/validators.ts` — `validateInput()`

**Other tool modules properly use it:**
- `tools/messages/index.ts` — 8 tools use `createSimpleValidatedTool`
- `tools/dependencies/index.ts` — 6 tools use `createSimpleValidatedTool`
- `tools/worktree-merge/index.ts` — 3 tools use `createSimpleValidatedTool`

**RFC tools bypass it entirely:**
- All 12 tools in `RfcWorkflowHandlers.register()` use raw `this.server.addTool()` with inline handler wiring
- Zero use of the validation wrapper

## Scope Problem

The RFC proposes:
1. Patch `parseNumericIdentifier` (AC #1) — **local fix, wrong layer**
2. "Audit all MCP tool handlers" (AC #2) — **no specific audit results**
3. "Add integration tests for MCP tools with edge cases" (AC #3) — **no concrete test plan**

Patching `parseNumericIdentifier` is like putting a bandaid on one finger while all 12 fingers are exposed. The real fix is to migrate ALL 12 RFC tools to use `createSimpleValidatedTool` from the existing validation infrastructure.

## Recommendations for Resubmission

1. **Expand AC #1:** Migrate all 12 RFC tools to use `createSimpleValidatedTool` from `validation/tool-wrapper.ts`, using the existing `inputSchema` definitions as the validation schema
2. **Concrete AC #2:** Specify the exact tools and audit checklist (every handler should have: type-safe param access, try/catch around DB calls, clear error messages)
3. **Concrete AC #3:** List specific test cases — e.g., `list_ac` with `proposal_id: 375` (number), `list_ac` with `proposal_id: undefined`, `add_discussion` with `proposal_id: null`, `transition_proposal` with missing `decided_by`

## Additional Issue Discovered

While investigating: `add_discussion` MCP tool ALSO fails because `resolveProposalRecord` references `p.dependency` (line 97) but the actual column is `p.dependency_note`. This affects ALL tools that call `resolveProposalRecord` — which is most of them.
