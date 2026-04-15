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

interface ACVerification {
  passed: number;
  failed: number;
  blocked: number;
  total: number;
}

interface DependencyCheck {
  resolved: boolean;
  blockers: string[];
}

// Verify acceptance criteria status for a proposal
async function verifyAcceptanceCriteria(proposalId: string): Promise<ACVerification> {
  try {
    const result = await query(
      `SELECT COUNT(*) FILTER (WHERE status = 'pass') as passed,
              COUNT(*) FILTER (WHERE status = 'fail') as failed,
              COUNT(*) FILTER (WHERE status = 'blocked') as blocked,
              COUNT(*) as total
       FROM roadmap.acceptance_criteria
       WHERE proposal_id = $1`,
      [proposalId]
    );

    if (result.rows.length === 0) {
      return { passed: 0, failed: 0, blocked: 0, total: 0 };
    }

    const row = result.rows[0];
    return {
      passed: parseInt(row.passed || '0', 10),
      failed: parseInt(row.failed || '0', 10),
      blocked: parseInt(row.blocked || '0', 10),
      total: parseInt(row.total || '0', 10)
    };
  } catch (e) {
    logger.warn(`Failed to verify ACs for ${proposalId}:`, e);
    return { passed: 0, failed: 0, blocked: 0, total: 0 };
  }
}

// Check dependency resolution status
async function checkDependencies(proposalId: string): Promise<DependencyCheck> {
  try {
    const result = await query(
      `SELECT array_agg(DISTINCT p.display_id) FILTER (WHERE d.resolved = false) as blockers
       FROM roadmap.proposal_dependency d
       JOIN roadmap.proposal p ON d.to_proposal_id = p.id
       WHERE d.from_proposal_id = $1
       GROUP BY d.from_proposal_id`,
      [proposalId]
    );

    const blockers = result.rows.length > 0 ? (result.rows[0].blockers || []) : [];
    return {
      resolved: blockers.length === 0,
      blockers: blockers as string[]
    };
  } catch (e) {
    logger.warn(`Failed to check dependencies for ${proposalId}:`, e);
    return { resolved: true, blockers: [] };
  }
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

  // Run skeptic review and collect gate decision data
  const verdict = await skepticReview(proposalId, fromState, toState);
  const acVerification = await verifyAcceptanceCriteria(proposalId);
  const depCheck = await checkDependencies(proposalId);

  // Map transition to gate level
  const gateMap: Record<string, string> = {
    "DRAFT→REVIEW": "D1",
    "REVIEW→DEVELOP": "D2",
    "DEVELOP→MERGE": "D3",
    "MERGE→COMPLETE": "D4"
  };
  const gateLevel = gateMap[transitionKey] ?? null;

  // Build rationale string summarizing gate decision
  const rationale = buildRationale(fromState, toState, acVerification, depCheck, verdict);

  if (!verdict.approved) {
    logger.warn(`🚨 SKEPTIC BLOCKED: ${proposalId} cannot advance from ${fromState} to ${toState}`);
    logger.warn(`   Reasons: ${verdict.blockers.join("; ")}`);

    // Log to gate_decision_log with complete structured rationale
    // Insert into base table directly (roadmap.gate_decision_log is a read-only view)
    try {
      await query(
        `INSERT INTO roadmap_proposal.gate_decision_log (proposal_id, from_state, to_state, gate_level, decision, decided_by, ac_verification, dependency_check, rationale, challenges, blockers)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          Number(proposalId),
          fromState,
          toState,
          gateLevel,
          "reject",
          "gate-agent",
          JSON.stringify(acVerification),
          JSON.stringify(depCheck),
          rationale,
          verdict.challenges,
          verdict.blockers
        ]
      );
    } catch (e) {
      logger.warn(`Failed to record gate decision to gate_decision_log:`, e);
    }

    // Also log to audit_log for historical record
    const blockerDecision = {
      verdict: "REJECT",
      from: fromState,
      to: toState,
      blockers: verdict.blockers,
      challenges: verdict.challenges,
      acVerification,
      dependencies: depCheck,
      timestamp: new Date().toISOString()
    };

    await query(
      `INSERT INTO roadmap.audit_log (entity_type, entity_id, action, changed_by, before_json, changed_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [
        "proposal",
        proposalId,
        "delete",
        "gate-agent",
        JSON.stringify(blockerDecision)
      ]
    );

    return false;
  }

  // Log approved decision to gate_decision_log with complete structured rationale
  // decision='advance' matches CHECK constraint; insert into base table not view
  try {
    await query(
      `INSERT INTO roadmap_proposal.gate_decision_log (proposal_id, from_state, to_state, gate_level, decision, decided_by, ac_verification, dependency_check, rationale, challenges)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        Number(proposalId),
        fromState,
        toState,
        gateLevel,
        "advance",
        "gate-agent",
        JSON.stringify(acVerification),
        JSON.stringify(depCheck),
        rationale,
        verdict.challenges
      ]
    );
  } catch (e) {
    logger.warn(`Failed to record gate decision to gate_decision_log:`, e);
  }

  // Log approved decision to audit_log
  const approvalDecision = {
    verdict: "APPROVE",
    from: fromState,
    to: toState,
    challenges: verdict.challenges,
    alternatives: verdict.alternatives,
    acVerification,
    dependencies: depCheck,
    timestamp: new Date().toISOString()
  };

  await query(
    `INSERT INTO roadmap.audit_log (entity_type, entity_id, action, changed_by, after_json, changed_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [
      "proposal",
      proposalId,
      "insert",
      "gate-agent",
      JSON.stringify(approvalDecision)
    ]
  );

  return true;
}

function buildRationale(fromState: string, toState: string, acVerification: ACVerification, depCheck: DependencyCheck, verdict: SkepticVerdict): string {
  const lines: string[] = [];

  lines.push(`Gate decision: ${verdict.approved ? 'APPROVE' : 'REJECT'}`);
  lines.push(`Transition: ${fromState} → ${toState}`);

  if (acVerification.total > 0) {
    lines.push(`Acceptance Criteria: ${acVerification.passed}/${acVerification.total} passed`);
    if (acVerification.failed > 0) {
      lines.push(`  - ${acVerification.failed} failed`);
    }
    if (acVerification.blocked > 0) {
      lines.push(`  - ${acVerification.blocked} blocked`);
    }
  } else {
    lines.push(`Acceptance Criteria: None defined`);
  }

  if (depCheck.blockers.length > 0) {
    lines.push(`Dependencies: ${depCheck.blockers.length} unresolved (${depCheck.blockers.join(', ')})`);
  } else {
    lines.push(`Dependencies: All resolved`);
  }

  if (verdict.blockers.length > 0) {
    lines.push(`Blockers:`);
    verdict.blockers.forEach(b => lines.push(`  - ${b}`));
  }

  if (verdict.challenges.length > 0) {
    lines.push(`Questions for review (${verdict.challenges.length}):`);
    verdict.challenges.forEach(c => lines.push(`  - ${c}`));
  }

  return lines.join('\n');
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
