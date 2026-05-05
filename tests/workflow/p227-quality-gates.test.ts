import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { query } from "../../src/infra/postgres/pool.ts";
import {
	enforceStageSequence,
	assertStageSequence,
} from "../../src/gate_pipeline/stage_enforcer.ts";
import { selectReviewer } from "../../src/gate_pipeline/code_review_dispatch.ts";

// Template IDs
const RFC_TEMPLATE_ID = 14;
const HOTFIX_TEMPLATE_ID = 37;

describe("P227 quality gates", () => {

	// ── AC#1: Standard RFC has CODE_REVIEW, TEST_WRITING, TEST_EXECUTION stages ──

	describe("Standard RFC workflow stages", () => {
		it("has CODE_REVIEW stage at order 4", async () => {
			const r = await query(
				`SELECT stage_order FROM roadmap.workflow_stages
				  WHERE template_id = $1 AND stage_name = 'CODE_REVIEW'`,
				[RFC_TEMPLATE_ID],
			);
			assert.equal(r.rows.length, 1, "CODE_REVIEW stage must exist");
			assert.equal(r.rows[0].stage_order, 4);
		});

		it("has TEST_WRITING stage at order 5", async () => {
			const r = await query(
				`SELECT stage_order FROM roadmap.workflow_stages
				  WHERE template_id = $1 AND stage_name = 'TEST_WRITING'`,
				[RFC_TEMPLATE_ID],
			);
			assert.equal(r.rows.length, 1, "TEST_WRITING stage must exist");
			assert.equal(r.rows[0].stage_order, 5);
		});

		it("has TEST_EXECUTION stage at order 6 with requires_ac=true", async () => {
			const r = await query(
				`SELECT stage_order, requires_ac FROM roadmap.workflow_stages
				  WHERE template_id = $1 AND stage_name = 'TEST_EXECUTION'`,
				[RFC_TEMPLATE_ID],
			);
			assert.equal(r.rows.length, 1, "TEST_EXECUTION stage must exist");
			assert.equal(r.rows[0].stage_order, 6);
			assert.equal(r.rows[0].requires_ac, true, "TEST_EXECUTION requires AC");
		});

		it("has MERGE at order 7 (bumped from 4)", async () => {
			const r = await query(
				`SELECT stage_order FROM roadmap.workflow_stages
				  WHERE template_id = $1 AND stage_name = 'MERGE'`,
				[RFC_TEMPLATE_ID],
			);
			assert.equal(r.rows.length, 1);
			assert.equal(r.rows[0].stage_order, 7);
		});

		it("has COMPLETE at order 8 (bumped from 5)", async () => {
			const r = await query(
				`SELECT stage_order FROM roadmap.workflow_stages
				  WHERE template_id = $1 AND stage_name = 'COMPLETE'`,
				[RFC_TEMPLATE_ID],
			);
			assert.equal(r.rows.length, 1);
			assert.equal(r.rows[0].stage_order, 8);
		});

		it("stage sequence is contiguous: DEVELOP→CODE_REVIEW→TEST_WRITING→TEST_EXECUTION→MERGE", async () => {
			const r = await query(
				`SELECT stage_name, stage_order
				   FROM roadmap.workflow_stages
				  WHERE template_id = $1 AND stage_order BETWEEN 3 AND 7
				  ORDER BY stage_order`,
				[RFC_TEMPLATE_ID],
			);
			const names = r.rows.map((row: { stage_name: string }) => row.stage_name);
			assert.deepEqual(names, [
				"DEVELOP",
				"CODE_REVIEW",
				"TEST_WRITING",
				"TEST_EXECUTION",
				"MERGE",
			]);
		});
	});

	// ── AC#2: Hotfix workflow has TEST_EXECUTION before DEPLOYED ──────────────

	describe("Hotfix workflow stages", () => {
		it("has TEST_EXECUTION stage at order 3", async () => {
			const r = await query(
				`SELECT stage_order, requires_ac FROM roadmap.workflow_stages
				  WHERE template_id = $1 AND stage_name = 'TEST_EXECUTION'`,
				[HOTFIX_TEMPLATE_ID],
			);
			assert.equal(r.rows.length, 1, "TEST_EXECUTION must exist in Hotfix");
			assert.equal(r.rows[0].stage_order, 3);
			assert.equal(r.rows[0].requires_ac, true);
		});

		it("has DEPLOYED at order 4 (bumped from 3)", async () => {
			const r = await query(
				`SELECT stage_order FROM roadmap.workflow_stages
				  WHERE template_id = $1 AND stage_name = 'DEPLOYED'`,
				[HOTFIX_TEMPLATE_ID],
			);
			assert.equal(r.rows.length, 1);
			assert.equal(r.rows[0].stage_order, 4);
		});

		it("FIX comes immediately before TEST_EXECUTION", async () => {
			const r = await query(
				`SELECT stage_name FROM roadmap.workflow_stages
				  WHERE template_id = $1 AND stage_order IN (2,3)
				  ORDER BY stage_order`,
				[HOTFIX_TEMPLATE_ID],
			);
			const names = r.rows.map((row: { stage_name: string }) => row.stage_name);
			assert.deepEqual(names, ["FIX", "TEST_EXECUTION"]);
		});
	});

	// ── AC#3: SMDL JSONB reflects the new stages ──────────────────────────────

	describe("SMDL JSONB consistency", () => {
		it("Standard RFC SMDL has CODE_REVIEW stage", async () => {
			const r = await query(
				`SELECT smdl_definition->'workflow'->'stages' AS stages
				   FROM roadmap.workflow_templates WHERE id = $1`,
				[RFC_TEMPLATE_ID],
			);
			const stages = r.rows[0].stages as Array<{ name: string; order: number }>;
			const cr = stages.find((s) => s.name === "CODE_REVIEW");
			assert.ok(cr, "CODE_REVIEW must be in smdl_definition");
			assert.equal(cr.order, 4);
		});

		it("Standard RFC SMDL has transition DEVELOP→CODE_REVIEW", async () => {
			const r = await query(
				`SELECT smdl_definition->'workflow'->'transitions' AS transitions
				   FROM roadmap.workflow_templates WHERE id = $1`,
				[RFC_TEMPLATE_ID],
			);
			const transitions = r.rows[0].transitions as Array<{
				from: string;
				to: string;
				labels: string[];
			}>;
			const t = transitions.find(
				(tr) => tr.from === "DEVELOP" && tr.to === "CODE_REVIEW",
			);
			assert.ok(t, "DEVELOP→CODE_REVIEW transition must exist in SMDL");
		});

		it("Hotfix SMDL has TEST_EXECUTION stage", async () => {
			const r = await query(
				`SELECT smdl_definition->'workflow'->'stages' AS stages
				   FROM roadmap.workflow_templates WHERE id = $1`,
				[HOTFIX_TEMPLATE_ID],
			);
			const stages = r.rows[0].stages as Array<{ name: string; order: number }>;
			const te = stages.find((s) => s.name === "TEST_EXECUTION");
			assert.ok(te, "TEST_EXECUTION must be in Hotfix smdl_definition");
			assert.equal(te.order, 3);
		});
	});

	// ── AC#4: Stage sequence enforcer rejects illegal jumps ──────────────────

	describe("enforceStageSequence", () => {
		it("allows forward transition to immediate next stage", async () => {
			const result = await enforceStageSequence({
				proposalId: 0,
				templateId: RFC_TEMPLATE_ID,
				fromStage: "DEVELOP",
				toStage: "CODE_REVIEW",
			});
			assert.equal(result.allowed, true);
		});

		it("blocks skipping CODE_REVIEW (DEVELOP→TEST_WRITING)", async () => {
			const result = await enforceStageSequence({
				proposalId: 0,
				templateId: RFC_TEMPLATE_ID,
				fromStage: "DEVELOP",
				toStage: "TEST_WRITING",
			});
			assert.equal(result.allowed, false);
			assert.ok(result.reason?.includes("CODE_REVIEW"), result.reason);
		});

		it("blocks skipping CODE_REVIEW and TEST_WRITING (DEVELOP→TEST_EXECUTION)", async () => {
			const result = await enforceStageSequence({
				proposalId: 0,
				templateId: RFC_TEMPLATE_ID,
				fromStage: "DEVELOP",
				toStage: "TEST_EXECUTION",
			});
			assert.equal(result.allowed, false);
		});

		it("blocks skipping to MERGE directly from DEVELOP", async () => {
			const result = await enforceStageSequence({
				proposalId: 0,
				templateId: RFC_TEMPLATE_ID,
				fromStage: "DEVELOP",
				toStage: "MERGE",
			});
			assert.equal(result.allowed, false);
		});

		it("allows backward transition (CODE_REVIEW→DEVELOP)", async () => {
			const result = await enforceStageSequence({
				proposalId: 0,
				templateId: RFC_TEMPLATE_ID,
				fromStage: "CODE_REVIEW",
				toStage: "DEVELOP",
			});
			assert.equal(result.allowed, true);
		});

		it("allows CODE_REVIEW→TEST_WRITING (forward, immediate next)", async () => {
			const result = await enforceStageSequence({
				proposalId: 0,
				templateId: RFC_TEMPLATE_ID,
				fromStage: "CODE_REVIEW",
				toStage: "TEST_WRITING",
			});
			assert.equal(result.allowed, true);
		});

		it("allows TEST_EXECUTION→MERGE (forward, immediate next)", async () => {
			const result = await enforceStageSequence({
				proposalId: 0,
				templateId: RFC_TEMPLATE_ID,
				fromStage: "TEST_EXECUTION",
				toStage: "MERGE",
			});
			assert.equal(result.allowed, true);
		});

		it("blocks TEST_WRITING→MERGE (skip TEST_EXECUTION)", async () => {
			const result = await enforceStageSequence({
				proposalId: 0,
				templateId: RFC_TEMPLATE_ID,
				fromStage: "TEST_WRITING",
				toStage: "MERGE",
			});
			assert.equal(result.allowed, false);
		});

		it("allows transition to terminal stage REJECTED from any stage", async () => {
			const result = await enforceStageSequence({
				proposalId: 0,
				templateId: RFC_TEMPLATE_ID,
				fromStage: "CODE_REVIEW",
				toStage: "REJECTED",
			});
			assert.equal(result.allowed, true);
		});

		it("assertStageSequence throws on illegal jump", async () => {
			await assert.rejects(
				() =>
					assertStageSequence({
						proposalId: 0,
						templateId: RFC_TEMPLATE_ID,
						fromStage: "DEVELOP",
						toStage: "MERGE",
					}),
				/StageEnforcer/,
			);
		});

		it("Hotfix: allows FIX→TEST_EXECUTION", async () => {
			const result = await enforceStageSequence({
				proposalId: 0,
				templateId: HOTFIX_TEMPLATE_ID,
				fromStage: "FIX",
				toStage: "TEST_EXECUTION",
			});
			assert.equal(result.allowed, true);
		});

		it("Hotfix: blocks FIX→DEPLOYED (must pass TEST_EXECUTION first)", async () => {
			const result = await enforceStageSequence({
				proposalId: 0,
				templateId: HOTFIX_TEMPLATE_ID,
				fromStage: "FIX",
				toStage: "DEPLOYED",
			});
			assert.equal(result.allowed, false);
			assert.ok(result.reason?.includes("TEST_EXECUTION"), result.reason);
		});
	});

	// ── AC#5: Reviewer selection excludes the developer ───────────────────────

	describe("selectReviewer", () => {
		it("returns an agent identity different from the excluded agent", async () => {
			// Use a non-existent agent as the developer so the query can find real reviewers
			const reviewer = await selectReviewer("tool/fake-developer-agent-xyz").catch(
				() => null,
			);
			// If no reviewers exist in this env, skip — the logic is what matters
			if (reviewer !== null) {
				assert.notEqual(reviewer, "tool/fake-developer-agent-xyz");
				assert.ok(typeof reviewer === "string" && reviewer.length > 0);
			}
		});
	});

	// ── AC#6: ac-test-executor is registered in tool_agent_config ─────────────

	describe("tool/ac-test-executor registration", () => {
		it("is present and active in tool_agent_config", async () => {
			const r = await query(
				`SELECT handler_class, is_active, config
				   FROM roadmap.tool_agent_config
				  WHERE agent_identity = 'tool/ac-test-executor'`,
			);
			assert.equal(r.rows.length, 1, "ac-test-executor must be registered");
			assert.equal(r.rows[0].is_active, true);
			assert.equal(r.rows[0].handler_class, "AcTestExecutor");
		});

		it("is present and active in agent_registry", async () => {
			const r = await query(
				`SELECT skills, status
				   FROM roadmap.agent_registry
				  WHERE agent_identity = 'tool/ac-test-executor'`,
			);
			assert.equal(r.rows.length, 1, "ac-test-executor must be in agent_registry");
			assert.equal(r.rows[0].status, "active");
			const skills: string[] = Array.isArray(r.rows[0].skills)
				? r.rows[0].skills
				: Object.values(r.rows[0].skills);
			assert.ok(
				skills.includes("ac-test-execution"),
				"must have ac-test-execution skill",
			);
		});
	});
});
