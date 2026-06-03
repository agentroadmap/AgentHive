# SMDL Weighted Scoring — Extension Spec (P374 AC-5)

**Author:** P374 architect pass  
**Date:** 2026-05-26  
**Status:** Ready for implementation

---

## Motivation

SMDL v1 gate evaluation is binary: a stage either passes or fails. Real review scenarios
require graduated verdicts — a proposal with strong design but weak tests should score
differently from one that is strong on both axes. The weighted scoring extension adds a
`criteria_weights` evaluator mode to SMDL gate definitions.

---

## Design

### 1. New evaluator mode: `weighted`

Extend `SMDLDecisionGate.evaluator` to accept `"weighted"` in addition to the existing
`"auto" | "ai" | "user"`.

```yaml
stages:
  - name: REVIEW
    decision_gate:
      evaluator: weighted           # ← new mode
      weighted_config:
        pass_threshold: 70          # minimum score (0–100) to advance
        criteria:
          - key: design_coherence
            label: "Design coherence"
            weight: 30              # max points this criterion contributes
            required: true          # proposal cannot advance if this is 0
          - key: feasibility
            label: "Technical feasibility"
            weight: 25
          - key: ac_quality
            label: "Acceptance criteria quality"
            weight: 25
          - key: cost_estimate
            label: "Cost estimate accuracy"
            weight: 20
        tie_break: age              # if score ties, use proposal age
```

`pass_threshold` is an integer 0–100 (percentage of total possible weight).

### 2. Criterion score submission

Reviewers (or auto-evaluators) submit criterion scores via a new MCP action:

```
mcp_proposal action=score_gate
  proposal_id  string   required
  stage        string   required  (e.g., "REVIEW")
  reviewer     string   required  (agent identity)
  scores       object   required  (map of criterion_key → 0..weight)
  rationale    string   optional
```

Example:

```json
{
  "proposal_id": "374",
  "stage": "REVIEW",
  "reviewer": "claude",
  "scores": {
    "design_coherence": 25,
    "feasibility": 20,
    "ac_quality": 18,
    "cost_estimate": 15
  },
  "rationale": "Design is solid; AC quality slightly weak"
}
```

### 3. Score aggregation rules

When multiple reviewers submit scores:

- **Default aggregation:** arithmetic mean per criterion across reviewers
- **Quorum requirement:** `weighted_config.min_reviewers` (default: 1) — gate does not
  evaluate until this many score submissions exist
- **Veto handling:** if a `required: true` criterion receives a score of 0 from any
  reviewer with `veto_power` in their role definition, the gate fails regardless of total
  score
- **Score lock:** once a proposal transitions out of the stage, score records are frozen;
  no further submissions accepted

### 4. DB migration

New table `roadmap.weighted_gate_scores`:

```sql
-- Migration: next available (follow database/migrations/ numbering)
CREATE TABLE roadmap.weighted_gate_scores (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    proposal_id     BIGINT NOT NULL REFERENCES roadmap.proposal(id) ON DELETE CASCADE,
    stage           TEXT NOT NULL,
    reviewer        TEXT NOT NULL,
    criterion_key   TEXT NOT NULL,
    score           NUMERIC(5,2) NOT NULL CHECK (score >= 0),
    max_score       NUMERIC(5,2) NOT NULL CHECK (max_score > 0),
    rationale       TEXT,
    submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked          BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE (proposal_id, stage, reviewer, criterion_key)
);

CREATE INDEX wgs_proposal_stage ON roadmap.weighted_gate_scores (proposal_id, stage);
```

New view `roadmap.weighted_gate_summary`:

```sql
CREATE VIEW roadmap.weighted_gate_summary AS
SELECT
    proposal_id,
    stage,
    criterion_key,
    COUNT(DISTINCT reviewer)            AS reviewer_count,
    ROUND(AVG(score), 2)               AS avg_score,
    MAX(max_score)                      AS max_score,
    ROUND(AVG(score) / MAX(max_score) * 100, 1) AS pct_score,
    MAX(locked::int)::boolean           AS locked
FROM roadmap.weighted_gate_scores
GROUP BY proposal_id, stage, criterion_key;
```

