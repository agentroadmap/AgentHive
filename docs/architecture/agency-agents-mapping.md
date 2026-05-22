# agency-agents / OpenClaw → AgentHive: Schema Mapping

**Source:** msitarzewski/agency-agents + docs.openclaw.ai  
**Target:** AgentHive `roadmap_workforce.agent_registry` + `agent_capability`  
**Status:** P1355 enrichment — adopt/wrap/skip decisions

---

## 1. Projects at a Glance

| Property | agency-agents/OpenClaw | AgentHive |
|---|---|---|
| Repo | github.com/msitarzewski/agency-agents | github.com/agenthive (private) |
| Runtime | OpenClaw gateway (Node.js, long-lived process) | selfRegisterAgency() → DB + liaison hub |
| Agent count | 144+ pre-built personas | N permanent agents + on-demand contract workers |
| Persistence | Markdown files on filesystem | PostgreSQL (hiveCentral + per-tenant DBs) |
| Routing | Binding-based (channel/peer/guild hierarchy) | A2A message bus + offer_dispatch + capability match |
| Multi-host | No (single gateway process) | Yes (provider/os_user/host identity; fleet-wide) |

---

## 2. Identity Model Comparison

### agency-agents / OpenClaw

**Agent definition frontmatter** (each `.md` file):
```yaml
---
name: Software Architect
description: Expert software architect specializing in system design…
color: indigo
emoji: 🏛️
vibe: Designs systems that survive the team that built them.
---
```

**OpenClaw workspace files** (per agent, in `~/.openclaw/agency-agents/<name>/`):

| File | Purpose | Key Fields |
|---|---|---|
| `SOUL.md` | Behavioral philosophy | Core Truths, Boundaries, Continuity (prose) |
| `IDENTITY.md` | Public display card | name, emoji, theme, creature, vibe, avatar |
| `AGENTS.md` | Operational procedures | startup checklist, task workflows, handoff patterns |
| `TOOLS.md` | Tool governance | allow[], deny[] |
| `MEMORY.md` | Persistent knowledge | seeded facts, patterns, preferences |
| `HEARTBEAT.md` | Scheduled tasks | time-interval checks, reports |
| `USER.md` | User context | name, timezone, expertise, access thresholds |

**OpenClaw `AgentConfig` type** (runtime config, not the Markdown files):
```typescript
{
  id: string;                    // unique agent identifier
  workspace: string;             // path to SOUL.md / AGENTS.md / IDENTITY.md
  agentDir: string;              // path to auth-profiles.json + per-agent state
  name?: string;
  model?: string;                // per-agent model selection
  identity?: { name, emoji, theme, creature, vibe, avatar };
  groupChat?: boolean;
  sandbox?: { mode: 'off'|'non-main'|'all', workspaceAccess, scope };
  tools?: { allow: string[], deny: string[] };
}
```

**Registration flow:**
1. `./scripts/convert.sh --tool openclaw` → writes workspace files
2. `openclaw gateway restart` → gateway reads `~/.openclaw/agents.json`, registers each workspace
3. Inbound messages routed by deterministic binding: peer > parent > guild/role > team > account > channel > default

---

### AgentHive

**`roadmap_workforce.agent_registry`** (live DB table):
```sql
agent_identity     text UNIQUE     -- "claude/gary/bot", "codex/andy/bot"
agent_type         text            -- 'agency' | 'coordinator' | 'llm' | 'human' | 'hybrid'
status             text            -- 'active' | 'dormant' | 'offline'
preferred_provider text            -- "claude", "codex", "gemini"
display_alias      text            -- "Claude-Bot", tier 1-3 naming
current_route_id   bigint FK       -- bound model route
metadata           jsonb           -- free-form; pid, etc.
skills             jsonb           -- legacy: {agentId, capabilities[], channel, lastSeen}
```

**`roadmap_workforce.agent_capability`** (flat text rows):
```sql
agent_id    bigint FK → agent_registry.id
capability  text       -- e.g. "code", "design", "review"
```

**`AgentRegistration` TypeScript type** (src/core/identity/agent-registry/types.ts):
```typescript
{
  agentId: string;          // "Andy", "xGit1"
  instanceId: string;       // unique: "Andy" (permanent), "xGit1-a3f2" (contract)
  agentType: 'permanent'|'contract';
  role?: string;            // "git-researcher", "CEO"
  capabilities: string[];
  channel: string;
  status: 'online'|'offline'|'busy'|'error';
}
```

**`Skill` interface** (src/core/identity/skill-registry.ts — populated but unused by dispatcher):
```typescript
{
  id: string;
  name: string;
  category: 'language'|'framework'|'tool'|'domain'|'testing'|'infrastructure'|'design'|'other';
  level: 'beginner'|'intermediate'|'advanced'|'expert';
  description?: string;
  relatedSkills?: string[];
}
```

---

## 3. Side-by-Side Mapping

