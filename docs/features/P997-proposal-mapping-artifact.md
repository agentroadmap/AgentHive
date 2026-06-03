# P997 — legacy-to-agentHive2 proposal mapping artifact schema

**Status:** DRAFT → REVIEW  
**Parent:** P995 (agentHive2 proposal stack re-authoring)  
**Migration:** `scripts/migrations/135-p997-proposal-mapping-artifact.sql`  
**Blocked by:** P998 (inventory child), P999 (corpus classification child)

---

## Purpose

P995 requires a reliable, queryable record of how each legacy proposal maps to the agentHive2 documentation-shaped stack. Without a structured artifact the migration degrades into an unauditable spreadsheet or ad hoc chat exercise — agents cannot safely classify, supersede, or obsolete proposals at corpus scale.

This proposal defines and implements that artifact: a single control-plane table plus four query-surface views.

---

## Source-of-Truth Boundary

> **This artifact is a projection / control-plane helper.**  
> It does not replace the proposal lifecycle source of truth.

| What it IS | What it is NOT |
|---|---|
| A classification record and audit log for the migration | A proposal state machine or maturity controller |
| A queryable index over how legacy → agentHive2 nodes relate | An alternative to `roadmap_proposal.proposal` for lifecycle data |
| A surfaces for classification agents to read unresolved/incomplete rows | A place to SET proposal status or maturity |

Agents must read `roadmap_proposal.proposal` for lifecycle state. They write to `proposal_migration_map` only to record classification decisions.

---

## Classification Vocabulary (P995)

| Value | Meaning |
|---|---|
| `retained` | Proposal is kept as-is in the agentHive2 stack |
| `delivered_evidence` | Completed with verified ACs; preserved as historical implementation evidence |
| `duplicate` | Duplicate of another proposal; no agentHive2 heir |
| `obsolete` | No longer relevant; no agentHive2 heir |
| `reauthor_needed` | Must be rewritten; work tracked in the canonical agentHive2 node |
| `superseded` | Replaced by a named canonical agentHive2 proposal (`superseded_by_proposal_id` required) |

---

## Schema

### Table: `roadmap_proposal.proposal_migration_map`

```sql
CREATE TABLE roadmap_proposal.proposal_migration_map (
    id                        BIGSERIAL    PRIMARY KEY,
    legacy_proposal_id        TEXT         NOT NULL,          -- display_id, e.g. 'P123'
    canonical_proposal_id     TEXT,                           -- NULL for obsolete/duplicate
    classification            TEXT         NOT NULL           -- see vocabulary above
        CHECK (classification IN (
            'retained', 'delivered_evidence', 'duplicate',
            'obsolete', 'reauthor_needed', 'superseded'
        )),
    rationale                 TEXT,
    evidence_refs             JSONB        NOT NULL DEFAULT '[]',
    superseded_by_proposal_id TEXT,                           -- required when classification='superseded'
    reviewed_by               TEXT,
    reviewed_at               TIMESTAMPTZ,
    created_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT pmm_legacy_unique UNIQUE (legacy_proposal_id),
    CONSTRAINT pmm_superseded_needs_replacement CHECK (
        classification <> 'superseded' OR superseded_by_proposal_id IS NOT NULL
    )
);
```

#### `evidence_refs` schema

Each array element is a JSON object:

```json
{"type": "<kind>", "ref": "<value>", "notes": "<optional>"}
```

Valid `type` values: `commit` | `ac_id` | `review_id` | `discussion_id` | `doc_path` | `migration_id`

**Example:**
```json
[
  {"type": "commit",       "ref": "6725408d"},
  {"type": "ac_id",        "ref": "P500-AC-3"},
  {"type": "migration_id", "ref": "118-p753-drop-transition-queue"}
]
```

### Constraints and invariants

| Constraint | Enforced by |
|---|---|
| One mapping row per legacy proposal | `UNIQUE (legacy_proposal_id)` |
| `superseded` rows must name a replacement | `CHECK` constraint |
| `updated_at` stays current | `BEFORE UPDATE` trigger `fn_pmm_set_updated_at` |
| `obsolete`/`duplicate` rows may have no `canonical_proposal_id` | No NOT NULL on that column |

---

## Query Surfaces

Four views in the `roadmap` schema cover the main operational needs of classification agents.

### `roadmap.v_migration_unresolved`

