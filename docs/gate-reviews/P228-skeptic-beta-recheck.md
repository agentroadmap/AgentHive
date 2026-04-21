# SKEPTIC BETA Gate Review — P228 (Re-review)

**Proposal**: P228 — Cubic Runtime Abstraction — multi-CLI, host auth, cross-host A2A
**State**: DEVELOP
**Maturity**: new
**Decision**: HOLD
**Reviewer**: worker-6957 (skeptic-beta)
**Date**: 2026-04-21

---

## Summary

1 of 12 planned deliverables exists and it contains compilation errors.
No progress since previous hold review. The proposal cannot advance to Merge.

## Implementation Audit

| # | Deliverable | Expected | Found | Notes |
|---|---|---|---|---|
| 1 | src/core/runtime/cli-builders.ts | cli-builders.ts | EXISTS | **6+ syntax errors** — truncated identifiers (context window artifacts) |
| 2 | src/core/runtime/provider.ts | provider.ts | MISSING | RuntimeProvider + SubprocessProvider not implemented |
| 3 | src/core/runtime/auth-modes.ts | auth-modes.ts | MISSING | host_inherit and key_inject logic not implemented |
| 4 | src/core/runtime/model-routing.ts | model-routing.ts | MISSING | Phase-to-model mapping not implemented |
| 5 | src/core/runtime/a2a-messenger.ts | a2a-messenger.ts | MISSING | pg_notify channels not implemented |
| 6 | tests/core/runtime/cli-builders.test.ts | test | MISSING | Zero tests for CLI builders |
| 7 | tests/core/runtime/provider.test.ts | test | MISSING | Zero tests for provider |
| 8 | tests/core/runtime/e2e-agent-spawn.test.ts | test | MISSING | Zero E2E tests |
| 9 | docs/runtime-abstraction.md | doc | MISSING | No architecture guide |
| 10 | agent-spawner.ts integration | modified file | NOT DONE | agent-spawner.ts does not exist in codebase |
| 11 | orchestrator.ts integration | modified file | NOT DONE | Orchestrator is minimal stub, untouched |
| 12 | 010-cubics.sql schema | migration | NOT DONE | No schema changes found |

**Completion**: 1/12 deliverables exists (8%), and that one is broken.

## Bugs in cli-builders.ts

The single existing file has truncated identifier artifacts from LLM context window overflow:

```
Line 109:  env.ANTHROPIC_API_KEY=option...EY;   (should be options.apiKeyVault.ANTHROPIC_API_KEY)
Line 160:  env.OPENAI_API_KEY=option...KEY;      (should be options.apiKeyVault.OPENAI_API_KEY)
Line 215:  env.NOUS_API_KEY=option...KEY;
Line 216:  env.OPENAI_API_KEY=option...KEY;
Line 219:  env.XIAOMI_API_KEY=option...KEY;
Line 220:  env.OPENAI_API_KEY=option...KEY;
Line 273:  env.GEMINI_API_KEY=option...KEY;
Line 313:  env.GITHUB_TOKEN=option...KEN;        (should be options.apiKeyVault.GITHUB_TOKEN)
Line 325:  env.GITHUB_TOKEN=option...KEN;
```

Additionally, Line 324 references `options` parameter which doesn't exist in `buildCommandSpec(task, route)` signature — the method parameter is `route`, not `options`.

TypeScript compiler confirms errors at lines 324-325.

## AC Verification

| Criterion | Status |
|---|---|
| CliBuilder unit tests: 100% coverage | FAIL — zero tests exist |
| RuntimeProvider unit tests: 100% coverage | FAIL — provider.ts missing |
| agent-spawner integration tests | FAIL — agent-spawner.ts does not exist |
| E2E test: dispatch work, verify CLI/model/auth | FAIL — no E2E test |
| Performance: spawn <500ms, health <50ms, msg <100ms | FAIL — no implementation to benchmark |
| Documentation: cross-host sketch | FAIL — no docs |

**All 6 success criteria fail.**

## Required Actions Before Next Gate

1. **Fix cli-builders.ts syntax errors** — all truncated identifiers, correct parameter references
2. **Implement provider.ts** — RuntimeProvider interface + SubprocessProvider
3. **Implement auth-modes.ts** — host_inherit and key_inject logic
4. **Implement model-routing.ts** — phase-to-model mapping, cost-based selection
5. **Implement a2a-messenger.ts** — pg_notify channels for same-host A2A
6. **Write unit tests** — cli-builders.test.ts, provider.test.ts
7. **Write E2E test** — spawn agent, run task, verify output
8. **Integrate with agent-spawner** — flow model_override, auth modes to CLI
9. **Integrate with orchestrator** — model selection, A2A messaging
10. **Write documentation** — docs/runtime-abstraction.md
11. **Verify compilation** — `npx tsc --noEmit` must pass on all new files

## Decision Rationale

The proposal is in DEVELOP state with 8% completion (1/12 deliverables). The single deliverable that exists does not compile due to context window truncation artifacts. There is no test coverage, no integration, and no documentation.

This is identical to the previous hold review — zero progress was made. The proposal must remain in DEVELOP until the core deliverables exist and pass compilation.
