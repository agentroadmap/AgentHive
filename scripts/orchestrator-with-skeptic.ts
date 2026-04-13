/**
 * AgentHive Orchestrator — Event-driven agent dispatcher with SKEPTIC GATE.
 * 
 * The skeptic participates in EVERY gate decision:
 *   - Before advancing REVIEW → DEVELOP: skeptic must not block
 *   - Before advancing DEVELOP → MERGE: skeptic must not block
 *   - Before advancing MERGE → COMPLETE: skeptic must not block
 * 
 * If the skeptic blocks, the proposal CANNOT advance.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { getPool, query } from "../src/infra/postgres/pool.ts";

const MCP_URL = "http://127.0.0.1:6421/sse";

const logger = {
  log: (...args: unknown[]) => console.log("[Orchestrator]", ...args),
  warn: (...args: unknown[]) => console.warn("[Orchestrator]", ...args),
  error: (...args: unknown[]) => console.error("[Orchestrator]", ...args),
};

// Gate transitions that require skeptic review
const GATED_TRANSITIONS = new Set([
  "REVIEW→DEVELOP",
  "DEVELOP→MERGE", 
  "MERGE→COMPLETE"
]);

interface SkepticVerdict {
  approved: boolean;
  challenges: string[];
  blockers: string[];
  alternatives: string[];
}

// Run skeptic review on a proposal
async function skepticReview(proposalId: string, fromState: string, toState: string): Promise<SkepticVerdict> {
  const client = new Client({ name: "skeptic-gate", version: "1.0.0" });
  const transport = new SSEClientTransport(new URL(MCP_URL));
  
  try {
    await client.connect(transport);
    
    // Get proposal details
    const result = await client.callTool({
      name: "prop_get",
      arguments: { id: proposalId }
    });
    const data = JSON.parse(result.content?.[0]?.text || "{}");
    
    const verdict: SkepticVerdict = {
      approved: true,
      challenges: [],
      blockers: [],
      alternatives: []
    };
    
    // D2 GATE: REVIEW → DEVELOP
    if (fromState === "REVIEW" && toState === "DEVELOP") {
      // Rule: MUST have all acceptance criteria
      if (!data.acceptance_criteria?.length) {
        verdict.approved = false;
        verdict.blockers.push("No acceptance criteria defined");
        verdict.challenges.push("How can we verify implementation without ACs?");
        verdict.challenges.push("What defines 'done' for this feature?");
      }
      
      // Rule: Must have design
      if (!data.design) {
        verdict.approved = false;
        verdict.blockers.push("No design document");
      }
      
      // Rule: Must have motivation
      if (!data.motivation) {
        verdict.challenges.push("Why is this needed? No motivation stated.");
      }
      
      // Alternatives check
      verdict.alternatives.push("Have we considered existing solutions?");
      verdict.alternatives.push("Is this the simplest approach?");
    }
    
    // D3 GATE: DEVELOP → MERGE
    if (fromState === "DEVELOP" && toState === "MERGE") {
      // Rule: Must be mature
      if (data.maturity_state !== "mature") {
        verdict.approved = false;
        verdict.blockers.push("Maturity is not 'mature'");
      }
      
      // Integration challenges
      verdict.challenges.push("Has code been reviewed?");
      verdict.challenges.push("Do all ACs pass tests?");
      verdict.challenges.push("Are integration constraints met?");
      verdict.challenges.push("Will this work with other proposals?");
      
      // Check for circular dependencies
      verdict.alternatives.push("Are there circular dependencies?");
      verdict.alternatives.push("Will this scale to 1000+ proposals?");
    }
    
    // D4 GATE: MERGE → COMPLETE
    if (fromState === "MERGE" && toState === "COMPLETE") {
      verdict.challenges.push("Is the merge truly complete?");
      verdict.challenges.push("Are all tests passing?");
      verdict.challenges.push("Is documentation updated?");
    }
    
    // Log the verdict
    logger.log(`🔍 SKEPTIC REVIEW: ${proposalId} (${fromState} → ${toState})`);
    logger.log(`   Approved: ${verdict.approved ? "YES" : "NO — BLOCKED"}`);
    if (verdict.blockers.length > 0) {
      logger.log(`   Blockers: ${verdict.blockers.join("; ")}`);
    }
    if (verdict.challenges.length > 0) {
      logger.log(`   Challenges: ${verdict.challenges.length} questions`);
    }
    
    return verdict;
    
  } finally {
    await client.close();
  }
}

// Check if transition is allowed (with skeptic gate)
async function canAdvance(proposalId: string, fromState: string, toState: string): Promise<boolean> {
  // Check if this is a gated transition
  const transitionKey = `${fromState}→${toState}`;
  if (!GATED_TRANSITIONS.has(transitionKey)) {
    return true; // Not gated, allow
  }
  
  // Run skeptic review
  const verdict = await skepticReview(proposalId, fromState, toState);
  
  if (!verdict.approved) {
    logger.warn(`🚨 SKEPTIC BLOCKED: ${proposalId} cannot advance from ${fromState} to ${toState}`);
    logger.warn(`   Reasons: ${verdict.blockers.join("; ")}`);
    
    // Log blocker to audit
    await query(
      `INSERT INTO roadmap.audit_log (entity_type, entity_id, action, changed_by, before_json, changed_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [
        "proposal",
        proposalId,
        "update",
        "skeptic",
        JSON.stringify({ verdict: "REJECT", from: fromState, to: toState, blockers: verdict.blockers })
      ]
    );

    // Log gate decision with structured rationale
    const gateMap: Record<string, string> = { "DRAFT→REVIEW": "D1", "REVIEW→DEVELOP": "D2", "DEVELOP→MERGE": "D3", "MERGE→COMPLETE": "D4" };
    await query(
      `INSERT INTO roadmap_proposal.gate_decision_log (proposal_id, from_state, to_state, maturity, gate, decided_by, decision, rationale)
       VALUES ($1, $2, $3, 'mature', $4, 'skeptic', 'reject', $5)`,
      [
        Number(proposalId),
        fromState,
        toState,
        gateMap[transitionKey] ?? null,
        JSON.stringify({ blockers: verdict.blockers, challenges: verdict.challenges, alternatives: verdict.alternatives })
      ]
    );

    return false;
  }

  // Log approved decision to audit
  await query(
    `INSERT INTO roadmap.audit_log (entity_type, entity_id, action, changed_by, after_json, changed_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [
      "proposal",
      proposalId,
      "update",
      "skeptic",
      JSON.stringify({ verdict: "APPROVE", from: fromState, to: toState, challenges: verdict.challenges, alternatives: verdict.alternatives })
    ]
  );

  // Log gate advance decision
  const gateMap2: Record<string, string> = { "DRAFT→REVIEW": "D1", "REVIEW→DEVELOP": "D2", "DEVELOP→MERGE": "D3", "MERGE→COMPLETE": "D4" };
  await query(
    `INSERT INTO roadmap_proposal.gate_decision_log (proposal_id, from_state, to_state, maturity, gate, decided_by, decision, rationale)
     VALUES ($1, $2, $3, 'mature', $4, 'skeptic', 'advance', $5)`,
    [
      Number(proposalId),
      fromState,
      toState,
      gateMap2[transitionKey] ?? null,
      JSON.stringify({ challenges: verdict.challenges, alternatives: verdict.alternatives, approved: true })
    ]
  );

  return true;
}

// Main orchestrator loop
async function main() {
  logger.log("Starting Orchestrator with SKEPTIC GATE...");
  
  const pool = getPool();
  const pgClient = await pool.connect();
  
  // Listen for state changes
  await pgClient.query("LISTEN proposal_gate_ready");
  await pgClient.query("LISTEN proposal_maturity_changed");
  await pgClient.query("LISTEN transition_queued");
  
  logger.log("Listening for notifications with skeptic gate enabled");
  logger.log("Gated transitions: REVIEW→DEVELOP, DEVELOP→MERGE, MERGE→COMPLETE");
  
  // Handle notifications
  pgClient.on("notification", async (msg: { channel: string; payload?: string }) => {
    if (!msg.payload) return;
    
    try {
      const data = JSON.parse(msg.payload);
      const proposalId = data.proposal_id || data.id;
      
      if (!proposalId) return;
      
      // Get current state
      const result = await query(
        "SELECT id, display_id, status FROM roadmap.proposal WHERE id = $1",
        [proposalId]
      );
      
      if (result.rows.length === 0) return;
      
      const proposal = result.rows[0];
      
      // Check if this is a gated transition
      const transitionKey = `${proposal.status}→${getNextState(proposal.status)}`;
      if (GATED_TRANSITIONS.has(transitionKey)) {
        const allowed = await canAdvance(proposalId, proposal.status, getNextState(proposal.status));
        if (!allowed) {
          logger.log(`⏳ ${proposal.display_id} blocked by skeptic — waiting for resolution`);
        }
      }
    } catch (e) {
      logger.error("Error handling notification:", e);
    }
  });
  
  logger.log("Orchestrator with skeptic gate running...");
  
  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.log(`Received ${signal}, shutting down...`);
    pgClient.release();
    await pool.end();
    process.exit(0);
  };
  
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

function getNextState(currentState: string): string {
  const transitions: Record<string, string> = {
    DRAFT: "REVIEW",
    REVIEW: "DEVELOP",
    DEVELOP: "MERGE",
    MERGE: "COMPLETE",
    TRIAGE: "FIX",
    FIX: "DEPLOYED"
  };
  return transitions[currentState] || currentState;
}

main().catch((err) => {
  console.error("[Orchestrator] Fatal error:", err);
  process.exit(1);
});
