-- Migration 122: P998 proposal_migration_map seed — first controlled inventory pass
-- Classifies the legacy proposal corpus against the agentHive2 canonical stack.
-- Reviewed by: alex (engineer, P995 offer 00000000-0000-0000-0000-000000008657)
-- Classification vocabulary: retained | delivered_evidence | duplicate | obsolete |
--                            reauthor_needed | superseded

-- ───────────────────────────────────────────────────────────────────────────
-- PILLAR 1: Control Plane (canonical P1014)
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO roadmap_proposal.proposal_migration_map
    (legacy_proposal_id, canonical_proposal_id, classification, rationale, evidence_refs, reviewed_by, reviewed_at)
VALUES
(821, 1014, 'delivered_evidence', 'AgentHive V2 single-database architecture — foundation for agentHive2 control plane', '["migration:agentHive2-baseline"]', 'alex', now()),
(823, 1014, 'delivered_evidence', 'agentHive2 database baseline DDL + seed — deployed schema foundation', '["migration:agentHive2-baseline"]', 'alex', now()),
(825, 1014, 'delivered_evidence', 'V2 SMDL migration — workflow definitions migrated to DB-only', '[]', 'alex', now()),
(826, 1014, 'delivered_evidence', 'V2 application code migration — schema-aware pool + search_path, COMPLETE with verified ACs', '[]', 'alex', now()),
(756, 1014, 'delivered_evidence', 'B2 hiveCentral DB bootstrap (provisioning + role grants)', '[]', 'alex', now()),
(757, 1014, 'delivered_evidence', 'B3 migrate control-plane tables out of agenthive into hiveCentral', '[]', 'alex', now()),
(758, 1014, 'delivered_evidence', 'B4 tenant-DB provisioning + project registry', '[]', 'alex', now()),
(759, 1014, 'delivered_evidence', 'B5 code rewire — every getPool() caller routes to hiveCentral or tenant', '[]', 'alex', now()),
(760, 1014, 'delivered_evidence', 'B6 project_capacity_config schema + seed', '[]', 'alex', now()),
(891, 1014, 'delivered_evidence', 'G1 camelCase identifier folding fix — agentHive2 DDL silent lowercasing', '[]', 'alex', now()),
(892, 1014, 'delivered_evidence', 'G2 observability schema port into agentHive2 control plane', '[]', 'alex', now()),
(893, 1014, 'delivered_evidence', 'G3 tenant lifecycle state machine port', '[]', 'alex', now()),
(894, 1014, 'delivered_evidence', 'G4 partition maintenance job for time-series tables', '[]', 'alex', now()),
(895, 1014, 'delivered_evidence', 'G5 backup harness + verify cron', '[]', 'alex', now()),
(896, 1014, 'delivered_evidence', 'G6 cross-project dependency graph + consistency check', '[]', 'alex', now()),
-- Obsolete Control Plane proposals (superseded by V2/agentHive2)
(429, 1014, 'obsolete', 'hiveControl + per-project tenant DBs keystone — superseded by P821/P745 agentHive2 architecture; maturity already obsolete', '[]', 'alex', now()),
(820, 1014, 'obsolete', 'Clean-sheet hiveCentral vNext — superseded by P821/agentHive2 baseline; maturity already obsolete', '[]', 'alex', now()),
(485, 1014, 'obsolete', 'Bridge sunset plan — superseded by execution of P757-760; maturity obsolete', '[]', 'alex', now()),
(473, 1014, 'obsolete', 'Compatibility-first migration plan — superseded by executed B-series; maturity obsolete', '[]', 'alex', now()),
(471, 1014, 'obsolete', 'Phased build-order plan — superseded by executed milestones; maturity obsolete', '[]', 'alex', now()),
(482, 1014, 'obsolete', 'Multi-Project Bootstrap M0 — executed and superseded by P513-516; maturity obsolete', '[]', 'alex', now()),
(302, 1014, 'obsolete', 'Multi-project architecture duplicate 2 — superseded by P429/P821', '[]', 'alex', now()),
(300, 1014, 'obsolete', 'Multi-project architecture component — superseded by P429/P821; maturity obsolete', '[]', 'alex', now()),
(298, 1014, 'obsolete', 'Multi-provider orchestration — superseded by P918 agency runtime; maturity obsolete', '[]', 'alex', now()),
(497, 1014, 'obsolete', 'Connection pool registry — superseded by P826 + P840; maturity obsolete', '[]', 'alex', now()),
(498, 1014, 'obsolete', 'Extend P474 config resolver — superseded by P826/P840; maturity obsolete', '[]', 'alex', now()),
-- P530 child components (all obsoleted by agentHive2)
(591, 1014, 'obsolete', 'P530.0 control-plane DR design — superseded by agentHive2 architecture; maturity obsolete', '[]', 'alex', now()),
(592, 1014, 'obsolete', 'P530.1 core schema — superseded by agentHive2 DDL; maturity obsolete', '[]', 'alex', now()),
(593, 1014, 'obsolete', 'P530.2 identity schema — superseded by agentHive2 DDL; maturity obsolete', '[]', 'alex', now()),
(594, 1014, 'obsolete', 'P530.3 agency schema — superseded by agentHive2 DDL; maturity obsolete', '[]', 'alex', now()),
(595, 1014, 'obsolete', 'P530.4 model schema — superseded by agentHive2 DDL; maturity obsolete', '[]', 'alex', now()),
(596, 1014, 'obsolete', 'P530.5 credential schema — superseded by agentHive2 DDL; maturity obsolete', '[]', 'alex', now()),
(598, 1014, 'obsolete', 'P530.7 template schema — superseded by agentHive2 DDL; maturity obsolete', '[]', 'alex', now()),
(599, 1014, 'obsolete', 'P530.8 tooling schema — superseded by agentHive2 DDL; maturity obsolete', '[]', 'alex', now()),
(600, 1014, 'obsolete', 'P530.9 sandbox schema — superseded by agentHive2 DDL; maturity obsolete', '[]', 'alex', now()),
(601, 1014, 'obsolete', 'P530.10 tenant lifecycle — superseded by P893 G3; maturity obsolete', '[]', 'alex', now()),
(603, 1014, 'obsolete', 'P530 messaging schema — superseded by P833-837 A2A series; maturity obsolete', '[]', 'alex', now()),
(606, 1014, 'obsolete', 'P530.15 efficiency schema — superseded by P892 G2 + observability DDL; maturity obsolete', '[]', 'alex', now()),
(607, 1014, 'obsolete', 'P530.16 policy engine seam — superseded by agentHive2 governance; maturity obsolete', '[]', 'alex', now())
ON CONFLICT (legacy_proposal_id) DO NOTHING;

