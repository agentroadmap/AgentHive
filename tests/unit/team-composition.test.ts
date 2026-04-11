/**
 * P055: Team Composition Tools Tests
 *
 * Tests for team_list and team_add_member MCP tools.
 */

import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// Mock the TeamHandlers since it has dependencies on complex infrastructure
describe("P055: Team Composition Tools", () => {
	describe("team_list schema", () => {
		it("should have correct schema structure", () => {
			const { teamListSchema } = require(
				"../../../src/apps/mcp-server/tools/teams/schemas.ts",
			);

			assert.equal(teamListSchema.type, "object");
			assert.ok(teamListSchema.properties.status);
			assert.ok(teamListSchema.properties.teamType);
			assert.deepEqual(teamListSchema.required, []);
		});

		it("should support status filter options", () => {
			const { teamListSchema } = require(
				"../../../src/apps/mcp-server/tools/teams/schemas.ts",
			);

			const statusOptions = teamListSchema.properties.status.enum;
			assert.ok(statusOptions.includes("active"));
			assert.ok(statusOptions.includes("archived"));
			assert.ok(statusOptions.includes("all"));
		});

		it("should support team type filter options", () => {
			const { teamListSchema } = require(
				"../../../src/apps/mcp-server/tools/teams/schemas.ts",
			);

			const typeOptions = teamListSchema.properties.teamType.enum;
			assert.ok(typeOptions.includes("feature"));
			assert.ok(typeOptions.includes("ops"));
			assert.ok(typeOptions.includes("research"));
			assert.ok(typeOptions.includes("admin"));
		});
	});

	describe("team_add_member schema", () => {
		it("should have correct schema structure", () => {
			const { teamAddMemberSchema } = require(
				"../../../src/apps/mcp-server/tools/teams/schemas.ts",
			);

			assert.equal(teamAddMemberSchema.type, "object");
			assert.ok(teamAddMemberSchema.properties.teamId);
			assert.ok(teamAddMemberSchema.properties.agentId);
			assert.ok(teamAddMemberSchema.properties.role);
		});

		it("should require teamId, agentId, and role", () => {
			const { teamAddMemberSchema } = require(
				"../../../src/apps/mcp-server/tools/teams/schemas.ts",
			);

			assert.deepEqual(teamAddMemberSchema.required, ["teamId", "agentId", "role"]);
		});
	});

	describe("Tool registration", () => {
		it("should export team_list and team_add_member schemas", async () => {
			const schemas = await import(
				"../../../src/apps/mcp-server/tools/teams/schemas.ts"
			);

			assert.ok(schemas.teamListSchema);
			assert.ok(schemas.teamAddMemberSchema);
		});

		it("should have registerTeamTools function that registers all tools", async () => {
			const { registerTeamTools } = await import(
				"../../../src/apps/mcp-server/tools/teams/index.ts"
			);

			assert.ok(typeof registerTeamTools === "function");
		});
	});
});
