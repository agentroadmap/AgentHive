agentHive Token Efficiency — Comprehensive Engineering Plan
There are two distinct problem spaces here: your own Claude Code development workflow (immediate) and agentHive platform efficiency for your users (strategic). Both share the same root causes and a layered solution architecture.

Part 1: Understand Where Tokens Actually Go
Before optimizing, you need instrumentation. You can’t improve what you don’t measure.
For Claude Code (your dev workflow):
Use /context to get a per-category breakdown — system prompt, tools, memory files, skills, and conversation history. If memory files are eating 15% of your window before you start, that’s a fixable problem. ￼
The four main cost drivers are: tool call outputs (file reads, grep results, stack traces all accumulate), conversation history (every message including Claude’s own reasoning stays in context), repeated context (restating project goals), and verbose outputs (Claude defaults to thorough explanations when not constrained). ￼
For agentHive agents (your users):
The equivalent metrics to instrument in your PostgreSQL schema:
	•	input_tokens vs cache_read_tokens vs cache_write_tokens per agent invocation
	•	Context window utilization % at task start vs task end
	•	Cache hit rate: cache_read_tokens / total_input_tokens — target 70%+ for stable-prompt workloads ￼
	•	Write/read ratio — a high ratio means prompts are changing too often or TTLs are expiring before reuse
	•	Token cost per “unit of work” (per feature, per RFC step, per agent task)

Part 2: The Three-Tier Architecture
Every solution below maps to one of three layers. Implement them in this order — earlier layers give you the fastest return.

Tier 1: Semantic Cache     → Intercept ~30% of queries before LLM call
Tier 2: Prefix/KV Cache    → Reduce 70-90% of input token cost on LLM hits
Tier 3: Context Management → Control what enters the window at all


A well-architected system can combine these layers: semantic caching handles ~30% of queries outright, while prefix caching covers 70%+ of input tokens on the remaining requests. Combined savings can exceed 80% versus a naive implementation. ￼

Part 3: Anthropic Prompt Caching — Your Highest Leverage Move
This is already partially planned as “cache write to increase cache hit.” Here’s the full picture.
How it works:
Prompt caching references the entire prompt — tools, system, and messages (in that order) — up to and including the block marked with cache_control. Cache read tokens are priced at 0.1× base input price (90% discount). Cache write tokens cost 1.25× base. You need at least 2–3 cache reuses to break even on a write. ￼
Structural rule — static before dynamic:

// WRONG — dynamic content invalidates cache for everything after it
messages: [
  { role: "user", content: `User ID: ${userId}` },  // dynamic
  { role: "user", content: LARGE_SCHEMA_DOCS }       // static — never cached
]

// CORRECT — all static content prefixes dynamic content
system: [
  { type: "text", text: AGENT_PERSONA,        cache_control: { type: "ephemeral" } },
  { type: "text", text: SCHEMA_DOCUMENTATION, cache_control: { type: "ephemeral" } },
  { type: "text", text: MCP_TOOL_DESCRIPTIONS,cache_control: { type: "ephemeral" } },
],
messages: [
  { role: "user", content: dynamicTask }  // only this varies
]


Multi-agent parallelism warning: Cache creation takes 2–4 seconds for large documents. If you fire off 10 parallel requests before the first cache has been written, each request processes the full prompt independently — you get 10 cache writes, 0 reads, and a bill 5–10× what you expected. ￼ For agentHive’s multi-agent orchestration, serialize the first request (warm the cache), then fan out.
Cache TTL strategy:
Most models support a 5-minute TTL. Claude Opus 4.5, Haiku 4.5, and Sonnet 4.5 also support an extended 1-hour TTL option. ￼ For long-running agentHive workflows — your RFC pipeline, feature development loops — always use the 1-hour TTL on shared agent system prompts.

Part 4: Semantic Cache Layer (pgvector — Already Planned)
This sits upstream of every LLM call. If a semantically equivalent request has been answered before, return the cached result without touching the API.
Schema design for your roadmap context:

-- In your roadmap schema
CREATE TABLE token_cache.semantic_responses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_hash   text NOT NULL,                    -- exact match fast path
  embedding    vector(1536) NOT NULL,             -- pgvector semantic match
  query_text   text NOT NULL,
  response     jsonb NOT NULL,
  agent_role   text,                              -- scope cache by agent type
  model        text NOT NULL,
  input_tokens  int,
  created_at   timestamptz DEFAULT now(),
  hit_count    int DEFAULT 0,
  last_hit_at  timestamptz
);

CREATE INDEX ON token_cache.semantic_responses 
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);


Lookup logic (TypeScript):

