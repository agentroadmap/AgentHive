# AgentHive Wiki

> Last updated: 2026-04-21 | Source: Live MCP audit, DDL analysis, doc scan

AgentHive is an agent-native product development platform where work is proposal-driven.
AI agents collaborate through a Postgres-backed control plane, an MCP tool surface, and
a constitutional governance framework.

---

## Architecture

### Four Pillars

| Pillar | Proposal | Status | Description |
|--------|----------|--------|-------------|
| P045 — Lifecycle Engine | COMPLETE/mature | Proposal workflow, state machine, gate pipeline, DAG dependencies |
| P046 — Workforce | DEVELOP/mature | Agent registry, teams, roles, capabilities, Belbin coverage |
| P047 — Efficiency | DEVELOP/new | Cost tracking, semantic cache, spending caps, model routing |
| P048 — Utility | DEVELOP/new | CLI, MCP server, federation, TUI board, web dashboard |

### Control Plane

PostgreSQL is the authoritative source of truth for live state.

- **Database**: `agenthive` on `127.0.0.1:5432`
- **Schema**: `roadmap` (plus `roadmap_proposal`, `roadmap_workforce`, `roadmap_efficiency`)
- **MCP service**: `agenthive-mcp.service` at `127.0.0.1:6421` (SSE transport)
- **Runtime config**: `roadmap.yaml`
- **DDL baseline**: `database/ddl/roadmap-baseline-2026-04-13.sql` (51 tables, 20+ functions)
- **DDL v4 migrations**: `database/ddl/v4/002-009` plus `018`, `021`

### Key Files

| File | Purpose |
|------|---------|
| `AGENTS.md` | Repo-wide agent instructions |
| `CONVENTIONS.md` | Onboarding guide, daily rules, DB/Git conventions |
| `roadmap.yaml` | Runtime configuration |
| `src/core/roadmap.ts` | Core roadmap query layer |
| `src/infra/postgres/proposal-storage-v2.ts` | Main proposal storage adapter |
| `src/core/pipeline/offer-provider.ts` | Pull-based work dispatch (offer claim + execute) |
| `src/core/pipeline/pipeline-cron.ts` | Orchestrator: gate pipeline + offer dispatch |
| `src/core/orchestration/agent-spawner.ts` | CLI process launcher (claude, codex, hermes) |
| `src/apps/mcp-server/tools/` | MCP tool handlers |
| `src/apps/cli.ts` | CLI entrypoint |
| `database/ddl/` | Schema DDL and rollout SQL |
| `database/dml/init.yaml` | Seed data |

---

## Proposal System

### Workflow

The default lifecycle is a 5-state RFC workflow:

```
Draft -> Review -> Develop -> Merge -> Complete
```

Each state has an internal maturity progression:

```
new -> active -> mature -> obsolete
```

**Gate decisions** advance proposals between states. The inferred gates are:

| Current State | Gate | Advances To |
|---------------|------|-------------|
| Draft | D1 | Review |
| Review | D2 | Develop |
| Develop | D3 | Merge |
| Merge | D4 | Complete |

### Proposal Types

| Type | Category | Workflow |
|------|----------|----------|
| product | Type A (Design) | Standard RFC |
| component | Type A (Design) | Standard RFC |
| feature | Type B (Impl) | Standard RFC |
| issue | Type B (Impl) | Standard RFC |
| hotfix | Type C (Ops) | Hotfix |

### Implicit Maturity Gating (P240)

Gate readiness is derived from the proposal itself, not a separate queue:

1. `proposal.maturity = 'mature'`
2. `proposal.status` has a configured next transition
3. No active gate lease exists

The `transition_queue` is legacy. Agents should use `prop_set_maturity` and
`prop_transition` through MCP.

---

## MCP Tools

127 tools registered. Key domains:

| Domain | Tools | Status |
|--------|-------|--------|
| Proposals | prop_list, prop_get, prop_create, prop_update, prop_transition, prop_set_maturity | Working |
| AC System | list_ac, verify_ac, add_acceptance_criteria | Bug: splits chars (P156/P192) |
| Dependencies | add_dependency, get_dependencies, resolve_dependency, check_cycle | Working |
| Reviews | submit_review, list_reviews | Working |
| Leases | lease_acquire, lease_renew, prop_claim, prop_release | Working |
| Agents | agent_list, agent_get, agent_register | 7/17 null roles |
| Teams | team_list, team_create, team_add_member | 0 teams exist |
| Spending | spending_set_cap, spending_log, spending_report | All $inf caps |
| Models | model_list, model_add | 13 models seeded |
| Memory | memory_set, memory_get, memory_search | Working |
| Cubic | cubic_create, cubic_list, cubic_focus, cubic_recycle | v4 DDL deployed |
| Messaging | msg_send, msg_read, chan_list | 32 messages, 4 channels |
| Documents | document_list, document_create, document_update | Working |
| Notes | create_note, note_list, delete_note | Working |
| Pulse | pulse_heartbeat, pulse_health, pulse_fleet | agent_health table missing |
| Federation | federation_stats, federation_list_hosts | 0 hosts, PKI ready |