-- ───────────────────────────────────────────────────────────────────────────
-- PILLAR 2: Proposal Engine (canonical P1015)
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO roadmap_proposal.proposal_migration_map
    (legacy_proposal_id, canonical_proposal_id, classification, rationale, evidence_refs, reviewed_by, reviewed_at)
VALUES
(774, 1015, 'delivered_evidence', 'C1 workflow vocab unification migration — COMPLETE', '["migration:054"]', 'alex', now()),
(775, 1015, 'delivered_evidence', 'C2 workflow-stages registry loader — COMPLETE', '[]', 'alex', now()),
(776, 1015, 'delivered_evidence', 'C3 web board force workflow filter + dynamic columns — COMPLETE', '[]', 'alex', now()),
(777, 1015, 'delivered_evidence', 'C4 TUI board filter row redesign — COMPLETE', '[]', 'alex', now()),
(934, 1015, 'delivered_evidence', 'Lease release semantics: release_reason required + enumerated — COMPLETE', '["migration:099"]', 'alex', now()),
(1001, 1015, 'delivered_evidence', 'HOTFIX: display_id truncation for four-digit IDs — COMPLETE', '[]', 'alex', now()),
(996, 1015, 'delivered_evidence', 'Permanent agent naming and liaison identity convention — COMPLETE', '[]', 'alex', now()),
(997, 1015, 'retained', 'P995-A: mapping artifact schema — DRAFT, this migration implements it', '["migration:121"]', 'alex', now()),
(998, 1015, 'retained', 'P995-B: corpus inventory seed — DRAFT, this migration implements it', '["migration:122"]', 'alex', now()),
(999, 1015, 'retained', 'P995-C: documentation projection demo — DRAFT, open work', '[]', 'alex', now()),
(706, 1015, 'retained', 'Workflow vocabulary unification umbrella — DEVELOP, parent of C1-C7 series', '[]', 'alex', now()),
(778, 1015, 'retained', 'C5 gate-evaluator closure verdicts → maturity=obsolete — DEVELOP open work', '[]', 'alex', now()),
(779, 1015, 'retained', 'C6 scanner rule + CI guard for legacy state literals — DEVELOP open work', '[]', 'alex', now()),
(780, 1015, 'retained', 'C7 documentation — CONVENTIONS.md updates — DEVELOP open work', '[]', 'alex', now()),
(150, 1015, 'retained', 'prop_update bypasses Decision Gate — DEVELOP, unfixed issue', '[]', 'alex', now()),
(87,  1015, 'obsolete', 'P087 adopt renamed maturity columns — superseded by executed migrations; maturity obsolete', '[]', 'alex', now()),
(145, 1015, 'obsolete', 'Remove duplicate proposal-storage-v2.ts shim — superseded; maturity obsolete', '[]', 'alex', now()),
(147, 1015, 'obsolete', 'P087 missing AC — superseded; maturity obsolete', '[]', 'alex', now())
ON CONFLICT (legacy_proposal_id) DO NOTHING;

