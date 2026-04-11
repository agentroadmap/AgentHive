# TRIAGE Decision Report

Date: 2026-04-11
Agent: Triage Agent (xiaomi/mimo-v2-pro)
Total proposals evaluated: 13

---

## Summary

| Classification | Count | Proposals |
|---|---|---|
| CAN FIX NOW | 8 | P086, P088, P091, P143, P144, P145, P146, P151 |
| ENHANCE | 4 | P087, P089, P147, P150 |
| ARCHIVE | 1 | P152 |

---

## Proposal-by-Proposal Decisions

### P088 - Design a universal reference-data catalog for shared schema terms
**Classification: CAN FIX NOW**
**Priority: High**

Full ACs, detailed DDL design, and clear migration path already written. This is a well-formed design proposal with concrete SQL for reference_domain and reference_term tables, seed data for proposal_maturity, and a phased migration from roadmap.maturity.

Fix summary: Implement the two new tables (roadmap.reference_domain, roadmap.reference_term) via a new numbered migration, seed the proposal_maturity domain with four terms (new/active/mature/obsolete), and add the Phase B bridge column (workflow_stages.maturity_term_key). The proposal is self-contained and can proceed to DEVELOP immediately.

Recommended action: Promote to REVIEW, then DEVELOP.

---

### P143 - CLI help text lists wrong proposal types and maturity values
**Classification: CAN FIX NOW**
**Priority: High**

Verified: src/apps/cli.ts lines 1820 and 3047 show "DIRECTIVE, CAPABILITY, TECHNICAL, COMPONENT, OPS_ISSUE" but the DB proposal_type_config table stores lowercase values (product, component, feature, issue). Lines 1924 and 3186 show "skeleton, contracted, audited" but actual maturity values are "new, active, mature, obsolete".

Fix summary: Update the four help-text strings in src/apps/cli.ts to display the correct values: --type help text should list "product, component, feature, issue" and --maturity help text should list "new, active, mature, obsolete". This is a documentation-only change with no logic impact.

Recommended action: File as ready issue, assign for immediate fix.

---

### P144 - CLI proposal create fails: type case mismatch between CLI and DB
**Classification: CAN FIX NOW**
**Priority: High**

Verified: src/apps/cli.ts line 1772 applies .toUpperCase() to the type input, converting "feature" to "FEATURE". The DB roadmap.proposal_type_config stores lowercase types (product, component, feature, issue). This causes FK violations on every CLI proposal create with --type.

Fix summary: Remove the .toUpperCase() call at line 1772 (and the similar call at line 3651 for edit) so that the CLI passes the type value in its original case. The DB already stores lowercase values and the user provides lowercase input, so no transformation is needed. This unblocks all CLI proposal creation against the Postgres backend.

Recommended action: File as ready issue, assign for immediate fix. Coordinate with P143 since both modify nearby cli.ts lines.

---

### P150 - prop_update bypasses Decision Gate
**Classification: ENHANCE**
**Priority: High**

This issue describes a real architectural problem: prop_update accepts a "status" field and directly changes proposal state without gate evaluation, no D1 gate decision record is created, and maturity enforcement is skipped. However, fixing this properly requires:
1. Defining the correct behavior for prop_update (should it reject status changes, or route through gate evaluation?)
2. Fixing prop_transition's display_id lookup bug ("Proposal undefined not found")
3. Ensuring PipelineCron is running (related to P151/P152)
4. Adding gate decision recording to proposal_audit_events

The fix is not straightforward — it touches the MCP tool handler, the gate pipeline, and the transition engine. Needs ACs that define the expected behavior boundary between prop_update and prop_transition.

Recommended action: Enhance with detailed ACs, then promote. This is a critical workflow integrity issue but needs architectural decisions first.

---

### P152 - MCP server does not initialize gate pipeline
**Classification: ARCHIVE**
**Priority: High**

This proposal is a subset of P151 (PipelineCron gate worker not running). P151 already covers both the standalone systemd service approach and the embedded-in-MCP-server approach, with more detail about the PipelineCron class, pg_notify channels, and fallback polling. P152 adds no unique information beyond what P151 already captures.

Recommended action: Archive as duplicate of P151. All unique requirements from P152 are already covered in P151's scope.

---

### P091 - P068 naming discrepancy: MCP lists as Web Dashboard but roadmap shows as Risk Alert & Mitigation
**Classification: CAN FIX NOW**
**Priority: Medium**

