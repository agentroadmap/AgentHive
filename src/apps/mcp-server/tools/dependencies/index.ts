/**
 * Proposal Dependency MCP Tools Registration
 *
 * P050: DAG Dependency Engine
 * Provides tools for managing proposal dependencies, cycle detection,
 * and promotion eligibility checking.
 */

import type { McpServer } from "../../server.ts";
import type { McpToolHandler } from "../../types.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import { DependencyHandlers } from "./handlers.ts";
import {
	addDependencySchema,
	canPromoteSchema,
	checkCycleSchema,
	getDependenciesSchema,
	removeDependencySchema,
	resolveDependencySchema,
} from "./schemas.ts";

export function registerDependencyTools(server: McpServer): void {
	const handlers = new DependencyHandlers();

	// add_dependency: Add a new dependency between proposals
	const addDependencyTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "add_dependency",
			description:
				"Add a dependency between two proposals. Validates that the dependency " +
				"doesn't create a cycle in the DAG. Dependency types: blocks (hard gate), " +
				"relates (informational), duplicates.",
			inputSchema: addDependencySchema,
		},
		addDependencySchema,
		async (input) =>
			handlers.addDependency(
				input as {
					fromProposalId: string;
					toProposalId: string;
					dependencyType?: "blocks" | "relates" | "duplicates";
					notes?: string;
				},
			),
	);

	// get_dependencies: Query dependencies with filters
	const getDependenciesTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "get_dependencies",
			description:
				"Query proposal dependencies with optional filters (fromProposalId, " +
				"toProposalId, dependencyType, resolved). Returns dependency details " +
				"including resolution status.",
			inputSchema: getDependenciesSchema,
		},
		getDependenciesSchema,
		async (input) =>
			handlers.getDependencies(
				input as {
					fromProposalId?: string;
					toProposalId?: string;
					dependencyType?: "blocks" | "relates" | "duplicates";
					resolved?: boolean;
				},
			),
	);

	// resolve_dependency: Mark a dependency as resolved
	const resolveDependencyTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "resolve_dependency",
			description:
				"Resolve or unresolve a dependency by ID. Resolution is required before " +
				"a dependent proposal can be promoted.",
			inputSchema: resolveDependencySchema,
		},
		resolveDependencySchema,
		async (input) =>
			handlers.resolveDependency(input as { id: number; resolved: boolean; notes?: string }),
	);

	// check_cycle: Check if a dependency would create a cycle
	const checkCycleTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "check_cycle",
			description:
				"Check if adding a dependency between two proposals would create a cycle " +
				"in the DAG. Returns the cycle path if one would be created.",
			inputSchema: checkCycleSchema,
		},
		checkCycleSchema,
		async (input) =>
			handlers.checkCycle(input as { fromProposalId: string; toProposalId: string }),
	);

	// remove_dependency: Remove a dependency
	const removeDependencyTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "remove_dependency",
			description: "Remove a dependency by ID. Use with caution as this affects DAG structure.",
			inputSchema: removeDependencySchema,
		},
		removeDependencySchema,
		async (input) => handlers.removeDependency(input as { id: number }),
	);

	// can_promote: Check if a proposal can be promoted
	const canPromoteTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "can_promote",
			description:
				"Check if a proposal can be promoted based on dependency resolution. " +
				"All blocking dependencies must be resolved before promotion is allowed.",
			inputSchema: canPromoteSchema,
		},
		canPromoteSchema,
		async (input) => handlers.canPromote(input as { proposalId: string }),
	);

	// Register all tools
	server.addTool(addDependencyTool);
	server.addTool(getDependenciesTool);
	server.addTool(resolveDependencyTool);
	server.addTool(checkCycleTool);
	server.addTool(removeDependencyTool);
	server.addTool(canPromoteTool);
}
