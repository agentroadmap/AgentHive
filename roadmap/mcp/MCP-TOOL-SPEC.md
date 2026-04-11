# MCP Tool Specification v2.1

_Schema-aligned, domain-organized, no bloat._

## Design Rules

1. **One table → one domain.** Tools map directly to SpacetimeDB tables.
2. **Sub-entities stay under parent.** Criteria, decisions, versions, attachments are sub-operations of `prop_*`.
3. **Short names.** `prop_`, `agent_`, `chan_`, `msg_`, `mem_`, `acl_`, `spend_`, `sync_`.
4. **No duplicate verbs.** Each verb appears once across all domains.
5. **Read-only domains** (business) get only `list`/`get` tools, no mutations.

---

## Domain: proposal (→ proposal, proposal_version, proposal_criteria, proposal_decision, attachment_registry)

| Tool | Description | Key Inputs | Writes to |
|------|-------------|-----------|-----------|
| `prop_create` | Create a new proposal (any type) | `title`, `proposal_type`, `domain_id`, `category`, `body_markdown`, `priority`, `budget_limit_usd`, `parent_id?`, `tags?` | `proposal` |
| `prop_get` | Get proposal by ID (includes criteria, latest version) | `id` | — (read) |
| `prop_list` | List proposals with filters | `proposal_type?`, `status?`, `domain_id?`, `category?`, `assigned_identity?` | — (read) |
| `prop_update` | Update proposal fields (auto-creates version entry) | `id`, `title?`, `body_markdown?`, `priority?`, `tags?`, `change_summary` | `proposal`, `proposal_version` |
| `prop_transition` | Change proposal status | `id`, `new_status` | `proposal`, `proposal_version` |
| `prop_history` | List version history for a proposal | `id` | — (read, `proposal_version`) |
| `prop_rollback` | Rollback to a previous version | `id`, `version_number` | `proposal`, `proposal_version` |
| `prop_ac_add` | Add acceptance criteria | `proposal_id`, `description` | `proposal_criteria` |
| `prop_ac_check` | Mark criteria as verified | `proposal_id`, `criteria_id` | `proposal_criteria` |
| `prop_ac_remove` | Remove a criteria | `proposal_id`, `criteria_id` | `proposal_criteria` |
| `prop_decision` | Record a decision (ADR) | `proposal_id`, `title`, `decision_summary`, `rationale`, `status` | `proposal_decision` |
| `prop_decisions` | List decisions for a proposal | `proposal_id` | — (read, `proposal_decision`) |
| `prop_attach` | Attach a file to a proposal | `proposal_id`, `display_id`, `file_name`, `relative_path`, `file_type`, `content_hash` | `attachment_registry` |
| `prop_attachments` | List attachments for a proposal | `proposal_id` | — (read, `attachment_registry`) |

**Proposal types:** `DIRECTIVE`, `CAPABILITY`, `TECHNICAL`, `COMPONENT`, `OPS_ISSUE`
**Proposal statuses:** `New`, `Draft`, `Review`, `Active`, `Accepted`, `Complete`, `Rejected`
**Proposal categories:** `FEATURE`, `BUG`, `RESEARCH`, `SECURITY`, `INFRA`

---

## Domain: workforce (→ workforce_registry, workforce_pulse)

| Tool | Description | Key Inputs | Writes to |
|------|-------------|-----------|-----------|
| `agent_register` | Register or update an agent | `agent_id`, `role`, `identity?`, `is_active?` | `workforce_registry` |
| `agent_get` | Get agent profile | `identity` or `agent_id` | — (read) |
| `agent_list` | List all agents | `role?`, `is_active?` | — (read) |
| `agent_update` | Update agent properties | `identity`, `role?`, `agent_id?`, `is_active?` | `workforce_registry` |
| `agent_retire` | Deactivate an agent | `identity` | `workforce_registry` |
| `agent_pulse` | Update agent heartbeat/pulse | `identity`, `active_proposal_id?`, `status_message?` | `workforce_pulse` |
| `agent_heartbeat` | Quick heartbeat signal (minimal update) | `identity` | `workforce_pulse` |
| `agent_report` | Get agent status report (pulse + current task) | `identity` | — (read, `workforce_pulse`) |

---

## Domain: channels

| Tool | Description | Key Inputs | Writes to |
|------|-------------|-----------|-----------|
| `chan_create` | Create a new message channel | `channel_name` | `message_ledger` (system entry) |
| `chan_delete` | Delete/deactivate a channel | `channel_name` | — |
| `chan_list` | List all active channels | — | — (read) |
| `chan_subscribe` | Subscribe agent to a channel | `channel_name`, `identity` | — |
| `chan_unsubscribe` | Unsubscribe agent from a channel | `channel_name`, `identity` | — |