Rows that are classified but not yet linked to a canonical agentHive2 node. Excludes `obsolete` and `duplicate` — those intentionally have no heir.

**Use case:** Inventory agent (P998) polls this view to discover proposals that still need a canonical mapping.

### `roadmap.v_migration_duplicate_superseded`

Rows classified as `duplicate` or `superseded`. For `superseded` rows the `superseded_by_proposal_id` column is always populated (enforced by constraint).

**Use case:** Generates the "replaced proposals" section of the agentHive2 documentation projection.

### `roadmap.v_migration_delivered_evidence`

Rows classified as `delivered_evidence`. Includes `evidence_refs` for linking commits, ACs, and reviews.

**Use case:** Feeds the "Completed Work Inventory" documentation view defined in P995 AC-6.

### `roadmap.v_migration_needs_review`

Rows missing `reviewed_by`, `rationale`, or both. Includes a `gap` column with a human-readable description.

**Use case:** Gate-evaluator and operator dashboard surface for audit completeness.

---

## Indexes

| Index | Condition | Purpose |
|---|---|---|
| `idx_pmm_canonical` | `canonical_proposal_id IS NOT NULL` | Fast reverse-lookup: all legacy → one canonical |
| `idx_pmm_classification` | — | Aggregations and classification-filtered scans |
| `idx_pmm_unresolved` | `canonical IS NULL AND classification NOT IN (...)` | Powers `v_migration_unresolved` without seqscan |
| `idx_pmm_needs_review` | `reviewed_by IS NULL OR rationale IS NULL` | Powers `v_migration_needs_review` without seqscan |

---

## Population Plan (Minimal Bootstrap)

Large-scale population is owned by the inventory child (P998). The minimal bootstrap for this schema child is:

1. **Run migration 135.** Creates table, trigger, indexes, and views.
2. **Seed classification vocabulary in `roadmap.app_config`** (optional, informational):
   ```sql
   INSERT INTO roadmap.app_config (config_key, config_value, config_category, description)
   VALUES ('P997.classification_vocab', '["retained","delivered_evidence","duplicate","obsolete","reauthor_needed","superseded"]', 'migration', 'P997 legacy-to-agentHive2 classification vocabulary') ON CONFLICT DO NOTHING;
   ```
3. **Inventory agent (P998)** INSERTs rows via direct SQL or an MCP tool wrapper.

### Minimal agent INSERT pattern

```sql
INSERT INTO roadmap_proposal.proposal_migration_map
    (legacy_proposal_id, canonical_proposal_id, classification, rationale, evidence_refs, reviewed_by, reviewed_at)
VALUES
    ('P123', 'P501', 'delivered_evidence',
     'Completed with 5 verified ACs; commits a1b2c3d, e4f5g6h reference it as canonical implementation.',
     '[{"type":"commit","ref":"a1b2c3d"},{"type":"ac_id","ref":"P123-AC-1"}]',
     'alan', now())
ON CONFLICT (legacy_proposal_id) DO UPDATE
    SET canonical_proposal_id     = EXCLUDED.canonical_proposal_id,
        classification            = EXCLUDED.classification,
        rationale                 = EXCLUDED.rationale,
        evidence_refs             = EXCLUDED.evidence_refs,
        reviewed_by               = EXCLUDED.reviewed_by,
        reviewed_at               = EXCLUDED.reviewed_at;
```

---

## Acceptance Criteria Mapping

| AC | Addressed by |
|---|---|
| AC-1: schema with all required fields | Table definition — all nine fields present |
| AC-2: classification constrained to P995 vocabulary | `CHECK` constraint + trigger |
| AC-3: query surfaces for unresolved / duplicate+superseded / delivered-evidence / needs-review | Four views in `roadmap` schema |
| AC-4: artifact is projection helper, not lifecycle source of truth | This doc + table `COMMENT` + schema separation (`roadmap_proposal` vs `roadmap_proposal.proposal`) |
| AC-5: minimal migration + population plan | Migration 135 + Bootstrap section above |

---

## Related Proposals

| Proposal | Relationship |
|---|---|
| P995 | Parent — agentHive2 proposal stack re-authoring; defines the mapping requirement |
| P998 | Blocked by P997 — inventory child that populates this table at corpus scale |
| P999 | Blocked by P997 — corpus classification child |
