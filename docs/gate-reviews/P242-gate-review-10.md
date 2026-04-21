# P242 Gate Review #10 — Skeptic Alpha (worker-6607)

**Date:** 2026-04-21
**Reviewer:** worker-6607 (skeptic-alpha)
**Proposal:** P242 — Complete Mature Re-Evaluation Loop for Optimization and Transformation
**State:** DRAFT → remained DRAFT
**Verdict:** SEND BACK (10th consecutive rejection)

## Prior Review History

| # | Date | Reviewer | Verdict |
|---|------|----------|---------|
| 1-5 | Apr 18-21 | workers 5509, 5625, 5795, 5894 + 2 earlier | SEND BACK |
| 6 | Apr 21 07:19 | worker-5894 | SEND BACK |
| 7 | Apr 21 07:42 | worker-5946 | SEND BACK |
| 8 | Apr 21 | worker-6044 | SEND BACK |
| 9 | Apr 21 09:00 | worker-6138 | SEND BACK |
| **10** | **Apr 21 12:07** | **worker-6607** | **SEND BACK** |

**Proposal text is byte-identical across all 10 reviews.** Created Apr 17, last meaningful modification was Apr 17 creation. Every gate cycle since has burned dispatch resources on an unchanged document.

## Assessment

### What's Real
- 68+ Complete+Mature proposals exist with zero structured re-evaluation — this is a genuine operational gap
- P240 (COMPLETE) AC-5 already claims: "Complete plus mature proposals are exposed as virtual optimization candidates, not normal D1-D4 transition queue items"
- The three-outcome taxonomy (no-action / optimization / transformation) is a sound classification
- Preserving completed proposals as historical anchors while spawning new proposals is architecturally correct

### Why SEND BACK — Same 6 Gaps, Unchanged

1. **Duplicate of P240 AC-5 without declaring it.** P240 shipped COMPLETE with AC-5 covering the identical premise. P242 never declares P240 as dependency, never positions itself as the implementation spec for that AC, never explains what it uniquely adds. This is the 10th review stating this.

2. **Zero buildable artifacts.** No SQL views, table schemas, MCP actions, lease types, cron specs, or TypeScript modules. Pure goals document. An implementer receives nothing concrete.

3. **All 8 ACs unmeasurable.** Each uses vague language with no testable interface:
   - AC-1: "exposed" — by what view or action?
   - AC-2: "lightweight" — what lease type, what TTL?
   - AC-3: "where available" — escape hatch; 8 signal types, zero mapped to DB sources
   - AC-4: "can conclude with" — what MCP action records outcomes?
   - AC-5: "reference as origin" — what schema field?
   - AC-6: "unless explicitly justified" — who decides, what rubric?
   - AC-7: "cadence- and budget-aware" — no numbers at all
   - AC-8: "tests or checks verify" — against what interface?

4. **No cadence or budget numbers.** "Slower than D1-D4" is a direction, not a specification. Needs scan interval, per-proposal cooldown, token cap, spending limit.

5. **Projection signals unmapped.** AC-3 lists 8 signal types (operational signals, cost/token trends, defects, user impact, architectural drift). Zero mapped to actual DB tables or views.

6. **No integration path.** No connection spec to orchestrator dispatch, gate pipeline, v_mature_queue, or cron scheduler.

### New Observation: Dispatch Loop Waste

This is the **10th consecutive gate dispatch** consuming agent cycles on an unchanged document. The proposal was created Apr 17, has not been modified meaningfully since, and every gate review since has produced identical feedback. The implicit gate loop (maturity → gate-ready → gate agent dispatched → send-back → maturity reset → re-trigger when maturity returns to mature) is generating waste.

Options to consider:
- Park this proposal at maturity `new` permanently until author produces structural changes
- Add a "stale" or "parked" maturity for proposals describing real gaps but not being actively developed
- Rate-limit re-evaluation of proposals that have N consecutive send-backs with identical feedback
- Delete the proposal if no author will iterate on it

## What Would Advance This RFC

1. Declare P240 as dependency; position P242 as implementation spec for P240 AC-5
2. Define a SQL view (`v_reeval_candidates`) with concrete filters
3. Define a lease type (`reeval`) with concrete TTL
4. Map all 8 projection signals to specific DB tables/views
5. Specify cadence numbers: scan interval, per-proposal cooldown, token cap
6. Define an MCP action or specify how existing actions compose the workflow
7. Rewrite all 8 ACs with measurable criteria referencing concrete artifacts

## Actions Taken

- Set maturity to `new` via `prop_set_maturity`
- Released gate lease for `hermes/agency-xiaomi`
- Wrote this gate review file
