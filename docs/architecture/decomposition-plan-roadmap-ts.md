# Decomposition Plan: `src/core/roadmap.ts`

**Source file:** `src/core/roadmap.ts` — 6 191 lines  
**Problem:** A single `Core` God Class (~110 methods) with three top-level exports.  
**Goal:** Break the class into focused domain modules, progressively reducing `Core` to a thin
service-container façade that delegates to the extracted modules.

---

## 1. Structural Context

The file exposes only **three top-level exports**:

| Export | Kind | Line | Domain |
|--------|------|------|--------|
| `TuiProposalEditFailureReason` | union type | 169 | TUI |
| `TuiProposalEditResult` | interface | 174 | TUI |
| `Core` | class | 276 | all |

The entire business logic lives inside `Core`. Its shared state every extracted module will receive via
dependency injection:

```ts
interface CoreDeps {
  fs: FileSystem;
  git: GitOperations;
  projectRoot: string;
  getContentStore(): ContentStore;
  getSearchService(): SearchService;
  getRateLimiter(): RateLimiter;
}
```

Three free functions at the module level (180–274) are pure and can be extracted at any time without
touching `Core`:

| Function | Line | Purpose |
|----------|------|---------|
| `buildLatestProposalMap` | 180 | Merge branch/local/archived snapshots into a per-ID "latest wins" map |
| `filterProposalsByProposalSnapshots` | 249 | Keep only snapshots of type `"proposal"` |
| `getActiveAndCompletedIdsFromProposalMap` | 264 | Extract active/completed IDs for ID generation |

---

## 2. Target Modules

### `src/core/postgres-proposal-repository.ts`
**Scope:** lines 590–1273 (~700 lines)  
**Rationale:** All PG-backed persistence and hydration logic is already internally cohesive;
`hydratePgProposalRow` and `loadPgProposalActivity` are sub-module-worthy in their own right.

| Method | Line | Purpose |
|--------|------|---------|
| `isPostgresProposalBackend` (→ `isPostgresBackend`) | 590 | Detect PG backend from config |
| `getPgTagMetadata` | 597 | Read tag metadata object |
| `getPgTagString` | 606 | Coerce tag value to string |
| `getPgTagStringArray` | 617 | Coerce tag value to string array |
| `buildPgTags` | 630 | Build PG `tags` JSON from a proposal |
| `mapPgAcceptanceCriteria` | 691 | Map PG rows → acceptance criteria |
| `hydratePgProposalRow` | 703 | Full PG row → `Proposal` hydration (~190 lines) |
| `buildPgRawContent` | 891 | Reconstruct markdown body from PG row |
| `mapPgLabels` | 921 | Derive labels from PG tags |
| `mapPgMaturity` | 972 | Derive maturity from PG row |
| `mapPgPriority` | 987 | Derive priority from PG row |
| `loadPgProposalActivity` | 1000 | Load + map activity/events (~120 lines) |
| `extractEventActor` | 1123 | Pull actor from an event |
| `extractEventReason` | 1137 | Pull reason from an event |
| `describeProposalEvent` | 1164 | Human-readable event description |
| `ensurePgPool` | 1190 | Ensure PG connection pool exists |
| `resolvePgProposalType` | 1203 | Resolve proposal type for PG |
| `loadPgProposalById` | 1215 | Load single proposal from PG |
| `loadProposalsFromPostgres` | 1244 | Load all proposals from PG |

**Extraction interface:** `class PostgresProposalRepository` receiving `CoreDeps`.

---

### `src/core/proposal-loading.ts`
**Scope:** lines 180–274 (free functions) + 387–536 + 1273–1560 + 5641–6000 (~900 lines total)  
**Rationale:** Proposal loading and querying is the highest-traffic code path. Extracting it reduces
`Core` by ~15% and isolates all filter/search/bulk-load logic.