---

## Domain: messaging (→ message_ledger)

| Tool | Description | Key Inputs | Writes to |
|------|-------------|-----------|-----------|
| `msg_send` | Send a message to a channel | `channel_name`, `content`, `sender_identity` | `message_ledger` |
| `msg_read` | Read recent messages from a channel | `channel_name`, `limit?`, `before_id?` | — (read) |
| `msg_history` | Full message history for a channel | `channel_name`, `offset?`, `limit?` | — (read) |

---

## Domain: spending (→ spending_caps, spending_log)

| Tool | Description | Key Inputs | Writes to |
|------|-------------|-----------|-----------|
| `spend_log` | Log a spending event | `proposal_id`, `agent_identity`, `cost_usd` | `spending_log` |
| `spend_caps` | Get/set spending caps for an agent | `agent_identity`, `daily_limit_usd?`, `is_frozen?` | `spending_caps` |
| `spend_freeze` | Freeze/unfreeze an agent's spending | `agent_identity`, `is_frozen` | `spending_caps` |

---

## Domain: security (→ security_acl, security_audit_log)

| Tool | Description | Key Inputs | Writes to |
|------|-------------|-----------|-----------|
| `acl_grant` | Grant permission to an agent | `agent_identity`, `target_proposal_id`, `permission_id` | `security_acl` |
| `acl_revoke` | Revoke permission from an agent | `agent_identity`, `target_proposal_id`, `permission_id` | `security_acl` |
| `acl_list` | List permissions for an agent or target | `agent_identity?`, `target_proposal_id?` | — (read) |
| `audit_log` | Record or query audit events | `actor_identity?`, `action?`, `severity?` | `security_audit_log` (write) or read |

---

## Domain: memory (→ agent_memory)

| Tool | Description | Key Inputs | Writes to |
|------|-------------|-----------|-----------|
| `mem_set` | Set a memory entry | `agent_identity`, `scope_proposal_id`, `key`, `val` | `agent_memory` |
| `mem_get` | Get a memory entry by key | `agent_identity`, `scope_proposal_id`, `key` | — (read) |
| `mem_search` | Search memory entries | `agent_identity`, `scope_proposal_id?`, `query?` | — (read) |
| `mem_wipe` | Delete memory entries | `agent_identity`, `scope_proposal_id?`, `key?` | `agent_memory` |

---

## Domain: export (filesystem sync)

| Tool | Description | Key Inputs | Writes to |
|------|-------------|-----------|-----------|
| `sync_run` | Trigger a sync from SDB to filesystem | `proposal_id?` (all if omitted) | Filesystem |
| `sync_status` | Check sync status | `proposal_id?` | — (read) |

---

## Tool Count Summary

| Domain | Tools |
|--------|-------|
| proposal | 14 |
| workforce | 8 |
| channels | 5 |
| messaging | 3 |
| spending | 3 |
| security | 4 |
| memory | 4 |
| export | 2 |
| **Total** | **43** |

---

## File Structure

```
src/mcp/tools/
  proposal/{index,handlers,schemas}.ts     → prop_* tools
  workforce/{index,handlers,schemas}.ts    → agent_* tools
  channels/{index,handlers,schemas}.ts     → chan_* tools
  messaging/{index,handlers,schemas}.ts    → msg_* tools
  spending/{index,handlers,schemas}.ts     → spend_* tools
  security/{index,handlers,schemas}.ts     → acl_*, audit_log
  memory/{index,handlers,schemas}.ts       → mem_* tools
  export/{index,handlers,schemas}.ts       → sync_* tools
```

---

## Reducer Alignment

Each tool calls a SpacetimeDB reducer. Required reducers:

| Reducer | Called by |
|---------|-----------|
| `create_proposal` | `prop_create` |
| `transition_proposal` | `prop_transition` |
| `register_agent` | `agent_register` |
| `send_message` | `msg_send` |
| `update_proposal` | `prop_update` |
| `add_criteria` | `prop_ac_add` |
| `check_criteria` | `prop_ac_check` |
| `record_decision` | `prop_decision` |
| `update_pulse` | `agent_pulse` |
| `log_spending` | `spend_log` |
| `set_spending_caps` | `spend_caps` |
| `grant_acl` | `acl_grant` |
| `revoke_acl` | `acl_revoke` |
| `set_memory` | `mem_set` |
| `sync_export` | `sync_run` |

Bob's module has 4 reducers currently. We'll need ~15 total to cover all tools.

---

_Last updated: 2026-03-31_