### 5. SMDL schema extension

Add to the `SMDLDecisionGate` interface in `smdl-loader.ts`:

```typescript
export interface SMDLWeightedCriterion {
  key: string;          // machine-readable identifier
  label: string;        // human-readable label
  weight: number;       // max points (sum of all weights = 100 recommended)
  required?: boolean;   // if true, score=0 from any veto-power reviewer fails gate
}

export interface SMDLWeightedConfig {
  pass_threshold: number;           // 0–100, % of total weight required to pass
  criteria: SMDLWeightedCriterion[];
  min_reviewers?: number;           // default 1
  tie_break?: "age" | "score" | "fifo";
}

// Extend existing SMDLDecisionGate:
export interface SMDLDecisionGate {
  evaluator: "auto" | "ai" | "user" | "weighted";  // ← add "weighted"
  trigger?: "on_request" | "on_threshold" | "on_schedule";
  priority?: "fifo" | "age" | "score";
  escalate_to_user?: SMDLEscalateToUser;
  weighted_config?: SMDLWeightedConfig;             // ← add this field
}
```

### 6. Gate evaluation logic

When the gate cron encounters a stage with `evaluator: weighted`:

```
1. Load weighted_gate_summary for (proposal_id, stage)
2. Check min_reviewers satisfied → if not, skip (gate stays open)
3. For each criterion:
   a. If required=true AND any reviewer with veto_power submitted score=0 → FAIL immediately
4. Compute total_score = SUM(avg_score for all criteria)
5. Compute max_possible = SUM(max_score for all criteria)
6. Compute pct = (total_score / max_possible) * 100
7. If pct >= pass_threshold → advance (gate passes)
8. If pct < pass_threshold → hold (gate fails — stays in stage)
9. Lock all score rows on advance
```

---

## API changes

### MCP tool changes

New action on `mcp_proposal`:

| action | params | description |
|---|---|---|
| `score_gate` | proposal_id, stage, reviewer, scores, rationale | Submit weighted scores for a gate |
| `get_gate_scores` | proposal_id, stage | Read current aggregate scores for a stage |

### Response format for `get_gate_scores`

```json
{
  "stage": "REVIEW",
  "pass_threshold": 70,
  "reviewer_count": 2,
  "total_pct": 82.5,
  "passes": true,
  "criteria": [
    {"key": "design_coherence", "avg_score": 24, "max_score": 30, "pct": 80},
    {"key": "feasibility",      "avg_score": 22, "max_score": 25, "pct": 88},
    {"key": "ac_quality",       "avg_score": 20, "max_score": 25, "pct": 80},
    {"key": "cost_estimate",    "avg_score": 17, "max_score": 20, "pct": 85}
  ]
}
```

---

## Acceptance criteria for implementation

- [ ] `SMDLDecisionGate` extended with `weighted_config` field; JSON schema updated
- [ ] `weighted_gate_scores` table and `weighted_gate_summary` view created via migration
- [ ] `mcp_proposal score_gate` action implemented with uniqueness enforcement
- [ ] `mcp_proposal get_gate_scores` action returns aggregate view
- [ ] Gate cron evaluates `weighted` stages using the 9-step logic above
- [ ] Veto-power + required criterion combination blocks advance correctly
- [ ] Score rows locked on stage transition; subsequent submissions rejected with error
- [ ] `workflow_visualize` MCP renders weighted criteria count in Mermaid note for
  weighted stages

---

## Non-goals

- Score editing / revision (immutable once submitted; reviewer must contact operator to void)
- Fractional reviewer weights (all reviewers equal within a quorum; trust is binary)
- Cross-stage score carry-over
