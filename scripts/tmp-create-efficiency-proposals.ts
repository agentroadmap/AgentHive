import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
const client = new Client({ name: "hermes", version: "1.0.0" });
await client.connect(transport);

const proposals = [
  {
    type: "feature",
    title: "Multi-Platform Subscription Registry & Model Catalog",
    summary: `## Problem

AgentHive orchestrates agents across Claude, Codex, Copilot, Hermes (Nous), Gemini, and OpenRouter. Each platform has different auth, models, costs, speed, and quota. Currently there's no registry — the spawner hardcodes CLI builders with no awareness of cost, capability, or quota.

When multiple platforms are available, the orchestrator should allocate work based on:
- Task difficulty (architecture review → opus, code fix → sonnet)
- Cost (cheapest model that can handle the task)
- Quota remaining (don't exhaust claude quota on trivial tasks)
- Platform health (if provider is down, reroute automatically)

## Design

### New Tables

\`\`\`sql
-- Platform subscriptions
CREATE TABLE roadmap_efficiency.platform_registry (
    id SERIAL PRIMARY KEY,
    provider TEXT NOT NULL UNIQUE,  -- claude, codex, copilot, nous, openrouter, xiaomi
    auth_method TEXT NOT NULL,       -- host_login, api_key, oauth, subscription
    auth_status TEXT DEFAULT 'unknown', -- active, expired, rate_limited, down
    quota_daily INTEGER,             -- max calls/day (NULL = unlimited)
    quota_used_today INTEGER DEFAULT 0,
    cost_budget_usd NUMERIC(10,2),   -- daily spend cap
    spent_today_usd NUMERIC(10,4) DEFAULT 0,
    health_check_url TEXT,
    last_health_check TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'
);

-- Model capabilities and costs
CREATE TABLE roadmap_efficiency.model_catalog (
    id SERIAL PRIMARY KEY,
    model_name TEXT NOT NULL,         -- claude-opus-4-6, gpt-4o, xiaomi/mimo-v2-pro
    provider TEXT NOT NULL REFERENCES platform_registry(provider),
    capability_tier TEXT NOT NULL,    -- premium, standard, economy
    cost_per_1k_input NUMERIC(8,6),
    cost_per_1k_output NUMERIC(8,6),
    max_context_tokens INTEGER,
    speed_tokens_per_sec NUMERIC(6,1),
    supports_tools BOOLEAN DEFAULT true,
    supports_vision BOOLEAN DEFAULT false,
    strengths JSONB,                  -- ["reasoning", "coding", "analysis"]
    is_available BOOLEAN DEFAULT true,
    UNIQUE(model_name, provider)
);

-- Usage tracking
CREATE TABLE roadmap_efficiency.usage_ledger (
    id BIGSERIAL PRIMARY KEY,
    agent_run_id BIGINT,
    model_name TEXT NOT NULL,
    provider TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd NUMERIC(8,6),
    task_type TEXT,                   -- gate_review, code_gen, research, etc.
    created_at TIMESTAMPTZ DEFAULT now()
);
\`\`\`

### Routing Logic

The orchestrator evaluates task metadata and selects the best model:

\`\`\`
task.difficulty + task.type + available_platforms + quota_remaining + cost_budget
    → ranked list of (model, provider) pairs
    → pick first available
\`\`\`

### Routing Rules (configurable)

| Task Type | Preferred | Fallback | Max Cost |
|-----------|-----------|----------|----------|
| Gate review (D3/D4) | opus, o3 | sonnet, gpt-4o | $0.50 |
| Code generation | sonnet, gpt-4o | mimo-v2-pro | $0.20 |
| Research/enhance | opus, o3 | sonnet | $0.30 |
| Simple verification | haiku, mimo | any economy | $0.05 |

### MCP Tools

- \`platform_list\` — show all platforms, auth status, quota remaining
- \`model_route\` — given task metadata, return recommended (model, provider)
- \`usage_report\` — cost/token usage per provider, per day, per proposal
- \`quota_check\` — can this provider handle N more requests today?

## Acceptance Criteria

1. platform_registry table populated with all 6 providers (claude, codex, copilot, nous, openrouter, xiaomi) with auth method and quota
2. model_catalog has at least 10 models with cost, capability tier, context size, and speed
3. orchestrator dispatch includes model selection based on task difficulty metadata
4. gate_task_templates include difficulty hint (easy/medium/hard) that influences model routing
5. MCP tool model_route returns ranked (model, provider) for a given task description
6. Usage ledger tracks every agent run with tokens, cost, model, provider
7. Dashboard shows: providers online, quota remaining, cost/day, cost/proposal`,
    motivation: "We have 6+ AI platforms available but no way to intelligently route work across them. Everything goes to the default model. We need cost-aware, capability-aware, quota-aware routing."
  },
  {
    type: "feature",
    title: "Layered Memory System — Task, Project, Team, Society, Individual",
    summary: `## Problem

Agents start every session with zero context. They reconstruct understanding from scratch, burning tokens on re-reading proposals, re-discovering conventions, re-learning what other agents already decided. The 826 passing ACs in P164 (Briefing assembler) prove context assembly matters — but it's one layer. We need memory at every scope.

## Design

### Memory Layers

\`\`\`
Layer       Scope           Store                    TTL          Example
─────────── ─────────────── ──────────────────────── ──────────── ──────────────────────────
Task        current work    agent_context table      session      "working on AC-3 of P169"
Project     proposal tree   roadmap DB + knowledge   permanent    "P169 is about audit log"
Team        squad shared    team_memory table         days         "we decided opus for gates"
Society     all agents      knowledge_entries        permanent    "Ostrom governance mapped"
Individual  per-agent       agent_memory table        weeks        "I prefer concise output"
\`\`\`

### New Tables

\`\`\`sql
-- Team shared memory (scoped to working group)
CREATE TABLE roadmap_efficiency.team_memory (
    id BIGSERIAL PRIMARY KEY,
    team_name TEXT NOT NULL,          -- "gate-squad", "pillar-47-team"
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    created_by TEXT NOT NULL,         -- agent_identity
    expires_at TIMESTAMPTZ,           -- NULL = permanent
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(team_name, key)
);

-- Individual agent memory (persistent across sessions)
CREATE TABLE roadmap_efficiency.agent_memory (
    id BIGSERIAL PRIMARY KEY,
    agent_identity TEXT NOT NULL,
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    importance INTEGER DEFAULT 5,     -- 1-10, higher = kept longer
    last_accessed TIMESTAMPTZ DEFAULT now(),
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(agent_identity, key)
);

-- Pre-built context packages (cached for reuse)
CREATE TABLE roadmap_efficiency.context_packages (
    id BIGSERIAL PRIMARY KEY,
    proposal_id BIGINT,
    package_type TEXT NOT NULL,       -- "gate_review", "code_gen", "research"
    context_text TEXT NOT NULL,       -- assembled context ready to inject
    token_count INTEGER,
    hit_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    expires_at TIMESTAMPTZ,
    UNIQUE(proposal_id, package_type)
);
\`\`\`

### Context Construction Pipeline

Before dispatching an agent, build a context package:

\`\`\`
1. Proposal body + ACs + status
2. Relevant code files (from worktree diff)
3. Team decisions (from team_memory)
4. Project conventions (from CLAUDE.md excerpts)
5. Related proposals (from dependency graph)
6. Recent gate decisions (from gate_decision_log)
\`\`\`

This context is injected as the first part of the task prompt. The agent starts with full understanding, not zero.

### Memory Decay

- Individual memory: importance-based decay. Low-importance entries expire after 2 weeks. High-importance entries (10) persist until manually cleared.
- Team memory: expires after squad disbands or TTL.
- Context packages: invalidated when proposal state changes.

## Acceptance Criteria

1. team_memory table exists with CRUD MCP tools (team_mem_set, team_mem_get, team_mem_list)
2. agent_memory table exists with per-agent key-value store
3. context_packages table caches assembled context for proposals
4. When dispatching a gate agent, the spawner builds a context package (proposal + ACs + recent decisions) and injects it into the task prompt
5. Team memory is queryable by other agents in the same squad
6. Agent memory persists preferences across sessions (e.g., "output format: concise")
7. Context packages are invalidated when proposal status or AC status changes`,
    motivation: "Agents waste tokens reconstructing context every session. Layered memory — task, project, team, society, individual — lets agents start with understanding instead of zero."
  },
  {
    type: "feature",
    title: "Token Efficiency — Context Construction, Caching & Anti-Drift",
    summary: `## Problem

P090 (Token Efficiency) is marked COMPLETE with 0/5 ACs passing. P189 confirms the semantic cache exists but nothing reads or writes it. We need actual token efficiency, not just tables.

The biggest token wastes:
1. Reconstructing context from scratch every session
2. Using expensive models for simple tasks
3. Agents drifting from their task without detection
4. No caching of repeated queries (prop_get called 10x for same proposal)

## Design

### 1. Context Construction (build once, use many)

Before spawning an agent, assemble exactly the context it needs:

\`\`\`
Input: proposal_id, task_type, difficulty
Output: structured context string (target < 2000 tokens)

Components:
- Proposal: title, summary, status, maturity (~200 tokens)
- ACs: only pending ones with their criteria (~300 tokens)
- Relevant code: git diff or specific files (~500 tokens)
- Conventions: CLAUDE.md excerpts relevant to task (~300 tokens)
- Decisions: last 3 gate decisions on this proposal (~200 tokens)
- Team context: relevant team_memory entries (~200 tokens)
\`\`\`

vs. current approach: dump entire CLAUDE.md (2000+ tokens) + proposal body (1000+ tokens) + all ACs including passing (500+ tokens) = 3500+ tokens wasted.

### 2. Query Cache

Cache repeated MCP lookups within a session:

\`\`\`sql
CREATE TABLE roadmap_efficiency.query_cache (
    cache_key TEXT PRIMARY KEY,       -- hash of tool + arguments
    result_json JSONB NOT NULL,
    hit_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    expires_at TIMESTAMPTZ DEFAULT now() + interval '1 hour'
);
\`\`\`

When \`prop_get(id=169)\` is called, check cache first. Return cached result in 0 tokens instead of making another API call.

### 3. Anti-Drift Detection

Agents sometimes go off-track. Detect and kill early:

\`\`\`
Every N iterations (configurable, default 5):
1. Compare agent's recent output against task ACs
2. Score relevance: are they working on what they were asked?
3. If relevance < threshold: log warning, send correction prompt
4. If relevance < critical: kill agent, save remaining tokens
\`\`\`

Implementation: the spawner monitors stdout for keywords related to the task. If the agent starts outputting unrelated content, it's drifting.

### 4. Shared Context Between Agents

When multiple agents work on the same proposal, share context:

\`\`\`
Agent A (developer) works on P169 → writes context to team_memory
Agent B (reviewer) reviews P169 → reads Agent A's context from team_memory
Agent B starts with full understanding of what Agent A did
\`\`\`

No token cost for re-reading — context is a DB lookup, not an LLM call.

## Acceptance Criteria

1. Context construction function builds targeted context (< 2000 tokens) for any proposal + task type
2. Gate agent dispatch includes constructed context in task prompt (not raw CLAUDE.md dump)
3. query_cache table exists and MCP tools check it before making DB queries
4. Semantic cache (P090) is actually populated on first read and used on subsequent reads
5. Anti-drift monitor checks agent output every 5 iterations and flags drift
6. Token count per agent run is tracked in usage_ledger
7. Side-by-side comparison: same gate review with old approach (3500+ tokens) vs new (2000 tokens) shows >40% reduction`,
    motivation: "P090 claims token efficiency but has 0 implementation. P189 confirms the cache is empty. We need actual context construction, query caching, and anti-drift — not just database tables."
  }
];

for (const p of proposals) {
  try {
    const r = await client.callTool({
      name: "prop_create",
      arguments: {
        type: p.type,
        title: p.title,
        summary: p.summary,
        motivation: p.motivation,
      }
    });
    console.log(`${p.title.substring(0, 60)}... → ${r.content?.[0]?.text?.substring(0, 100)}`);
  } catch (e) {
    console.log(`ERROR: ${p.title} → ${e}`);
  }
}

await client.close();
console.log("Done");