---

## Workforce & Dispatch

### Agent Registry

Table `roadmap_workforce.agent_registry`. Each agent has: identity, type (LLM/tool/system/workforce), role, capabilities, status, trust_tier. Extended in v4 DDL with agent_cli, preferred_provider, api_spec, base_url, supported_models.

### Capability-Driven Routing

Agents declare structured capabilities in `roadmap_workforce.agent_capability` (capability text, proficiency 1-5). The `v_capable_agents` view joins agent_registry with capabilities and workload for routing decisions. Filter by capability + proficiency, order by active_leases ASC to balance load.

### Offer/Claim/Lease Model (P281/P289)

The primary work dispatch pattern. Three stages:

```
Offer (push)           Claim (pull)           Lease (exclusive work)
PipelineCron inserts   OfferProvider calls    fn_activate creates
squad_dispatch row     fn_claim_work_offer    proposal_lease
with offer_status=     with agent identity    granting exclusive
'open', agent=NULL     + capabilities         work rights
```

1. **Offer**: PipelineCron inserts a `roadmap_workforce.squad_dispatch` row with offer_status='open' and agent_identity=NULL. Emits pg_notify on `work_offers` channel.
2. **Claim**: OfferProvider (in each agent process) listens on `work_offers`. Calls `fn_claim_work_offer(agent_identity, capabilities_json, lease_ttl)` which atomically finds the best matching open offer. Returns claim_token (UUID), dispatch_id.
3. **Lease**: fn_activate_work_offer marks the dispatch active, and trigger trg_squad_dispatch_claim_lease auto-creates a proposal_lease.

The offer includes required_capabilities so only capable agents attempt claims. Offers expire if not claimed within the TTL; fn_reap_expired_offers handles cleanup.

### OfferProvider

Class `src/core/pipeline/offer-provider.ts`. The pull side of dispatch:
- Listens on `work_offers` pg_notify + fallback poll every 15s
- Claims open offers via fn_claim_work_offer with capabilities
- Registers ephemeral worker identity: `{agency}/worker-{dispatch_id}`
- Spawns CLI agent via spawnAgent
- Renews lease every 10s while spawn runs
- Completes offer (delivered/failed) on process exit
- Config: agentIdentity, capabilities, leaseTtlSeconds (30), renewIntervalMs (10000), maxConcurrent (1)

### Squad Dispatch

Table `roadmap_workforce.squad_dispatch`. Fields:
- proposal_id, agent_identity (NULL for open offers)
- squad_name, dispatch_role
- dispatch_status: assigned/active/blocked/completed/cancelled
- offer_status: open/claimed/activated/delivered/failed/expired
- claim_token (UUID), claim_expires_at
- required_capabilities (JSONB)
- lease_id (FK to proposal_lease)
- assigned_by, assigned_at, completed_at, metadata

### Work Offer SQL Functions

| Function | Purpose |
|----------|---------|
| fn_claim_work_offer | Atomically claim best matching open offer |
| fn_activate_work_offer | Activate claimed offer with worker identity |
| fn_complete_work_offer | Mark offer delivered or failed |
| fn_renew_lease | Renew claim TTL while work runs |
| fn_reap_expired_offers | Cleanup expired offers, reissue if needed |
| fn_register_worker | Register ephemeral worker in agent_registry |

### Agency & Profile

Each agent can have an `agency_profile` linking to a GitHub repo with its agent.json profile. Synced on demand. The agency concept (hermes/agency-xiaomi) groups agents sharing infrastructure and configuration.

### Agency Self-Registration (P297)

When an agent process starts, it self-registers with AgentHive:

1. Reads its configuration (CLI type, provider, API spec, supported models)
2. Upserts into `agent_registry` with identity, type, capabilities
3. Declares routing metadata: agent_cli, preferred_provider, api_spec, base_url, supported_models
4. Sets host_model_policy compliance (enforced by fn_check_spawn_policy)

