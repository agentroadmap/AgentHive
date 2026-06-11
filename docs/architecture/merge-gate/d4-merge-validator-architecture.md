> **Type:** design note
> **MCP-tracked:** P1124
> **Source-of-truth:** Postgres `roadmap_proposal.proposal` row P1124

# D4 Merge-Gate E2E Validator Architecture

## Overview

The **D4 merge-gate validator** is a dispatch-wired job that runs at the MERGE/mature state of proposals and programmatically validates all acceptance criteria (ACs) before advancing to COMPLETE. It is the final integration gate that certifies that a proposal's deliverables meet their acceptance criteria.

### Related Work

- **P1094** — D4 role binding; establishes that MERGE stage uses `gate-reviewer` role
- **P1140** — Deliverable verification; validates that code artifacts exist (decorator over developer work)
- **P1112** — Response verification; validates that proposal responses meet expectations
- **P1124** — This proposal; validates that acceptance criteria themselves pass

### Boundary and Scope

| Aspect | Owned by P1124 | Owned by P1140 | Owned by P1112 |
| --- | --- | --- | --- |
| **What** | Do all ACs pass? | Does the artifact exist? | Does the response meet standards? |
| **When** | MERGE/mature | DEVELOP/mature or later | Throughout proposal lifecycle |
| **Who verifies** | D4 gate reviewer (validator job) | Developer (self-reported) → Deliverable Verifier (automated check) | Response evaluator (analyst/architect) |
| **Gate stage** | D4 (MERGE) | D2 (DEVELOP) pre-flight | D1 (DRAFT) or D2 (REVIEW) |
| **Blocks what** | MERGE → COMPLETE | Maturity advance | Transition to next stage |

### Why Separate?

The three verification layers prevent advancement without proof at different stages:

- **P1112 (Response):** Does the proposal's problem statement and design make sense?
- **P1140 (Deliverable):** Did the developer actually produce the promised code/artifact?
- **P1124 (AC):** Do the delivered artifacts meet each specific acceptance criterion?

A proposal can have excellent architecture, shipping code, *and* pass deliverable checks, but still fail AC verification if the implementation doesn't meet the specific acceptance bar.

## Architecture

### Job Lifecycle

```
orchestrator.scanQueues()
  ↓ (finds proposal in MERGE/mature)
  ↓ (resolves dispatch role 'd4-e2e-validator')
  ↓
spawn d4-e2e-validate-merge.ts with:
  - proposal_id
  - agent_identity (D4 reviewer)
  - briefing (proposal context)
  ↓
[Validator Job]
  1. Load all proposal_acceptance_criteria rows
  2. For each AC:
     a. Determine category (code, artifact, review, design, manual)
     b. Run category-specific verification (test suite, file check, review count, etc.)
     c. Record status: pass | fail | blocked | waived
     d. Store evidence in proposal_acceptance_criteria.details (P707)
  3. Aggregate results:
     - If all non-waived ACs are 'pass': decide='advance', to_state='COMPLETE'
     - If any AC is 'fail' or 'blocked': decide='hold', to_state='MERGE'
  4. Emit gate_decision_log row
  5. Exit with code 0 (pass) or 1 (fail)
  ↓
orchestrator observes job exit
  ↓ (if advance): trigger MERGE → COMPLETE state transition
  ↓ (if hold): re-queue for operator review
```

### AC Verification Strategies

Each AC has a `category` field that determines how it is verified:

#### **category = "code"**
Verifies that a code test suite passes.

**Check logic:**
1. Find agent_runs rows for this proposal with role='developer'
2. Parse the most recent run's output_summary or test results
3. Look for test pass/fail indicators (e.g., "✓ 10 tests passed")
4. Mark AC as `pass` if test count matches or exceeds expected; `fail` if tests failed

