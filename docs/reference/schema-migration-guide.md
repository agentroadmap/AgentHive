# Schema Migration Guide (AgentHive v2)

**Canonical conventions:** See `CONVENTIONS.md` (repo root) for all shared rules — workflow, MCP, DB, Git, governance.

**Schema migration context:**
- `docs/pillars/1-proposal/new-data-model-guide.md` — current v2 data model rules
- `docs/pillars/1-proposal/data-model-change.md` — migration analysis
- `database/ddl/roadmap-baseline-2026-04-13.sql` — full schema baseline (snapshot applied 2026-04-13)
- `database/ddl/v4/` — ordered delta migrations applied on top of the baseline (002–056+)
- `database/ddl/hivecentral/` — hiveCentral control-plane DDL (000–015+)
- `docs/features/P305-schema-drift-ship-report.md` — column drift log + v4 delta inventory

> **Note:** `roadmap-ddl-v2.sql` and `roadmap-ddl-v2-additions.sql` are retired filenames; do not reference them.

**Database conventions:** See CONVENTIONS.md section 6 (Database Conventions) for DDL/DML rules, schema qualification, rollout patterns, and proposal-gated changes.
