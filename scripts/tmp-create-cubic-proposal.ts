import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
const client = new Client({ name: "hermes", version: "1.0.0" });
await client.connect(transport);

const r = await client.callTool({
  name: "prop_create",
  arguments: {
    type: "component",
    title: "Cubic Runtime Abstraction — multi-CLI, host auth, cross-host A2A",
    summary: `## Problem

P058 designed the cubic as a metadata container (lock, phase, budget) but the runtime layer is hardcoded to a single CLI invocation pattern. Current gaps:

1. **No multi-CLI support** — agent-spawner.ts assumes one CLI. Cubic should abstract over claude, codex, hermes, gemini, copilot uniformly.
2. **Auth is broken** — we don't manage API keys. Auth is the host's responsibility. The cubic must run agents in the host's native environment (correct HOME, PATH, existing CLI auth state).
3. **No cross-host collaboration** — agent on host A (claude) can't work with agent on host B (copilot). A2A messaging bridges this but the cubic doesn't model host identity.
4. **Model selection is implicit** — the orchestrator should decide which model to use (e.g., "GPT-6 for this architectural decision"), not the agent CLI's default.

## Design

### Cubic as Runtime Container

A cubic encapsulates a runtime environment for agent execution:

\`\`\`
┌─────────────────────────────────────────┐
│                 Cubic                    │
│                                          │
│  runtime_type: subprocess | persistent   │
│  agent_cli: claude | codex | hermes |    │
│             gemini | copilot             │
│  host: localhost | <remote-host-id>      │
│  auth_mode: host_inherit | key_inject    │
│  model_override: <model-id> | null       │
│  tools: [mcp://..., mcp://...]           │
│  messaging: a2a://channel-name           │
│  budget: { max_usd, max_time_ms }        │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │         Runtime Provider           │  │
│  │  spawn(task, cwd) → process        │  │
│  │  send(agentId, message)            │  │
│  │  recv(agentId) → message           │  │
│  │  health() → status                 │  │
│  │  shutdown()                        │  │
│  └────────────────────────────────────┘  │
└─────────────────────────────────────────┘
\`\`\`

### Auth: Host Responsibility

The cubic does NOT manage credentials. Auth modes:
- **host_inherit** (default): Run CLI in the host's environment. Set HOME to the user who authenticated the CLI. The agent finds its auth in ~/.claude/, ~/.codex/, ~/.hermes/auth.json, etc.
- **key_inject**: For remote/subprocess where host auth isn't available. Inject credentials from a vault.

Current fix: agent-spawner.ts sets HOME=/home/andy and PATH includes the CLI's install location. Claude/codex find their own auth.

### Multi-CLI Dispatch

Each agent CLI has a builder that produces argv + env:

| CLI | Command | Auth Location | Model Flag |
|-----|---------|---------------|------------|
| claude | claude --print | ~/.claude/ | --model |
| codex | codex exec | ~/.codex/ | --model |
| hermes | hermes chat -q | ~/.hermes/auth.json | -m |
| gemini | gemini --prompt | ~/.gemini/ | --model |
| copilot | via ACP | host config | --model |

The cubic's agent_cli field selects which builder to use. The orchestrator assigns agents to cubics based on availability, capability, and cost.

### Cross-Host Collaboration

Agents on different hosts communicate via A2A messaging:
- Each host runs its own orchestrator + MCP server
- A2A channels bridge hosts (pg_notify for local, websocket/webhook for remote)
- The cubic tracks host identity: cubic.metadata.host = "host-A"
- Orchestrator on host-A can dispatch work to a cubic on host-B via A2A

This is future scope — current implementation is single-host.

### Model Selection

The orchestrator (not the agent) decides which model to use:
- Gate task metadata includes model_override
- Phase-to-model mapping (design→opus, build→sonnet, test→gpt-4o)
- Cost routing: cheapest model that can handle the task
- The agent CLI receives the model as a flag: claude --model <model>

The cubic stores model_override in metadata. The spawner passes it to the CLI builder.

## Acceptance Criteria

1. agent-spawner.ts supports at least 3 agent CLIs (claude, codex, hermes) via pluggable builders
2. Auth is host-inherit by default: HOME and PATH set correctly for each CLI
3. Cubic metadata includes agent_cli, host, auth_mode, model_override fields
4. Orchestrator dispatchAgent selects agent_cli based on availability and task requirements
5. Model override from gate task metadata flows through to the CLI --model flag
6. A2A messaging works between agents on the same host (local channels)
7. Design document describes cross-host extension path (implementation deferred)`,
    motivation: "The cubic is currently a metadata-only container disconnected from execution. We need it to be a proper runtime abstraction that supports multiple agent CLIs, inherits host auth, enables cross-host collaboration, and lets the orchestrator control model selection.",
    design: `See summary for full design. Key components:

1. Runtime Provider interface: spawn(), send(), recv(), health(), shutdown()
2. CLI builders: claude, codex, hermes, gemini, copilot
3. Auth modes: host_inherit (default), key_inject
4. Model selection: orchestrator-level, passed as CLI flag
5. Cross-host: A2A messaging bridge (future scope)
`,
  },
});
console.log("Created:", r.content?.[0]?.text?.substring(0, 300));
await client.close();
