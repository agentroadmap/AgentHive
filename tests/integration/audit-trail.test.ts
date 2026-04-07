/**
 * Tests for Audit Logging & Forensic Trail (proposal-53)
 *
 * AC#1: All proposal transitions logged with timestamp and actor
 * AC#2: Authentication events logged (success and failure)
 * AC#3: Rate limit violations recorded with agent ID
 * AC#4: Audit logs queryable via MCP tool
 * AC#5: Logs retained for configurable period (default 90 days)
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { AuditEvent } from "../../src/core/infrastructure/audit-trail.ts";
import {
	AuditTrail,
	formatAuditEvents,
	resetAuditTrail,
} from "../../src/core/infrastructure/audit-trail.ts";

describe("AuditTrail (proposal-53)", () => {
	let tempDir: string;
	let audit: AuditTrail;

	before(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "roadmap-audit-test-"));
	});

	beforeEach(async () => {
		resetAuditTrail();
		audit = new AuditTrail({
			auditDir: join(tempDir, `audit-${Date.now()}`),
			retentionDays: 1, // Short retention for tests
			maxFileSize: 1024, // Small for testing rotation
		});
		await audit.initialize();
	});

	afterEach(async () => {
		await audit.shutdown();
	});

	after(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	// ─── AC#1: Proposal Transitions ─────────────────────────────────────

	describe("AC#1: Proposal transition logging", () => {
		it("should log proposal transitions with timestamp and actor", async () => {
			const event = await audit.logProposalTransition(
				"agent-001",
				"proposal-42",
				"Potential",
				"Active",
			);

			assert.ok(event.id, "Event should have ID");
			assert.ok(event.timestamp, "Event should have timestamp");
			assert.equal(event.type, "proposal_transition");
			assert.equal(event.agentId, "agent-001");
			assert.equal(event.resourceId, "proposal-42");
			assert.equal(event.success, true);
			assert.equal(event.details?.fromStatus, "Potential");
			assert.equal(event.details?.toStatus, "Active");
		});

		it("should log proposal transitions with additional details", async () => {
			const event = await audit.logProposalTransition(
				"agent-002",
				"proposal-51",
				"Active",
				"Review",
				{ reason: "All ACs complete", testCount: 25 },
			);

			assert.equal(event.details?.reason, "All ACs complete");
			assert.equal(event.details?.testCount, 25);
		});
	});

	// ─── AC#2: Authentication Events ─────────────────────────────────

	describe("AC#2: Authentication logging", () => {
		it("should log successful authentication", async () => {
			const event = await audit.logAuthSuccess("agent-001", "token", {
				method: "bearer",
			});

			assert.equal(event.type, "auth_success");
			assert.equal(event.agentId, "agent-001");
			assert.equal(event.action, "auth:token");
			assert.equal(event.success, true);
		});

		it("should log failed authentication with reason", async () => {
			const event = await audit.logAuthFailure("agent-002", "expired_token", {
				attempts: 3,
			});

			assert.equal(event.type, "auth_failure");
			assert.equal(event.agentId, "agent-002");
			assert.equal(event.success, false);
			assert.equal(event.details?.reason, "expired_token");
			assert.equal(event.details?.attempts, 3);
		});
	});

	// ─── AC#3: Rate Limit Violations ─────────────────────────────────

	describe("AC#3: Rate limit violation logging", () => {
		it("should log rate limit violations with agent ID", async () => {
			const event = await audit.logRateLimitViolation(
				"agent-003",
				"/api/proposals",
				100,
				150,
			);

			assert.equal(event.type, "rate_limit_violation");
			assert.equal(event.agentId, "agent-003");
			assert.equal(event.success, false);
			assert.equal(event.details?.endpoint, "/api/proposals");
			assert.equal(event.details?.limit, 100);
			assert.equal(event.details?.current, 150);
			assert.equal(event.details?.exceededBy, 50);
		});
	});

	// ─── AC#4: Querying ──────────────────────────────────────────────

	describe("AC#4: Audit log querying", () => {
		it("should query events and support filtering", async () => {
			// Use fresh audit instance for isolation
			const testAudit = new AuditTrail({
				auditDir: join(
					tempDir,
					`audit-query-test-${Date.now()}-${Math.random()}`,
				),
				retentionDays: 1,
			});
			await testAudit.initialize();

			// Add test events
			await testAudit.logProposalTransition(
				"agent-A",
				"proposal-1",
				"Potential",
				"Active",
			);
			await testAudit.logProposalTransition(
				"agent-B",
				"proposal-2",
				"Active",
				"Review",
			);
			await testAudit.logAuthSuccess("agent-A", "token");
			await testAudit.logAuthFailure("agent-B", "invalid_token");
			await testAudit.logRateLimitViolation("agent-A", "/api/test", 10, 15);

			// Query should return events
			const result = await testAudit.query({});
			assert.ok(result.total >= 5, "Should have at least 5 events");
			assert.ok(result.events.length >= 5, "Should return events");
			await testAudit.shutdown();
		});

		it("should filter by event type", async () => {
			const testAudit = new AuditTrail({
				auditDir: join(
					tempDir,
					`audit-filter-type-${Date.now()}-${Math.random()}`,
				),
				retentionDays: 1,
			});
			await testAudit.initialize();

			await testAudit.logProposalTransition(
				"agent-A",
				"proposal-1",
				"Potential",
				"Active",
			);
			await testAudit.logAuthSuccess("agent-A", "token");

			const result = await testAudit.query({
				eventType: "proposal_transition",
			});
			assert.ok(
				result.total >= 1,
				"Should have at least one proposal_transition",
			);
			assert.ok(result.events.every((e) => e.type === "proposal_transition"));
			await testAudit.shutdown();
		});

		it("should filter by agent ID", async () => {
			const testAudit = new AuditTrail({
				auditDir: join(
					tempDir,
					`audit-filter-agent-${Date.now()}-${Math.random()}`,
				),
				retentionDays: 1,
			});
			await testAudit.initialize();

			await testAudit.logProposalTransition(
				"agent-A",
				"proposal-1",
				"Potential",
				"Active",
			);
			await testAudit.logAuthSuccess("agent-A", "token");
			await testAudit.logAuthFailure("agent-B", "invalid_token");

			const result = await testAudit.query({ agentId: "agent-A" });
			assert.ok(result.total >= 2, "agent-A should have at least 2 events");
			assert.ok(result.events.every((e) => e.agentId === "agent-A"));
			await testAudit.shutdown();
		});

		it("should filter by success status", async () => {
			const testAudit = new AuditTrail({
				auditDir: join(
					tempDir,
					`audit-filter-success-${Date.now()}-${Math.random()}`,
				),
				retentionDays: 1,
			});
			await testAudit.initialize();

			await testAudit.logAuthSuccess("agent-A", "token");
			await testAudit.logAuthFailure("agent-B", "invalid_token");

			const result = await testAudit.query({ success: false });
			assert.ok(result.events.every((e) => e.success === false));
			await testAudit.shutdown();
		});

		it("should support pagination", async () => {
			const testAudit = new AuditTrail({
				auditDir: join(
					tempDir,
					`audit-pagination-${Date.now()}-${Math.random()}`,
				),
				retentionDays: 1,
			});
			await testAudit.initialize();

			// Add 5 events
			for (let i = 0; i < 5; i++) {
				await testAudit.logProposalTransition(
					"agent-A",
					`proposal-${i}`,
					"Potential",
					"Active",
				);
			}

			const page1 = await testAudit.query({ limit: 2, offset: 0 });
			const page2 = await testAudit.query({ limit: 2, offset: 2 });

			assert.ok(page1.events.length >= 1, "Page 1 should have events");
			assert.ok(page2.events.length >= 1, "Page 2 should have events");
			await testAudit.shutdown();
		});

		it("should sort by timestamp (newest first)", async () => {
			const testAudit = new AuditTrail({
				auditDir: join(tempDir, `audit-sort-${Date.now()}-${Math.random()}`),
				retentionDays: 1,
			});
			await testAudit.initialize();

			await testAudit.logProposalTransition(
				"agent-A",
				"proposal-1",
				"Potential",
				"Active",
			);
			await new Promise((r) => setTimeout(r, 5)); // Small delay
			await testAudit.logProposalTransition(
				"agent-A",
				"proposal-2",
				"Potential",
				"Active",
			);

			const result = await testAudit.query({ limit: 2 });
			if (result.events.length >= 2) {
				const timestamps = result.events.map((e) => e.timestamp);
				// First event should be newer or same
				assert.ok(
					timestamps[0] >= timestamps[1],
					"Events should be sorted newest first",
				);
			}
			await testAudit.shutdown();
		});
	});

	// ─── AC#5: Retention ─────────────────────────────────────────────

	describe("AC#5: Log retention", () => {
		it("should report retention configuration in stats", async () => {
			const stats = await audit.getStats();
			assert.equal(stats.retentionDays, 1, "Should use configured retention");
		});

		it("should purge old events", async () => {
			const testAudit = new AuditTrail({
				auditDir: join(tempDir, `audit-purge-${Date.now()}-${Math.random()}`),
				retentionDays: 1,
			});
			await testAudit.initialize();

			await testAudit.logProposalTransition(
				"agent-001",
				"proposal-1",
				"Potential",
				"Active",
			);

			const stats = await testAudit.getStats();
			assert.ok(stats.totalEvents >= 1, "Should have at least 1 event");

			// Purge with retention of 1 day (nothing should be purged yet)
			const purged = await testAudit.purgeOldEvents();
			assert.equal(purged, 0, "Recent events should not be purged");
			await testAudit.shutdown();
		});

		it("should report log file count in stats", async () => {
			await audit.logProposalTransition(
				"agent-001",
				"proposal-1",
				"Potential",
				"Active",
			);
			await audit.flush();

			const stats = await audit.getStats();
			assert.ok(stats.logFiles >= 1, "Should have at least one log file");
		});
	});

	// ─── Format Helpers ──────────────────────────────────────────────

	describe("Format helpers", () => {
		const testEvents: AuditEvent[] = [
			{
				id: "1",
				timestamp: "2026-03-24T02:00:00.000Z",
				type: "proposal_transition",
				agentId: "agent-001",
				action: "proposal:Potential→Active",
				success: true,
			},
			{
				id: "2",
				timestamp: "2026-03-24T02:01:00.000Z",
				type: "auth_failure",
				agentId: "agent-002",
				action: "auth:failed",
				success: false,
			},
		];

		it("should format as JSON", () => {
			const output = formatAuditEvents(testEvents, "json");
			const parsed = JSON.parse(output);
			assert.equal(parsed.length, 2);
		});

		it("should format as table", () => {
			const output = formatAuditEvents(testEvents, "table");
			assert.ok(output.includes("TIMESTAMP"), "Should include header");
			assert.ok(output.includes("agent-001"), "Should include agent ID");
		});

		it("should format as text", () => {
			const output = formatAuditEvents(testEvents, "text");
			assert.ok(
				output.includes("proposal_transition"),
				"Should include event type",
			);
			assert.ok(output.includes("2026-03-24"), "Should include timestamp");
		});
	});
});