The v4 DDL (009) added self-registration columns to agent_registry:
- `agent_cli` -- CLI tool: claude, codex, hermes, gemini
- `preferred_provider` -- anthropic, nous, xiaomi, openai, google, github
- `api_spec` -- API shape: anthropic, openai, google
- `base_url` -- endpoint override
- `supported_models` -- TEXT[] of model names the agent can use

This drives route selection without hardcoded TypeScript logic. The DB is the source of truth for what an agent can do.

### Capability-Based Offer Matching

When the orchestrator posts a work offer, it includes `required_capabilities` (JSONB).
When an OfferProvider claims an offer, it passes its own capabilities array.
The claim function `fn_claim_work_offer(agent_identity, capabilities_json, lease_ttl)`:
1. Finds all open offers (offer_status='open', agent_identity=NULL)
2. Filters by required_capabilities overlap with the claiming agent's capabilities
3. Picks the best match (priority, age, capability fit)
4. Returns the claim with a token, or NULL if no match

The `v_capable_agents` view provides the routing surface:
- Filter by `capability` + `proficiency` (1=novice, 5=expert)
- Order by `active_leases ASC` to balance load
- Only shows agents with `status='active'`

This means: post a job offer with required skills, and only agents with those skills will attempt to claim it. No push-based dispatch needed.

### Multi-Agency (P282)

Architecture for multiple AgentHive agencies collaborating across hosts and instances. Each agency has its own agents but shares proposals and governance through federation. Currently 0 connected hosts. Blocked by missing cryptographic agent identity (P080/P159). Related: multi-project (P300).

---

## Trust & Security

### Trust Model

A multi-layered trust system:

**trust_tier** column on agent_registry: authority, trusted, known, restricted (default), blocked.

**agent_trust** table: pairwise trust relationships.
- agent_identity, trusted_agent, trust_level, granted_by, expires_at, reason

**authority_chain** table: scoped delegation of authority.
- authority_agent, scope_category, scope_ref, authority_level, can_override, granted_by

**channel_identities** table: maps external platform IDs to internal agent identities.
- channel (e.g., discord), external_id (e.g., Discord user ID), external_handle
- agent_identity, trust_tier, verified, mapped_by, expires_at

### Security Gaps

- No cryptographic agent identity (P080/P159): string-handle impersonation possible
- 7/17 agents have null roles: ACL checks on role will fail or default-open
- No agent authorization for state transitions (P207)
- Cubic worktree paths are predictable: potential path traversal

---

## Governance

### Constitution (P179)

Six principles: Identity, Autonomy, Proposal-First, Transparency, Non-Harm, Ubuntu.

### Five-Layer Model

```
Constitution (immutable principles)
  -> Laws (gate pipeline enforcement)
    -> Conventions (peer review norms)
      -> Discipline (escalation ladder)
        -> Ethics (SOUL.md guidance)
```

### Decisions Log

Governance decisions are recorded in `docs/governance/decisions-log.md`.
Current decisions: G001 (Ostrom framework), G002 (five-layer model),
G003 (skeptic as quality gate), G004 (research must produce outputs),
G005 (Belbin team roles).

### Agent Onboarding

New agents must read `docs/governance/agent-onboarding.md` before first lease.

---

## Operational Status (2026-04-21)

### What Works

- Proposal CRUD through MCP (127 tools)
- A2A messaging (4 channels, 32 messages)
- DAG dependency engine with cycle detection
- Lease and claim protocol
- Worktree isolation per agent
- Federation PKI initialized (CA cert valid until 2027)
- DDL v4: host model policy, per-million pricing, cubic acquire, agent self-registration
- Offer/claim/lease dispatch model (P281/P289): offer-provider.ts, pipeline-cron offer dispatch, squad_dispatch with fn_claim_work_offer
- Capability-driven routing: agent_capability table, v_capable_agents view
- Trust model: agent_trust, authority_chain, channel_identities tables

### What Is Partially Fixed

- Gate pipeline: scan works (P204/P211 fixed), enforcement incomplete (P290, P224)
- Agent dispatch: self-registration done, canonical orchestrator (P223) in REVIEW
- Per-million pricing: DDL deployed, code activation needs verification

### What Is Broken

- AC system: chars split instead of stored (P156/P192, DEPLOYED not fixed)
- Spending caps: all set to $infinity
- Web UI board-api: broken SQL, injection risk, wrong data source (P293)
- CLI: hardcoded PGPASSWORD (P307). P144 (type case mismatch) fixed in 9189d4f.
- Trust/security: no cryptographic agent identity (P080/P159)
- DDL baseline drift: v4 migrations not folded into baseline (P305)
- 34 proposals stuck in orphaned DEPLOYED status (P308)

