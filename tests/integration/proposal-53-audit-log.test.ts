/**
 * proposal-53: Audit Logging & Forensic Trail - Test Suite
 *
 * Tests for the immutable, append-only audit log system.
 */

import assert from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { AuditLog } from "../../src/core/infrastructure/audit-log.ts";

let tempDir: string;
let auditLog: AuditLog;

async function setup() {
	tempDir = await mkdtemp(join(tmpdir(), "audit-test-"));
	auditLog = new AuditLog(tempDir);
	await auditLog.initialize();
}

async function teardown() {
	auditLog.close();
	await rm(tempDir, { recursive: true, force: true });
}

describe("proposal-53: Audit Logging & Forensic Trail", () => {
	beforeEach(async () => {
		await setup();
	});

	afterEach(async () => {
		await teardown();
	});

	describe("AC#1: Proposal transitions are logged", () => {
		test("logProposalTransition() creates a valid entry", async () => {
			const entry = await auditLog.logProposalTransition(
				"proposal_claim",
				"carter",
				"proposal-100",
				"claim_proposal",
				"success",
				{ priority: "high" },
			);

			assert.notStrictEqual(entry.id, undefined);
			assert.notStrictEqual(entry.timestamp, undefined);
			assert.strictEqual(entry.eventType, "proposal_claim");
			assert.strictEqual(entry.agentId, "carter");
			assert.strictEqual(entry.targetId, "proposal-100");
			assert.strictEqual(entry.action, "claim_proposal");
			assert.strictEqual(entry.result, "success");
			assert.strictEqual(entry.details.priority, "high");
		});

		test("Proposal claim, start, complete, revert are all logged", async () => {
			await auditLog.logProposalTransition(
				"proposal_claim",
				"carter",
				"proposal-100",
				"claim",
				"success",
				{},
			);
			await auditLog.logProposalTransition(
				"proposal_start",
				"carter",
				"proposal-100",
				"start",
				"success",
				{},
			);
			await auditLog.logProposalTransition(
				"proposal_complete",
				"carter",
				"proposal-100",
				"complete",
				"success",
				{},
			);
			await auditLog.logProposalTransition(
				"proposal_revert",
				"carter",
				"proposal-100",
				"revert",
				"success",
				{},
			);

			const stats = await auditLog.getStats();
			assert.strictEqual(stats.totalEntries, 4);
		});

		test("Failed proposal transitions are logged with failure result", async () => {
			const entry = await auditLog.logProposalTransition(
				"proposal_claim",
				"carter",
				"proposal-100",
				"claim",
				"failure",
				{ error: "Already claimed" },
			);

			assert.strictEqual(entry.result, "failure");
			assert.strictEqual(entry.details.error, "Already claimed");
		});
	});

	describe("AC#2: Authentication events are logged", () => {
		test("Token issuance is logged", async () => {
			const entry = await auditLog.logAuthEvent(
				"auth_token_issued",
				"carter",
				"issue_token",
				"success",
				{ expiresIn: "24h" },
			);

			assert.strictEqual(entry.eventType, "auth_token_issued");
			assert.strictEqual(entry.result, "success");
		});

		test("Token validation is logged", async () => {
			const entry = await auditLog.logAuthEvent(
				"auth_token_validated",
				"carter",
				"validate_token",
				"success",
				{ tokenId: "tok-123" },
			);

			assert.strictEqual(entry.eventType, "auth_token_validated");
		});

		test("Failed authentication is logged", async () => {
			const entry = await auditLog.logAuthEvent(
				"auth_failed",
				"unknown-agent",
				"auth_attempt",
				"failure",
				{ reason: "Invalid token" },
			);

			assert.strictEqual(entry.result, "failure");
			assert.strictEqual(entry.details.reason, "Invalid token");
		});

		test("Token revocation is logged", async () => {
			const entry = await auditLog.logAuthEvent(
				"auth_token_revoked",
				"carter",
				"revoke_token",
				"success",
				{ tokenId: "tok-123" },
			);

			assert.strictEqual(entry.eventType, "auth_token_revoked");
		});
	});

	describe("AC#3: Rate limit events are logged", () => {
		test("Rate limit check is logged", async () => {
			const entry = await auditLog.logRateLimitEvent(
				"rate_limit_check",
				"carter",
				"check_limit",
				"success",
				{ remaining: 95 },
			);

			assert.strictEqual(entry.eventType, "rate_limit_check");
		});

		test("Rate limit violation is logged", async () => {
			const entry = await auditLog.logRateLimitEvent(
				"rate_limit_violation",
				"carter",
				"violation",
				"warning",
				{ limit: 100, current: 101 },
			);

			assert.strictEqual(entry.eventType, "rate_limit_violation");
			assert.strictEqual(entry.result, "warning");
		});

		test("Rate limit suspension is logged", async () => {
			const entry = await auditLog.logRateLimitEvent(
				"rate_limit_suspension",
				"carter",
				"suspend",
				"failure",
				{ duration: "1h" },
			);

			assert.strictEqual(entry.eventType, "rate_limit_suspension");
			assert.strictEqual(entry.result, "failure");
		});
	});

	describe("AC#5: Append-only hash chain", () => {
		test("Each entry has a hash and previousHash", async () => {
			const entry1 = await auditLog.logProposalTransition(
				"proposal_claim",
				"carter",
				"proposal-1",
				"claim",
				"success",
				{},
			);
			const entry2 = await auditLog.logProposalTransition(
				"proposal_claim",
				"bob",
				"proposal-2",
				"claim",
				"success",
				{},
			);

			assert.notStrictEqual(entry1.hash, undefined);
			assert.strictEqual(entry1.previousHash, "genesis");
			assert.strictEqual(entry2.previousHash, entry1.hash);
		});

		test("Hash chain validation works", async () => {
			await auditLog.logProposalTransition(
				"proposal_claim",
				"carter",
				"proposal-1",
				"claim",
				"success",
				{},
			);
			await auditLog.logProposalTransition(
				"proposal_claim",
				"bob",
				"proposal-2",
				"claim",
				"success",
				{},
			);
			await auditLog.logProposalTransition(
				"proposal_claim",
				"alice",
				"proposal-3",
				"claim",
				"success",
				{},
			);

			const result = await auditLog.validateHashChain();
			assert.strictEqual(result.valid, true);
			assert.strictEqual(result.entries, 3);
		});

		test("Corrupted log is detected by hash chain validation", async () => {
			await auditLog.logProposalTransition(
				"proposal_claim",
				"carter",
				"proposal-1",
				"claim",
				"success",
				{},
			);
			await auditLog.logProposalTransition(
				"proposal_claim",
				"bob",
				"proposal-2",
				"claim",
				"success",
				{},
			);

			// Corrupt the log file by modifying an entry
			const logPath = join(tempDir, "roadmap", "audit.log");
			const content = await readFile(logPath, "utf-8");
			const lines = content.trim().split("\n");
			lines[1] = lines[1].replace('"agentId":"bob"', '"agentId":"hacker"');
			await writeFile(logPath, `${lines.join("\n")}\n`);

			const result = await auditLog.validateHashChain();
			assert.strictEqual(result.valid, false);
		});
	});

	describe("AC#7: Query interface", () => {
		test("query() returns all entries by default", async () => {
			await auditLog.logProposalTransition(
				"proposal_claim",
				"carter",
				"proposal-1",
				"claim",
				"success",
				{},
			);
			await auditLog.logProposalTransition(
				"proposal_claim",
				"bob",
				"proposal-2",
				"claim",
				"success",
				{},
			);
			await auditLog.logAuthEvent(
				"auth_failed",
				"alice",
				"auth",
				"failure",
				{},
			);

			const results = await auditLog.query();
			assert.strictEqual(results.length, 3);
		});

		test("query() filters by agentId", async () => {
			await auditLog.logProposalTransition(
				"proposal_claim",
				"carter",
				"proposal-1",
				"claim",
				"success",
				{},
			);
			await auditLog.logProposalTransition(
				"proposal_claim",
				"bob",
				"proposal-2",
				"claim",
				"success",
				{},
			);
			await auditLog.logProposalTransition(
				"proposal_claim",
				"carter",
				"proposal-3",
				"claim",
				"success",
				{},
			);

			const results = await auditLog.query({ agentId: "carter" });
			assert.strictEqual(results.length, 2);
			assert.strictEqual(
				results.every((r) => r.agentId === "carter"),
				true,
			);
		});

		test("query() filters by eventType", async () => {
			await auditLog.logProposalTransition(
				"proposal_claim",
				"carter",
				"proposal-1",
				"claim",
				"success",
				{},
			);
			await auditLog.logAuthEvent(
				"auth_failed",
				"carter",
				"auth",
				"failure",
				{},
			);
			await auditLog.logProposalTransition(
				"proposal_start",
				"carter",
				"proposal-1",
				"start",
				"success",
				{},
			);

			const results = await auditLog.query({ eventType: "proposal_claim" });
			assert.strictEqual(results.length, 1);
			assert.strictEqual(results[0].eventType, "proposal_claim");
		});

		test("query() filters by result", async () => {
			await auditLog.logProposalTransition(
				"proposal_claim",
				"carter",
				"proposal-1",
				"claim",
				"success",
				{},
			);
			await auditLog.logProposalTransition(
				"proposal_claim",
				"bob",
				"proposal-2",
				"claim",
				"failure",
				{},
			);
			await auditLog.logProposalTransition(
				"proposal_claim",
				"alice",
				"proposal-3",
				"claim",
				"success",
				{},
			);

			const results = await auditLog.query({ result: "failure" });
			assert.strictEqual(results.length, 1);
			assert.strictEqual(results[0].result, "failure");
		});

		test("query() supports limit and offset", async () => {
			for (let i = 1; i <= 10; i++) {
				await auditLog.logProposalTransition(
					"proposal_claim",
					"carter",
					`proposal-${i}`,
					"claim",
					"success",
					{},
				);
			}

			const page1 = await auditLog.query({ limit: 3, offset: 0 });
			assert.strictEqual(page1.length, 3);

			const page2 = await auditLog.query({ limit: 3, offset: 3 });
			assert.strictEqual(page2.length, 3);

			// Pages should be different
			assert.notStrictEqual(page1[0].id, page2[0].id);
		});

		test("query() filters by targetId", async () => {
			await auditLog.logProposalTransition(
				"proposal_claim",
				"carter",
				"proposal-1",
				"claim",
				"success",
				{},
			);
			await auditLog.logProposalTransition(
				"proposal_claim",
				"bob",
				"proposal-2",
				"claim",
				"success",
				{},
			);
			await auditLog.logProposalTransition(
				"proposal_start",
				"carter",
				"proposal-1",
				"start",
				"success",
				{},
			);

			const results = await auditLog.query({ targetId: "proposal-1" });
			assert.strictEqual(results.length, 2);
		});

		test("query() filters by time range", async () => {
			await auditLog.logProposalTransition(
				"proposal_claim",
				"carter",
				"proposal-1",
				"claim",
				"success",
				{},
			);

			// Query from 1 hour ago should include our entry
			const earlier = new Date(Date.now() - 3600000).toISOString();
			const results = await auditLog.query({ startDate: earlier });
			assert.strictEqual(results.length, 1);

			// Query from the future should return no results
			const future = new Date(Date.now() + 60000).toISOString();
			const futureResults = await auditLog.query({ startDate: future });
			assert.strictEqual(futureResults.length, 0);
		});
	});

	describe("AC#8: Anomaly detection", () => {
		test("detects high volume claims", async () => {
			// Simulate 100+ claims in a short time
			for (let i = 0; i < 101; i++) {
				await auditLog.logProposalTransition(
					"proposal_claim",
					"spam-bot",
					`proposal-${i}`,
					"claim",
					"success",
					{},
				);
			}

			const alerts = auditLog.checkAnomalies();
			assert.ok(alerts.length > 0);
			assert.strictEqual(alerts[0].type, "high_volume");
			assert.strictEqual(alerts[0].agentId, "spam-bot");
			assert.strictEqual(alerts[0].severity, "critical");
		});

		test("detects multiple auth failures", async () => {
			for (let i = 0; i < 11; i++) {
				await auditLog.logAuthEvent(
					"auth_failed",
					"attacker",
					"auth",
					"failure",
					{},
				);
			}

			const alerts = auditLog.checkAnomalies();
			assert.ok(alerts.length > 0);
			assert.strictEqual(alerts[0].type, "auth_failures");
			assert.strictEqual(alerts[0].agentId, "attacker");
		});

		test("no alerts when within thresholds", async () => {
			await auditLog.logProposalTransition(
				"proposal_claim",
				"carter",
				"proposal-1",
				"claim",
				"success",
				{},
			);
			await auditLog.logAuthEvent(
				"auth_failed",
				"carter",
				"auth",
				"failure",
				{},
			);

			const alerts = auditLog.checkAnomalies();
			assert.strictEqual(alerts.length, 0);
		});
	});

	describe("Statistics and monitoring", () => {
		test("getStats() returns correct statistics", async () => {
			await auditLog.logProposalTransition(
				"proposal_claim",
				"carter",
				"proposal-1",
				"claim",
				"success",
				{},
			);
			await auditLog.logProposalTransition(
				"proposal_claim",
				"bob",
				"proposal-2",
				"claim",
				"failure",
				{},
			);
			await auditLog.logAuthEvent(
				"auth_token_issued",
				"carter",
				"issue",
				"success",
				{},
			);

			const stats = await auditLog.getStats();
			assert.strictEqual(stats.totalEntries, 3);
			assert.strictEqual(stats.uniqueAgents, 2);
			assert.ok(Math.abs(stats.failureRate - 1 / 3) < 0.001);
			assert.strictEqual(stats.hashChainValid, true);
			assert.strictEqual(stats.entriesByType.proposal_claim, 2);
			assert.strictEqual(stats.entriesByType.auth_token_issued, 1);
		});

		test("getEntryCount() returns current count", async () => {
			assert.strictEqual(auditLog.getEntryCount(), 0);

			await auditLog.logProposalTransition(
				"proposal_claim",
				"carter",
				"proposal-1",
				"claim",
				"success",
				{},
			);
			assert.strictEqual(auditLog.getEntryCount(), 1);

			await auditLog.logProposalTransition(
				"proposal_claim",
				"bob",
				"proposal-2",
				"claim",
				"success",
				{},
			);
			assert.strictEqual(auditLog.getEntryCount(), 2);
		});

		test("getLastHash() returns the current chain hash", async () => {
			const initialHash = auditLog.getLastHash();
			assert.strictEqual(initialHash, "genesis");

			const entry = await auditLog.logProposalTransition(
				"proposal_claim",
				"carter",
				"proposal-1",
				"claim",
				"success",
				{},
			);
			assert.strictEqual(auditLog.getLastHash(), entry.hash);
		});
	});

	describe("AC#4: Message events (placeholder)", () => {
		test("logMessageEvent() creates valid entry", async () => {
			const entry = await auditLog.logMessageEvent(
				"message_sent",
				"carter",
				"msg-123",
				"send_to_bob",
				"success",
				{ channel: "general" },
			);

			assert.strictEqual(entry.eventType, "message_sent");
			assert.strictEqual(entry.targetId, "msg-123");
			assert.strictEqual(entry.details.channel, "general");
		});

		test("logMessageEvent() for verification", async () => {
			const entry = await auditLog.logMessageEvent(
				"message_verification",
				"carter",
				"msg-123",
				"verify_signature",
				"success",
				{ verified: true },
			);

			assert.strictEqual(entry.eventType, "message_verification");
		});
	});
});