-- ───────────────────────────────────────────────────────────────────────────
-- PILLAR 3: Workforce and Agencies (canonical P1016)
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO roadmap_proposal.proposal_migration_map
    (legacy_proposal_id, canonical_proposal_id, classification, rationale, evidence_refs, reviewed_by, reviewed_at)
VALUES
(918, 1016, 'delivered_evidence', 'Agency runtime contract + shared messaging gateway libraries — COMPLETE', '[]', 'alex', now()),
(919, 1016, 'delivered_evidence', 'Tiered Agent Identity — Human-Readable Roles + Scalable Instances — COMPLETE', '["migration:114"]', 'alex', now()),
(920, 1016, 'delivered_evidence', 'P918-1 CLI invocation registry — COMPLETE', '[]', 'alex', now()),
(921, 1016, 'delivered_evidence', 'P918-2 Active liaison session uniqueness — COMPLETE', '[]', 'alex', now()),
(922, 1016, 'delivered_evidence', 'P918-3 Host-aware notification optimization — COMPLETE', '[]', 'alex', now()),
(923, 1016, 'delivered_evidence', 'P918-4 Discord external routing bridge — COMPLETE', '[]', 'alex', now()),
(924, 1016, 'delivered_evidence', 'P918-5 Multi-host recovery and polling semantics — COMPLETE', '[]', 'alex', now()),
(912, 1016, 'delivered_evidence', 'Agency self-registration and liaison bootstrap on provider startup — COMPLETE', '[]', 'alex', now()),
(913, 1016, 'delivered_evidence', 'HOTFIX: agency-self-registration FK type / no transaction / race — COMPLETE', '[]', 'alex', now()),
(914, 1016, 'delivered_evidence', 'HOTFIX: push-dispatch payload missing offer_id/claim_token — COMPLETE', '[]', 'alex', now()),
(928, 1016, 'delivered_evidence', 'Agent registry route binding — surface current backend on agent identities — COMPLETE', '["migration:117"]', 'alex', now()),
(930, 1016, 'delivered_evidence', 'Generic agency systemd template + retire per-provider service units — COMPLETE', '[]', 'alex', now()),
(852, 1016, 'delivered_evidence', 'Readable Agent Names — model_routes.abbr + structured identity — COMPLETE', '[]', 'alex', now()),
(746, 1016, 'retained', 'Umbrella C — Agency Offline Detection + Auto-Recovery — DEVELOP open work', '[]', 'alex', now()),
(765, 1016, 'retained', 'C5 auto-recovery and scope-aware alerting — DEVELOP open work', '[]', 'alex', now()),
(766, 1016, 'retained', 'C6 operator action surface for liaison pause/resume/retire — DEVELOP open work', '[]', 'alex', now()),
(289, 1016, 'obsolete', 'Pull-Based Work Dispatch — superseded by P912 agency self-registration; maturity obsolete', '[]', 'alex', now())
ON CONFLICT (legacy_proposal_id) DO NOTHING;

-- ───────────────────────────────────────────────────────────────────────────
-- PILLAR 4: A2A Messaging (canonical P1017)
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO roadmap_proposal.proposal_migration_map
    (legacy_proposal_id, canonical_proposal_id, classification, rationale, evidence_refs, reviewed_by, reviewed_at)