async function semanticCacheLookup(
  query: string, 
  agentRole: string,
  threshold = 0.92   // tune per agent type
): Promise<CachedResponse | null> {
  const embedding = await embedQuery(query);
  
  const result = await db.query(`
    SELECT response, 1 - (embedding <=> $1) AS similarity
    FROM token_cache.semantic_responses
    WHERE agent_role = $2
      AND 1 - (embedding <=> $1) > $3
    ORDER BY embedding <=> $1
    LIMIT 1
  `, [embedding, agentRole, threshold]);
  
  if (result.rows[0]) {
    await db.query(`
      UPDATE token_cache.semantic_responses 
      SET hit_count = hit_count + 1, last_hit_at = now()
      WHERE id = $1
    `, [result.rows[0].id]);
    return result.rows[0].response;
  }
  return null;
}


Threshold calibration by agent type:
	•	Research/exploration agents: 0.88 (broader match acceptable)
	•	Code generation agents: 0.95 (higher precision needed)
	•	RFC review agents: 0.90

Part 5: Layered Memory & Context Management
This is your most complex planned feature. Here’s a concrete implementation model.
The three memory tiers:

Working Memory    → Current task context (in-context, ~20K tokens max)
Session Memory    → Current session summary + key decisions (compact on milestone)
Long-term Memory  → pgvector + structured facts (never in-context raw)


Context refresh/compact trigger points — implement as hooks or agent lifecycle events:

enum CompactTrigger {
  MILESTONE_COMPLETE  = 'milestone_complete',   // feature done, tests pass
  RESEARCH_DONE       = 'research_done',         // before implementation starts
  CONTEXT_PCT         = 'context_pct',           // at 50% window usage
  TASK_SWITCH         = 'task_switch',           // unrelated new task
  ERROR_RECOVERY      = 'error_recovery',        // after failed approach
}

async function maybeCompact(session: AgentSession): Promise<void> {
  const usage = await getContextUsage(session);
  
  if (usage.pct > 50 || session.pendingTrigger) {
    const summary = await generateCompactSummary(session, {
      preserve: ['architectural_decisions', 'constraints', 'completed_work'],
      drop:     ['exploration_paths', 'failed_attempts', 'verbose_reasoning']
    });
    await session.replaceHistoryWithSummary(summary);
    await persistSummaryToMemory(summary, session.agentId);
  }
}


Compacting at 95% (the default) means you’ve already filled 190K of 200K tokens. Compacting at 50% gives the agent much more room to work effectively. ￼
For Claude Code specifically, the env setting:

{
  "env": {
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "50",
    "MAX_THINKING_TOKENS": "10000",
    "CLAUDE_CODE_SUBAGENT_MODEL": "haiku"
  }
}


Extended thinking defaults to 31,999 tokens per request — a hidden cost. Reducing to 10K tokens cuts that by ~70%. Most coding tasks don’t need 32K thinking tokens. ￼

Part 6: Model Routing by Task Complexity
This is free money. Route each task to the cheapest model that can handle it.

type TaskComplexity = 'trivial' | 'standard' | 'complex' | 'architectural';

const MODEL_ROUTING: Record<TaskComplexity, string> = {
  trivial:      'claude-haiku-4-5-20251001',  // syntax, linting, status checks
  standard:     'claude-sonnet-4-6',           // 80% of implementation work
  complex:      'claude-sonnet-4-6',           // debugging, multi-file refactors
  architectural:'claude-opus-4-6',             // RFC review, architecture decisions
};

function classifyTask(task: AgentTask): TaskComplexity {
  if (task.type === 'lint' || task.type === 'format') return 'trivial';
  if (task.type === 'research' || task.type === 'rfc_review') return 'architectural';
  if (task.fileCount > 5 || task.estimatedTokens > 50_000) return 'complex';
  return 'standard';
}


Reserve high-reasoning models for critical, low-frequency tasks like architectural design or final code review. For the majority of high-frequency implementation work — syntax validation, linting, simple transforms, status checks — use faster, cheaper models like Haiku. ￼
For your subagent configuration in agentHive/OpenClaw: route research subagents to Haiku (they’re doing file reads and summarizing), route implementation agents to Sonnet, and only escalate to Opus for RFC synthesis and cross-pillar architecture.

Part 7: MCP Tool Scoping
Each enabled MCP server adds tool definitions to the system prompt, consuming context window. Use /context to identify MCP server consumption, then disable servers not needed for your current task. Too many MCPs can reduce your effective window from 200K to ~70K. ￼
For agentHive, implement dynamic MCP scoping — each agent only loads the MCP tools relevant to its role:

const AGENT_MCP_SCOPES: Record<AgentRole, string[]> = {
  'feature-proposer':  ['gitlab', 'roadmap-db'],
  'researcher':        ['web-search', 'codebase-read'],
  'implementer':       ['filesystem', 'bash', 'gitlab'],
  'reviewer':          ['gitlab', 'test-runner'],
  'rfc-synthesizer':   ['roadmap-db', 'gitlab'],
};


Part 8: Measurement Infrastructure
Build this before any optimization — you need a baseline.
Core metrics table:

CREATE TABLE metrics.token_efficiency (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      uuid REFERENCES agent_sessions(id),
  agent_role      text,
  model           text,
  task_type       text,
  
  -- Raw counts
  input_tokens    int,
  output_tokens   int,
  cache_write_tokens int DEFAULT 0,
  cache_read_tokens  int DEFAULT 0,
  
  -- Derived
  cache_hit_rate  numeric GENERATED ALWAYS AS (
    CASE WHEN input_tokens > 0 
    THEN cache_read_tokens::numeric / input_tokens 
    ELSE 0 END
  ) STORED,
  
  -- Cost (in microdollars to avoid float precision issues)
  cost_microdollars bigint,
  
  recorded_at     timestamptz DEFAULT now()
);


Weekly targets to track progress:



|Metric                   |Baseline (now)|Target Week 4|Target Week 8|
|-------------------------|--------------|-------------|-------------|
|Cache hit rate           |~0%           |40%          |70%          |
|Avg context at task start|~80%          |40%          |20%          |
|Opus usage %             |~50%          |30%          |<15%         |
|Cost per RFC cycle       |measure       |–40%         |–70%         |

Implementation Sequence
Given what’s already planned vs. not started, here’s the priority order:
Week 1–2 (instrumentation + quick wins):
	1.	Add token metrics to all agent invocations (you can’t navigate blind)
	2.	Set CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50 and MAX_THINKING_TOKENS=10000 in Claude Code config
	3.	Audit your CLAUDE.md — add explicit forbidden directories, keep it under 500 tokens
	4.	Disable unused MCP servers per session type
Week 3–4 (caching infrastructure):
5. Implement Anthropic cache_control markers on all static system prompt sections
6. Serialize the first request in parallel agent batches to warm the cache
7. Build the token_cache.semantic_responses pgvector table and embedding lookup
Week 5–6 (context management):
8. Implement compact triggers at the 50% threshold and at milestone boundaries
9. Build the three-tier memory model — working/session/long-term
10. Model routing by task complexity (haiku for subagents/research)
Week 7–8 (platform rollout):
11. Expose cache hit rate and cost metrics to agentHive users in their dashboard
12. Build per-agent MCP scoping so agents only load relevant tool schemas
13. Add the cost_microdollars tracking to your roadmap schema for user-facing reporting
The single most impactful thing you can do this week for both your dev workflow and agentHive is adding cache_control markers to your static agent system prompts — Anthropic’s prompt caching delivers 90% cost reduction and 85% latency reduction for long prompts ￼, and your agent personas + schema documentation are exactly the kind of large, stable, repeated prefix that benefits most.
Short answer: yes, but with guardrails.
Xiaomi’s flash models (and similar budget/flash tiers on OpenRouter) are fine for:
	•	Running the migration SQL against your DB
	•	Scaffolding boilerplate TypeScript from a clear spec
	•	Writing test fixtures
	•	Simple file operations your conventions define
Where they’ll burn you on P090Phase1 specifically:
	•	Schema design nuance — your conventions have opinions about FKs, derived aggregates, normalization. A flash model will miss them and you’ll get a schema that looks right but violates your pillars
	•	cache_control marker placement — getting the static/dynamic boundary wrong costs you money instead of saving it. This requires understanding your agent prompt structure
	•	The metrics table relationships — connecting it correctly to agent_sessions, scoping by agent_role, the generated column for cache_hit_rate — flash models cut corners here
Practical split:



|Task                                          |Model                        |
|----------------------------------------------|-----------------------------|
|Design review + spec sign-off                 |Sonnet (or you + Claude Code)|
|Write the migration SQL                       |Flash ✓                      |
|Scaffold the TypeScript service layer         |Flash ✓                      |
|Place `cache_control` markers in agent prompts|Sonnet minimum               |
|Write the pgvector lookup query               |Flash ✓ (simple query)       |

So: let Sonnet/Claude Code produce the spec, then hand the build tasks to flash. That’s actually the agentHive pattern you’re building — you’re just dogfooding it on your own dev workflow.