This is a data integrity issue where the Postgres proposal record for P068 says "Web Dashboard & TUI Board" but the file-based roadmap says "Risk Alert & Mitigation System". The fix requires a reconciliation query: determine which name is correct (check P068's original creation context and related proposals), then update either the DB record or the roadmap file.

Fix summary: Query P068 in Postgres and compare with docs/pillars/1-proposal/product-roadmap.md. Based on P068's design and motivation fields, determine the authoritative title and correct the other source. Then consider whether P068 should be split into two proposals if both features are intended.

Recommended action: File as ready issue for data reconciliation.

---

### P146 - Fix conflicting SQL migration file numbering
**Classification: CAN FIX NOW**
**Priority: Medium**

Verified: database/ddl/ has three 003-prefixed files (003-dependency-columns-fix.sql, 003-rfc-state-machine.sql, 003-rfc-workflow.sql) and two 004-prefixed files (004-multi-template-workflow.sql, 004-workflow-multi-template-support.sql). This violates the CONVENTIONS.md rule that numbered migrations are immutable and unique.

Fix summary: Determine which migrations have actually been applied to the live DB. Rename the conflicting files with unique sequential numbers starting from the next available number (e.g., renumber the later 003 files to 013, 014 and the later 004 file to 015). Update any migration runner references or scripts that depend on the old numbering. Do NOT change file contents, only filenames, since applied migrations are immutable.

Recommended action: File as ready issue. Requires DB migration audit first to determine which files are live.

---

### P147 - P087 missing AC; ~12 code files still reference old maturity naming
**Classification: ENHANCE**
**Priority: Medium**

This is a meta-issue about P087's quality. It identifies that P087 (Adopt renamed maturity and dependency columns) has no acceptance criteria and enumerates ~12 files that still use the old naming. However, the fix is not to address P147 directly — the fix is to enhance P087 with proper ACs that cover each of the identified code locations. P147 should serve as input to the P087 enhancement process.

Recommended action: Use P147's findings to enhance P087's ACs. Once P087 has comprehensive ACs, P147 can be closed as subsumed. Keep P147 open as a tracking issue until P087 is enhanced.

---

### P145 - Remove duplicate src/postgres/proposal-storage-v2.ts shim
**Classification: CAN FIX NOW**
**Priority: Low**

Verified: src/postgres/proposal-storage-v2.ts is a 1-line re-export shim. Four files import from the old path: src/core/roadmap.ts (confirmed 2 imports), src/apps/mcp-server/tools/spending/pg-handlers.ts, src/apps/mcp-server/tools/proposals/pg-handlers.ts.

Fix summary: Update the import paths in the 4 consumer files from "src/postgres/proposal-storage-v2" (or relative equivalent) to "src/infra/postgres/proposal-storage-v2". Then delete the shim file at src/postgres/proposal-storage-v2.ts. This is a straightforward code cleanup with no functional change.

Recommended action: File as ready issue, low priority cleanup task.

---

### P086 - Rename proposal.maturity_state and dependency in live Postgres schema
**Classification: CAN FIX NOW**
**Priority: Medium**

Full DDL script and acceptance criteria already written. Two ALTER TABLE RENAME COLUMN statements: maturity_state -> maturity, dependency -> dependency_note. The proposal notes dependency on P085 DDL being deployed first.

Fix summary: Execute the rename DDL on the live Postgres instance after confirming P085's migration 012 has been applied. Update any indexes, triggers, views, or queries that reference the old column names. The DDL is straightforward and values are preserved during rename.

Recommended action: Promote to READY. Verify P085 deployment status first, then execute.

---

### P087 - Adopt renamed maturity and dependency columns in Postgres and MCP code
**Classification: ENHANCE**
**Priority: Medium**

This proposal has 7 acceptance criteria but P147 identifies it as missing ACs — the issue is that the ACs are too high-level and don't enumerate specific code locations. P147 found ~12 files still using old naming. The proposal needs enhanced ACs that list each file and the expected change.

Fix summary: Enhance P087 with a concrete file-by-file change list. Verified 5 files still reference maturityState/maturity_state: src/infra/postgres/proposal-storage-v2.ts (7 refs), src/apps/mcp-server/tools/proposals/pg-handlers.ts (2 refs), src/apps/mcp-server/tools/rfc/pg-handlers.ts (3 refs), src/core/roadmap.ts (2 refs), src/shared/types/index.ts. Each needs updating to use the new column names from P086.

Recommended action: Enhance P087 with detailed file-level ACs incorporating P147's findings, then promote.

---

### P089 - Review the schema and define early cross-domain data architecture improvements
**Classification: ENHANCE**
**Priority: Medium**

This is a well-written architecture analysis proposal with 10 review findings and 6 recommended work packages. It covers identity strategy, reference data, event/audit patterns, workflow modeling, operational log retention, and domain grouping. However, it is an analysis/recommendation proposal — the actual implementation would need to be broken into separate concrete proposals.

Fix summary: This proposal should remain as the architectural vision document. After review and approval, spawn concrete child proposals for each work package (e.g., "Standardize identity strategy", "Implement retention policy for operational logs", etc.). P088 (reference-data catalog) is already one concrete child of this vision.

Recommended action: Promote to REVIEW as an architecture RFC. Upon approval, decompose into child implementation proposals.

---

### P151 - PipelineCron gate worker not running
**Classification: CAN FIX NOW**
**Priority: Critical**

Verified: PipelineCron class exists at src/core/pipeline/pipeline-cron.ts with pg_notify listeners for proposal_maturity_changed, transition_queued, and proposal_gate_ready channels, plus 30-second polling fallback. But neither the MCP server startup nor any systemd service starts it.

Fix summary: Add PipelineCron initialization to the MCP server startup (scripts/mcp-sse-server.js or equivalent). Import PipelineCron, instantiate with the Postgres connection, and call start() during server boot. Alternatively, create a systemd user service unit similar to hermes-gateway.service that runs PipelineCron as a standalone process. The embedded approach is simpler for now. Also add a health check indicator to the /health endpoint.

Recommended action: File as ready issue, CRITICAL priority. This blocks the entire gate pipeline and state machine workflow.

---

## Recommended Processing Order

1. **P151** (Critical) - Start PipelineCron, unblocks state machine
2. **P144** (High) - Fix CLI type case, unblocks proposal creation
3. **P143** (High) - Fix CLI help text, low risk alongside P144
4. **P150** (High) - Enhance and define gate bypass fix, architectural
5. **P088** (High) - Implement reference-data catalog
6. **P086** (Medium) - Deploy column rename DDL (after P085 verification)
7. **P087** (Medium) - Enhance ACs using P147 findings, then implement
8. **P146** (Medium) - Fix migration numbering
9. **P091** (Medium) - Reconcile P086 naming data
10. **P089** (Medium) - Review architecture proposal, decompose
11. **P145** (Low) - Remove shim file cleanup
12. **P152** - Archive (duplicate of P151)