VALUES
(833, 1017, 'delivered_evidence', 'A2A Unified Message Envelope — extend message_ledger + ACK/reply MCP tools — COMPLETE', '["migration:096"]', 'alex', now()),
(834, 1017, 'delivered_evidence', 'A2A Identity & Trust — agent_secret, HMAC dispatch gate, spawn grant verification — COMPLETE', '["migration:102"]', 'alex', now()),
(835, 1017, 'delivered_evidence', 'A2A Message Reliability — timeout tracking cron, dead letter, escalation — COMPLETE', '[]', 'alex', now()),
(836, 1017, 'delivered_evidence', 'A2A Cross-Host Delivery — HTTP callback relay via agent_registry — COMPLETE', '["migration:103"]', 'alex', now()),
(837, 1017, 'delivered_evidence', 'A2A Legacy Cleanup — consolidate liaison_message into message_ledger — COMPLETE', '["migration:118"]', 'alex', now()),
(888, 1017, 'delivered_evidence', 'fn_a2a_message_notify deploy gap fix — COMPLETE', '["migration:119"]', 'alex', now()),
(907, 1017, 'delivered_evidence', 'A2A reply/thread/broadcast semantics standardization — COMPLETE', '[]', 'alex', now()),
(990, 1017, 'delivered_evidence', 'Enforce message_ledger nonce uniqueness for A2A replay prevention — COMPLETE', '[]', 'alex', now()),
(991, 1017, 'delivered_evidence', 'P834 Phase 4 enforce HMAC sig_verified on msg_send — COMPLETE', '["migration:116"]', 'alex', now()),
(992, 1017, 'delivered_evidence', 'P935 agentic task execution via liaison message bus — COMPLETE', '[]', 'alex', now()),
(993, 1017, 'delivered_evidence', 'A2A Agentic Task Protocol — Stateful Liaison Orchestration — COMPLETE', '[]', 'alex', now()),
(994, 1017, 'delivered_evidence', 'P993 Phase 2 Task Protocol Completeness — COMPLETE', '[]', 'alex', now()),
(1007, 1017, 'delivered_evidence', 'P907-A A2A reply-semantics P1 fixes — COMPLETE', '[]', 'alex', now()),
(1008, 1017, 'delivered_evidence', 'P907-B A2A reply-semantics P2 fixes — COMPLETE', '[]', 'alex', now())
ON CONFLICT (legacy_proposal_id) DO NOTHING;

-- ───────────────────────────────────────────────────────────────────────────
-- PILLAR 5: Execution and Orchestration (canonical P1021)
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO roadmap_proposal.proposal_migration_map
    (legacy_proposal_id, canonical_proposal_id, classification, rationale, evidence_refs, reviewed_by, reviewed_at)
VALUES
(902, 1021, 'delivered_evidence', 'A8 collapse scripts/orchestrator.ts into unified Orchestrator class — COMPLETE', '["commit:8693f8d3"]', 'alex', now()),
(903, 1021, 'delivered_evidence', 'P902-A shim + lifecycle wiring — COMPLETE', '[]', 'alex', now()),
(909, 1021, 'delivered_evidence', 'P902-E resolver cleanup (sweep dead duplicate, gate-role-resolver boundary) — COMPLETE', '["commit:367b15f1"]', 'alex', now()),
(761, 1021, 'delivered_evidence', 'C1 agency liveness state consumed by resolve_agency — COMPLETE', '[]', 'alex', now()),
(763, 1021, 'delivered_evidence', 'C3 spawn-failure counter feeding TypeScript agency resolver — COMPLETE', '[]', 'alex', now()),
(764, 1021, 'delivered_evidence', 'C4 tenant-aware agency in-flight capacity — COMPLETE', '[]', 'alex', now()),
(767, 1021, 'delivered_evidence', 'D1 project_route_policy schema + seed — COMPLETE', '["migration:056"]', 'alex', now()),
(769, 1021, 'delivered_evidence', 'D3 queue-role route constraints on agent_role_profile — COMPLETE', '[]', 'alex', now()),
(770, 1021, 'delivered_evidence', 'D4 per-(project,route) hourly token-budget table + window resetter — COMPLETE', '[]', 'alex', now()),
(771, 1021, 'delivered_evidence', 'D5 extend resolveModelRoute() with 4 new filter layers — COMPLETE', '[]', 'alex', now()),
(772, 1021, 'delivered_evidence', 'D6 route_decision_log audit table + write hook — COMPLETE', '["migration:117"]', 'alex', now()),
(773, 1021, 'delivered_evidence', 'D7 fallback chain when chosen route throttled — COMPLETE', '[]', 'alex', now()),
(796, 1021, 'delivered_evidence', 'Provider health tracking — async query endpoint — COMPLETE', '[]', 'alex', now()),
(744, 1021, 'retained', 'Umbrella A — Centralized Orchestrator — DEVELOP, parent of A8 series', '[]', 'alex', now()),
(904, 1021, 'retained', 'P902-B Liaison-first dispatch (replace direct spawn with offer_dispatch) — DEVELOP open work', '[]', 'alex', now()),
(223, 1021, 'obsolete', 'Canonical Orchestrator — superseded by P902/A8 Orchestrator class; maturity obsolete', '[]', 'alex', now())
ON CONFLICT (legacy_proposal_id) DO NOTHING;

