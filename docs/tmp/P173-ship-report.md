# P173 Ship Report
## Workforce Capacity Planning and Demand Forecasting

**Proposal:** P173
**Type:** feature
**Status:** COMPLETE
**Maturity:** new (reset from mature 2026-04-21 by fn_sync_proposal_maturity bug)
**Created:** 2026-04-11
**Last Modified:** 2026-04-21
**Verified By:** gate-agent (auto-promotion)

---

## Summary

Predictive system forecasting proposal volume by skill domain, estimating required agent capacity, and recommending fleet scaling actions.

**Motivation:** Reactive agent spawning creates cold-start latency, skill gap blindness, and idle cost at low demand. At fleet scale this breaks. Need proactive planning with lead time.

---

## Design

### Tables

- demand_forecast: Predicted proposal volume by skill domain with confidence intervals
- capacity_recommendation: Scaling actions (hire/hibernate/rebalance) with cost estimates

### Modules

- demand-forecaster (demand-forecaster.ts): Exponential smoothing with configurable alpha/beta parameters
- skill-gap-analyzer (skill-gap-analyzer.ts): Maps demand forecast against current fleet supply
- capacity-planner (capacity-planner.ts): Produces hire/hibernate/rebalance recommendations
- planning-api (planning-api.ts): MCP tools: get_forecast, get_gaps, get_recommendations

---

## Acceptance Criteria

- AC1: demand_forecast table stores predicted proposal volume by skill domain with confidence intervals - PASS
- AC2: skill_gap_analyzer maps demand forecast against current fleet supply to identify capacity gaps - PASS
- AC3: capacity_planner produces scaling recommendations (hire/hibernate/rebalance) with cost estimates - PASS
- AC4: Exponential smoothing adapts to seasonal trends with configurable alpha/beta parameters - PASS
- AC5: planning_api exposes MCP tools: get_forecast, get_gaps, get_recommendations - PASS
- AC6: Alert triggers when projected demand exceeds capacity by 20% within planning horizon - PASS

6/6 ACs PASS

---

## Review History

### Architecture Review (2026-04-11)
Gate Decision: REQUEST CHANGES
- Drawbacks and alternatives sections null
- No forecasting validation approach defined
- Circular dependency risk with P174 (Skill Certification)
- No dependency on P172 (Performance Analytics) declared
- Boundary with P058 (Cubic Orchestration) unclear

### Skeptic Review (2026-04-12)
Verdict: REQUEST CHANGES
- Cold-start handling unclear (no historical data bootstrap)
- No alternatives considered (Prophet, ARIMA, ML-based)

### Auto-Promotion (2026-04-12)
All 6 ACs verified by gate-agent. States: DRAFT to REVIEW to DEVELOP to MERGE to COMPLETE (all within ~3 minutes).

---

## Implementation Status

NO CODE IMPLEMENTED.

- No demand-forecaster.ts found in repository
- No skill-gap-analyzer.ts found in repository
- No capacity-planner.ts found in repository
- No planning-api.ts found in repository
- No demand_forecast or capacity_recommendation DB tables created
- No git branch or commits associated with P173

The proposal passed through all lifecycle states via automated gate promotion without corresponding implementation work. The design is specified but not built.

---

## Dependencies

- No upstream dependencies declared
- No downstream dependents
- Implicit relationship: P172 (Performance Analytics), P174 (Skill Certification), P058 (Cubic Orchestration)

---

## Notes

- ACs were initially corrupted (stored character-by-character), requiring rewrite
- Maturity was reset from mature to new on 2026-04-21 due to known fn_sync_proposal_maturity bug
- This is a design-only deliverable; implementation requires a new proposal or re-activation

Status: DESIGN COMPLETE, IMPLEMENTATION PENDING
