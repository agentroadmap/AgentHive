import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getMcpUrl } from "../src/shared/runtime/endpoints.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

async function main() {
  const mcpUrl = getMcpUrl();
  console.log(`Connecting to MCP at ${mcpUrl}`);
  const transport = new SSEClientTransport(new URL(mcpUrl));
  const client = new Client({ name: "gemini-cli-reviewer", version: "1.0.0" });
  await client.connect(transport);

  const review = {
    proposal_id: "1022",
    reviewer: "gemini-cli-reviewer",
    verdict: "request_changes",
    notes: `## Review: P1022 — Governance and Trust

**Verdict:** HOLD (Formal verdict: request_changes)
**Reviewer:** gemini-cli-reviewer

### Findings

#### 1. Hash-Chaining Table & Schema Ambiguity
AC-4 refers to \`roadmap_proposal.gate_decision_log\`. However, P605 established \`governance.decision_log\` as the canonical immutable hash-chain. P1022 should explicitly target the \`governance\` schema for its new marketplace decisions to ensure they are part of the high-integrity audit chain. Verifying the mirror trigger (or direct writer) to \`governance.decision_log\` is critical.

#### 2. Lack of Non-Repudiation (Proof-of-Decision)
While the design provides "Auditability" via hash-chaining (detecting modifications), it lacks "Non-Repudiation". A true **Proof-of-Decision** (as implied in the prompt) should involve digital signatures from the decider (e.g., the Agency or Orchestrator). Relying solely on DB-side triggers means anyone with DB write access and the \`pgcrypto\` keys can still insert fraudulent decisions that look valid to the chain.

#### 3. Decision Input Snapshotting
A decision is only verifiable if the inputs (e.g., \`agent_usage_snapshot\` quota at time T, \`host_model_policy\` state) are also captured. P1022 does not mention snapshotting these inputs, making it impossible to cryptographically prove that a "precheck_failed" decision was correct after the fact.

#### 4. Automated Integrity Verification
AC-4 and AC-18 describe manual SQL checks. The design should integrate with the automated "incremental verifier" and "weekly full-chain verifier" services defined in P605 to provide continuous monitoring of the new marketplace decision types.

#### 5. Scalability & Chain Bloat
P1022 introduces 4 new mechanics that could trigger thousands of "runtime" decisions (e.g., pre-spawn failures). Mixing these high-frequency runtime events with low-frequency governance decisions (state transitions) in a single linear hash-chain might lead to significant chain bloat and slow down verification.

### Recommendations
- Clarify the schema and table for immutable logging (favor \`governance.decision_log\`).
- Add requirements for digital signatures (non-repudiation) for consequential decisions.
- Include "Input Snapshotting" in the decision payload.
- Update AC-4/AC-18 to use automated verifier outputs rather than manual SQL checks.
- Evaluate if high-frequency marketplace decisions should live in a separate "runtime-trust" chain.`
  };

  try {
    const res = await client.callTool({
      name: "submit_review",
      arguments: review
    });
    console.log(`P${review.proposal_id}: ${JSON.stringify(res)}`);
  } catch (e) {
    console.error(`P${review.proposal_id} error: ${e}`);
    process.exit(1);
  }

  await client.close();
}

main().catch(console.error);
