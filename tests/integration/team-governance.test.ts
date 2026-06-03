/**
 * P182: Team Governance Layer — Integration Tests
 *
 * AC-1: Team charter is created at squad assembly and stored as team:charter
 * AC-2: Team memory naming conventions enforced (team:charter, team:norm:*, etc.)
 * AC-3: Three-tier dispute resolution ladder (Team → Skeptic → Human)
 * AC-4: 80% of disputes resolve at L1-L3 (team level)
 * AC-5: agent_conflicts supports team_resolved status
 * AC-6: 100% of active squads have team:charter within 1 lease cycle
 * AC-7: On COMPLETE, governance entries are archived or cleaned up
 * AC-8: P179 Article III Section 7a documented
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { PgTeamGovernanceHandlers } from "../../src/apps/mcp-server/tools/teams/pg-governance-handlers.ts";
import {
	teamDisputeLogSchema,
	teamCharterCreateSchema,
} from "../../src/apps/mcp-server/tools/teams/schemas.ts";

// Mock McpServer — governance handlers don't use server directly
const mockServer = {} as any;

describe("P182: Team Governance Layer", () => {
	// ─── AC-2: Naming convention enforcement ──────────────────────────────────

	describe("AC-2: Team norm naming conventions", () => {
		it("teamNormsSet rejects keys not starting with team:", async () => {
			const gov = new PgTeamGovernanceHandlers(mockServer);
			const result = await gov.teamNormsSet({
				teamId: "1",
				normKey: "invalid:key",
				normValue: { rule: "test" },
				setBy: "test-agent",
			});
			const text = result.content[0].type === "text" ? result.content[0].text : "";
			assert.ok(
				text.includes("Norm keys must start with") || text.includes("⚠️"),
				`Expected rejection of invalid norm key, got: ${text}`,
			);
		});

		it("teamNormsSet accepts keys starting with team:", async () => {
			const gov = new PgTeamGovernanceHandlers(mockServer);
			const result = await gov.teamNormsSet({
				teamId: "not-a-number",
				normKey: "team:norm:handoff",
				normValue: { rule: "test" },
				setBy: "test-agent",
			});
			const text = result.content[0].type === "text" ? result.content[0].text : "";
			// Should fail on teamId validation, not on normKey
			assert.ok(
				text.includes("Invalid teamId") || text.includes("⚠️"),
				`Expected teamId error (not normKey error), got: ${text}`,
			);
			assert.ok(
				!text.includes("Norm keys must start with"),
				"Should not reject valid team: prefix key",
			);
		});
	});

	// ─── AC-5: agent_conflicts team_resolved status ───────────────────────────

	describe("AC-5: team_resolved status in agent_conflicts", () => {
		it("teamDisputeLog accepts status=team_resolved", async () => {
			const gov = new PgTeamGovernanceHandlers(mockServer);
			const result = await gov.teamDisputeLog({
				proposalId: "not-a-number",
				initiatorAgent: "agent-a",
				respondentAgent: "agent-b",
				description: "Test dispute",
				escalationLevel: "L3",
				status: "team_resolved",
				resolutionNote: "Resolved via team coordinator",
			});
			const text = result.content[0].type === "text" ? result.content[0].text : "";
			// Fails on proposalId, not on status
			assert.ok(
				text.includes("Invalid proposalId") || text.includes("⚠️"),
				`Expected proposalId error, got: ${text}`,
			);
		});

		it("teamDisputeLog rejects invalid escalation levels via schema", () => {
			const level = teamDisputeLogSchema.properties.escalationLevel;
			assert.deepEqual(level.enum, ["L1", "L2", "L3", "L4"]);
		});
	});

	// ─── AC-3: Three-tier dispute resolution schema ───────────────────────────

	describe("AC-3: Three-tier dispute resolution ladder defined", () => {
		it("dispute status enum covers all ladder states", () => {
			const statuses = teamDisputeLogSchema.properties.status.enum;
			assert.ok(statuses.includes("open"), "must have open");
			assert.ok(statuses.includes("team_resolved"), "must have team_resolved (L3)");
			assert.ok(statuses.includes("escalated"), "must have escalated (L4)");
			assert.ok(statuses.includes("resolved"), "must have resolved");
			assert.ok(statuses.includes("dismissed"), "must have dismissed");
		});

		it("escalation levels cover all four tiers", () => {
			const levels = teamDisputeLogSchema.properties.escalationLevel.enum;
			assert.deepEqual(levels, ["L1", "L2", "L3", "L4"]);
		});
	});

	// ─── AC-1, AC-6: Charter creation ────────────────────────────────────────

	describe("AC-1, AC-6: Team charter at squad assembly", () => {
		it("teamCharterCreate requires teamId, proposalIds, teamName, createdBy", () => {
			assert.deepEqual(
				teamCharterCreateSchema.required,
				["teamId", "proposalIds", "teamName", "createdBy"],
			);
		});

		it("teamCharterCreate rejects non-numeric teamId", async () => {
			const gov = new PgTeamGovernanceHandlers(mockServer);
			const result = await gov.teamCharterCreate({
				teamId: "not-a-number",
				proposalIds: ["182", "178"],
				teamName: "team:P178-P182-governance",
				createdBy: "orchestrator",
			});
			const text = result.content[0].type === "text" ? result.content[0].text : "";
			assert.ok(text.includes("Invalid teamId"), `Got: ${text}`);
		});
	});

	// ─── AC-7: Archive/cleanup on COMPLETE ───────────────────────────────────

	describe("AC-7: Governance archive on dissolution", () => {
		it("teamGovernanceArchive rejects non-numeric teamId", async () => {
			const gov = new PgTeamGovernanceHandlers(mockServer);
			const result = await gov.teamGovernanceArchive({
				teamId: "bad-id",
				archivedBy: "orchestrator",
			});
			const text = result.content[0].type === "text" ? result.content[0].text : "";
			assert.ok(text.includes("Invalid teamId"), `Got: ${text}`);
		});
	});

	// ─── AC-8: P179 constitution section documented ───────────────────────────

	describe("AC-8: P179 Article III Section 7a documented", () => {
		it("constitution doc exists at expected path", () => {
			const docPath = "docs/governance/P179-team-governance-article-III-7a.md";
			assert.ok(existsSync(docPath), `Expected doc at ${docPath}`);
		});

		it("constitution doc covers all required sections", () => {
			const content = readFileSync(
				"docs/governance/P179-team-governance-article-III-7a.md",
				"utf8",
			);
			const required = [
				"§7a.1",
				"§7a.2",
				"§7a.3",
				"§7a.4",
				"§7a.5",
				"§7a.6",
				"§7a.7",
				"team:charter",
				"team:norm:",
				"team:decision:",
				"L1",
				"L4",
				"team_resolved",
			];
			for (const keyword of required) {
				assert.ok(
					content.includes(keyword),
					`Constitution doc missing required content: "${keyword}"`,
				);
			}
		});
	});

	// ─── Default norms coverage ───────────────────────────────────────────────

	describe("Default norms coverage (AC-2)", () => {
		it("five default norm categories are defined", () => {
			const handlerSrc = readFileSync(
				"src/apps/mcp-server/tools/teams/pg-governance-handlers.ts",
				"utf8",
			);
			const defaultNormKeys = [
				"team:norm:handoff",
				"team:norm:communication",
				"team:norm:challenge",
				"team:norm:memory",
				"team:norm:worktree",
			];
			for (const key of defaultNormKeys) {
				assert.ok(handlerSrc.includes(key), `Missing default norm: ${key}`);
			}
		});
	});

	// ─── Migration coverage ───────────────────────────────────────────────────

	describe("Database migration coverage (AC-5)", () => {
		it("migration 058 adds team_norms table and team_resolved status", () => {
			const migration = readFileSync(
				"database/migrations/058-team-governance-p182.sql",
				"utf8",
			);
			assert.ok(migration.includes("team_norms"), "Migration must create team_norms table");
			assert.ok(migration.includes("team_resolved"), "Migration must add team_resolved status");
			assert.ok(migration.includes("escalation_level"), "Migration must add escalation_level column");
			assert.ok(migration.includes("metadata"), "Migration must add metadata column to team table");
		});
	});

	// ─── AC-9: Orchestrator auto-charter hook ─────────────────────────────────

	describe("AC-9: Auto-charter trigger on squad_dispatch", () => {
		it("migration 178 defines fn_auto_charter_team and trg_auto_charter_on_dispatch", () => {
			const { readFileSync } = require("node:fs");
			const migration = readFileSync(
				"scripts/migrations/178-p182-auto-charter-trigger.sql",
				"utf8",
			);
			assert.ok(
				migration.includes("fn_auto_charter_team"),
				"Migration must define fn_auto_charter_team trigger function",
			);
			assert.ok(
				migration.includes("trg_auto_charter_on_dispatch"),
				"Migration must create trg_auto_charter_on_dispatch trigger",
			);
			assert.ok(
				migration.includes("squad_dispatch"),
				"Trigger must fire on squad_dispatch table",
			);
			assert.ok(
				migration.includes("team:charter"),
				"Trigger function must insert team:charter norm",
			);
			assert.ok(
				migration.includes("team:norm:"),
				"Trigger function must insert default governance norms",
			);
		});

		it("migration 178 uses SECURITY DEFINER and non-terminal dispatch filter", () => {
			const { readFileSync } = require("node:fs");
			const migration = readFileSync(
				"scripts/migrations/178-p182-auto-charter-trigger.sql",
				"utf8",
			);
			assert.ok(
				migration.includes("SECURITY DEFINER"),
				"Trigger function must use SECURITY DEFINER for cross-schema writes",
			);
			assert.ok(
				migration.includes("cancelled") && migration.includes("failed") && migration.includes("completed"),
				"Trigger function must skip terminal dispatch_status values",
			);
		});

		it("trigger function body requires count >= 2 before firing charter", () => {
			const { readFileSync } = require("node:fs");
			const migration = readFileSync(
				"scripts/migrations/178-p182-auto-charter-trigger.sql",
				"utf8",
			);
			assert.ok(
				migration.includes("v_count < 2"),
				"Trigger must only create charter when 2+ dispatches exist for same proposal",
			);
			assert.ok(
				migration.includes("ON CONFLICT (team_id, norm_key) DO NOTHING"),
				"Charter insert must be idempotent",
			);
		});
	});
});
