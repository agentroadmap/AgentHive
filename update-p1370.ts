import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function main() {
  const transport = new SSEClientTransport(new URL("http://127.0.0.1:6421/sse"));
  const client = new Client({ name: "proposal-updater", version: "1.0.0" });
  await client.connect(transport);

  const newDesign = `## Pre-flight schema audit (D2 reviewer aid)

Verified against live DB 2026-05-22 before filing ACs:

| Reference | Status | Source |
| --- | --- | --- |
| \`roadmap_workforce.agent_registry.max_concurrent_claims\` | ✓ exists (int NOT NULL DEFAULT 3) | live schema |
| \`roadmap_workforce.agent_registry.host_affinity\` | ✓ exists, indexed | live schema |
| \`roadmap_workforce.agent_registry.agency_style/llm_variant\` | ✓ added by P1367 today | this session |
| \`roadmap_workforce.agent_capability\` | ✓ exists | live schema |
| \`roadmap_workforce.proposal_role_pause\` | ✓ exists (P1291 landed) | live schema |
| \`roadmap.agent_budget_ledger\` | ✓ exists; budget_allocated_usd / cost_usd / cumulative_cost_usd | live schema |
| \`roadmap.provider_health.cooldown_until\` | ✓ exists | live schema |
| \`roadmap.agency.presence_state\` | ✓ exists | live schema |
| \`roadmap_workforce.agency_capacity\` | ✗ does NOT exist yet — P1365 ships it | depends on P1365 |

## What the liaison needs to know at boot (revised)

\`\`\`typescript
interface LiaisonContext {
  // Identity
  agency_identity: string;          // 'adam', 'claude-mimo-a', etc.
  agency_style: string;             // 'claude' | 'codex' | 'gemini' | 'copilot' | 'hermes'
  llm_variant: string | null;       // 'mimo' | 'bedrock' | null = default
  provider: string;                 // 'anthropic' | 'openai' | 'google' | 'github'
  host_id: string;                  // 'bot' or hostname

  // Capacity (sourced from P1365 agency_capacity; null until P1365 lands)
  capacity: {
    requests_remaining: number | null;
    tokens_remaining: number | null;
    reset_at: string | null;
    headroom_pct: number | null;     // null = unknown
    throttle_action: 'none' | 'soft' | 'hard' | 'unknown';
    last_sampled_at: string | null;
  };

  // Spending (sourced from agent_budget_ledger)
  spending: {
    spent_today_usd: number;
    spent_week_usd: number;
    cumulative_usd: number;
    daily_cap_usd: number | null;
  };

  // Provider-level cooldown (P1359 reactive)
  provider_cooldown_until: string | null;

  // Capability gates
  capabilities: string[];
  max_concurrent_claims: number;
  active_claim_count: number;
  paused_roles: string[];

  // Peer awareness (de-identified summary)
  peers: Array<{
    identity: string;
    agency_style: string;
    llm_variant: string | null;
    online: boolean;
    headroom_pct: number | null;
    capabilities: string[];
  }>;
}
\`\`\`

## Schema (corrected DDL)

\`\`\`sql
-- migrations/NNN-p1370-v-liaison-context.sql
-- BLOCKER: This migration MUST run after P1365 (agency_capacity table).
-- AC-10 enforcement:
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'roadmap_workforce' AND table_name = 'agency_capacity') THEN
        RAISE EXCEPTION 'Prerequisite table roadmap_workforce.agency_capacity missing. Land P1365 first.';
    END IF;
END $$;

CREATE OR REPLACE VIEW roadmap_workforce.v_liaison_context AS
SELECT
  ar.agent_identity,
  ar.agency_style,
  ar.llm_variant,
  ar.preferred_provider                            AS provider,
  COALESCE(NULLIF(ar.host_affinity, ''), 'bot')    AS host_id,
  ar.max_concurrent_claims,
  ARRAY(
    SELECT DISTINCT ac.capability
    FROM roadmap_workforce.agent_capability ac
    WHERE ac.agent_id = ar.id
    ORDER BY ac.capability
  ) AS capabilities,
  ARRAY(
    SELECT DISTINCT role
    FROM roadmap_workforce.proposal_role_pause
    WHERE expires_at > NOW()
  ) AS paused_roles, -- Added in D2 remediation
  ag.presence_state,
  ag.last_heartbeat_at,
  ph.cooldown_until                                AS provider_cooldown_until,
  ac_cap.requests_remaining,
  ac_cap.tokens_remaining,
  ac_cap.reset_at                                  AS capacity_reset_at,
  ac_cap.throttle_action,
  ac_cap.last_sampled_at                           AS capacity_last_sampled_at,
  sp.spent_today_usd,
  sp.spent_week_usd,
  sp.cumulative_usd,
  sp.daily_cap_usd,
  (SELECT COUNT(*) FROM roadmap_workforce.squad_dispatch sd
     WHERE (sd.worker_identity = ar.agent_identity OR sd.agent_identity = ar.agent_identity)
       -- dispatch_status corrected to match live enum observed in DB
       AND sd.dispatch_status IN ('open', 'assigned', 'active', 'claimed', 'running', 'pending'))
    AS active_claim_count
FROM roadmap_workforce.agent_registry ar
LEFT JOIN roadmap.agency ag
  ON ag.display_name = ar.agent_identity
LEFT JOIN roadmap.provider_health ph
  ON ph.provider_name = ar.preferred_provider -- Corrected column: provider -> provider_name
LEFT JOIN LATERAL (
  SELECT requests_remaining, tokens_remaining, reset_at, throttle_action, last_sampled_at
  FROM roadmap_workforce.agency_capacity ac
  WHERE ac.agency_id = ar.agent_identity
  ORDER BY ac.last_sampled_at DESC LIMIT 1
) ac_cap ON true
LEFT JOIN LATERAL (
  SELECT
    COALESCE(SUM(cost_usd) FILTER (WHERE recorded_at::date = CURRENT_DATE), 0)::numeric AS spent_today_usd,
    COALESCE(SUM(cost_usd) FILTER (WHERE recorded_at > NOW() - INTERVAL '7 days'), 0)::numeric AS spent_week_usd,
    COALESCE(MAX(cumulative_cost_usd), 0)::numeric AS cumulative_usd,
    MAX(budget_allocated_usd)::numeric AS daily_cap_usd
  FROM roadmap.agent_budget_ledger
  WHERE agent_identity = ar.agent_identity
) sp ON true
WHERE ar.agent_type IN ('agency', 'alias') AND ar.status = 'active';
\`\`\`

## Peer Awareness Strategy (Remediated)

Peer awareness is assembled in the \`hydrateLiaisonContext\` TypeScript function by querying \`v_liaison_context\` for all active agencies and filtering by identity to exclude self. Project-level filtering is performed by matching the \`agent_identity\` prefix (convention: \`project-name-agent-name\`) until a formal \`project_id\` column is added to \`agent_registry\`.

## Stale-data Guard (Remediated)

AC-8's stale-data guard is implemented as an **async-with-background-refresh** pattern. If the snapshot is > 5 minutes old, the current request returns the stale data immediately while triggering an asynchronous \`hydrateLiaisonContext\` call in the background to refresh the module-scope state for the next request. This avoids blocking the offer-claim hot path.
`;

  console.log("Updating P1370 design...");
  await client.callTool({
    name: "mcp_proposal",
    arguments: {
      action: "update",
      args: {
        id: "1370",
        design: newDesign
      }
    }
  });

  console.log("Updating ACs...");
  const acUpdates = [
    { num: 1, text: "Migration file creates corrected VIEW roadmap_workforce.v_liaison_context (fixed provider_health join and dispatch_status list). EXPLAIN ANALYZE run against seeded agency_capacity rows (min 1 row per agency) completes under 20ms; output pasted in AC comment." },
    { num: 8, text: "Stale-data guard: if Date.now() - snapshot.last_hydrated_at > 5*60_000ms, returns stale data and triggers an ASYNC background re-hydrate. Unit test covers background trigger." },
    { num: 10, text: "Migration is gated on P1365's MERGE. Script uses DO block to RAISE EXCEPTION if agency_capacity table is missing, preventing partial view creation." }
  ];

  for (const ac of acUpdates) {
    await client.callTool({
      name: "mcp_proposal",
      arguments: {
        action: "update_ac",
        args: {
          proposal_id: "P1370",
          item_number: ac.num,
          text: ac.text
        }
      }
    });
  }

  await client.close();
  console.log("P1370 remediated.");
}

main().catch(console.error);
