/**
 * AgentHive Discord Bridge — Enhanced with proposal details.
 * 
 * Shows which proposals are transitioning, not just counts.
 */

import { getPool, query } from "../src/infra/postgres/pool.ts";

const DISCORD_CHANNEL_ID = "1480366428325548200";
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";

// ... existing code ...

// Enhanced formatNotification with proposal details
function formatNotification(channel: string, payload: string): string {
  try {
    const data = JSON.parse(payload);
    
    // Gate ready notification with proposal details
    if (channel === "proposal_gate_ready") {
      const proposalId = data.proposal_id || data.id || "unknown";
      const displayId = data.display_id || `P${proposalId}`;
      return `🚪 **GATE READY** — ${displayId} is ready for gate evaluation`;
    }
    
    // Maturity changed with proposal details
    if (channel === "proposal_maturity_changed") {
      const maturity = data.maturity_state || data.maturity;
      const displayId = data.display_id || `P${data.proposal_id || data.id}`;
      return `📊 **MATURITY** — ${displayId} → ${maturity}`;
    }
    
    // Transition queued with proposal details
    if (channel === "transition_queued") {
      const count = data.enqueued || 1;
      // Try to get proposal details from the notification
      if (data.proposal_id) {
        const displayId = data.display_id || `P${data.proposal_id}`;
        const from = data.from_stage || "?";
        const to = data.to_stage || "?";
        return `🔄 **TRANSITION** — ${displayId}: ${from} → ${to}`;
      }
      return `🔄 **TRANSITIONS** — ${count} queued for processing`;
    }
    
    // Skeptic challenge
    if (channel === "skeptic_challenge") {
      const displayId = data.display_id || `P${data.proposal_id}`;
      return `🔍 **SKEPTIC** — ${displayId}: ${data.challenge || "Challenge raised"}`;
    }
    
    // Agent dispatch
    if (channel === "agent_dispatch") {
      const agent = data.agent || "unknown";
      const displayId = data.display_id || `P${data.proposal_id}`;
      return `🤖 **AGENT** — ${agent} dispatched for ${displayId}`;
    }
    
    return `📢 **${channel}** — ${JSON.stringify(data).substring(0, 200)}`;
  } catch {
    return `📢 **${channel}** — ${payload.substring(0, 200)}`;
  }
}

// ... rest of existing code ...