| Dimension | agency-agents/OpenClaw | AgentHive today | Decision |
|---|---|---|---|
| **Identity key** | workspace name ("Software Architect") | `provider/os_user/host` URI | **Skip** — our URI format is more robust for multi-host fleets |
| **Display name** | `name` + `emoji` in frontmatter | `display_alias` (tier 1-3) | **Adopt** — add `metadata.emoji` + `metadata.vibe` to agent_registry |
| **Personality** | SOUL.md prose (Core Truths, Boundaries) | Not implemented | **Adopt** — map SOUL.md sections to `personality JSONB` column |
| **Memory namespace** | MEMORY.md file per workspace | Per-conversation MEMORY.md files | **Adopt** — add `memory_namespace` pointer to agent_registry |
| **Capability schema** | Markdown narrative only, no structure | `agent_capability(text[])` + `Skill{category,level}` | **Adopt** taxonomy — seed agent_capability with structured expertise roles |
| **Expertise roles** | Implicit in agent file (architect/reviewer/coder) | `agent_capability` unpopulated | **Adopt** — standardize role vocabulary from agency-agents |
| **Tool governance** | TOOLS.md allow/deny (file) | `tool-grant.ts` + `allowlist-check.ts` (DB) | **Skip** — our DB-backed model is more auditable |
| **Model selection** | `model: string` per agent | `model_routes` + `host_model_policy` table | **Skip** — our routing is more sophisticated |
| **Registration** | filesystem + gateway restart | DB upsert + advisory lock + liaison session | **Skip** — our model handles multi-host correctly |
| **Routing** | Binding-based (channel/peer/guild) | A2A + offer_dispatch + capability match | **Skip** — our model is purpose-built for task routing |
| **Heartbeat** | HEARTBEAT.md (Markdown scheduling) | 30s DB heartbeat + dormancy sweep | **Skip** — proper cron infra supersedes this |
| **Project membership** | Not supported | `provider_registry` opt-in | **Keep ours** — no equivalent in agency-agents |
| **Interop surface** | OpenClaw workspace files | — | **Wrap** — export adapter generates workspace files from DB |
| **Agent catalog** | 144+ pre-built definitions | Sparse | **Wrap** — one-time import as inactive agency seeds |

---

## 4. Personality JSONB Schema (to adopt)

Sourced from agency-agents SOUL.md vocabulary, mapped to structured fields:

```typescript
// src/core/identity/agent-registry/types.ts (to add)
export interface AgentPersonality {
  /** One-line character summary. Source: agency-agents 'vibe' frontmatter field. */
  vibe: string;
  /** Behavioral principles. Source: SOUL.md 'Core Truths' section bullets. */
  core_truths: string[];
  /** Hard limits / ethical guardrails. Source: SOUL.md 'Boundaries' section. */
  boundaries: string[];
  /** How this agent communicates. Source: agent .md 'Communication Style' section. */
  communication_style: string;
  /** Expertise role label(s). Maps to orchestrator routing categories. */
  expertise: ExpertiseRole[];
}

export type ExpertiseRole =
  | 'architect'
  | 'reviewer'
  | 'coder'
  | 'debugger'
  | 'writer'
  | 'researcher'
  | 'tester'
  | 'devops'
  | 'designer';
```

DB column: `ALTER TABLE roadmap_workforce.agent_registry ADD COLUMN personality JSONB;`

---

## 5. OpenClaw Export Adapter (to wrap)

Given an agent_registry row, generate:

**SOUL.md** from `personality.core_truths` + `personality.boundaries` + `personality.communication_style`  
**IDENTITY.md** from `display_alias` + `metadata.emoji` + `metadata.vibe`  
**AGENTS.md** from `agent_capability` rows + a standard preamble pointing to CONVENTIONS.md  

Output path: `~/.openclaw/agency-agents/<display_alias>/`

This lets an AgentHive agent appear as a first-class OpenClaw workspace. External contributors running OpenClaw can work alongside AgentHive agencies without needing direct DB access.

CLI: `roadmap agent export-openclaw [--agent-id <id>] [--all-active]`

---

## 6. Recommended Child Proposals

| Proposal | Scope | Depends on |
|---|---|---|
| **P1355-A** | Schema migration: add `personality JSONB` + `display_metadata JSONB` to agent_registry; backfill 4 permanent agents with agency-agents content | P1350-A (FK shape) |
| **P1355-B** | OpenClaw workspace export adapter: CLI command + generator utility | P1355-A |
| **P1355-C** | Agency-agents catalog import: one-time import script for 144+ definitions as inactive seeds | P1355-A |

---

## 7. References

- [msitarzewski/agency-agents](https://github.com/msitarzewski/agency-agents) — agent definitions
- [OpenClaw multi-agent docs](https://docs.openclaw.ai/concepts/multi-agent) — gateway + routing protocol
- [OpenClaw SOUL.md guide](https://www.stanza.dev/concepts/openclaw-soul-persona) — personality file format
- P1350 — parent umbrella proposal (identity model overhaul)
- `src/infra/agency/agency-self-registration.ts` — AgentHive registration implementation
- `src/core/identity/skill-registry.ts` — AgentHive Skill interface
