/**
 * MCP Tool Handlers for Proposal Dependencies
 */

import type { CallToolResult } from "../../types.ts";
import {
	addDependency,
	canPromote,
	checkCycle,
	getDependencies,
	getResolutionSummary,
	removeDependency,
	resolveDependency,
	createStore,
} from "../../../../core/dag/dependency-engine.ts";
import type {
	CreateDependencyInput,
	CycleCheckResult,
	DependencyQueryFilters,
	DependencyResolutionSummary,
	ProposalDependency,
	ResolveDependencyInput,
} from "../../../../core/dag/dependency-types.ts";

/** Singleton store for dependency management */
const dependencyStore = createStore();

export class DependencyHandlers {
	/**
	 * Add a new dependency between proposals.
	 */
	async addDependency(input: CreateDependencyInput): Promise<CallToolResult> {
		const result = addDependency(dependencyStore, input);

		if (!result.success) {
			return {
				content: [
					{
						type: "text",
						text: `Failed to add dependency: ${result.error}`,
					},
				],
				isError: true,
			};
		}

		const dep = result.dependency!;
		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(
						{
							success: true,
							dependency: {
								id: dep.id,
								fromProposalId: dep.fromProposalId,
								toProposalId: dep.toProposalId,
								dependencyType: dep.dependencyType,
								resolved: dep.resolved,
								createdAt: dep.createdAt,
							},
						},
						null,
						2,
					),
				},
			],
		};
	}

	/**
	 * Get dependencies with optional filters.
	 */
	async getDependencies(filters: DependencyQueryFilters = {}): Promise<CallToolResult> {
		const deps = getDependencies(dependencyStore, filters);

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(
						{
							count: deps.length,
							dependencies: deps.map((d) => ({
								id: d.id,
								fromProposalId: d.fromProposalId,
								toProposalId: d.toProposalId,
								dependencyType: d.dependencyType,
								resolved: d.resolved,
								createdAt: d.createdAt,
								updatedAt: d.updatedAt,
								notes: d.notes,
							})),
						},
						null,
						2,
					),
				},
			],
		};
	}

	/**
	 * Resolve or unresolve a dependency.
	 */
	async resolveDependency(input: ResolveDependencyInput): Promise<CallToolResult> {
		const result = resolveDependency(dependencyStore, input);

		if (!result.success) {
			return {
				content: [
					{
						type: "text",
						text: `Failed to resolve dependency: ${result.error}`,
					},
				],
				isError: true,
			};
		}

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(
						{
							success: true,
							dependency: result.dependency,
						},
						null,
						2,
					),
				},
			],
		};
	}

	/**
	 * Check if adding a dependency would create a cycle.
	 */
	async checkCycle(input: CreateDependencyInput): Promise<CallToolResult> {
		const result = checkCycle(dependencyStore, input);

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(
						{
							wouldCreateCycle: result.wouldCreateCycle,
							cyclePath: result.cyclePath,
							message: result.message,
						},
						null,
						2,
					),
				},
			],
		};
	}

	/**
	 * Remove a dependency by ID.
	 */
	async removeDependency(input: { id: number }): Promise<CallToolResult> {
		const result = removeDependency(dependencyStore, input.id);

		if (!result.success) {
			return {
				content: [
					{
						type: "text",
						text: `Failed to remove dependency: ${result.error}`,
					},
				],
				isError: true,
			};
		}

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify({ success: true, removedId: input.id }),
				},
			],
		};
	}

	/**
	 * Check if a proposal can be promoted (all blocking deps resolved).
	 */
	async canPromote(input: { proposalId: string }): Promise<CallToolResult> {
		const promotable = canPromote(dependencyStore, input.proposalId);
		const summary = getResolutionSummary(dependencyStore, input.proposalId);

		return {
			content: [
				{
					type: "text",
					text: JSON.stringify(
						{
							proposalId: input.proposalId,
							canPromote: promotable,
							summary: {
								totalBlocking: summary.totalBlocking,
								resolvedBlocking: summary.resolvedBlocking,
								unresolvedBlocking: summary.unresolvedBlocking,
								unresolvedDetails: summary.unresolvedDetails,
							},
						},
						null,
						2,
					),
				},
			],
		};
	}
}
