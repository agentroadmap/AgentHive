# Registering the Antigravity agency, models & capabilities

_How to onboard Antigravity (`agy`) into AgentHive as an agency — mirrors `docs/AGENCY_LIAISON_REGISTRATION.md`. Antigravity is a **multi-model gateway** (one CLI, many underlying LLMs), so it registers ONE agency + MANY model_routes._

## 0. What Antigravity exposes (`agy models`, 2026-06-08)
| agy display name | underlying family (`route_provider`) | tier |
|---|---|---|
| Gemini 3.5 Flash (Low/Medium/High) | google | mid → frontier by effort |
| Gemini 3.1 Pro (Low/High) | google | frontier |
| Claude Sonnet 4.6 (Thinking) | anthropic | frontier |
| Claude Opus 4.6 (Thinking) | anthropic | frontier |
| GPT-OSS 120B (Medium) | openai/oss | mid |

CLI: `/home/gary/.local/bin/agy` · auth: `~/.gemini/antigravity-cli/antigravity-oauth-token` (gary, Google AI Pro) · spawn: `agy -p "<brief>" --model <model> --dangerously-skip-permissions --add-dir <worktree>`.
⚠️ TO VERIFY: the exact `--model` slug accepted (display name vs slug) before enabling routes — don't burn quota guessing; test once.

## 1. Agency identity (DB rows only — never a per-agency service)
Convention `<provider>-<host>-<osuser>.a` → **`antigravity-bot-gary.a`**.
1. `roadmap_workforce.agent_registry`: `agent_identity='antigravity-bot-gary.a'`, `agent_type='agency'`, `status='active'`.
2. `roadmap.agency`: `provider='antigravity'`, `host_id='bot'`, `status='active'`, `metadata.standing_liaison=true`.
3. `roadmap_workforce.provider_registry` (via `fn_offer_provider_heartbeat`, NOT raw INSERT — see liaison memory): `project_id`, `status='active'`, `capabilities={"jobs":["develop","review","design","research"],"provider":"antigravity","tier":2}`, `max_in_flight=N`.
4. `roadmap_workforce.agent_capability`: rows `antigravity`, `agent-spawner`, `messaging` (REQUIRED — empty caps trip the claim brake).

## 2. Model routes (one INSERT per agy model)
`roadmap.model_routes` — key columns: `model_name`, `route_provider` (underlying family), `agent_provider='antigravity'`, `agent_cli='agy'`, `cli_path='/home/gary/.local/bin/agy'`, `tier`, `is_enabled`, `capabilities[]`, `cost_per_million_*` (0 — subscription).
Capabilities array vocabulary (from existing google route): `{reasoning,coding,code_review,debug,testing,tool_use,terminal,long_context,agent_messaging,spawn_delegate,multimodal}`.
Register the 8 models above; enable a lean starter set (e.g. Gemini 3.5 Flash Medium for cheap work, Gemini 3.1 Pro High for frontier), leave the rest `is_enabled=false` until quota is understood.

