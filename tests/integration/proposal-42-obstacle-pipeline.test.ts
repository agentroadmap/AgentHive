/**
 * Tests for proposal-42: Obstacle-to-Proposal Pipeline
 * - Obstacle can be promoted to proposal via CLI/MCP
 * - Promoted proposal includes context from original obstacle
 * - Blocking relationship preserved in dependencies
 * - Agent who created obstacle notified when promoted proposal is resolved
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ObstaclePipeline } from "../../src/core/pipeline/obstacle-pipeline.ts";

const TEST_BASE = join(import.meta.dirname, "../../tmp/test-obstacle-pipeline");

describe("proposal-42: Obstacle-to-Proposal Pipeline", () => {
	let testDir: string;
	let pipeline: ObstaclePipeline;
	let testCounter = 0;

	beforeEach(() => {
		testCounter++;
		testDir = join(TEST_BASE, `test-${Date.now()}-${testCounter}`);
		mkdirSync(testDir, { recursive: true });
		pipeline = new ObstaclePipeline(testDir);
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	const createTestObstacle = (
		overrides?: Partial<Parameters<typeof pipeline.createObstacle>[0]>,
	) =>
		pipeline.createObstacle({
			title: "TypeScript compilation error",
			description:
				"Cannot find module '@types/node' after upgrade to Node.js 24",
			blockingProposalIds: ["proposal-1", "proposal-2"],
			reportedBy: "agent-1",
			severity: "high",
			suggestedApproach: "Update @types/node to v24 compatible version",
			...overrides,
		});

	describe("AC#1: Obstacle can be promoted to proposal", () => {
		it("creates an obstacle", () => {
			const obstacle = createTestObstacle();

			assert.ok(obstacle.id.startsWith("OBS-"));
			assert.equal(obstacle.title, "TypeScript compilation error");
			assert.equal(obstacle.blockingProposalIds.length, 2);
		});

		it("promotes obstacle to proposal", () => {
			const obstacle = createTestObstacle();
			const result = pipeline.promoteToProposal(obstacle.id);

			assert.equal(result.success, true);
			assert.ok(result.newProposalId);
			assert.ok(result.proposal.id);
		});

		it("fails promotion for non-existent obstacle", () => {
			const result = pipeline.promoteToProposal("OBS-999");

			assert.equal(result.success, false);
			assert.ok(result.warnings.length > 0);
		});

		it("tracks promotion in history", () => {
			const obstacle = createTestObstacle();
			pipeline.promoteToProposal(obstacle.id, { promotedBy: "reviewer" });

			const promotions = pipeline.getPromotions();
			assert.equal(promotions.length, 1);
			assert.equal(promotions[0].promotedBy, "reviewer");
		});
	});

	describe("AC#2: Promoted proposal includes context from obstacle", () => {
		it("includes original obstacle ID in proposal", () => {
			const obstacle = createTestObstacle();
			const result = pipeline.promoteToProposal(obstacle.id);

			assert.equal(result.proposal.metadata.originalObstacleId, obstacle.id);
		});

		it("includes obstacle description in proposal body", () => {
			const obstacle = createTestObstacle();
			const result = pipeline.promoteToProposal(obstacle.id);

			assert.ok(result.proposal.description.includes(obstacle.description));
		});

		it("includes suggested approach in description", () => {
			const obstacle = createTestObstacle();
			const result = pipeline.promoteToProposal(obstacle.id);

			assert.ok(result.proposal.description.includes("Suggested Approach"));
			assert.ok(result.proposal.description.includes("Update @types/node"));
		});

		it("includes original reporter in assignee", () => {
			const obstacle = createTestObstacle();
			const result = pipeline.promoteToProposal(obstacle.id);

			assert.ok(result.proposal.assignee.includes("agent-1"));
		});

		it("maps severity to priority", () => {
			const critical = createTestObstacle({ severity: "critical" });
			const low = createTestObstacle({ severity: "low" });

			const r1 = pipeline.promoteToProposal(critical.id);
			const r2 = pipeline.promoteToProposal(low.id);

			assert.equal(r1.proposal.priority, "high");
			assert.equal(r2.proposal.priority, "low");
		});

		it("includes acceptance criteria", () => {
			const obstacle = createTestObstacle();
			const result = pipeline.promoteToProposal(obstacle.id);

			assert.ok(result.proposal.description.includes("Root cause identified"));
			assert.ok(result.proposal.description.includes("Solution implemented"));
		});

		it("supports custom title", () => {
			const obstacle = createTestObstacle();
			const result = pipeline.promoteToProposal(obstacle.id, {
				customTitle: "Fix Node.js 24 type compatibility",
			});

			assert.equal(result.proposal.title, "Fix Node.js 24 type compatibility");
		});
	});

	describe("AC#3: Blocking relationship preserved in dependencies", () => {
		it("includes blocking proposal IDs as dependencies", () => {
			const obstacle = createTestObstacle({
				blockingProposalIds: ["proposal-10", "proposal-20"],
			});
			const result = pipeline.promoteToProposal(obstacle.id);

			assert.ok(result.proposal.dependencies.includes("proposal-10"));
			assert.ok(result.proposal.dependencies.includes("proposal-20"));
		});

		it("includes extra dependencies", () => {
			const obstacle = createTestObstacle();
			const result = pipeline.promoteToProposal(obstacle.id, {
				extraDeps: ["proposal-30"],
			});

			assert.ok(result.proposal.dependencies.includes("proposal-30"));
		});

		it("labels proposal as blocking", () => {
			const obstacle = createTestObstacle();
			const result = pipeline.promoteToProposal(obstacle.id);

			assert.ok(result.proposal.labels.includes("blocking"));
			assert.ok(result.proposal.labels.includes("obstacle"));
		});

		it("stores blocking IDs in metadata", () => {
			const obstacle = createTestObstacle({
				blockingProposalIds: ["proposal-5"],
			});
			const result = pipeline.promoteToProposal(obstacle.id);

			assert.deepEqual(result.proposal.metadata.blockingProposalIds, [
				"proposal-5",
			]);
		});
	});

	describe("AC#4: Agent notified when promoted proposal resolved", () => {
		it("returns notification target for promoted proposal", () => {
			const obstacle = createTestObstacle({ reportedBy: "alice" });
			const result = pipeline.promoteToProposal(obstacle.id);

			// Get notification target using proposal ID
			const target = pipeline.getNotificationTarget(result.newProposalId);
			assert.equal(target, "alice");
		});

		it("returns null for non-promoted proposal", () => {
			const target = pipeline.getNotificationTarget("proposal-999");
			assert.equal(target, null);
		});

		it("can mark obstacle as resolved", () => {
			const obstacle = createTestObstacle();
			const resolved = pipeline.markResolved(obstacle.id, "solver-agent");

			assert.ok(resolved);

			const updated = pipeline.getObstacle(obstacle.id);
			assert.ok((updated as any).resolvedAt);
			assert.equal((updated as any).resolvedBy, "solver-agent");
		});

		it("excludes resolved from unresolved-only query", () => {
			const o1 = createTestObstacle({ title: "Obstacle 1" });
			const o2 = createTestObstacle({ title: "Obstacle 2" });

			pipeline.markResolved(o1.id, "agent");

			const unresolved = pipeline.getObstacles({ unresolvedOnly: true });
			assert.equal(unresolved.length, 1);
			assert.equal(unresolved[0].id, o2.id);
		});
	});

	describe("Query and management", () => {
		it("gets all obstacles", () => {
			createTestObstacle({ title: "A" });
			createTestObstacle({ title: "B" });

			const obstacles = pipeline.getObstacles();
			assert.equal(obstacles.length, 2);
		});

		it("gets obstacle by ID", () => {
			const created = createTestObstacle();
			const fetched = pipeline.getObstacle(created.id);

			assert.ok(fetched);
			assert.equal(fetched.title, created.title);
		});

		it("gets blocking obstacles for a proposal", () => {
			createTestObstacle({ blockingProposalIds: ["proposal-1"] });
			createTestObstacle({ blockingProposalIds: ["proposal-1", "proposal-2"] });
			createTestObstacle({ blockingProposalIds: ["proposal-3"] });

			const blocking = pipeline.getBlockingObstacles("proposal-1");
			assert.equal(blocking.length, 2);
		});

		it("deletes un-promoted obstacle", () => {
			const obstacle = createTestObstacle();

			const deleted = pipeline.deleteObstacle(obstacle.id);
			assert.ok(deleted);
			assert.equal(pipeline.getObstacle(obstacle.id), null);
		});

		it("prevents deletion of promoted obstacle", () => {
			const obstacle = createTestObstacle();
			pipeline.promoteToProposal(obstacle.id);

			const deleted = pipeline.deleteObstacle(obstacle.id);
			assert.equal(deleted, false);
		});

		it("reports statistics", () => {
			createTestObstacle();
			const o2 = createTestObstacle();
			pipeline.promoteToProposal(o2.id);

			const stats = pipeline.getStats();
			assert.equal(stats.totalObstacles, 2);
			assert.equal(stats.promoted, 1);
			assert.ok(stats.blockingCount >= 0);
		});
	});

	describe("Persistence", () => {
		it("persists across instances", () => {
			const obstacle = createTestObstacle();

			const pipeline2 = new ObstaclePipeline(testDir);
			const fetched = pipeline2.getObstacle(obstacle.id);

			assert.ok(fetched);
			assert.equal(fetched.title, obstacle.title);
		});
	});
});