| Export / function | Line | Purpose |
|-------------------|------|---------|
| `buildLatestProposalMap` (free fn) | 180 | Merge snapshot sources |
| `filterProposalsByProposalSnapshots` (free fn) | 249 | Filter to proposal-type snapshots |
| `getActiveAndCompletedIdsFromProposalMap` (free fn) | 264 | ID-set extraction |
| `applyProposalFilters` | 387 | Apply `ProposalListFilter` (~110 lines) |
| `filterLocalEditableProposals` | 497 | Keep locally-editable proposals |
| `requireCanonicalStatus` | 501 | Validate/normalize status string |
| `normalizePriority` | 512 | Normalize priority input |
| `isExactProposalReference` | 528 | Test exact-ID reference match |
| `sanitizeArchivedProposalLinks` | 550 | Strip/repair archived-proposal links |
| `queryProposals` | 1273 | Primary query entry point (~250 lines) |
| `getProposal` | 1520 | Fetch single proposal by ID |
| `getProposalWithSubproposals` | 1543 | Fetch proposal with its subproposals |
| `loadProposalById` | 1560 | Load proposal by ID from storage |
| `loadAllProposalsForStatistics` | 5641 | Load every proposal for stats (~140 lines) |
| `loadProposals` | 5786 | Canonical proposal-loading entry point (~200 lines) |

---

### `src/core/proposal-mutations.ts`
**Scope:** lines 2105–3850 (~1 750 lines)  
**Rationale:** `applyProposalUpdateInput` alone is ~910 lines — the single largest method in the file.
Grouping create, update, and the field-application logic together and then splitting internally is
safer than two separate extractions.

| Method | Line | Purpose |
|--------|------|---------|
| `createProposalFromData` | 2105 | Build+persist proposal from raw data object |
| `createProposalFromInput` | 2177 | Build+persist from `ProposalCreateInput` (~280 lines) |
| `createProposal` | 2454 | Persist a fully-formed `Proposal` |
| `createDraft` | 2586 | Create a Draft-status proposal |
| `updateProposal` | 2605 | Persist updates to a proposal (~230 lines) |
| `addActivityLog` | 2835 | Append entry to activity log |
| `applyProposalUpdateInput` | 2852 | Apply `ProposalUpdateInput` diff (~910 lines) — **must be decomposed internally into per-concern handlers** |
| `updateProposalFromInput` | 3762 | Load-apply-save wrapper |
| `updateDraft` | 3852 | Persist draft updates |
| `updateDraftFromInput` | 3873 | Input-based draft update wrapper |

Internal decomposition of `applyProposalUpdateInput` (priority sub-tasks):
- `applyStatusTransition(proposal, input)` — status/maturity transitions
- `applyMetadataFields(proposal, input)` — title, priority, labels, assignee
- `applyRelationshipFields(proposal, input)` — parent/subproposal links
- `applyAcceptanceCriteriaUpdates(proposal, input)` — AC add/remove/check

---

### `src/core/proposal-workflow.ts`
**Scope:** lines 3903–4143 + 5066–5096 + 6022–6139 (~400 lines)  
**Rationale:** Draft promotion/demotion and status-level transitions are workflow-domain concerns
distinct from field-level mutation.

| Method | Line | Purpose |
|--------|------|---------|
| `editProposalOrDraft` | 3903 | Dispatch edit to proposal or draft path |
| `promoteDraftWithUpdates` | 3932 | Promote draft applying pending updates |
| `demoteProposalWithUpdates` | 4006 | Demote proposal applying updates |
| `executeStatusChangeCallback` | 4069 | Run per-proposal/global status-change hook |
| `assertNoBlockingTestIssues` | 4112 | Gate: block transition if test issues open |
| `editProposal` | 4132 | Edit a non-draft proposal |
| `updateProposalsBulk` | 4214 | Apply updates across many proposals |
| `promoteDraft` | 5081 | Promote draft to proposal |
| `demoteProposal` | 5096 | Demote proposal back to draft |
| `promoteProposal` | 6022 | Advance proposal to next status level |
| `demoteProposalProper` | 6051 | Move proposal to previous status level |
| `moveProposal` | 6139 | Move proposal within/between columns |

---

### `src/core/lease-manager.ts`
**Scope:** lines 4144–4597 (~450 lines)  
**Rationale:** Claim/lease lifecycle is a complete, bounded subdomain with rate-limit integration.

| Method | Line | Purpose |
|--------|------|---------|
| `pruneClaims` | 4144 | Recover claims past timeout |
| `claimProposal` | 4240 | Claim a proposal for an agent (rate-limit check) |
| `executeClaimProposal` | 4394 | Core claim mutation logic |
| `releaseClaim` | 4447 | Release a claim (validates release reason) |
| `renewClaim` | 4524 | Extend an existing claim's expiration |

