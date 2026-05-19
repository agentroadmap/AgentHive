import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

async function main() {
  const transport = new SSEClientTransport(new URL('http://127.0.0.1:6421/sse'));
  const client = new Client({ name: 'remediator', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  console.log("Remediating P919...");
  await client.callTool({ name: 'mcp_proposal', arguments: { action: 'update', args: {
    id: 'P919',
    design: `## Design (Remediated)

### 1. Schema
Migration 'scripts/migrations/121-p919-display-alias.sql' adds 'display_alias TEXT NULL' to 'roadmap_workforce.agent_registry'. 
Index: 'CREATE UNIQUE INDEX idx_agent_alias_active ON roadmap_workforce.agent_registry (display_alias) WHERE status = "active";'
Postgres allows multiple NULLs in this index; explicit AC added for verification.

### 2. Alias Claim Logic
Helper 'assignDisplayAlias(identity, alias, force = false)':
1. If 'alias' is already held by an 'active' row:
   a. If 'force' is true OR (the row is silent > 90s AND the owner PID is dead), flip owner to 'inactive' with 'status_reason="alias_reclaimed"'.
   b. Else, throw 'ALIAS_IN_USE'.
2. Update target row with the alias.

This resolves 'stuck-active' aliases after crashes.`
  }}});
  await client.callTool({ name: 'mcp_proposal', arguments: { action: 'add_acceptance_criteria', args: {
    proposal_id: 'P919',
    criteria: 'AC-16: NULL Uniqueness. Unit test verifies that multiple agents with NULL display_alias can coexist in the same active registry without violating the UNIQUE index.'
  }}});

  console.log("Remediating P920...");
  await client.callTool({ name: 'mcp_proposal', arguments: { action: 'update', args: {
    id: 'P920',
    design: `## Current Code Reality (Verified Root)

**Prerequisite**: P912 (Shared Self-Registration) must be applied to the worktree. 
In the current root:
- 'resolveLiaisonHandler()' exists at 'scripts/start-agency.ts:58-85'.
- 'OfferProvider' is retired (comments at lines 11-15).
P920 targets this state. Legacy worktrees (like codex-one) must rebase on P912 before implementing P920.

**Implementation**: Extract 'resolveLiaisonHandler' and 'buildArgsBySpec' into 'src/core/runtime/cli-invocation.ts'. Same logic, shared location.`
  }}});

  console.log("Remediating P921...");
  await client.callTool({ name: 'mcp_proposal', arguments: { action: 'update', args: {
    id: 'P921',
    design: `## Entrypoint Enforcement

The invariant 'idx_agency_session_one_active' is enforced at the DB level.
The application logic in 'scripts/start-agency.ts' (root version) calls 'selfRegisterAgency'.
1. 'selfRegisterAgency' wraps the session INSERT.
2. If it catches a unique violation, it throws 'AgencyAlreadyActive'.
3. 'start-agency.ts' main() MUST catch this and exit 0. 
AC-8 added to verify that the runtime DOES NOT continue on registration failure.`
  }}});
  await client.callTool({ name: 'mcp_proposal', arguments: { action: 'add_acceptance_criteria', args: {
    proposal_id: 'P921',
    criteria: 'AC-8: Registration Failure Guard. Integration test verifies that if selfRegisterAgency throws (e.g. due to duplicate session), start-agency.ts exits immediately with code 0 and DOES NOT start the liaison agent or heartbeat loops.'
  }}});

  console.log("Remediating P922...");
  await client.callTool({ name: 'mcp_proposal', arguments: { action: 'update', args: {
    id: 'P922',
    design: `## Dependencies and LISTEN Helper

1. **pgcrypto**: Required for 'gen_host_id()' (using 'digest(hostname, "sha256")') if the host does not have a persistent identity file. Migration '122-p922-host-id.sql' ensures 'CREATE EXTENSION IF NOT EXISTS pgcrypto'.
2. **ListenRelay**: A new shared helper in 'src/shared/runtime/notify.ts' that manages LISTEN/UNLISTEN across restarts and connection drops. It handles dual-subscribing to 'liaison_message_{agency_id}' and 'host_dispatch_{host_id}'.
3. **Polling Compatibility**: P922 does not freeze the polling window. It uses the same cursor-based polling defined in P924.`
  }}});

  console.log("Remediating P923...");
  await client.callTool({ name: 'mcp_proposal', arguments: { action: 'update', args: {
    id: 'P923',
    design: `## Secure Messaging Path

**No direct INSERTs**. External bridges (Discord) MUST call 'roadmap.fn_liaison_message_send_v2'.
This function:
1. Validates the 'from_agent' is a registered external bridge.
2. Injects the correct 'host_id' and 'routing_context'.
3. Inserts into 'roadmap.liaison_message'.
Notification is handled by a trigger on 'liaison_message' that dual-fires per P922. Unconditional prefix NOTIFY in design text is removed; the trigger handles it conditionally.`
  }}});

  console.log("Remediating P924...");
  await client.callTool({ name: 'mcp_proposal', arguments: { action: 'update', args: {
    id: 'P924',
    design: `## Cursor-Based Recovery (Remediated)

1. **Schema**: Migration adds 'metadata JSONB' to 'roadmap.agency_liaison_session'.
2. **Cursor**: Polling uses '(created_at, liaison_message_id)' composite cursor, not a random UUID. This ensures strict ordering and no missed rows.
3. **Ack Path**: 'acked_at' is updated only AFTER the message is successfully processed by the agency runtime.
4. **Safe Sweep**: Dormancy sweep uses 'pg_try_advisory_xact_lock(hashtext("agency_sweep")::int4, 0)' to ensure only one cleaner runs at a time. PID check is guarded by 'pg_stat_get_backend_pid' if on same host, or purely heartbeat-based for multi-host.
5. **Window**: Removed "5 minutes" hard limit. The cursor starts from the last acked message.`
  }}});

  console.log("All remediations applied.");
  await client.close();
}

main().catch(console.error);
