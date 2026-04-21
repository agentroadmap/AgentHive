# P242 Gate Review #9 — Skeptic Alpha (worker-6138)

**Date:** 2026-04-21
**Reviewer:** worker-6138 (skeptic-alpha)
**Proposal:** P242 — Complete Mature Re-Evaluation Loop for Optimization and Transformation
**State:** DRAFT → remained DRAFT
**Verdict:** SEND BACK (9th consecutive rejection)

## Prior Review History

| # | Date | Reviewer | Verdict |
|---|------|----------|---------|
| 1-5 | Apr 18-21 | workers 5509, 5625, 5795, 5894 + 2 earlier | SEND BACK |
| 6 | Apr 21 07:19 | worker-5894 | SEND BACK |
| 7 | Apr 21 07:42 | worker-5946 | SEND BACK |
| 8 | Apr 21 | worker-6044 | SEND BACK |
| **9** | **Apr 21 09:00** | **worker-6138** | **SEND BACK** |

**Proposal unchanged across all 9 reviews.**

## Assessment

### What's Real
- 68+ Complete+Mature proposals exist with no structured re-evaluation pathway
- P240 (COMPLETE) AC-5 establishes the premise: Complete+Mature items are not normal D1-D4 queue items
- The three-outcome taxonomy (no-action / optimization / transformation) is clean and sound
- The concept of preserving completed proposals as historical anchors while generating new proposals is architecturally correct

### Why SEND BACK

1. **Duplicate of P240 AC-5.** P240 shipped with AC-5 stating: "Complete plus mature proposals are exposed as virtual optimization candidates, not normal D1-D4 transition queue items." P242 never declares a dependency on P240, never positions itself as the implementation spec for that AC, and never explains what it uniquely adds. Until this relationship is declared, P242 appears to duplicate an already-shipped capability claim.

2. **Zero Buildable Artifacts.** No SQL views, no table schemas, no MCP actions, no lease types, no cron specs, no TypeScript modules. A skeptic cannot advance a design that gives an implementer nothing concrete to build.

3. **All 8 ACs Unmeasurable.**
   - AC-1: "exposed" — by what view or action?
   - AC-2: "lightweight" — what lease type, what TTL?
   - AC-3: "where available" — escape hatch; 8 signal types, zero mapped to DB sources
   - AC-4: "can conclude with" — what MCP action records outcomes?
   - AC-5: "reference as origin" — what schema field?
   - AC-6: "unless explicitly justified" — who decides, what's the rubric?
   - AC-7: "cadence- and budget-aware" — no numbers
   - AC-8: "tests or checks verify" — against what interface?

4. **No Cadence or Budget Numbers.** "Slower than D1-D4" is a direction. Needs: scan interval (e.g., every 7 days), per-proposal cooldown (e.g., 30 days), token cap per re-evaluation (e.g., 2000 tokens), monthly spending limit.

5. **Projection Signals Unmapped.** AC-3 lists 8 signal types. Zero are mapped to actual DB tables or views. What table stores cost trends? What view exposes drift indicators?

6. **No Integration Path.** No spec for connection to orchestrator dispatch, gate pipeline, v_mature_queue, or cron scheduler.

## What Would Advance This RFC

1. Declare P240 as dependency; position P242 as implementation spec for P240 AC-5
2. Define a SQL view (`v_reeval_candidates`) that produces re-evaluation candidates with specific filters
3. Define a lease type (`reeval`) with concrete TTL (e.g., 60 minutes)
4. Map all 8 projection signals to specific DB tables/views
5. Specify cadence numbers: scan interval, per-proposal cooldown, token cap
6. Define an MCP action (`prop_reevaluate`) or specify how existing actions compose the workflow
7. Rewrite all ACs with measurable criteria referencing the concrete artifacts above

## Actions Taken

- Set maturity to `new` via `prop_set_maturity`
- Recorded discussion #2171 with decision rationale
- Wrote this gate review file

## Systemic Concern

9 consecutive rejections consuming gate agent dispatch cycles on an unchanged document. The implicit gate loop re-triggers when maturity resets to `mature`. Consider whether this proposal should be held at maturity `new` permanently until the author produces structural changes, or whether a "parking lot" status is needed for proposals that describe real gaps but aren't being actively developed.
