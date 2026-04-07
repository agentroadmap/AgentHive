/**
 * Test Suite: proposal-091 Status Transition Guidance & Pulse
 *
 * Tests for advisory warnings, artifact detection, pulse recording,
 * and peer notifications.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type AdvisoryWarning,
	type ArtifactStatus,
	analyzeArtifacts,
	calculateTransitionQuality,
	createPulseRecord,
	formatAdvisories,
	formatArtifactStatus,
	formatPeerNotification,
	generateAdvisories,
	getTransitionAdvisory,
	type PulseRecord,
	PulseStorage,
	parseFrontmatter,
	pulseRecordHash,
	STATUS_ORDER,
	shouldNotifyPeers,
} from "../../src/core/infrastructure/pulse.ts";

// Test data
const SAMPLE_STATE_CONTENT = `---
id: proposal-091
title: Test Proposal
status: Complete
assignee:
  - agent-1
created_date: '2026-03-24'
updated_date: '2026-03-25'
complete_date: '2026-03-25T10:00:00Z'
---

## Description
A test proposal.

## Final Summary
Completed all acceptance criteria.

## Proof
- Tests: 42/42 passing
- Commit: abc123

## Implementation Notes
Key decisions documented here.
`;

const MINIMAL_STATE_CONTENT = `---
id: proposal-001
title: Minimal Proposal
status: Active
---

Basic description only.
`;

describe("STATUS_ORDER", () => {
	it("should define correct status order", () => {
		assert.deepEqual(STATUS_ORDER, [
			"Potential",
			"Active",
			"Review",
			"Complete",
			"Abandoned",
		]);
	});

	it("should have 5 statuses", () => {
		assert.equal(STATUS_ORDER.length, 5);
	});
});

describe("parseFrontmatter", () => {
	it("should parse basic frontmatter", () => {
		const content = `---
id: proposal-001
title: Test Proposal
status: Active
---
Body`;

		const result = parseFrontmatter(content);
		assert.ok(result);
		assert.equal(result.id, "proposal-001");
		assert.equal(result.status, "Active");
	});

	it("should parse assignee array", () => {
		const content = `---
id: proposal-001
status: Active
assignee:
  - agent-1
  - agent-2
---
Body`;

		const result = parseFrontmatter(content);
		assert.ok(result);
		assert.deepEqual(result.assignee, ["agent-1", "agent-2"]);
	});

	it("should parse dependencies array", () => {
		const content = `---
id: proposal-001
status: Active
dependencies:
  - proposal-002
  - proposal-003
---
Body`;

		const result = parseFrontmatter(content);
		assert.ok(result);
		assert.deepEqual(result.dependencies, ["proposal-002", "proposal-003"]);
	});

	it("should return null for missing frontmatter", () => {
		const content = "No frontmatter here";
		const result = parseFrontmatter(content);
		assert.equal(result, null);
	});

	it("should parse dates", () => {
		const content = `---
id: proposal-001
status: Complete
created_date: '2026-03-24'
updated_date: '2026-03-25 10:00'
---
Body`;

		const result = parseFrontmatter(content);
		assert.ok(result);
		assert.equal(result.created_date, "2026-03-24");
		assert.equal(result.updated_date, "2026-03-25 10:00");
	});
});

describe("analyzeArtifacts", () => {
	it("should detect all artifacts in complete proposal", () => {
		const artifacts = analyzeArtifacts(SAMPLE_STATE_CONTENT);

		assert.ok(artifacts.reachedDate, "Should detect complete_date");
		assert.ok(artifacts.finalSummary, "Should detect final summary");
		assert.ok(artifacts.proofReferences, "Should detect proof");
		assert.ok(
			artifacts.implementationNotes,
			"Should detect implementation notes",
		);
		assert.ok(artifacts.testResults, "Should detect test results");
	});

	it("should detect missing artifacts in minimal proposal", () => {
		const artifacts = analyzeArtifacts(MINIMAL_STATE_CONTENT);

		assert.ok(!artifacts.reachedDate, "Should not detect complete_date");
		assert.ok(!artifacts.finalSummary, "Should not detect final summary");
		assert.ok(!artifacts.proofReferences, "Should not detect proof");
		assert.ok(
			!artifacts.implementationNotes,
			"Should not detect implementation notes",
		);
		assert.ok(!artifacts.testResults, "Should not detect test results");
	});

	it("should detect completed_date as alternative to complete_date", () => {
		const content = "completed_date: 2026-03-25";
		const artifacts = analyzeArtifacts(content);
		assert.ok(artifacts.reachedDate, "Should detect completed_date");
	});

	it("should detect Summary section as alternative to Final Summary", () => {
		const content = "## Summary\nDone.";
		const artifacts = analyzeArtifacts(content);
		assert.ok(artifacts.finalSummary, "Should detect Summary section");
	});

	it("should detect Verification section as alternative to Proof", () => {
		const content = "## Verification\nAll good.";
		const artifacts = analyzeArtifacts(content);
		assert.ok(artifacts.proofReferences, "Should detect Verification section");
	});

	it("should detect Notes section as alternative to Implementation Notes", () => {
		const content = "## Notes\nStuff.";
		const artifacts = analyzeArtifacts(content);
		assert.ok(artifacts.implementationNotes, "Should detect Notes section");
	});
});

describe("calculateTransitionQuality", () => {
	it("should return good for sequential forward transition with artifacts", () => {
		const artifacts: ArtifactStatus = {
			reachedDate: true,
			finalSummary: true,
			proofReferences: true,
			implementationNotes: true,
			testResults: true,
		};

		const quality = calculateTransitionQuality(
			"Potential",
			"Active",
			artifacts,
		);
		assert.equal(quality, "good");
	});

	it("should return warning for missing artifacts (sequential transition)", () => {
		const artifacts: ArtifactStatus = {
			reachedDate: false,
			finalSummary: false,
			proofReferences: false,
			implementationNotes: false,
			testResults: false,
		};

		// Use sequential transition Potential -> Active (not skipping stages)
		const quality = calculateTransitionQuality(
			"Potential",
			"Active",
			artifacts,
		);
		assert.equal(quality, "warning");
	});

	it("should return fast-tracked for quick completion", () => {
		const artifacts: ArtifactStatus = {
			reachedDate: true,
			finalSummary: true,
			proofReferences: true,
			implementationNotes: true,
			testResults: true,
		};

		// 30 minutes age
		const quality = calculateTransitionQuality(
			"Active",
			"Complete",
			artifacts,
			30 * 60 * 1000,
		);
		assert.equal(quality, "fast-tracked");
	});

	it("should return skipped for non-sequential transition", () => {
		const artifacts: ArtifactStatus = {
			reachedDate: true,
			finalSummary: true,
			proofReferences: true,
			implementationNotes: true,
			testResults: true,
		};

		// Potential → Complete (skipping Active, Review)
		const quality = calculateTransitionQuality(
			"Potential",
			"Complete",
			artifacts,
		);
		assert.equal(quality, "skipped");
	});

	it("should return warning for backward transition", () => {
		const artifacts: ArtifactStatus = {
			reachedDate: true,
			finalSummary: true,
			proofReferences: true,
			implementationNotes: true,
			testResults: true,
		};

		const quality = calculateTransitionQuality("Complete", "Active", artifacts);
		assert.equal(quality, "warning");
	});
});

describe("generateAdvisories", () => {
	it("should generate no advisories for clean transition", () => {
		const artifacts: ArtifactStatus = {
			reachedDate: true,
			finalSummary: true,
			proofReferences: true,
			implementationNotes: true,
			testResults: true,
		};

		const advisories = generateAdvisories(
			"Potential",
			"Active",
			artifacts,
			"good",
		);
		assert.equal(advisories.length, 0);
	});

	it("should warn on non-sequential transition", () => {
		const artifacts: ArtifactStatus = {
			reachedDate: true,
			finalSummary: true,
			proofReferences: true,
			implementationNotes: true,
			testResults: true,
		};

		const advisories = generateAdvisories(
			"Potential",
			"Complete",
			artifacts,
			"skipped",
		);

		const nonSequential = advisories.find((a) => a.type === "non-sequential");
		assert.ok(nonSequential, "Should have non-sequential advisory");
		assert.equal(nonSequential.severity, "warning");
		assert.ok(nonSequential.canOverride, "Should be overridable");
	});

	it("should warn on missing final summary", () => {
		const artifacts: ArtifactStatus = {
			reachedDate: true,
			finalSummary: false,
			proofReferences: true,
			implementationNotes: true,
			testResults: true,
		};

		const advisories = generateAdvisories(
			"Active",
			"Complete",
			artifacts,
			"warning",
		);

		const missingSummary = advisories.find(
			(a) => a.message.includes("Final Summary") || a.type === "missing-notes",
		);
		assert.ok(missingSummary, "Should warn about missing summary");
	});

	it("should warn on missing proof", () => {
		const artifacts: ArtifactStatus = {
			reachedDate: true,
			finalSummary: true,
			proofReferences: false,
			implementationNotes: true,
			testResults: true,
		};

		const advisories = generateAdvisories(
			"Active",
			"Complete",
			artifacts,
			"warning",
		);

		const missingProof = advisories.find((a) => a.type === "missing-proof");
		assert.ok(missingProof, "Should warn about missing proof");
	});

	it("should warn on fast transition", () => {
		const artifacts: ArtifactStatus = {
			reachedDate: true,
			finalSummary: true,
			proofReferences: true,
			implementationNotes: true,
			testResults: true,
		};

		const advisories = generateAdvisories(
			"Active",
			"Complete",
			artifacts,
			"fast-tracked",
		);

		const fastAdvisory = advisories.find((a) => a.type === "fast-transition");
		assert.ok(fastAdvisory, "Should warn about fast transition");
	});

	it("should warn on backward transition", () => {
		const artifacts: ArtifactStatus = {
			reachedDate: true,
			finalSummary: true,
			proofReferences: true,
			implementationNotes: true,
			testResults: true,
		};

		const advisories = generateAdvisories(
			"Complete",
			"Active",
			artifacts,
			"warning",
		);

		const backwardAdvisory = advisories.find(
			(a) => a.type === "stale-proposal",
		);
		assert.ok(backwardAdvisory, "Should warn about reopening proposal");
	});

	it("should allow all advisories to be overridden", () => {
		const artifacts: ArtifactStatus = {
			reachedDate: false,
			finalSummary: false,
			proofReferences: false,
			implementationNotes: false,
			testResults: false,
		};

		const advisories = generateAdvisories(
			"Potential",
			"Complete",
			artifacts,
			"skipped",
		);

		for (const advisory of advisories) {
			assert.ok(advisory.canOverride, `${advisory.type} should be overridable`);
		}
	});
});

describe("createPulseRecord", () => {
	it("should create a complete pulse record", () => {
		const record = createPulseRecord(
			"proposal-001",
			"Potential",
			"Active",
			"agent-1",
			SAMPLE_STATE_CONTENT,
		);

		assert.equal(record.proposalId, "proposal-001");
		assert.equal(record.fromStatus, "Potential");
		assert.equal(record.toStatus, "Active");
		assert.equal(record.agentId, "agent-1");
		assert.ok(record.timestamp);
		assert.ok(record.artifactsPresent);
		assert.ok(Array.isArray(record.advisories));
		assert.equal(record.overridden, false);
	});

	it("should detect artifacts from content", () => {
		const record = createPulseRecord(
			"proposal-001",
			"Active",
			"Complete",
			"agent-1",
			SAMPLE_STATE_CONTENT,
		);

		assert.ok(record.artifactsPresent.reachedDate);
		assert.ok(record.artifactsPresent.finalSummary);
		assert.ok(record.artifactsPresent.proofReferences);
		assert.ok(record.artifactsPresent.implementationNotes);
		assert.ok(record.artifactsPresent.testResults);
	});

	it("should include quality assessment", () => {
		// Use sequential transition for minimal content to get warning quality
		const record = createPulseRecord(
			"proposal-001",
			"Potential",
			"Active",
			"agent-1",
			MINIMAL_STATE_CONTENT,
		);

		assert.equal(record.quality, "warning");
	});
});

describe("formatAdvisories", () => {
	it("should show success message for no advisories", () => {
		const result = formatAdvisories([]);
		assert.ok(result.includes("✅"));
		assert.ok(result.includes("clean"));
	});

	it("should format advisory list", () => {
		const advisories: AdvisoryWarning[] = [
			{
				type: "missing-artifact",
				severity: "warning",
				message: "Missing proof",
				suggestion: "Add proof section",
				canOverride: true,
			},
			{
				type: "non-sequential",
				severity: "warning",
				message: "Skipping stages",
				suggestion: "Go through all stages",
				canOverride: true,
			},
		];

		const result = formatAdvisories(advisories);
		assert.ok(result.includes("2 suggestion(s)"));
		assert.ok(result.includes("Missing proof"));
		assert.ok(result.includes("Skipping stages"));
		assert.ok(result.includes("--rationale"));
	});
});

describe("formatArtifactStatus", () => {
	it("should format artifact checklist", () => {
		const artifacts: ArtifactStatus = {
			reachedDate: true,
			finalSummary: false,
			proofReferences: true,
			implementationNotes: false,
			testResults: true,
		};

		const result = formatArtifactStatus(artifacts);
		assert.ok(result.includes("📊 Artifact Status"));
		assert.ok(result.includes("Complete/Completed Date"));
		assert.ok(result.includes("3/5 artifacts"));
	});
});

describe("pulseRecordHash", () => {
	it("should generate consistent hash", () => {
		const record: PulseRecord = {
			proposalId: "proposal-001",
			fromStatus: "Active",
			toStatus: "Complete",
			agentId: "agent-1",
			timestamp: "2026-03-25T10:00:00.000Z",
			quality: "good",
			advisories: [],
			overridden: false,
			artifactsPresent: {
				reachedDate: true,
				finalSummary: true,
				proofReferences: true,
				implementationNotes: true,
				testResults: true,
			},
		};

		const hash1 = pulseRecordHash(record);
		const hash2 = pulseRecordHash(record);

		assert.equal(hash1, hash2, "Hash should be deterministic");
		assert.equal(hash1.length, 16, "Hash should be 16 chars");
	});

	it("should generate different hashes for different records", () => {
		const record1: PulseRecord = {
			proposalId: "proposal-001",
			fromStatus: "Active",
			toStatus: "Complete",
			agentId: "agent-1",
			timestamp: "2026-03-25T10:00:00.000Z",
			quality: "good",
			advisories: [],
			overridden: false,
			artifactsPresent: {
				reachedDate: true,
				finalSummary: true,
				proofReferences: true,
				implementationNotes: true,
				testResults: true,
			},
		};

		const record2 = { ...record1, proposalId: "proposal-002" };

		const hash1 = pulseRecordHash(record1);
		const hash2 = pulseRecordHash(record2);

		assert.notEqual(
			hash1,
			hash2,
			"Different records should have different hashes",
		);
	});
});

describe("getTransitionAdvisory", () => {
	it("should allow clean transitions", () => {
		const result = getTransitionAdvisory(
			"proposal-001",
			"Potential",
			"Active",
			SAMPLE_STATE_CONTENT,
		);

		assert.ok(result.allowed);
		assert.equal(result.quality, "good");
		assert.equal(
			result.message,
			"Transition Potential → Active allowed with 0 advisory note(s)",
		);
	});

	it("should provide advisory for incomplete transitions", () => {
		const result = getTransitionAdvisory(
			"proposal-001",
			"Active",
			"Complete",
			MINIMAL_STATE_CONTENT,
		);

		assert.ok(result.allowed, "Should allow with advisories");
		assert.ok(result.advisories.length > 0, "Should have advisories");
		assert.ok(result.artifactStatus);
	});

	it("should reject invalid status transitions", () => {
		const result = getTransitionAdvisory(
			"proposal-001",
			"Invalid",
			"Active",
			SAMPLE_STATE_CONTENT,
		);

		assert.ok(!result.allowed);
		assert.ok(result.message.includes("Invalid"));
	});

	it("should detect fast-tracked transitions", () => {
		const result = getTransitionAdvisory(
			"proposal-001",
			"Active",
			"Complete",
			SAMPLE_STATE_CONTENT,
			30 * 60 * 1000, // 30 minutes
		);

		assert.equal(result.quality, "fast-tracked");
	});
});

describe("shouldNotifyPeers", () => {
	it("should notify on fast-tracked completion", () => {
		assert.ok(shouldNotifyPeers("fast-tracked", "Complete"));
	});

	it("should notify on skipped stages", () => {
		assert.ok(shouldNotifyPeers("skipped", "Complete"));
		assert.ok(shouldNotifyPeers("skipped", "Active"));
	});

	it("should not notify on good transitions", () => {
		assert.ok(!shouldNotifyPeers("good", "Complete"));
		assert.ok(!shouldNotifyPeers("good", "Active"));
	});

	it("should not notify on warnings", () => {
		assert.ok(!shouldNotifyPeers("warning", "Complete"));
	});
});

describe("formatPeerNotification", () => {
	it("should format fast-tracked notification", () => {
		const message = formatPeerNotification(
			"proposal-001",
			"agent-1",
			"fast-tracked",
			"Active",
			"Complete",
		);

		assert.ok(message.includes("Fast-tracked"));
		assert.ok(message.includes("@agent-1"));
		assert.ok(message.includes("proposal-001"));
		assert.ok(message.includes("review"));
	});

	it("should format skipped stages notification", () => {
		const message = formatPeerNotification(
			"proposal-001",
			"agent-1",
			"skipped",
			"Potential",
			"Complete",
		);

		assert.ok(message.includes("Skipped stages"));
		assert.ok(message.includes("@agent-1"));
		assert.ok(message.includes("verify"));
	});

	it("should format generic transition notification", () => {
		const message = formatPeerNotification(
			"proposal-001",
			"agent-1",
			"good",
			"Active",
			"Complete",
		);

		assert.ok(message.includes("Transition"));
		assert.ok(message.includes("proposal-001"));
	});
});

describe("PulseStorage", () => {
	it("should track records in memory", async () => {
		const storage = new PulseStorage("/tmp/test-pulse");

		const record: PulseRecord = {
			proposalId: "proposal-001",
			fromStatus: "Active",
			toStatus: "Complete",
			agentId: "agent-1",
			timestamp: "2026-03-25T10:00:00.000Z",
			quality: "good",
			advisories: [],
			overridden: false,
			artifactsPresent: {
				reachedDate: true,
				finalSummary: true,
				proofReferences: true,
				implementationNotes: true,
				testResults: true,
			},
		};

		await storage.record(record);
		const stats = storage.getStats();

		assert.equal(stats.totalTransitions, 1);
		assert.equal(stats.goodTransitions, 1);
	});

	it("should compute statistics correctly", async () => {
		const storage = new PulseStorage("/tmp/test-pulse");

		const records: PulseRecord[] = [
			{
				proposalId: "proposal-001",
				fromStatus: "Active",
				toStatus: "Complete",
				agentId: "agent-1",
				timestamp: "2026-03-25T10:00:00.000Z",
				quality: "good",
				advisories: [],
				overridden: false,
				artifactsPresent: {
					reachedDate: true,
					finalSummary: true,
					proofReferences: true,
					implementationNotes: true,
					testResults: true,
				},
			},
			{
				proposalId: "proposal-002",
				fromStatus: "Active",
				toStatus: "Complete",
				agentId: "agent-2",
				timestamp: "2026-03-25T11:00:00.000Z",
				quality: "warning",
				advisories: [
					{
						type: "missing-proof",
						severity: "info",
						message: "No proof",
						suggestion: "Add proof",
						canOverride: true,
					},
				],
				overridden: true,
				overrideRationale: "Will add later",
				artifactsPresent: {
					reachedDate: true,
					finalSummary: true,
					proofReferences: false,
					implementationNotes: true,
					testResults: true,
				},
			},
			{
				proposalId: "proposal-003",
				fromStatus: "Potential",
				toStatus: "Complete",
				agentId: "agent-1",
				timestamp: "2026-03-25T12:00:00.000Z",
				quality: "fast-tracked",
				advisories: [],
				overridden: false,
				artifactsPresent: {
					reachedDate: true,
					finalSummary: true,
					proofReferences: true,
					implementationNotes: true,
					testResults: true,
				},
			},
		];

		for (const record of records) {
			await storage.record(record);
		}

		const stats = storage.getStats();

		assert.equal(stats.totalTransitions, 3);
		assert.equal(stats.goodTransitions, 1);
		assert.equal(stats.warningTransitions, 1);
		assert.equal(stats.fastTrackedTransitions, 1);
		assert.equal(stats.overrideCount, 1);
		assert.equal(stats.topAgents.get("agent-1"), 2);
		assert.equal(stats.topAgents.get("agent-2"), 1);
		assert.equal(stats.topAdvisories.get("missing-proof"), 1);
	});

	it("should filter stats by time", async () => {
		const storage = new PulseStorage("/tmp/test-pulse");

		const records: PulseRecord[] = [
			{
				proposalId: "proposal-001",
				fromStatus: "Active",
				toStatus: "Complete",
				agentId: "agent-1",
				timestamp: "2026-03-24T10:00:00.000Z",
				quality: "good",
				advisories: [],
				overridden: false,
				artifactsPresent: {
					reachedDate: true,
					finalSummary: true,
					proofReferences: true,
					implementationNotes: true,
					testResults: true,
				},
			},
			{
				proposalId: "proposal-002",
				fromStatus: "Active",
				toStatus: "Complete",
				agentId: "agent-1",
				timestamp: "2026-03-25T10:00:00.000Z",
				quality: "good",
				advisories: [],
				overridden: false,
				artifactsPresent: {
					reachedDate: true,
					finalSummary: true,
					proofReferences: true,
					implementationNotes: true,
					testResults: true,
				},
			},
		];

		for (const record of records) {
			await storage.record(record);
		}

		// Filter to only today
		const todayStats = storage.getStats("2026-03-25");
		assert.equal(todayStats.totalTransitions, 1);

		// All stats
		const allStats = storage.getStats();
		assert.equal(allStats.totalTransitions, 2);
	});

	it("should format statistics", async () => {
		const storage = new PulseStorage("/tmp/test-pulse");

		const record: PulseRecord = {
			proposalId: "proposal-001",
			fromStatus: "Active",
			toStatus: "Complete",
			agentId: "agent-1",
			timestamp: "2026-03-25T10:00:00.000Z",
			quality: "good",
			advisories: [],
			overridden: false,
			artifactsPresent: {
				reachedDate: true,
				finalSummary: true,
				proofReferences: true,
				implementationNotes: true,
				testResults: true,
			},
		};

		await storage.record(record);
		const stats = storage.getStats();
		const formatted = storage.formatStats(stats);

		assert.ok(formatted.includes("Pulse Statistics"));
		assert.ok(formatted.includes("Total Transitions: 1"));
		assert.ok(formatted.includes("agent-1"));
	});
});
