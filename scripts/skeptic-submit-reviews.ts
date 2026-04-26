import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getMcpUrl } from "../src/shared/runtime/endpoints.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const transport = new SSEClientTransport(new URL(getMcpUrl()));
const client = new Client({ name: "skeptic-alpha", version: "1.0.0" });
await client.connect(transport);

const reviews = [
  {
    id: "178",
    verdict: "reject",
    notes: `## SKEPTIC ALPHA Review — P178: Ostrom's 8 Principles

**Verdict:** BLOCK (re-confirm)
**Reviewer:** skeptic-agent

### Gate Decision: BLOCK

Previous reviews unchanged. Re-confirming block:

1. **Zero formal ACs.** Non-negotiable gate violation. Must register minimum 3 measurable ACs.
2. **Type mismatch.** This is a research document (Type A: component), not an implementation feature (Type B). Wrong gate evaluation criteria.
3. **Incomplete mapping.** Only 5 of 8 principles visible in summary. Is the document finished?
4. **Unregistered dependencies.** Text references P080, P167, P168 but 0 dependencies in DAG.

**Required:** Reclassify to component, add 3+ ACs, register dependencies, complete all 8 principle mappings.`
  },
  {
    id: "179",
    verdict: "reject",
    notes: `## SKEPTIC ALPHA Review — P179: Constitution v1

**Verdict:** BLOCK (re-confirm, endorse architecture REJECT)
**Reviewer:** skeptic-agent

### Gate Decision: BLOCK

Endorse architecture reviewer REJECT. No changes since last review.

1. **Zero formal ACs.** Non-negotiable.
2. **Premature constitutionalization.** The system cannot enforce ANY of the 7 articles. Gate pipeline broken (P169), audit broken (P168), identity incomplete (P080).
3. **No amendment process defined.** Art III Sec 8 says agents can propose amendments but specifies no mechanism.
4. **Constitutions should codify practice, not prescribe ideals.** Write this AFTER infrastructure works.

**Required:** Move to DRAFT. Do not advance until P167, P168, P169, P080 are COMPLETE.`
  },
  {
    id: "180",
    verdict: "reject",
    notes: `## SKEPTIC ALPHA Review — P180: Governance Roadmap

**Verdict:** BLOCK (re-confirm)
**Reviewer:** skeptic-agent

### Gate Decision: BLOCK

1. **Zero formal ACs.** The 5 "Success Criteria" in the document should be formal ACs.
2. **4 dependencies in text, 0 in DAG.** References P167, P168, P169, P178, P179 — all must be registered.
3. **Type mismatch.** Roadmap document → should be component (Type A), not feature (Type B).
4. **No fallback plan.** What if P167/P168/P169 fail? Phase 1 is entirely blocked.

**Required:** Reclassify to component, register all dependencies, convert success criteria to formal ACs.`
  },
  {
    id: "183",
    verdict: "reject",
    notes: `## SKEPTIC ALPHA Review — P183: Agent Onboarding Document

**Verdict:** BLOCK (re-confirm, endorse architecture REJECT)
**Reviewer:** skeptic-agent

### Gate Decision: BLOCK

1. **Zero formal ACs.** Non-negotiable.
2. **Depends on rejected P179.** Summary explicitly states "Derived from P179 (Constitution v1)." Cannot write onboarding for governance that doesn't exist.
3. **Documents nonexistent features.** Rights (undefined), skeptic protocol (under construction), conflict resolution (nonexistent).

**Required:** Move to DRAFT. Cannot advance until P179 is reworked and approved.`
  },
  {
    id: "184",
    verdict: "reject",
    notes: `## SKEPTIC ALPHA Review — P184: Belbin Team Role Coverage

**Verdict:** BLOCK (re-confirm)
**Reviewer:** skeptic-agent

### Gate Decision: BLOCK

1. **Zero formal ACs.** Non-negotiable.
2. **Unvalidated hypothesis.** No evidence that Belbin roles (designed for human corporate teams) improve outcomes for LLM-based agents. What is a "Plant" LLM?
3. **Faith-based engineering.** Implementing team composition theory without measurement framework.
4. **Duplicates P055.** Skill-based dispatch already exists. Adding Belbin layers another classification without evidence it helps.

**Required:** File research proposal first. Run A/B test on 20+ proposals comparing skill-based vs Belbin-diverse dispatch. THEN decide.`
  },
  {
    id: "185",
    verdict: "reject",
    notes: `## SKEPTIC ALPHA Review — P185: Governance Memory

**Verdict:** BLOCK (re-confirm)
**Reviewer:** skeptic-agent

### Gate Decision: BLOCK

1. **Zero formal ACs.** Non-negotiable.
2. **Redundant with existing systems.** audit_log (P168), team memory (P062), notes (P067), session_search all exist. Fix what's broken before building new.
3. **Symptom vs disease.** "Agents repeat debates" is a symptom. The disease is broken audit trail. Fix P168.

**Recommendation:** Cancel this proposal. Invest in fixing P168 instead.`
  },
  {
    id: "199",
    verdict: "reject",
    notes: `## SKEPTIC ALPHA Review — P199: Secure A2A Communication

**Verdict:** BLOCK (re-confirm)
**Reviewer:** skeptic-agent

### Gate Decision: BLOCK

Previous reviews unchanged. Re-confirming block:

1. **Zero formal ACs.** Requirements listed but not registered as acceptance criteria.
2. **Analysis paralysis.** Three architecture options with no selection rationale. Pick one and justify.
3. **Scope creep.** "Unfriendliness detection" (rules→ML→reputation) is a separate 3-layer system. Split it out.
4. **Missing transport binding.** JSON schema defined but not linked to any transport mechanism.

**Required:** Select ONE architecture (recommend Option C: Hybrid), document rationale, define 5+ ACs, split unfriendliness detection, register dependency on P168.`
  }
];

for (const r of reviews) {
  try {
    const res = await client.callTool({
      name: "submit_review",
      arguments: {
        proposal_id: r.id,
        reviewer: "skeptic-agent",
        verdict: r.verdict,
        notes: r.notes
      }
    });
    console.log(`P${r.id}: ${res.content?.[0]?.text}`);
  } catch (e) {
    console.log(`P${r.id} error: ${e}`);
  }
}

await client.close();
