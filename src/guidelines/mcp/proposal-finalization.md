## State Finalization & Audit Guide

States are reached through a formal quality gate involving **Acceptance Criteria**, **Verification Statements**, and a **Peer Audit**.

### Finalization Workflow

1.  **Self-Verification (Builder):**
    - Confirm all **Acceptance Criteria** are satisfied and checked via `state_edit` (`checkAcceptanceCriteria`).
    - Verify all **Verification Statements** (assertions) assigned to the `builder` role are checked via `state_edit` (`checkVerificationStatements`).
    - Provide **Proof of Arrival (PoA)**: Attach verifiable evidence (CLI output, test reports, hashes) via `state_edit` (`addProof`).
    - Log final **Implementation Notes**: Summarize key technical decisions and progress via `state_edit` (`appendImplementationNotes`).
    - Write the **Final Summary**: Capture a PR-style summary of what changed and why via `state_edit` (`finalSummary`).

2.  **Request Audit:**
    - Signal readiness for review by setting the state status to `Review` using the `--request-audit` flag in `state_edit`.

3.  **Peer Audit (Auditor):**
    - A different agent (not the builder) picks up the state in `Review`.
    - The auditor examines the provided proof and the state contract (Acceptance Criteria + Verification Statements).
    - The auditor performs additional testing or inspection as required by the contract.
    - Findings are recorded in **Audit Notes** via `state_edit` (`appendAuditNotes`).

4.  **Certification:**
    - Once satisfied, the auditor marks the `peer-tester` verification statements as checked.
    - The auditor sets the state maturity to `audited` via `state_edit` (`--maturity audited`).
    - Finally, the auditor transitions the status to `Reached` via `state_edit`.

### Guardrails

The framework enforces several quality checks during the `Reached` transition:
- **Distinct Roles:** The Auditor MUST be a different agent than the Builder.
- **Audited Maturity:** Only states with `audited` maturity can be marked `Reached`.
- **Proof Required:** At least one Proof of Arrival entry must exist.
- **Unchecked Assertions:** All Verification Statements must be checked before certification.
- **Final Summary:** A PR-style summary is mandatory.

### After Finalization

**Never autonomously create or start new states.** Instead:

- **If follow-up work is needed**: Present the idea to the user and ask whether to create a follow-up state.
- **If this was a substate**:
  - Check if the user explicitly told you to work on "parent state and all substates".
    - If YES: Proceed directly to the next substate without asking.
    - If NO: Ask the user: "Substate X is complete. Should I proceed with substate Y, or would you like to review first?"
- **If all substates in a series are complete**: Update the parent state's `scopeSummary` if appropriate, then ask the user what to do next.

### Implementation Notes vs. Final Summary vs. Audit Notes

- **Implementation Notes:** Progress logging during execution (decisions, blockers, learnings).
- **Final Summary:** PR-style completion summary when the state is done (What, Why, Impact).
- **Audit Notes:** Independent verification findings and certification rationale recorded by the peer auditor.