**Evidence schema:**
```json
{
  "verified_by": "d4-e2e-validator",
  "verified_at": "2026-06-10T12:34:56Z",
  "evidence": {
    "testSuiteName": "acceptance.test.ts",
    "passedTests": 10,
    "failedTests": 0,
    "duration_ms": 5432
  }
}
```

#### **category = "artifact"**
Verifies that a deliverable file exists and matches the AC description.

**Check logic:**
1. Load agent_runs rows for developer role
2. Parse output for artifact paths (e.g., "Built: /path/to/binary")
3. Verify file exists in the worktree or build output
4. Mark AC as `pass` if artifact matches description; `fail` if missing or mismatch

**Evidence schema:**
```json
{
  "verified_by": "d4-e2e-validator",
  "verified_at": "2026-06-10T12:34:56Z",
  "evidence": {
    "artifactType": "executable",
    "path": "/data/code/AgentHive/dist/orchestrator",
    "checksum": "sha256:abc123...",
    "sizeBytes": 45678
  }
}
```

#### **category = "review"**
Verifies that required peer reviews were submitted.

**Check logic:**
1. Query proposal_reviews rows WHERE proposal_id = $1
2. Check for rows with status in ('approved', 'request_changes_resolved', etc.)
3. Mark AC as `pass` if count >= expected; `fail` if missing

**Evidence schema:**
```json
{
  "verified_by": "d4-e2e-validator",
  "verified_at": "2026-06-10T12:34:56Z",
  "evidence": {
    "reviewCount": 2,
    "reviewers": ["alice", "bob"],
    "approvalsCount": 2
  }
}
```

#### **category = "design"**
Verifies that design discussions and feedback were captured.

**Check logic:**
1. Query proposal_discussions WHERE context_prefix IN ('feedback:', 'design:')
2. Count rows; mark as `pass` if >= 1, `fail` if none

**Evidence schema:**
```json
{
  "verified_by": "d4-e2e-validator",
  "verified_at": "2026-06-10T12:34:56Z",
  "evidence": {
    "discussionCount": 3,
    "contextPrefixes": ["feedback:", "design:"]
  }
}
```

#### **category = "manual"**
Operator-marked as waived; skips automatic verification.

**Behavior:** Always recorded as `status='waived'`. Does not block AC aggregate.

**Evidence schema:**
```json
{
  "verified_by": "d4-e2e-validator",
  "verified_at": "2026-06-10T12:34:56Z",
  "evidence": {
    "reason": "manually_waived_by_operator",
    "waived_by": "operator_identity"
  }
}
```

### Database Schema Changes

No new tables. Uses existing columns:

- **proposal_acceptance_criteria.status** — updated with `pass | fail | blocked | waived`
- **proposal_acceptance_criteria.details** — stores evidence payload (JSONB, P707)
- **proposal_acceptance_criteria.details_schema_version** — set to 'v1' on each verify run
- **gate_decision_log** — new row emitted with decision (advance/hold) and summary

### Entry Point and Dispatch Wiring

**Queue context definition** (roadmap.agent_role_profile):
```sql
INSERT INTO roadmap.agent_role_profile
  (workflow_template_id, stage, maturity, role, required_capabilities, prompt_template, priority)
VALUES
  (14, 'MERGE', 'mature', 'd4-e2e-validator',
   ARRAY['gating', 'qa', 'e2e-testing', 'ac-verification'],
   '{"system": "D4 merge validator...", "mode": "d4_merge_validator"}',
   10);
```

**Script entry point:**
- File: `scripts/d4-e2e-validate-merge.ts`
- Invoked via orchestrator spawn with `role='d4-e2e-validator'`
- Argument: `{ proposal_id: number, agent_identity: string, briefing: {...} }`
- Exit code: 0 (all ACs pass) → orchestrator advances MERGE → COMPLETE; 1 (any AC fails) → hold

### Test Coverage

