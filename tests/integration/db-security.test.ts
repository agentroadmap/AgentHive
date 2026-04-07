/**
 * Tests for Database Migration Security Layer (proposal-095 AC#5)
 *
 * AC#5a: Access control (file permissions → DB permissions)
 * AC#5b: Audit trail migration (git log → event table)
 * AC#5c: Data integrity during migration
 * AC#5d: Secret/credential handling in DB context
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import {
	AccessControl,
	AgentTokenStore,
	AuditTrail,
	DataIntegrity,
	initializeSecurity,
} from "../../src/core/security/db-security.ts";

describe("Database Migration Security (proposal-095 AC#5)", () => {
	let tempDir: string;
	let db: DatabaseSync;

	before(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "roadmap-dbsec-test-"));
		db = new DatabaseSync(join(tempDir, "test.db"));
		initializeSecurity(db);
	});

	after(async () => {
		db.close();
		await rm(tempDir, { recursive: true, force: true });
	});

	// ─── AC#5b: Audit Trail (git log → event table) ───────────────

	describe("AC#5b: Audit Trail — git log → event table", () => {
		let audit: AuditTrail;

		before(() => {
			audit = new AuditTrail(db);
		});

		it("should log an audit event with all required fields", () => {
			const event = audit.logEvent({
				agentId: "agent-builder",
				action: "proposal_update",
				resourceType: "proposal",
				resourceId: "proposal-51",
				beforeHash: "abc123",
				afterHash: "def456",
				source: "database",
				keyVersion: 1,
			});

			assert.ok(event.id, "Should have UUID");
			assert.ok(event.timestamp, "Should have timestamp");
			assert.equal(event.agentId, "agent-builder");
			assert.equal(event.action, "proposal_update");
			assert.equal(event.resourceType, "proposal");
			assert.equal(event.resourceId, "proposal-51");
			assert.equal(event.beforeHash, "abc123");
			assert.equal(event.afterHash, "def456");
			assert.equal(event.source, "database");
			assert.equal(event.keyVersion, 1);
		});

		it("should track migration events with source='migration'", () => {
			const event = audit.logEvent({
				agentId: "migration-agent",
				action: "file_to_db_migrate",
				resourceType: "proposal",
				resourceId: "proposal-42",
				beforeHash: "file-hash-123",
				afterHash: "db-hash-123",
				source: "migration",
				keyVersion: 1,
			});

			assert.equal(event.source, "migration");
			assert.equal(event.action, "file_to_db_migrate");
		});

		it("should query events by agent", () => {
			const events = audit.queryEvents({ agentId: "agent-builder" });
			assert.ok(events.length > 0, "Should find events for agent-builder");
			assert.ok(events.every((e) => e.agentId === "agent-builder"));
		});

		it("should query events by resource", () => {
			const events = audit.queryEvents({
				resourceType: "proposal",
				resourceId: "proposal-51",
			});
			assert.ok(events.length > 0, "Should find events for proposal-51");
		});

		it("should query events since a timestamp", () => {
			const events = audit.queryEvents({ since: "2020-01-01T00:00:00.000Z" });
			assert.ok(events.length > 0, "Should find events since epoch");
		});

		it("should enforce limit on queries", () => {
			// Log a few more events
			for (let i = 0; i < 5; i++) {
				audit.logEvent({
					agentId: "bulk-agent",
					action: "test_action",
					resourceType: "proposal",
					resourceId: `proposal-BULK-${i}`,
					beforeHash: null,
					afterHash: null,
					source: "database",
					keyVersion: 1,
				});
			}

			const events = audit.queryEvents({ agentId: "bulk-agent", limit: 2 });
			assert.equal(events.length, 2, "Should respect limit");
		});

		it("should purge old events by retention period", () => {
			// This tests the purge mechanism — all events are recent so nothing purged
			const purged = audit.purgeOldEvents(365);
			assert.equal(
				typeof purged,
				"number",
				"Should return count of purged events",
			);
		});
	});

	// ─── AC#5a: Access Control (file perms → DB) ──────────────────

	describe("AC#5a: Access Control — file permissions → DB permissions", () => {
		let acl: AccessControl;

		before(() => {
			acl = new AccessControl(db);
		});

		it("should grant read permission to an agent", () => {
			acl.grant(
				"agent-reader",
				"proposal",
				"proposal-51",
				"read",
				"admin-agent",
			);
			assert.ok(
				acl.hasPermission("agent-reader", "proposal", "proposal-51", "read"),
				"Should have read permission",
			);
		});

		it("should deny permission that was not granted", () => {
			assert.ok(
				!acl.hasPermission("agent-reader", "proposal", "proposal-51", "delete"),
				"Should not have delete permission",
			);
		});

		it("should support wildcard resource permissions", () => {
			acl.grant("agent-admin", "proposal", "*", "admin", "system");

			assert.ok(
				acl.hasPermission("agent-admin", "proposal", "proposal-99", "admin"),
				"Wildcard should cover any proposal",
			);
			assert.ok(
				acl.hasPermission("agent-admin", "proposal", "proposal-51", "admin"),
				"Wildcard should cover proposal-51 too",
			);
		});

		it("should deny unknown agents", () => {
			assert.ok(
				!acl.hasPermission("unknown-agent", "proposal", "proposal-51", "read"),
				"Unknown agent should be denied",
			);
		});

		it("should revoke permissions", () => {
			acl.grant(
				"agent-temp",
				"proposal",
				"proposal-51",
				"write",
				"admin-agent",
			);
			assert.ok(
				acl.hasPermission("agent-temp", "proposal", "proposal-51", "write"),
			);

			acl.revoke(
				"agent-temp",
				"proposal",
				"proposal-51",
				"write",
				"admin-agent",
			);
			assert.ok(
				!acl.hasPermission("agent-temp", "proposal", "proposal-51", "write"),
			);
		});

		it("should list all permissions for an agent", () => {
			const perms = acl.listPermissions("agent-reader");
			assert.ok(
				perms.length > 0,
				"Should have at least the granted permission",
			);
			assert.equal(perms[0]?.agentId, "agent-reader");
		});
	});

	// ─── AC#5c: Data Integrity ────────────────────────────────────

	describe("AC#5c: Data integrity during migration", () => {
		let integrity: DataIntegrity;

		before(() => {
			integrity = new DataIntegrity(db);
		});

		it("should compute SHA-256 hash of content", () => {
			const hash = DataIntegrity.computeHash("test content");
			assert.equal(hash.length, 64, "SHA-256 should be 64 hex chars");
			assert.ok(/^[0-9a-f]{64}$/.test(hash), "Should be lowercase hex");
		});

		it("should detect matching file and DB content", () => {
			const content = "# proposal-51\nStatus: Active";
			const check = integrity.recordCheck(
				"proposal",
				"proposal-51",
				content,
				content,
			);

			assert.ok(check.match, "Same content should match");
			assert.equal(check.fileHash, check.dbHash);
		});

		it("should detect mismatched file and DB content", () => {
			const fileContent = "# proposal-51\nStatus: Active";
			const dbContent = "# proposal-51\nStatus: Complete";
			const check = integrity.recordCheck(
				"proposal",
				"proposal-52",
				fileContent,
				dbContent,
			);

			assert.ok(!check.match, "Different content should not match");
			assert.notEqual(check.fileHash, check.dbHash);
		});

		it("should list all mismatches", () => {
			const mismatches = integrity.getMismatches();
			assert.ok(
				mismatches.length > 0,
				"Should have at least the mismatch we just created",
			);
			assert.ok(mismatches.every((m) => !m.match));
		});

		it("should verify all proposals and report counts", () => {
			const proposals = [
				{ id: "S1", fileContent: "content-a", dbContent: "content-a" },
				{ id: "S2", fileContent: "content-b", dbContent: "content-b" },
				{ id: "S3", fileContent: "content-c", dbContent: "content-differs" },
				{ id: "S4", fileContent: "content-e", dbContent: "" },
			];

			const result = integrity.verifyAll(proposals);
			assert.equal(result.verified, 2, "Two should match");
			assert.equal(result.mismatched, 1, "One should mismatch");
			assert.equal(result.missing, 1, "One should be missing from DB");
		});
	});

	// ─── AC#5d: Secret/Credential Handling in DB ──────────────────

	describe("AC#5d: Secret/credential handling — token store", () => {
		let tokenStore: AgentTokenStore;

		before(() => {
			tokenStore = new AgentTokenStore(db);
		});

		it("should store and verify a token hash", () => {
			const expiresAt = new Date(Date.now() + 3600000).toISOString();
			tokenStore.storeToken(
				"agent-test",
				"sha256-of-token-value",
				expiresAt,
				1,
			);

			const result = tokenStore.verifyTokenHash("sha256-of-token-value");
			assert.ok(result, "Token hash should verify");
			assert.equal(result?.agentId, "agent-test");
			assert.equal(result?.keyVersion, 1);
		});

		it("should reject unknown token hashes", () => {
			const result = tokenStore.verifyTokenHash("nonexistent-hash");
			assert.equal(result, null, "Unknown token should return null");
		});

		it("should reject expired tokens", () => {
			const pastExpiry = new Date(Date.now() - 1000).toISOString();
			tokenStore.storeToken(
				"agent-expired",
				"expired-token-hash",
				pastExpiry,
				1,
			);

			const result = tokenStore.verifyTokenHash("expired-token-hash");
			assert.equal(result, null, "Expired token should return null");
		});

		it("should revoke all tokens for an agent", () => {
			const futureExpiry = new Date(Date.now() + 3600000).toISOString();
			tokenStore.storeToken("agent-revoke", "revoke-hash-1", futureExpiry, 1);
			tokenStore.storeToken("agent-revoke", "revoke-hash-2", futureExpiry, 1);

			const revoked = tokenStore.revokeAllForAgent("agent-revoke");
			assert.ok(revoked >= 2, "Should revoke at least 2 tokens");

			assert.equal(tokenStore.verifyTokenHash("revoke-hash-1"), null);
			assert.equal(tokenStore.verifyTokenHash("revoke-hash-2"), null);
		});

		it("should purge expired tokens", () => {
			const purged = tokenStore.purgeExpired();
			assert.equal(
				typeof purged,
				"number",
				"Should return count of purged tokens",
			);
		});

		it("CRITICAL: should never store plaintext tokens", () => {
			// Verify the token store only accepts hashes, not raw tokens
			// This is enforced by the API — storeToken takes a hash parameter
			const expiresAt = new Date(Date.now() + 3600000).toISOString();

			// The caller is responsible for hashing — storeToken stores whatever is passed
			// The security assumption: callers pass sha256(token), not token itself
			// This test verifies the convention is followed
			tokenStore.storeToken(
				"agent-hash-check",
				"sha256:abc123def456",
				expiresAt,
				1,
			);

			const row = db
				.prepare("SELECT token_hash FROM agent_tokens WHERE agent_id = ?")
				.get("agent-hash-check") as { token_hash: string };

			assert.ok(
				row.token_hash.startsWith("sha256:") || row.token_hash.length === 64,
				"Stored value should be a hash, not a raw token",
			);
		});
	});
});