-- ───────────────────────────────────────────────────────────────────────────
-- PILLAR 6: Governance and Trust (canonical P1022)
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO roadmap_proposal.proposal_migration_map
    (legacy_proposal_id, canonical_proposal_id, classification, rationale, evidence_refs, reviewed_by, reviewed_at)
VALUES
(841, 1022, 'delivered_evidence', 'Agent Authentication & Resource Access Distribution Architecture — COMPLETE', '[]', 'alex', now()),
(843, 1022, 'delivered_evidence', 'P841-A MCP Auth Middleware — PrincipalVerifier Integration — COMPLETE', '["migration:107"]', 'alex', now()),
(844, 1022, 'delivered_evidence', 'P841-B Pool Identity Gating — agent_project_roles + AsyncLocalStorage — COMPLETE', '["migration:109"]', 'alex', now()),
(845, 1022, 'delivered_evidence', 'P841-C Spawned Agent Env Sanitization — COMPLETE', '[]', 'alex', now()),
(842, 1022, 'delivered_evidence', 'P841-D Hard Budget Enforcement per Agent — COMPLETE', '["migration:110"]', 'alex', now()),
(851, 1022, 'delivered_evidence', 'P841 follow-up: POST /mcp bearer verification + e2e test suite — COMPLETE', '[]', 'alex', now()),
(854, 1022, 'delivered_evidence', 'P844 pool gate gap: propagate _auth principal into callTool() — COMPLETE', '[]', 'alex', now()),
(846, 1022, 'delivered_evidence', 'Operator Agency Registration & A2A Response Closure — COMPLETE', '[]', 'alex', now()),
(840, 1022, 'delivered_evidence', 'Wire ConfigResolver into pool.ts — eliminate bare process.env.PG* reads — COMPLETE', '[]', 'alex', now())
ON CONFLICT (legacy_proposal_id) DO NOTHING;

-- ───────────────────────────────────────────────────────────────────────────
-- PILLAR 7: Observability and Efficiency (canonical P1023)
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO roadmap_proposal.proposal_migration_map
    (legacy_proposal_id, canonical_proposal_id, classification, rationale, evidence_refs, reviewed_by, reviewed_at)
VALUES
(897, 1023, 'delivered_evidence', 'G7 budget unblock reserve on spBudget — COMPLETE', '[]', 'alex', now()),
(898, 1023, 'delivered_evidence', 'G8 DLQ replay/inspect MCP actions — COMPLETE', '[]', 'alex', now()),
(899, 1023, 'delivered_evidence', 'G9 kbEmbedding IVFFlat index auto-creation in project-init — COMPLETE', '[]', 'alex', now()),
(1004, 1023, 'delivered_evidence', 'Agent Cost & Quota Self-Reporting — Provider-Aware Budget Intelligence — COMPLETE', '[]', 'alex', now()),
(1005, 1023, 'delivered_evidence', 'Task Tier Routing — Free-Model Labour Pool for Mechanical Ops — COMPLETE', '[]', 'alex', now()),
(1006, 1023, 'delivered_evidence', 'Model Capability Registry — Structured Provider Profiles — COMPLETE', '[]', 'alex', now())
ON CONFLICT (legacy_proposal_id) DO NOTHING;

-- ───────────────────────────────────────────────────────────────────────────
-- PILLAR 8: Web and Operator Experience (canonical P1024)
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO roadmap_proposal.proposal_migration_map
    (legacy_proposal_id, canonical_proposal_id, classification, rationale, evidence_refs, reviewed_by, reviewed_at)