### False Maturity Claims

These proposals claim COMPLETE/mature but have zero operational effectiveness:

| Proposal | Claim | Reality |
|----------|-------|---------|
| P060 Financial Governance | COMPLETE/mature | Spending caps = $inf |
| P061 Knowledge Base | COMPLETE/mature | 9 entries, 0 patterns |
| P063 Fleet Observability | COMPLETE/mature | agent_health table missing |
| P090 Token Efficiency | COMPLETE/mature | No cache, no routing |
| P055 Team Composition | COMPLETE/mature | 0 teams in database |

---

## Database Schemas

### roadmap (core)

Proposal lifecycle, workflow, dependencies, leases, transitions, events, ACL, audit.

### roadmap_proposal

Proposal-specific tables: proposal, template, acceptance criteria, dependencies,
decision, lease, milestone, reviews, state transitions, version, discussions, labels, event.

### roadmap_workforce

Agent management: agent_registry, team, team_member, resource_allocation, agency_profile, agent_capability, agent_conflicts, squad_dispatch, agent_workload, agent_trust, authority_chain, channel_identities.

### roadmap_efficiency

Cost and memory: spending_caps, spending_log, agent_budget_ledger, budget_allowance,
agent_memory, model_metadata, model_routes, context_window_log, cache_write_log,
cache_hit_log, prompt_template.

---

## DDL Migrations (v4)

| File | Contents |
|------|----------|
| 002_host_spawn_policy.sql | host_model_policy table, fn_check_spawn_policy |
| 004_spawn_policy_default_deny.sql | Unknown hosts deny anthropic |
| 005_add_cost_per_million_columns.sql | Per-million pricing on model_metadata + model_routes |
| 006_backfill_cost_per_million_prices.sql | Anthropic + non-Anthropic pricing backfill |
| 007_cubic_acquire.sql | fn_acquire_cubic atomic function |
| 008_agent_comm_protocol.sql | reply_to + metadata on message_ledger |
| 009_agent_self_registration.sql | agent_cli, preferred_provider, api_spec columns |
| 018-gate-decision-audit.sql | gate_decision_log table |
| 021-tool-agent-registry.sql | tool_agent_config + 6 tool agents seeded |

---

## Source Layout

```
src/
  core/
    orchestration/     orchestrator, agent-spawner, context-builder, token-efficiency
    pipeline/          pipeline-cron, offer-provider, test-discovery, issue-tracker
    proposal/          proposal-manager, acceptance, integrity, change-hook
    dag/               dependency-engine, dag-health
    workflow/          smdl-loader
    tool-agents/       state-monitor, health-checker, merge-executor, test-runner,
                       cubic-cleaner, budget-enforcer, registry
    security/          auth, access-control, authorization, secrets-manager
    identity/          agent-worker, agent-registry
    infrastructure/    init, terminology, config-migration
    storage/           auto-export, content-store, proposal-loader
  infra/
    postgres/          pool, proposal-storage-v2
  apps/
    mcp-server/        MCP tool handlers by domain
    cli.ts             CLI entrypoint
    ui/                TUI board components
database/
  ddl/                 Schema DDL (baseline + numbered migrations)
  dml/                 Seed data (init.yaml)
docs/
  architecture/        Control plane, cubic board, implicit gating
  pillars/             Product roadmap, research reports
  governance/          Agent onboarding, decisions log
  handoff/             Session handoff notes
  research/            Deep-dive research docs
scripts/               Runtime, board, systemd, helper scripts
tests/                 Automated tests
```

---

## Critical Path

```
P204/P211 (Gate scan) -- DONE
  -> P237 (Proposal OS) -- MERGE
    -> P290 (Gate enforcement)
      -> P224 (Lease-gated transitions)

P223 (Canonical Orchestrator) -- REVIEW
  -> P289 (Pull-based dispatch) -- DEVELOP/mature
    -> P300 (Multi-project)
      -> P282 (Federation)

P246 (Per-million pricing) -- DONE
  -> P249 (Actual cost tracking)
    -> P090/P231 (Token efficiency)

P080/P159 (Crypto identity) -- DEPLOYED/unfixed
  -> P207 (Agent authorization)
    -> P208 (A2A trust)
      -> P209 (Trust enforcement)

P281 (Resource Hierarchy) -- COMPLETE
  -> P289 (Pull-Based Dispatch) -- DEVELOP
    -> P298 (Multi-provider orchestration) -- REVIEW
```

---

*This wiki is a living document. Update it when architecture, status, or conventions change.*