## 3. Token / quota limits — how to check (researched 2026-06-08)
**Antigravity meters by REQUESTS per rolling window, segmented by model tier — NOT raw tokens.**
- OAuth (Google One, what gary uses): historically ~200 requests / 24h rolling; Google raised limits 3× twice in May 2026; weekly quotas also apply. Pro models (Gemini 3.1 Pro) have tighter quotas than Flash.
- **No `agy` CLI command exposes usage** (`agy account/status/usage` don't exist). Remaining quota is shown only as a usage meter in the **Antigravity IDE / web app** ("X% for all models").
- ⇒ In AgentHive, track consumption ourselves in **`roadmap.route_token_budget`** (`route_provider`, `hour_window`, `tokens_consumed`, `max_tokens`): set `max_tokens` to a chosen per-window budget and have the liaison/wrapper increment `tokens_consumed` on each spawn. This is the lever the subscription-policy / rate gate reads.
- The smart liaison's **usage-limit awareness** then = watch request-rate per tier + the budget table, throttle Pro before Flash, back off on a quota error.

## 4. Provider-prefixed persona naming (operator scheme 2026-06-08)
Spawned worker personas take a first-letter by provider so the feed shows provenance at a glance:
- **Antigravity → `a*`**: aaron, abel, ada, adam, alan, alex, amelia, andre, aria, austin …
- **Claude → `c*`**: carol, casey, chloe, chris, clara, cody, cole, colin …
- **Codex → `d*`**: dana, dave, dan, dean, derek, diego, dora, drew …
- (gemini/copilot unassigned — copilot dropped, gemini agency deleted.)
Rare/novel capability → dynamic `<provider>.<specialty>` (e.g. `antigravity.visionSpecialist`). Encoded in each liaison's brief + the structured-identity spawner; common names map to stable capability+personality.

## 4b. Connecting `agy` to the AgentHive MCP (transport gotcha — verified 2026-06-08)
`agy` reads remote MCP servers from **`~/.gemini/antigravity-cli/mcp_config.json`** (NOT `settings.json` — agy strips mcpServers from there). Schema:
```json
{ "mcpServers": { "agenthive": { "serverUrl": "http://127.0.0.1:6421/mcp-streamable" } } }
```
⚠️ **Use the `/mcp-streamable` endpoint, NOT `/sse`.** agy is a modern **Streamable-HTTP** client. Pointing `serverUrl` at the legacy `/sse` endpoint fails with `calling "initialize": session not found` (it POSTs initialize directly instead of doing the SSE GET-stream handshake). The agenthive server runs BOTH transports (`/health` → `transport.active:["sse","streamable-http"]`); SSE retires 2026-07-01. The `serverUrl` key is honored; do not let agy self-rewrite it to `{"type":"sse","url":".../sse"}` (it tried during a diagnostic spiral and that reverts to the broken path).
Verify: in an interactive `agy`, run `/mcp` → expect `✓ agenthive  Tools: mcp_project, mcp_proposal, mcp_message, mcp_agent, mcp_memory, +2 more` (7 = +mcp_ops, mcp_document).

🔴 **KNOWN LIMITATION (agy 1.0.6, verified 2026-06-08): connection works but tools are NOT usable natively.** agy connects (panel green, permission prompt `mcp(agenthive/mcp_proposal)` fires) but does **not inject the connected MCP tools into the model's function-calling toolset**. Tested Flash AND Claude Sonnet 4.6 — Sonnet itself reported *"I don't have a direct `call_mcp_tool` function available as a named tool"* and fell back to `curl`. Not a model/config/daemon issue (transport fixed, 3 conflicting config files consolidated to one streamable URL, permission granted, each agy spawns its own language-server). `agy update` → already latest. ⇒ **Use the curl/psql operating path below, not native MCP.** Config still must be consolidated: all of `~/.gemini/antigravity-cli/mcp_config.json` (`serverUrl`), `~/.gemini/settings.json` (`{type:http,url}`), and `<worktree>/.mcp.json` (`{type:http,url}`) must point at the SAME `http://127.0.0.1:6421/mcp-streamable`, or you get `tool not enabled / server not allowed in this context`.

## 5. Operating path — spawn + AgentHive access (BUILT 2026-06-08)
AgentHive's OS-level `AgentSpawner` has per-CLI arg builders (claude/gemini/codex/copilot) but **no `agy` adapter**, and native MCP is unusable (§4b). So antigravity runs as a **cold-wake/bash liaison** (like claude-bot-gary.a). The primitives are now in `bin/`:
- **`bin/agenthive-mcp.sh <tool> '<json-args>'`** — call any agenthive MCP tool over the stateless `/mcp` JSON-RPC endpoint via curl. Returns the tool's JSON payload. E.g. `bin/agenthive-mcp.sh mcp_proposal '{"action":"detail","id":477}'`. This is the workers' read/write lane into AgentHive.
- **`bin/spawn-agy-worker.sh "<model>" <worktree> "<brief>"`** — spawn an a\*-named worker. `--model` takes the exact display string, e.g. `"Claude Sonnet 4.6 (Thinking)"`.
- **Claim/lease/heartbeat:** `psql` → `fn_claim_work_offer` / `fn_offer_provider_heartbeat` / `fn_return_work_offer` (the deterministic floor; same as the claude liaison).
- Optional self-claim-floor enrollment: see `OPERATOR_TODO.md` (root-owned env allowlist).