---

### `src/core/sequence-manager.ts`
**Scope:** lines 4598–4847 (~250 lines)  
**Rationale:** Ordering/sequence logic is fully separable; no shared mutable state beyond `CoreDeps`.

| Method | Line | Purpose |
|--------|------|---------|
| `reorderProposal` | 4598 | Reorder proposal within status (~185 lines) |
| `listActiveSequences` | 4783 | List unsequenced proposals + computed sequences |
| `moveProposalInSequences` | 4792 | Move proposal between/within sequences |

---

### `src/core/acceptance-criteria.ts`
**Scope:** lines 5117–5253 (~140 lines)  
**Rationale:** Narrow, stable domain. Leaf module — no inbound dependencies from other planned modules.

| Method | Line | Purpose |
|--------|------|---------|
| `addAcceptanceCriteria` | 5117 | Add criteria to a proposal |
| `removeAcceptanceCriteria` | 5152 | Remove criteria |
| `checkAcceptanceCriteria` | 5199 | Check/uncheck criteria by index |
| `listAcceptanceCriteria` | 5243 | List a proposal's criteria |

---

### `src/core/decisions.ts`
**Scope:** lines 5254–5346 (~93 lines)  
**Rationale:** Leaf module. No dependency on lease or sequence state.

| Method | Line | Purpose |
|--------|------|---------|
| `createDecision` | 5254 | Create a decision record |
| `updateDecisionFromContent` | 5278 | Update a decision from raw content |
| `createDecisionWithTitle` | 5323 | Create a decision with an explicit title |

---

### `src/core/document-store.ts`
**Scope:** lines 1630–1648 + 5347–5404 (~80 lines)  
**Rationale:** Leaf module; isolated document CRUD.

| Method | Line | Purpose |
|--------|------|---------|
| `getDocument` | 1630 | Fetch a document by ID |
| `getDocumentContent` | 1636 | Raw content of a document |
| `createDocument` | 5347 | Create a document |
| `updateDocument` | 5362 | Update a document |
| `createDocumentWithId` | 5384 | Create a document with an explicit ID |

---

### `src/core/archival.ts`
**Scope:** lines 4847–5080 (~233 lines)  
**Rationale:** Lifecycle-terminal operations (archive, complete) form a natural group.

| Method | Line | Purpose |
|--------|------|---------|
| `archiveProposal` | 4847 | Archive a proposal |
| `archiveDirective` | 4905 | Archive a directive |
| `renameDirective` | 4953 | Rename a directive |
| `completeProposal` | 5000 | Mark a proposal complete |
| `getCompleteProposalsByAge` | 5032 | Completed proposals older than N days |
| `getReachedProposalsByAge` | 5053 | "Reached" proposals by age |
| `archiveDraft` | 5066 | Archive a draft |

---

### `src/core/config-migration.ts`
**Scope:** lines 1705–1924 (~220 lines)  
**Rationale:** Legacy-YAML parsing + migration is self-contained with no outbound dependencies.

| Method | Line | Purpose |
|--------|------|---------|
| `parseLegacyInlineArray` | 1705 | Parse legacy inline-array YAML values |
| `stripYamlComment` | 1743 | Strip trailing YAML comments |
| `parseLegacyYamlValue` | 1765 | Normalize a legacy YAML value |
| `extractLegacyConfigDirectives` | 1778 | Pull directives out of legacy config |
| `migrateLegacyConfigDirectivesToFiles` | 1850 | Migrate legacy directives to per-file storage |
| `ensureConfigMigrated` | 1886 | Orchestrate legacy→file config migration |

---

### `src/core/id-generator.ts`
**Scope:** lines 1924–2104 (~180 lines)  
**Rationale:** ID generation is a pure utility with a clear interface and no domain coupling.

| Method | Line | Purpose |
|--------|------|---------|
| `getActiveAndCompletedProposalIds` | 2002 | Gather in-use proposal IDs |
| `getExistingIdsForType` | 2080 | Existing IDs for a given entity type |
| `generateNextId` | 1924 | Generate next sequential ID per entity type |

---