VALUES
(238, 1024, 'retained', 'State Machine Dashboard — DEVELOP open work', '[]', 'alex', now()),
(296, 1024, 'retained', 'Web UI model routing management page — DEVELOP open work', '[]', 'alex', now()),
(301, 1024, 'retained', 'Web UI: unify data source on Postgres — DEVELOP open work', '[]', 'alex', now()),
(388, 1024, 'retained', 'Dashboard Architecture & Data Layer — DEVELOP open work', '[]', 'alex', now()),
(390, 1024, 'retained', 'Design System & Component Library — DEVELOP open work', '[]', 'alex', now()),
(802, 1024, 'retained', 'Dashboard-web portal gap report — DEVELOP open work', '[]', 'alex', now()),
(720, 1024, 'retained', 'Activity Feed redesign — Discord posts + roadmap-board live panel — DEVELOP', '[]', 'alex', now()),
(294, 1024, 'obsolete', 'Web UI data source duplicate hotfix — superseded by P301; maturity obsolete', '[]', 'alex', now())
ON CONFLICT (legacy_proposal_id) DO NOTHING;

-- ───────────────────────────────────────────────────────────────────────────
-- TEST FIXTURE PROPOSALS (P224 queue test series)
-- Synthetic proposals created by state-transition tests; not real work items.
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO roadmap_proposal.proposal_migration_map
    (legacy_proposal_id, canonical_proposal_id, classification, rationale, evidence_refs, reviewed_by, reviewed_at)
VALUES
(879, NULL, 'obsolete', 'P224 Queue Test fixture — synthetic test artifact, not a real work proposal', '[]', 'alex', now()),
(880, NULL, 'obsolete', 'P224 Locked Queue Test fixture — synthetic test artifact', '[]', 'alex', now()),
(881, NULL, 'obsolete', 'P224 Unlocked 1 fixture — synthetic test artifact', '[]', 'alex', now()),
(882, NULL, 'obsolete', 'P224 Locked 1 fixture — synthetic test artifact', '[]', 'alex', now()),
(863, NULL, 'obsolete', 'P224 Queue Test fixture — synthetic test artifact', '[]', 'alex', now()),
(864, NULL, 'obsolete', 'P224 Locked Queue Test fixture — synthetic test artifact', '[]', 'alex', now()),
(865, NULL, 'obsolete', 'P224 Unlocked 1 fixture — synthetic test artifact', '[]', 'alex', now()),
(866, NULL, 'obsolete', 'P224 Locked 1 fixture — synthetic test artifact', '[]', 'alex', now()),
(884, NULL, 'obsolete', 'P224 Queue Test fixture — synthetic test artifact', '[]', 'alex', now()),
(885, NULL, 'obsolete', 'P224 Locked Queue Test fixture — synthetic test artifact', '[]', 'alex', now()),
(886, NULL, 'obsolete', 'P224 Unlocked 1 fixture — synthetic test artifact', '[]', 'alex', now()),
(887, NULL, 'obsolete', 'P224 Locked 1 fixture — synthetic test artifact', '[]', 'alex', now()),
(807, NULL, 'obsolete', 'p437-itest fixture — synthetic test artifact', '[]', 'alex', now()),
(817, NULL, 'obsolete', 'P224 Locked Queue Test fixture — synthetic test artifact; maturity obsolete', '[]', 'alex', now()),
(810, NULL, 'obsolete', 'P224 Locked Queue Test fixture — synthetic test artifact; maturity obsolete', '[]', 'alex', now()),
(792, NULL, 'obsolete', 'P224 Locked Queue Test fixture — synthetic test artifact; maturity obsolete', '[]', 'alex', now())
ON CONFLICT (legacy_proposal_id) DO NOTHING;

-- ───────────────────────────────────────────────────────────────────────────
-- CROSS-PILLAR / UNPARENTED OBSOLETE PROPOSALS
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO roadmap_proposal.proposal_migration_map
    (legacy_proposal_id, canonical_proposal_id, classification, rationale, evidence_refs, superseded_by_proposal_id, reviewed_by, reviewed_at)
VALUES
(231, NULL, 'obsolete', 'Token Efficiency — superseded by P1004/P1005 (agent cost reporting + task tier routing); maturity obsolete', '[]', 1005, 'alex', now()),
(302, 1014, 'duplicate', 'Multi-project arch duplicate of P300; both obsoleted by P821', '[]', 821, 'alex', now())
ON CONFLICT (legacy_proposal_id) DO NOTHING;
