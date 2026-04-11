/**
 * P050: DAG Dependency Engine Tests
 *
 * Tests for the core dependency management functionality:
 * - Adding dependencies
 * - Cycle detection
 * - Dependency resolution
 * - Queue priority computation
 * - Oscillation detection
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
	createStore,
	addDependency,
	checkCycle,
	resolveDependency,
	getDependencies,
	getResolutionSummary,
	canPromote,
	getDependents,
	getDependencyIds,
	computeQueuePriority,
	topologicalSort,
	removeDependency,
	getAllRelatedDependencies,
	detectOscillation,
} from "../../src/core/dag/dependency-engine.ts";

describe("DAG Dependency Engine", () => {
	let store: ReturnType<typeof createStore>;

	beforeEach(() => {
		store = createStore();
	});

	describe("addDependency", () => {
		it("should add a dependency successfully", () => {
			const result = addDependency(store, {
				fromProposalId: "P001",
				toProposalId: "P002",
			});

			assert.equal(result.success, true);
			assert.ok(result.dependency);
			assert.equal(result.dependency.fromProposalId, "P001");
			assert.equal(result.dependency.toProposalId, "P002");
			assert.equal(result.dependency.dependencyType, "blocks");
			assert.equal(result.dependency.resolved, false);
		});

		it("should add dependency with custom type", () => {
			const result = addDependency(store, {
				fromProposalId: "P001",
				toProposalId: "P002",
				dependencyType: "relates",
				notes: "Related implementation",
			});

			assert.equal(result.success, true);
			assert.equal(result.dependency!.dependencyType, "relates");
			assert.equal(result.dependency!.notes, "Related implementation");
		});

		it("should prevent duplicate dependencies", () => {
			addDependency(store, { fromProposalId: "P001", toProposalId: "P002" });
			const result = addDependency(store, { fromProposalId: "P001", toProposalId: "P002" });

			assert.equal(result.success, false);
			assert.ok(result.error?.includes("already exists"));
		});

		it("should prevent self-references", () => {
			const result = addDependency(store, { fromProposalId: "P001", toProposalId: "P001" });

			assert.equal(result.success, false);
			assert.ok(result.error?.includes("cycle") || result.error?.includes("itself"));
		});
	});

	describe("checkCycle", () => {
		it("should detect direct cycles", () => {
			addDependency(store, { fromProposalId: "P001", toProposalId: "P002" });

			const result = checkCycle(store, {
				fromProposalId: "P002",
				toProposalId: "P001",
			});

			assert.equal(result.wouldCreateCycle, true);
			assert.ok(result.cyclePath);
		});

		it("should detect indirect cycles", () => {
			addDependency(store, { fromProposalId: "P001", toProposalId: "P002" });
			addDependency(store, { fromProposalId: "P002", toProposalId: "P003" });

			const result = checkCycle(store, {
				fromProposalId: "P003",
				toProposalId: "P001",
			});

			assert.equal(result.wouldCreateCycle, true);
		});

		it("should allow non-cyclic dependencies", () => {
			addDependency(store, { fromProposalId: "P001", toProposalId: "P002" });

			const result = checkCycle(store, {
				fromProposalId: "P001",
				toProposalId: "P003",
			});

			assert.equal(result.wouldCreateCycle, false);
		});
	});

	describe("resolveDependency", () => {
		it("should resolve a dependency", () => {
			const addResult = addDependency(store, {
				fromProposalId: "P001",
				toProposalId: "P002",
			});

			const result = resolveDependency(store, {
				id: addResult.dependency!.id,
				resolved: true,
				notes: "Completed",
			});

			assert.equal(result.success, true);
			assert.equal(result.dependency!.resolved, true);
			assert.equal(result.dependency!.notes, "Completed");
		});

		it("should fail for non-existent dependency", () => {
			const result = resolveDependency(store, { id: 999, resolved: true });

			assert.equal(result.success, false);
			assert.ok(result.error?.includes("not found"));
		});
	});

	describe("getDependencies", () => {
		it("should return all dependencies without filters", () => {
			addDependency(store, { fromProposalId: "P001", toProposalId: "P002" });
			addDependency(store, { fromProposalId: "P001", toProposalId: "P003" });
			addDependency(store, { fromProposalId: "P002", toProposalId: "P003" });

			const deps = getDependencies(store);
			assert.equal(deps.length, 3);
		});

		it("should filter by fromProposalId", () => {
			addDependency(store, { fromProposalId: "P001", toProposalId: "P002" });
			addDependency(store, { fromProposalId: "P002", toProposalId: "P003" });

			const deps = getDependencies(store, { fromProposalId: "P001" });
			assert.equal(deps.length, 1);
			assert.equal(deps[0].fromProposalId, "P001");
		});

		it("should filter by resolved status", () => {
			const add1 = addDependency(store, { fromProposalId: "P001", toProposalId: "P002" });
			addDependency(store, { fromProposalId: "P001", toProposalId: "P003" });
			resolveDependency(store, { id: add1.dependency!.id, resolved: true });

			const unresolved = getDependencies(store, { resolved: false });
			assert.equal(unresolved.length, 1);
		});
	});

	describe("canPromote", () => {
		it("should allow promotion with no dependencies", () => {
			assert.equal(canPromote(store, "P001"), true);
		});

		it("should block promotion with unresolved dependencies", () => {
			addDependency(store, { fromProposalId: "P001", toProposalId: "P002" });
			assert.equal(canPromote(store, "P001"), false);
		});

		it("should allow promotion when all dependencies resolved", () => {
			const dep = addDependency(store, { fromProposalId: "P001", toProposalId: "P002" });
			resolveDependency(store, { id: dep.dependency!.id, resolved: true });
			assert.equal(canPromote(store, "P001"), true);
		});
	});

	describe("getDependents", () => {
		it("should return proposals that depend on given proposal", () => {
			addDependency(store, { fromProposalId: "P001", toProposalId: "P002" });
			addDependency(store, { fromProposalId: "P003", toProposalId: "P002" });

			const dependents = getDependents(store, "P002");
			assert.equal(dependents.length, 2);
			assert.ok(dependents.includes("P001"));
			assert.ok(dependents.includes("P003"));
		});

		it("should not include resolved dependencies", () => {
			const dep = addDependency(store, { fromProposalId: "P001", toProposalId: "P002" });
			resolveDependency(store, { id: dep.dependency!.id, resolved: true });

			const dependents = getDependents(store, "P002");
			assert.equal(dependents.length, 0);
		});
	});

	describe("topologicalSort", () => {
		it("should return proposals in dependency order", () => {
			addDependency(store, { fromProposalId: "P002", toProposalId: "P001" });
			addDependency(store, { fromProposalId: "P003", toProposalId: "P002" });

			const sorted = topologicalSort(store, ["P001", "P002", "P003"]);

			const p001Index = sorted.indexOf("P001");
			const p002Index = sorted.indexOf("P002");
			const p003Index = sorted.indexOf("P003");

			// P001 has no deps, should come first
			// P002 depends on P001, should come after
			// P003 depends on P002, should come last
			assert.ok(p001Index < p002Index);
			assert.ok(p002Index < p003Index);
		});
	});

	describe("removeDependency", () => {
		it("should remove a dependency", () => {
			const dep = addDependency(store, { fromProposalId: "P001", toProposalId: "P002" });
			const result = removeDependency(store, dep.dependency!.id);

			assert.equal(result.success, true);
			assert.equal(getDependencies(store).length, 0);
		});

		it("should fail for non-existent dependency", () => {
			const result = removeDependency(store, 999);
			assert.equal(result.success, false);
		});
	});

	describe("getAllRelatedDependencies", () => {
		it("should return dependencies as source and target", () => {
			addDependency(store, { fromProposalId: "P001", toProposalId: "P002" });
			addDependency(store, { fromProposalId: "P003", toProposalId: "P001" });

			const related = getAllRelatedDependencies(store, "P001");

			assert.equal(related.asSource.length, 1);
			assert.equal(related.asSource[0].toProposalId, "P002");
			assert.equal(related.asTarget.length, 1);
			assert.equal(related.asTarget[0].fromProposalId, "P003");
		});
	});

	describe("detectOscillation", () => {
		it("should detect oscillation pattern", () => {
			const now = Date.now();
			const transitions = [
				{ proposalId: "P001", fromState: "Review", toState: "Active", timestamp: new Date(now - 5000).toISOString() },
				{ proposalId: "P001", fromState: "Active", toState: "Review", timestamp: new Date(now - 4000).toISOString() },
				{ proposalId: "P001", fromState: "Review", toState: "Active", timestamp: new Date(now - 3000).toISOString() },
				{ proposalId: "P001", fromState: "Active", toState: "Review", timestamp: new Date(now - 2000).toISOString() },
			];

			const result = detectOscillation(transitions, "P001", 60000, 4);

			assert.equal(result.isOscillating, true);
			assert.equal(result.transitionCount, 4);
		});

		it("should not detect oscillation for normal progression", () => {
			const now = Date.now();
			const transitions = [
				{ proposalId: "P001", fromState: "Draft", toState: "Review", timestamp: new Date(now - 3000).toISOString() },
				{ proposalId: "P001", fromState: "Review", toState: "Active", timestamp: new Date(now - 2000).toISOString() },
				{ proposalId: "P001", fromState: "Active", toState: "Complete", timestamp: new Date(now - 1000).toISOString() },
			];

			const result = detectOscillation(transitions, "P001", 60000, 4);

			assert.equal(result.isOscillating, false);
		});

		it("should not detect oscillation with too few transitions", () => {
			const now = Date.now();
			const transitions = [
				{ proposalId: "P001", fromState: "Review", toState: "Active", timestamp: new Date(now - 1000).toISOString() },
			];

			const result = detectOscillation(transitions, "P001", 60000, 4);

			assert.equal(result.isOscillating, false);
			assert.equal(result.transitionCount, 1);
		});
	});
});
