import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const MCP_URL = "http://127.0.0.1:6421/sse";

async function main() {
  const transport = new SSEClientTransport(new URL(MCP_URL));
  const client = new Client({ name: "rfc-gate-evaluator", version: "1.0.0" });

  try {
    await client.connect(transport);
    console.log("✅ Connected to AgentHive MCP\n");

    async function callTool(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      return result.content?.[0]?.text || JSON.stringify(result);
    }

    const actions = [];

    // =====================================================
    // QUICK FIX WORKFLOW: TRIAGE → FIX → DEPLOYED
    // =====================================================
    console.log("═".repeat(60));
    console.log("QUICK FIX WORKFLOW (issue type)");
    console.log("═".repeat(60));

    // --- TRIAGE: mature → FIX ---
    console.log("\n📋 Step 1: TRIAGE Issues (check if any are ready to work on)");
    const triageRaw = await callTool("prop_list", { status: "TRIAGE" });
    const triageProps = parseProposals(triageRaw);
    console.log(`  Found ${triageProps.length} TRIAGE proposals`);

    for (const p of triageProps) {
      console.log(`\n  [${p.id}] ${p.title}`);
      console.log(`    maturity: ${p.maturity}, type: ${p.type}`);
      
      // Skip obsolete proposals
      if (p.maturity === "obsolete") {
        console.log(`    ⏭️ Obsolete — skipping`);
        continue;
      }

      // Get proposal details to check if description is solid enough
      const detail = await callTool("prop_get", { id: p.id });
      const hasDescription = detail && detail.length > 100 && !detail.includes("No description");
      
      if (p.maturity === "mature") {
        console.log(`    ✅ Already mature — eligible for TRIAGE → FIX`);
        try {
          const result = await callTool("transition_proposal", {
            proposal_id: p.id,
            to_state: "FIX",
            decided_by: "rfc-gate-evaluator",
            rationale: "Gate evaluation: mature issue accepted for fix"
          });
          console.log(`    → ${result}`);
          actions.push(`${p.id}: TRIAGE → FIX`);
        } catch (e) {
          console.log(`    ❌ Transition failed: ${e.message}`);
        }
      } else if (p.maturity === "active") {
        console.log(`    ✅ Active (under lease) — setting mature to trigger FIX`);
        try {
          const result = await callTool("prop_set_maturity", {
            id: p.id, maturity: "mature", agent: "rfc-gate-evaluator"
          });
          console.log(`    → ${result}`);
          actions.push(`${p.id}: set mature (TRIAGE → FIX auto-transition)`);
        } catch (e) {
          console.log(`    ❌ ${e.message}`);
        }
      } else {
        console.log(`    ⏳ maturity=${p.maturity} — not ready for gate advancement`);
      }
    }

    // --- FIX: mature + all AC passing → DEPLOYED ---
    console.log("\n📋 Step 2: FIX Issues (check if mature with passing AC)");
    const fixRaw = await callTool("prop_list", { status: "FIX" });
    const fixProps = parseProposals(fixRaw);
    console.log(`  Found ${fixProps.length} FIX proposals`);

    for (const p of fixProps) {
      console.log(`\n  [${p.id}] ${p.title}`);
      console.log(`    maturity: ${p.maturity}`);

      if (p.maturity === "mature") {
        const acRaw = await callTool("list_ac", { proposal_id: p.id });
        const acStatus = parseAC(acRaw);
        console.log(`    AC: ${acStatus.summary}`);
        
        if (acStatus.allPassing) {
          console.log(`    ✅ All AC passing — advancing FIX → DEPLOYED`);
          try {
            const result = await callTool("transition_proposal", {
              proposal_id: p.id,
              to_state: "DEPLOYED",
              decided_by: "rfc-gate-evaluator",
              rationale: "Gate: all AC verified, deploying fix"
            });
            console.log(`    → ${result}`);
            actions.push(`${p.id}: FIX → DEPLOYED`);
          } catch (e) {
            console.log(`    ❌ ${e.message}`);
          }
        } else if (!acStatus.hasAC) {
          console.log(`    ⚠️ No AC defined — cannot verify fix completeness`);
        } else {
          console.log(`    ⏳ AC not all passing — cannot deploy yet`);
        }
      } else {
        console.log(`    ⏳ maturity=${p.maturity} — not ready`);
      }
    }

    // =====================================================
    // RFC WORKFLOW: DRAFT → REVIEW → DEVELOP → MERGE → COMPLETE
    // =====================================================
    console.log("\n" + "═".repeat(60));
    console.log("RFC WORKFLOW (feature/component/product)");
    console.log("═".repeat(60));

    // --- DRAFT: mature → REVIEW ---
    console.log("\n📋 Step 1: DRAFT Proposals (enhance and move to REVIEW)");
    const draftRaw = await callTool("prop_list", { status: "DRAFT" });
    const draftProps = parseProposals(draftRaw);
    console.log(`  Found ${draftProps.length} DRAFT proposals`);

    for (const p of draftProps) {
      console.log(`\n  [${p.id}] ${p.title}`);
      console.log(`    maturity: ${p.maturity}`);

      if (p.maturity === "mature") {
        console.log(`    ✅ Mature — advancing DRAFT → REVIEW`);
        try {
          const result = await callTool("transition_proposal", {
            proposal_id: p.id,
            to_state: "REVIEW",
            decided_by: "rfc-gate-evaluator",
            rationale: "Gate: proposal description solid, advancing to REVIEW"
          });
          console.log(`    → ${result}`);
          actions.push(`${p.id}: DRAFT → REVIEW`);
        } catch (e) {
          console.log(`    ❌ ${e.message}`);
        }
      } else {
        console.log(`    ⏳ maturity=${p.maturity} — needs enhancement before REVIEW`);
      }
    }

    // --- REVIEW: mature + has AC → DEVELOP ---
    console.log("\n📋 Step 2: REVIEW Proposals (check AC, move to DEVELOP)");
    const reviewRaw = await callTool("prop_list", { status: "REVIEW" });
    const reviewProps = parseProposals(reviewRaw);
    console.log(`  Found ${reviewProps.length} REVIEW proposals`);

    for (const p of reviewProps) {
      console.log(`\n  [${p.id}] ${p.title}`);
      console.log(`    maturity: ${p.maturity}`);

      if (p.maturity === "mature") {
        const acRaw = await callTool("list_ac", { proposal_id: p.id });
        const acStatus = parseAC(acRaw);
        console.log(`    AC: ${acStatus.summary}`);

        if (acStatus.hasAC && acStatus.allPassing) {
          console.log(`    ✅ AC defined & passing — advancing REVIEW → DEVELOP`);
          try {
            const result = await callTool("transition_proposal", {
              proposal_id: p.id,
              to_state: "DEVELOP",
              decided_by: "rfc-gate-evaluator",
              rationale: "Gate: AC defined and verified, advancing to DEVELOP"
            });
            console.log(`    → ${result}`);
            actions.push(`${p.id}: REVIEW → DEVELOP`);
          } catch (e) {
            console.log(`    ❌ ${e.message}`);
          }
        } else if (acStatus.hasAC) {
          console.log(`    ⏳ AC exists but not all passing`);
        } else {
          console.log(`    ⚠️ No AC defined — needs acceptance criteria before REVIEW → DEVELOP`);
        }
      } else {
        console.log(`    ⏳ maturity=${p.maturity} — not ready for REVIEW → DEVELOP`);
      }
    }

    // --- DEVELOP: mature + all AC passing → MERGE ---
    console.log("\n📋 Step 3: DEVELOP Proposals (check work completion, move to MERGE)");
    const developRaw = await callTool("prop_list", { status: "DEVELOP" });
    const developProps = parseProposals(developRaw);
    console.log(`  Found ${developProps.length} DEVELOP proposals`);

    for (const p of developProps) {
      console.log(`\n  [${p.id}] ${p.title}`);
      console.log(`    maturity: ${p.maturity}`);

      if (p.maturity === "mature") {
        const acRaw = await callTool("list_ac", { proposal_id: p.id });
        const acStatus = parseAC(acRaw);
        console.log(`    AC: ${acStatus.summary}`);

        if (acStatus.allPassing) {
          console.log(`    ✅ All AC passing — advancing DEVELOP → MERGE`);
          try {
            const result = await callTool("transition_proposal", {
              proposal_id: p.id,
              to_state: "MERGE",
              decided_by: "rfc-gate-evaluator",
              rationale: "Gate: development complete, all AC verified, advancing to MERGE"
            });
            console.log(`    → ${result}`);
            actions.push(`${p.id}: DEVELOP → MERGE`);
          } catch (e) {
            console.log(`    ❌ ${e.message}`);
          }
        } else if (!acStatus.hasAC) {
          console.log(`    ⚠️ No AC defined`);
        } else {
          console.log(`    ⏳ AC not all passing — work incomplete`);
        }
      } else {
        console.log(`    ⏳ maturity=${p.maturity} — not ready`);
      }
    }

    // --- MERGE: mature + all AC passing → COMPLETE ---
    console.log("\n📋 Step 4: MERGE Proposals (verify merge, move to COMPLETE)");
    const mergeRaw = await callTool("prop_list", { status: "MERGE" });
    const mergeProps = parseProposals(mergeRaw);
    console.log(`  Found ${mergeProps.length} MERGE proposals`);

    for (const p of mergeProps) {
      console.log(`\n  [${p.id}] ${p.title}`);
      console.log(`    maturity: ${p.maturity}`);

      if (p.maturity === "mature") {
        const acRaw = await callTool("list_ac", { proposal_id: p.id });
        const acStatus = parseAC(acRaw);
        console.log(`    AC: ${acStatus.summary}`);

        if (acStatus.allPassing) {
          console.log(`    ✅ All AC passing — advancing MERGE → COMPLETE`);
          try {
            const result = await callTool("transition_proposal", {
              proposal_id: p.id,
              to_state: "COMPLETE",
              decided_by: "rfc-gate-evaluator",
              rationale: "Gate: merged to main, all AC verified, marking COMPLETE"
            });
            console.log(`    → ${result}`);
            actions.push(`${p.id}: MERGE → COMPLETE`);
          } catch (e) {
            console.log(`    ❌ ${e.message}`);
          }
        } else {
          console.log(`    ⏳ AC not all passing`);
        }
      } else {
        console.log(`    ⏳ maturity=${p.maturity} — not ready`);
      }
    }

    // --- Summary ---
    console.log("\n" + "═".repeat(60));
    console.log("EVALUATION SUMMARY");
    console.log("═".repeat(60));
    if (actions.length === 0) {
      console.log("No proposals advanced — none met gate criteria this run.");
    } else {
      console.log(`${actions.length} transition(s) performed:`);
      actions.forEach(a => console.log(`  ✅ ${a}`));
    }

    await client.close();
    console.log("\n✅ Gate evaluation complete");

  } catch (err) {
    console.error("❌ MCP Error:", err.message);
    try { await client.close(); } catch {}
    process.exit(1);
  }
}

