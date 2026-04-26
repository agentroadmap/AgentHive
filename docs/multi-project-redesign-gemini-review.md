This comprehensive review evaluates the **AgentHive Multi-Project Redesign** draft from the perspective of a Software Architect. The focus is on the structural integrity, scalability, and operational viability of the proposed `hiveCentral` + Tenant DB model.

---

# Architectural Review: AgentHive Multi-Project Redesign

## 1. Executive Summary
The redesign shifts AgentHive from a monolithic database to a **distributed multi-tenant architecture**. The primary architectural win is the formal separation of the **Control Plane** (`hiveCentral`) from the **Data Plane** (Tenant DBs). This aligns with industry standards for SaaS and autonomous agent platforms, providing a clear path for horizontal scaling and security isolation.

## 2. Structural Strengths (Architectural Wins)

### 2.1 Domain Isolation and Scalability
The decision to use **physical database isolation** (one DB per project) instead of logical isolation (shared tables with `project_id` filters) is superior for this use case. 
* **Performance:** It prevents "noisy neighbor" issues where one hyper-active project (Pillar 2/Workforce) could degrade performance for the entire platform. 
* **Mobility:** As noted in Section 3, this enables moving tenant DBs to different physical hosts without re-architecting the core logic.

### 2.2 Proposals as a Durable Product
The "Markdown-first" approach for proposals (Section 4) correctly identifies that the **rationale** is as important as the **execution**. By making proposals the canonical store for design and intent, the platform ensures that the system's "memory" survives even after the operational workflow rows (cubics, dispatches) are archived.

### 2.3 Defense-in-Depth Security Model
The five-layer security approach (Section 9 & 10) is robust. Specifically:
* **Postgres RLS + Agency Identity:** The requirement to `SET LOCAL app.current_agency_id` creates a mandatory context-check at the SQL level, significantly reducing the risk of cross-tenant data leakage.
* **Signed Envelopes:** Using Ed25519 signatures for A2A communication (Section 7) ensures non-repudiation, which is critical for an autonomous agency where agents must be held accountable for state mutations.

---

## 3. Critical Weaknesses & Risks

### 3.1 Orchestration Bottleneck (The Central Single-Point-of-Failure)
Section 1 defines a "Central Orchestrator (1 process)." While the design accounts for stateless restarts (Section 11), a single process managing dispatches across $N$ projects and $N$ agencies may become a bottleneck as the fleet grows toward the 100-agent target. 
* **Issue:** If the central orchestrator lags in processing the A2A bus, lease renewals (Section 11) may fail, causing agents to lose worktrees prematurely.

### 3.2 Complexity of "Self-Evolution" Special-Casing
The `is_self_evo` flag and the `orchestration_self` schema (Section 4) create a dual-path logic for the orchestrator.
* **Risk:** This creates "God Mode" logic. A bug in the self-evolution dispatch path could brick the platform's ability to fix itself. Mixing infrastructure management with product management in the same control plane increases the "blast radius" of a failed self-evolution proposal.

### 3.3 Application-Level Joins
The ban on cross-DB joins (Section 3) is a necessary trade-off for multi-tenancy, but it shifts significant complexity to the application layer.
* **Risk:** Joining `workforce.agent` (Central) with `proposal.proposal_lease` (Tenant) in code will require efficient caching strategies (Pillar 3: Efficiency). Without careful implementation, the p99 latency targets for dispatch (Section 11) may be difficult to meet.

---

## 4. Technical Analysis & Potential Issues

### 4.1 Consistency in Reference Terms
The redesign mentions `reference_terms` (Section 3) to replace hard-coded terms. 
* **Potential Issue:** In a multi-tenant setup, ensuring that all Tenant DBs stay in sync with the `hiveCentral` reference terms is difficult. If a new `maturity` level is added centrally, existing tenant logic (which may have copied templates at bootstrap) might not handle the new term correctly until a "Sync Audit" is performed.

### 4.2 A2A Messaging Retention
Section 7 sets a 14-day retention for `a2a_topic`. 
* **Potential Issue:** For complex "Type A" design proposals that might span weeks of deliberation, 14 days of message history might be insufficient for a "Skeptic" agent to reconstruct the full context of why a decision was made. If messages are the primary "Team Memory" (Pillar 3), they may need to be persisted as `proposal_review` entries before the retention period expires.

### 4.3 Sandbox Egress Latency
Section 10 requires ephemeral sandbox spawning per task with p99 < 30s.
* **Potential Issue:** For "Chatty" MCP interactions, spinning up a full container-based sandbox (firejail/bwrap) for every single tool call may introduce prohibitive overhead. The design should clarify if sandboxes persist for the duration of a **Lease** or if they are truly **Per-Task**.

---

## 5. Review of "Open Questions" (Section 15)

1.  **Workflow Customization:** *Feedback:* Option (a) (adding templates centrally) is the safest for v1. Option (c) (composable steps) is the "Architectural North Star" but adds massive complexity to the Gating Agent's logic.
2.  **Cross-Project Dependencies:** *Feedback:* A `hiveCentral.cross_project_dependency` table is preferable. If a proposal in Project A blocks Project B, the "Control Plane" needs to know this to manage budget and dispatching priority without having to crawl every tenant DB.
3.  **Budget Cap Behavior:** *Feedback:* Stalling in `budget_blocked` is the correct "Axelrod" move. However, the system should allow a "Emergency Hotfix" type to bypass the hard cap if the `host_id` health is at risk.

---

## 6. Conclusion
The **Multi-Project Redesign** is a solid, professional-grade architectural blueprint. It effectively solves the identity and isolation problems inherent in the previous "everything in one DB" model. 

**Recommendation:** Focus immediate attention on the **Wave 2 read-shadow** (Section 13). Because the "Proposals as Documentation" shift changes the fundamental schema of the durable product, the shadow-testing phase will be the most critical for identifying "semantic drift" between the old `roadmap` schema and the new tenant-scoped `proposal` schema.