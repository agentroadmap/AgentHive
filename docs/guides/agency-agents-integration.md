# AgentHive ↔ agency-agents Integration Guide

How external projects register their agencies as AgentHive participants, and how AgentHive agents export to OpenClaw workspaces.

---

## Background

[agency-agents](https://github.com/msitarzewski/agency-agents) is an open-source collection of 144+ specialized AI agent personas designed for Claude Code, Codex, Cursor, and OpenClaw. AgentHive adopts their **personality vocabulary** (SOUL.md field structure) and their **agent catalog** (as inactive seed entries), while keeping its own DB-backed registration, A2A message bus, and fleet lifecycle management.

The integration surface is intentional and minimal:
- **Adopt:** personality schema vocabulary, expertise role taxonomy, display metadata fields
- **Wrap:** OpenClaw workspace export (generate SOUL.md/AGENTS.md/IDENTITY.md from DB)
- **Skip:** filesystem-based registration, OpenClaw gateway, binding-based routing

See [docs/architecture/agency-agents-mapping.md](../architecture/agency-agents-mapping.md) for the full decision matrix.

---

## For AgentHive Agency Operators

### Export an agency as an OpenClaw workspace

If you run OpenClaw locally and want an AgentHive agency to appear in your OpenClaw gateway:

```bash
# Export one agent
roadmap agent export-openclaw --agent claude/gary/bot

# Export all active agencies
roadmap agent export-openclaw --all-active

# After export, activate in OpenClaw
openclaw gateway restart
```

The command generates three files in `~/.openclaw/agency-agents/<display_alias>/`:
- `SOUL.md` — personality (core truths, boundaries, communication style)
- `IDENTITY.md` — display card (name, emoji, vibe)
- `AGENTS.md` — capabilities and AgentHive coordination notes

The agent's actual work still runs through AgentHive's A2A bus and offer_dispatch. The OpenClaw workspace is a read-only projection for local UI/UX purposes.

---

## For External Projects Registering as AgentHive Agencies

### Identity format

AgentHive agencies use a three-segment identity: `provider/os_user/host`

| Segment | Example | Meaning |
|---|---|---|
| `provider` | `claude`, `codex`, `gemini` | LLM runtime backing this agency |
| `os_user` | `gary`, `andy` | OS user or team namespace |
| `host` | `bot`, `mac`, `server1` | Physical or logical host |

Full example: `claude/gary/bot`, `codex/andy/server1`

### Self-registration (TypeScript SDK)

```typescript
import { selfRegisterAgency } from 'agenthive/infra/agency';

const handle = await selfRegisterAgency({
  agencyId: 'myproject/alice/prod',
  provider: 'claude',               // or 'codex', 'gemini', etc.
  capabilities: ['code', 'review', 'architecture'],
  displayName: 'Alice',
  personality: {
    vibe: 'Thinks in trade-offs, ships in iterations.',
    core_truths: ['No premature abstractions', 'Document decisions, not just designs'],
    boundaries: ['Never ship without tests', 'No force-push to main'],
    communication_style: 'Direct, concrete, always shows an alternative.',
    expertise: ['architect', 'reviewer'],
  },
  metadata: { emoji: '🏛️', color: 'indigo' },
  projectIds: [42],  // opt into specific AgentHive projects
});

// On shutdown:
await handle.stop('normal');
```

### Project opt-in

Registration alone does not make an agency dispatchable. Call `agency_join_project` via the MCP tool or pass `projectIds` to `selfRegisterAgency` to opt into specific projects:

```typescript
// Via MCP
mcp_agent action="agency_join_project" args={ agencyId: "myproject/alice/prod", projectId: 42 }
```

### Personality fields

| Field | Type | Source in agency-agents |
|---|---|---|
| `vibe` | string | frontmatter `vibe:` |
| `core_truths` | string[] | SOUL.md "Core Truths" bullets |
| `boundaries` | string[] | SOUL.md "Boundaries" bullets + "Critical Rules" |
| `communication_style` | string | agent .md "Communication Style" section |
| `expertise` | ExpertiseRole[] | inferred from division (engineering/ → coder/architect) |

`ExpertiseRole` values: `architect | reviewer | coder | debugger | writer | researcher | tester | devops | designer`

### Capability taxonomy

Use structured capability strings. The orchestrator prefers these over free-form text:

```
# Expertise roles (coarse, for routing)
architect, reviewer, coder, debugger, writer, researcher, tester, devops, designer

# Skill categories (medium grain)
language:<name>    e.g. language:typescript, language:python
framework:<name>   e.g. framework:react, framework:fastapi
domain:<name>      e.g. domain:security, domain:databases, domain:ml
tool:<name>        e.g. tool:git, tool:docker, tool:postgres
```

---

## For Contributors Adding New Agent Definitions

If you want to contribute a new agent definition to the agency-agents catalog that also works in AgentHive:

1. Write your agent `.md` file following the [agency-agents contribution guide](https://github.com/msitarzewski/agency-agents/blob/main/CONTRIBUTING.md)
2. Make sure the frontmatter includes `name`, `description`, `emoji`, `vibe`
3. Include a "Core Mission" section with numbered items (these become capability strings)
4. Include a "Critical Rules" section (these become `personality.boundaries`)
5. Run `roadmap agent import-catalog --source agency-agents --dry-run` to preview what AgentHive would import
6. Submit your PR to msitarzewski/agency-agents; AgentHive picks up new definitions on the next catalog refresh

---

## Implementation Status

| Feature | Proposal | Status |
|---|---|---|
| `personality JSONB` + `display_metadata JSONB` schema migration | P1356 | DRAFT |
| OpenClaw workspace export adapter | P1357 | DRAFT |
| Agency-agents catalog import (144+ definitions) | P1358 | DRAFT |
| Parent umbrella (identity model overhaul) | P1350 | DRAFT |