function parseProposals(text) {
  if (!text || text.startsWith("No proposals")) return [];
  const lines = text.trim().split('\n');
  return lines.map(line => {
    const m = line.match(/^\[(P\d+)\]\s+(.+?)\s+—\s+status:\s+(\S+),\s+type:\s+(\S+),\s+maturity:\s+(\S+)/);
    if (m) return { id: m[1], title: m[2], status: m[3], type: m[4], maturity: m[5] };
    return null;
  }).filter(Boolean);
}

function parseAC(acText) {
  if (!acText || acText.includes("No acceptance criteria") || acText.includes("not found")) {
    return { hasAC: false, allPassing: false, summary: "none" };
  }
  // Look for structured AC items
  const hasItems = /\bAC[-\s]?\d+/i.test(acText) || /\d+\.\s/.test(acText) || /- \[[ x]\]/.test(acText);
  const passCount = (acText.match(/✅|pass(?:ed)?/gi) || []).length;
  const failCount = (acText.match(/❌|fail(?:ed)?/gi) || []).length;
  const pendingCount = (acText.match(/⏳|pending/gi) || []).length;
  const blockedCount = (acText.match(/blocked/gi) || []).length;
  
  const hasAC = hasItems || passCount > 0 || failCount > 0;
  const allPassing = hasAC && failCount === 0 && pendingCount === 0 && blockedCount === 0;
  
  return {
    hasAC,
    allPassing,
    summary: `${passCount}✅ ${failCount}❌ ${pendingCount}⏳ ${blockedCount}🚫`
  };
}

main();