### `src/core/tui-editor.ts`
**Scope:** lines 169–177 (types) + 5438–5640 (~220 lines)  
**Rationale:** TUI and external-editor integration is platform-specific; isolating it lets the rest of
Core be tested without a terminal.

| Export / method | Line | Purpose |
|-----------------|------|---------|
| `TuiProposalEditFailureReason` | 169 | Failure reason union |
| `TuiProposalEditResult` | 174 | Result interface |
| `listProposalsWithMetadata` | 5438 | List proposals enriched with metadata |
| `editProposalInTui` | 5483 | Edit proposal via external editor inside blessed TUI (~100 lines) |
| `openEditor` | 5584 | Launch the configured external editor on a file |

---

### `src/core/events.ts`
**Scope:** lines 5989–6021 (~33 lines)  
**Rationale:** Leaf; two thin wrapper methods.

| Method | Line | Purpose |
|--------|------|---------|
| `emitPulse` | 5989 | Emit a `PulseEvent` |
| `emitEvent` | 5998 | Emit a generic event |

---

### `src/core/merge.ts`
**Scope:** line 6098 (~40 lines)  
**Rationale:** Proposal merge is rare and isolated; clean leaf.

| Method | Line | Purpose |
|--------|------|---------|
| `mergeProposals` | 6098 | Merge one proposal into another |
| `updatePriority` | 6080 | Change a proposal's priority |

---

## 3. Sequenced Extraction Order

Extraction must proceed leaf-first to avoid circular-import risk during the refactor.

| Phase | Module | Justification |
|-------|--------|---------------|
| **1** | `config-migration.ts` | Pure legacy-YAML util; zero inbound deps from other planned modules |
| **1** | `id-generator.ts` | Pure util; depends only on `CoreDeps.fs` |
| **1** | `events.ts` | Two thin wrappers; no deps on other planned modules |
| **1** | `acceptance-criteria.ts` | Leaf; stable; narrow scope |
| **1** | `decisions.ts` | Leaf; stable; narrow scope |
| **1** | `document-store.ts` | Leaf; isolated CRUD |
| **2** | `postgres-proposal-repository.ts` | Depends on `CoreDeps` only; no deps on Phase 1 modules |
| **2** | `proposal-loading.ts` (free functions first) | Free functions at 180–274 are trivially extractable; full module depends on PG repo |
| **2** | `sequence-manager.ts` | Depends on `CoreDeps` + proposal loading; no workflow dep |
| **2** | `lease-manager.ts` | Depends on `CoreDeps` + rate limiter; no mutation dep |
| **3** | `archival.ts` | Depends on proposal loading and mutations (needs create/update calls) |
| **3** | `tui-editor.ts` | Depends on proposal loading |
| **3** | `merge.ts` | Depends on proposal loading and mutations |
| **4** | `proposal-mutations.ts` | Largest extraction; depends on PG repo, proposal loading, acceptance-criteria, id-generator |
| **5** | `proposal-workflow.ts` | Depends on proposal mutations + lease manager |
| **6** | `Core` (residual) | Becomes a thin service-container façade; all business methods delegated |

---

## 4. Dependency Injection Strategy

All extracted modules receive `CoreDeps` at construction time. The residual `Core` class becomes
the DI root:

```ts
// After full extraction
export class Core {
  private pgRepo: PostgresProposalRepository;
  private leaseManager: LeaseManager;
  private sequenceManager: SequenceManager;
  // …

  constructor(fs: FileSystem, git: GitOperations, projectRoot: string) {
    const deps = this.buildDeps(fs, git, projectRoot);
    this.pgRepo = new PostgresProposalRepository(deps);
    this.leaseManager = new LeaseManager(deps);
    // …
  }
}
```

Alternatively, extracted modules can be free-function namespaces receiving `CoreDeps` as a first
argument — this avoids the class-instance allocation cost and simplifies testing.

---

## 5. Acceptance Criteria Traceability

| AC | How satisfied |
|----|---------------|
| AC-1 | This document published on main branch; `git grep decomposition-plan-roadmap-ts docs/architecture/` returns this file |
| AC-3 | Section 3 "Sequenced Extraction Order" provides explicit dependency ordering, leaf-first |
| AC-4 | Operator review recorded as a discussion entry on P3844 before child proposals are filed |