**Unit tests** (`tests/integration/p1124-d4-merge-validator.test.ts`):
- AC-1: Load all ACs for a proposal
- AC-2: Record verification results with status and evidence
- AC-3: Emit advance gate decision when all ACs pass
- AC-4: Emit hold gate decision when any AC fails
- AC-5: Waived ACs do not block advance
- AC-6: Evidence schema includes verifier identity and timestamp

**Integration tests** (env-gated):
- AC-7: End-to-end dispatch cycle validates and advances proposal (behind AGENTHIVE_ALLOW_LIVE_DB flag)

### Example: Full Flow

**Scenario:** Proposal P1234 in MERGE/mature with 3 ACs.

1. **Orchestrator detects** P1234 in MERGE/mature, resolves role='d4-e2e-validator'
2. **Spawns job** with proposal_id=1234, agent_identity='gate-reviewer'
3. **Validator loads ACs:**
   - AC#1: category='code', criterion_text='All unit tests pass'
   - AC#2: category='artifact', criterion_text='Binary built at /dist/orchestrator'
   - AC#3: category='review', criterion_text='Approved by 2+ reviewers'
4. **Verifies each:**
   - AC#1: Finds 15 passing tests → status='pass'
   - AC#2: Finds binary with correct checksum → status='pass'
   - AC#3: Finds 3 approval reviews → status='pass'
5. **All non-waived ACs pass → allPass=true**
6. **Emits gate_decision:** status='advance', to_state='COMPLETE', reason='All ACs passed'
7. **Orchestrator observes** advance decision → triggers MERGE → COMPLETE transition
8. **Proposal state**: MERGE/mature → COMPLETE/new

If any AC had failed:
- Step 6: Emits gate_decision with status='hold', to_state='MERGE'
- Step 7: Orchestrator keeps proposal in MERGE, signals operator review
- Operator can then request AC correction, return to DEVELOP, or waive the AC

## Implementation Checklist

- [ ] **AC-1:** Queue context row in roadmap.agent_role_profile for 'd4-e2e-validator' role
- [ ] **AC-2:** Implement scripts/d4-e2e-validate-merge.ts with category-specific verifiers
- [ ] **AC-3:** AC runner loop (verifyAllACs function) executes each AC by category
- [ ] **AC-4:** Results capture (recordACResults) writes status + evidence to proposal_acceptance_criteria
- [ ] **AC-5:** Gate integration (emitGateDecision) writes gate_decision_log row
- [ ] **AC-6:** Failure handling (allPass logic) blocks advance if any non-waived AC fails
- [ ] **AC-7:** Integration test suite (tests/integration/p1124-d4-merge-validator.test.ts) env-gated
- [ ] **AC-8:** Architecture documentation (this file) explains design + boundaries

## Operational Notes

### When a Proposal Fails D4 Merge Validation

1. **Operator sees** gate_decision_log with status='hold', reason=[AC failures]
2. **Check proposal_acceptance_criteria.details** for evidence on which AC(s) failed and why
3. **Options:**
   - Return proposal to DEVELOP to fix failing AC (if implementable)
   - Waive AC with operator override (set category='manual', mark as 'waived')
   - Request AC refinement if category definition was ambiguous (return to REVIEW)
4. **Re-run validator** once proposal re-enters MERGE/mature

### Tuning Category-Specific Verification

Each category verifier can be extended:
- **code:** Add support for parsing test output from different test frameworks (pytest, jest, cargo test, etc.)
- **artifact:** Add checksum validation, size constraints, binary signature checks
- **review:** Require specific reviewer identities or approval comment content
- **design:** Require discussion from specific participants or keyword search in comments

## See Also

- **P1094:** D4 role binding and MERGE gate reviewer assignment
- **P1140:** Deliverable verification decorator (validates artifacts exist)
- **P1112:** Response verification (validates proposal design quality)
- **P707:** AC evidence columns (proposal_acceptance_criteria.details schema)
- **CONVENTIONS §5a:** Architectural Umbrella Pattern (P1124 is a MERGE-specific pattern, not umbrella)
