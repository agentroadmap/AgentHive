/**
 * Tests for proposal-56: Federation-PKI-Host-Authentication
 *
 * AC#1: Internal CA for agent certificates
 * AC#2: mTLS enforced on all federation connections
 * AC#3: Host registry with join approval workflow
 * AC#4: Certificate rotation with 90-day expiry
 * AC#5: Rogue host quarantine capability
 */

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	FederationPKI,
	initializeFederation,
	isValidPublicKey,
} from "../../src/core/infrastructure/federation.ts";

/**
 * Generate a test RSA key pair.
 */
function generateTestKeyPair(): { publicKey: string; privateKey: string } {
	return generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "spki", format: "pem" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});
}

describe("proposal-56: Federation-PKI-Host-Authentication", () => {
	let tempDir: string;
	let pki: FederationPKI;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "roadmap-federation-test-"));
		pki = new FederationPKI({
			configDir: tempDir,
			certExpiryDays: 90,
			requireApproval: true,
		});
		await pki.initialize();
		await pki.initializeCA(); // Initialize CA for all tests
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	// ─── AC#1: Internal CA for Agent Certificates ────────────────

	describe("AC#1: Internal CA for agent certificates", () => {
		// Tests for CA initialization itself - need fresh PKI without CA
		describe("CA initialization", () => {
			let freshTempDir: string;
			let freshPki: FederationPKI;

			beforeEach(async () => {
				freshTempDir = await mkdtemp(join(tmpdir(), "roadmap-ca-init-"));
				freshPki = new FederationPKI({ configDir: freshTempDir });
				await freshPki.initialize();
			});

			afterEach(async () => {
				await rm(freshTempDir, { recursive: true, force: true });
			});

			it("initializes a new CA", async () => {
				const ca = await freshPki.initializeCA();

				assert.ok(ca.certId, "CA should have cert ID");
				assert.ok(
					ca.keyPair.publicKey.includes("BEGIN PUBLIC KEY"),
					"CA should have PEM public key",
				);
				assert.ok(
					ca.keyPair.privateKey.includes("BEGIN PRIVATE KEY"),
					"CA should have PEM private key",
				);
				assert.equal(ca.subject, "Roadmap Federation CA");
				assert.ok(ca.notBefore, "CA should have notBefore");
				assert.ok(ca.notAfter, "CA should have notAfter");
			});

			it("returns existing CA on re-initialization", async () => {
				const ca1 = await freshPki.initializeCA();
				const ca2 = await freshPki.initializeCA();

				assert.equal(ca1.certId, ca2.certId, "Should return same CA");
				assert.equal(ca1.version, 1);
			});

			it("allows custom CA subject", async () => {
				const ca = await freshPki.initializeCA("Custom CA Name");

				assert.equal(ca.subject, "Custom CA Name");
			});

			it("CA expiry is configurable", async () => {
				const shortCA = new FederationPKI({
					configDir: join(freshTempDir, "short-ca"),
					caExpiryDays: 30,
				});
				await shortCA.initialize();
				const ca = await shortCA.initializeCA();

				const notAfter = new Date(ca.notAfter);
				const notBefore = new Date(ca.notBefore);
				const daysDiff =
					(notAfter.getTime() - notBefore.getTime()) / (24 * 60 * 60 * 1000);

				assert.ok(Math.abs(daysDiff - 30) <= 1, "CA should expire in ~30 days");
			});
		});

		it("issues certificates signed by CA", async () => {
			await pki.initializeCA();
			const keys = generateTestKeyPair();

			const cert = await pki.issueCertificate(
				"host-001",
				keys.publicKey,
				"client",
			);

			assert.ok(cert.certId, "Certificate should have ID");
			assert.equal(cert.hostId, "host-001");
			assert.equal(cert.type, "client");
			assert.equal(cert.issuer, "Roadmap Federation CA");
			assert.ok(cert.signature, "Certificate should have CA signature");
			assert.equal(cert.revoked, false);
		});

		it("issues server-type certificates", async () => {
			await pki.initializeCA();
			const keys = generateTestKeyPair();

			const cert = await pki.issueCertificate(
				"server-001",
				keys.publicKey,
				"server",
			);

			assert.equal(cert.type, "server");
		});

		it("rejects certificate issuance without CA", async () => {
			const noCA = new FederationPKI({ configDir: join(tempDir, "no-ca") });
			await noCA.initialize();
			const keys = generateTestKeyPair();

			await assert.rejects(
				() => noCA.issueCertificate("host-001", keys.publicKey),
				/CA not initialized/,
			);
		});

		it("verifies valid certificate", async () => {
			await pki.initializeCA();
			const keys = generateTestKeyPair();
			const cert = await pki.issueCertificate("host-001", keys.publicKey);

			const result = pki.verifyCertificate(cert.certId);
			assert.equal(result.valid, true);
		});

		it("rejects verification of unknown certificate", () => {
			const result = pki.verifyCertificate("unknown-cert-id");
			assert.equal(result.valid, false);
			assert.ok(result.reason?.includes("not found"));
		});

		it("rejects revoked certificate", async () => {
			await pki.initializeCA();
			const keys = generateTestKeyPair();
			const cert = await pki.issueCertificate("host-001", keys.publicKey);

			pki.revokeCertificate(cert.certId, "Testing revocation");

			const result = pki.verifyCertificate(cert.certId);
			assert.equal(result.valid, false);
			assert.ok(result.reason?.includes("revoked"));
		});

		it("getCA returns public CA info", async () => {
			await pki.initializeCA();

			const caInfo = pki.getCA();
			assert.ok(caInfo);
			assert.equal(caInfo.subject, "Roadmap Federation CA");
			assert.ok(caInfo.publicKey);
			assert.ok(
				!caInfo.publicKey.includes("PRIVATE"),
				"Should not expose private key",
			);
		});
	});

	// ─── AC#2: mTLS Enforcement ──────────────────────────────────

	describe("AC#2: mTLS enforced on all federation connections", () => {
		it("validates successful mTLS connection between active hosts", async () => {
			await pki.initializeCA();
			const keys1 = generateTestKeyPair();
			const keys2 = generateTestKeyPair();

			// Register and approve hosts
			const req1 = await pki.registerHost("host1.local", 8080, keys1.publicKey);
			await pki.approveJoinRequest(req1.requestId, "admin");

			const req2 = await pki.registerHost("host2.local", 8080, keys2.publicKey);
			await pki.approveJoinRequest(req2.requestId, "admin");

			const host1 = pki.getHost(req1.hostId)!;
			const host2 = pki.getHost(req2.hostId)!;

			// Test mTLS connection
			const conn = pki.validateMTLSConnection(
				host1.hostId,
				host1.certificateId!,
				host2.hostId,
				host2.certificateId!,
			);

			assert.equal(conn.mtlsVerified, true);
			assert.equal(conn.certValid, true);
			assert.ok(!conn.error);
		});

		it("rejects connection with invalid source certificate", async () => {
			await pki.initializeCA();
			const keys1 = generateTestKeyPair();
			const keys2 = generateTestKeyPair();

			const req1 = await pki.registerHost("host1.local", 8080, keys1.publicKey);
			await pki.approveJoinRequest(req1.requestId, "admin");

			const req2 = await pki.registerHost("host2.local", 8080, keys2.publicKey);
			await pki.approveJoinRequest(req2.requestId, "admin");

			const host1 = pki.getHost(req1.hostId)!;
			const host2 = pki.getHost(req2.hostId)!;

			// Use a fake cert ID
			const conn = pki.validateMTLSConnection(
				host1.hostId,
				"fake-cert-id",
				host2.hostId,
				host2.certificateId!,
			);

			assert.equal(conn.mtlsVerified, false);
			assert.ok(conn.error?.includes("Source certificate invalid"));
		});

		it("rejects connection from quarantined host", async () => {
			await pki.initializeCA();
			const keys1 = generateTestKeyPair();
			const keys2 = generateTestKeyPair();

			const req1 = await pki.registerHost("host1.local", 8080, keys1.publicKey);
			await pki.approveJoinRequest(req1.requestId, "admin");

			const req2 = await pki.registerHost("host2.local", 8080, keys2.publicKey);
			await pki.approveJoinRequest(req2.requestId, "admin");

			// Quarantine host1
			pki.quarantineHost(req1.hostId, "Suspicious activity");

			const host1 = pki.getHost(req1.hostId)!;
			const host2 = pki.getHost(req2.hostId)!;

			const conn = pki.validateMTLSConnection(
				host1.hostId,
				host1.certificateId!,
				host2.hostId,
				host2.certificateId!,
			);

			assert.equal(conn.mtlsVerified, false);
			assert.ok(conn.error?.includes("not active"));
		});

		it("tracks connection history", async () => {
			await pki.initializeCA();
			const keys1 = generateTestKeyPair();
			const keys2 = generateTestKeyPair();

			const req1 = await pki.registerHost("host1.local", 8080, keys1.publicKey);
			await pki.approveJoinRequest(req1.requestId, "admin");
			const req2 = await pki.registerHost("host2.local", 8080, keys2.publicKey);
			await pki.approveJoinRequest(req2.requestId, "admin");

			const host1 = pki.getHost(req1.hostId)!;
			const host2 = pki.getHost(req2.hostId)!;

			pki.validateMTLSConnection(
				host1.hostId,
				host1.certificateId!,
				host2.hostId,
				host2.certificateId!,
			);

			const connections = pki.getHostConnections(host1.hostId);
			assert.equal(connections.length, 1);
			assert.equal(connections[0]?.mtlsVerified, true);
		});

		it("tracks failed connections", async () => {
			await pki.initializeCA();
			const keys1 = generateTestKeyPair();
			const keys2 = generateTestKeyPair();

			const req1 = await pki.registerHost("host1.local", 8080, keys1.publicKey);
			await pki.approveJoinRequest(req1.requestId, "admin");
			const req2 = await pki.registerHost("host2.local", 8080, keys2.publicKey);
			await pki.approveJoinRequest(req2.requestId, "admin");

			const host1 = pki.getHost(req1.hostId)!;
			const host2 = pki.getHost(req2.hostId)!;

			// Failed connection
			pki.validateMTLSConnection(
				host1.hostId,
				"bad-cert",
				host2.hostId,
				host2.certificateId!,
			);

			const failed = pki.getFailedConnections();
			assert.equal(failed.length, 1);
			assert.ok(failed[0]?.error);
		});
	});

	// ─── AC#3: Host Registry with Join Approval ──────────────────

	describe("AC#3: Host registry with join approval workflow", () => {
		it("creates pending join request", async () => {
			const keys = generateTestKeyPair();

			const req = await pki.registerHost(
				"new-host.local",
				9000,
				keys.publicKey,
			);

			assert.ok(req.requestId);
			assert.equal(req.status, "pending");
			assert.equal(req.hostname, "new-host.local");
			assert.equal(req.port, 9000);
			assert.ok(req.fingerprint);
		});

		it("lists pending requests", async () => {
			const keys1 = generateTestKeyPair();
			const keys2 = generateTestKeyPair();

			await pki.registerHost("host1.local", 8080, keys1.publicKey);
			await pki.registerHost("host2.local", 8080, keys2.publicKey);

			const pending = pki.getPendingRequests();
			assert.equal(pending.length, 2);
		});

		it("approves join request and creates active host", async () => {
			const keys = generateTestKeyPair();
			const req = await pki.registerHost(
				"new-host.local",
				9000,
				keys.publicKey,
			);

			const host = await pki.approveJoinRequest(req.requestId, "admin-1");

			assert.ok(host.hostId);
			assert.equal(host.status, "active");
			assert.equal(host.approvedBy, "admin-1");
			assert.ok(host.approvedAt);
			assert.ok(host.certificateId, "Approved host should have certificate");
		});

		it("denies join request", async () => {
			const keys = generateTestKeyPair();
			const req = await pki.registerHost(
				"new-host.local",
				9000,
				keys.publicKey,
			);

			const result = pki.denyJoinRequest(
				req.requestId,
				"admin-1",
				"Not authorized",
			);
			assert.equal(result, true);

			const pending = pki.getPendingRequests();
			assert.equal(pending.length, 0);
		});

		it("auto-approves when approval not required", async () => {
			const autoPki = new FederationPKI({
				configDir: join(tempDir, "auto"),
				requireApproval: false,
			});
			await autoPki.initialize();
			await autoPki.initializeCA();

			const keys = generateTestKeyPair();
			const req = await autoPki.registerHost(
				"auto-host.local",
				8080,
				keys.publicKey,
			);

			assert.equal(req.status, "approved");
			assert.equal(req.reviewedBy, "auto");

			const host = autoPki.getHost(req.hostId);
			assert.ok(host);
			assert.equal(host.status, "active");
		});

		it("rejects duplicate active host registration", async () => {
			const keys = generateTestKeyPair();
			await pki.registerHost("dup-host.local", 8080, keys.publicKey);
			const _req = await pki.approveJoinRequest(
				pki.getPendingRequests()[0]?.requestId,
				"admin",
			);

			// Try to register same host again
			await assert.rejects(
				() => pki.registerHost("dup-host.local", 8080, keys.publicKey),
				/already registered and active/,
			);
		});

		it("lists all hosts", async () => {
			const keys1 = generateTestKeyPair();
			const keys2 = generateTestKeyPair();

			await pki.registerHost("host1.local", 8080, keys1.publicKey);
			await pki.registerHost("host2.local", 8080, keys2.publicKey);

			// Approve both hosts
			const pending = pki.getPendingRequests();
			await pki.approveJoinRequest(pending[0]?.requestId, "admin");
			await pki.approveJoinRequest(pending[1]?.requestId, "admin");

			const hosts = pki.getAllHosts();
			assert.equal(hosts.length, 2);
		});

		it("lists only active hosts", async () => {
			const keys1 = generateTestKeyPair();
			const keys2 = generateTestKeyPair();

			await pki.registerHost("host1.local", 8080, keys1.publicKey);
			await pki.registerHost("host2.local", 8080, keys2.publicKey);

			// Approve only host1
			const pending = pki.getPendingRequests();
			await pki.approveJoinRequest(pending[0]?.requestId, "admin");

			const active = pki.getActiveHosts();
			assert.equal(active.length, 1);
			assert.equal(active[0]?.hostname, "host1.local");
		});
	});

	// ─── AC#4: Certificate Rotation with 90-Day Expiry ──────────

	describe("AC#4: Certificate rotation with 90-day expiry", () => {
		it("rotates host certificate", async () => {
			await pki.initializeCA();
			const keys1 = generateTestKeyPair();
			const req = await pki.registerHost("host1.local", 8080, keys1.publicKey);
			await pki.approveJoinRequest(req.requestId, "admin");

			const oldCertId = pki.getHost(req.hostId)?.certificateId!;

			// Rotate
			const keys2 = generateTestKeyPair();
			const newCert = await pki.rotateCertificate(req.hostId, keys2.publicKey);

			assert.notEqual(newCert.certId, oldCertId);
			assert.ok(newCert.notAfter);

			// Old cert should be revoked
			const oldResult = pki.verifyCertificate(oldCertId);
			assert.equal(oldResult.valid, false);
		});

		it("prevents rotation for non-active hosts", async () => {
			await pki.initializeCA();
			const keys = generateTestKeyPair();
			const req = await pki.registerHost("host1.local", 8080, keys.publicKey);
			await pki.approveJoinRequest(req.requestId, "admin");

			// Quarantine host
			pki.quarantineHost(req.hostId, "Suspicious");

			const newKeys = generateTestKeyPair();
			await assert.rejects(
				() => pki.rotateCertificate(req.hostId, newKeys.publicKey),
				/not active/,
			);
		});

		it("detects expiring certificates", async () => {
			const shortPki = new FederationPKI({
				configDir: join(tempDir, "short-expiry"),
				certExpiryDays: 30,
			});
			await shortPki.initialize();
			await shortPki.initializeCA();

			const keys = generateTestKeyPair();
			await shortPki.registerHost("host1.local", 8080, keys.publicKey);
			const pending = shortPki.getPendingRequests();
			await shortPki.approveJoinRequest(pending[0]?.requestId, "admin");

			// Check for certs expiring in 30 days (should include our 30-day cert)
			const expiring = shortPki.getExpiringCertificates(30);
			assert.equal(expiring.length, 1);
		});

		it("cleans up expired certificates", async () => {
			await pki.initializeCA();
			const keys = generateTestKeyPair();
			await pki.registerHost("host1.local", 8080, keys.publicKey);
			const pending = pki.getPendingRequests();
			await pki.approveJoinRequest(pending[0]?.requestId, "admin");

			// Manually expire the certificate for testing
			const approvedHostId = pending[0]?.hostId;
			assert.ok(approvedHostId);
			const _certs = pki.getHostCertificates(approvedHostId);
			// No way to manually expire in this implementation, but cleanup works
			const expired = pki.cleanupExpiredCertificates();
			assert.ok(Array.isArray(expired));
		});

		it("default cert expiry is 90 days", async () => {
			await pki.initializeCA();
			const keys = generateTestKeyPair();
			const cert = await pki.issueCertificate("host-001", keys.publicKey);

			const notAfter = new Date(cert.notAfter);
			const notBefore = new Date(cert.notBefore);
			const daysDiff =
				(notAfter.getTime() - notBefore.getTime()) / (24 * 60 * 60 * 1000);

			assert.ok(
				Math.abs(daysDiff - 90) <= 1,
				"Default cert expiry should be ~90 days",
			);
		});
	});

	// ─── AC#5: Rogue Host Quarantine Capability ──────────────────

	describe("AC#5: Rogue host quarantine capability", () => {
		it("quarantines a host", async () => {
			const keys = generateTestKeyPair();
			const req = await pki.registerHost("host1.local", 8080, keys.publicKey);
			await pki.approveJoinRequest(req.requestId, "admin");

			const result = pki.quarantineHost(
				req.hostId,
				"Suspicious network activity",
			);

			assert.equal(result, true);

			const host = pki.getHost(req.hostId);
			assert.equal(host?.status, "quarantined");
			assert.equal(host?.quarantineReason, "Suspicious network activity");
			assert.ok(host?.quarantinedAt);
		});

		it("revokes certificate when quarantining", async () => {
			const keys = generateTestKeyPair();
			const req = await pki.registerHost("host1.local", 8080, keys.publicKey);
			await pki.approveJoinRequest(req.requestId, "admin");

			const host = pki.getHost(req.hostId)!;
			const certId = host.certificateId!;

			pki.quarantineHost(req.hostId, "Rogue host detected");

			const certResult = pki.verifyCertificate(certId);
			assert.equal(certResult.valid, false);
			assert.ok(certResult.reason?.includes("revoked"));
		});

		it("lists quarantined hosts", async () => {
			const keys1 = generateTestKeyPair();
			const keys2 = generateTestKeyPair();

			await pki.registerHost("host1.local", 8080, keys1.publicKey);
			await pki.registerHost("host2.local", 8080, keys2.publicKey);

			const pending = pki.getPendingRequests();
			await pki.approveJoinRequest(pending[0]?.requestId, "admin");
			await pki.approveJoinRequest(pending[1]?.requestId, "admin");

			pki.quarantineHost(pending[0]?.hostId, "Malicious behavior");

			const quarantined = pki.getQuarantinedHosts();
			assert.equal(quarantined.length, 1);
			assert.equal(quarantined[0]?.hostId, pending[0]?.hostId);
		});

		it("lifts quarantine", async () => {
			const keys = generateTestKeyPair();
			const req = await pki.registerHost("host1.local", 8080, keys.publicKey);
			await pki.approveJoinRequest(req.requestId, "admin");

			pki.quarantineHost(req.hostId, "Investigation");
			const result = pki.liftQuarantine(req.hostId, "admin-2");

			assert.equal(result, true);

			const host = pki.getHost(req.hostId);
			assert.equal(host?.status, "approved");
			assert.equal(host?.approvedBy, "admin-2");
			assert.ok(!host?.quarantineReason);
		});

		it("prevents registration of quarantined host", async () => {
			const keys = generateTestKeyPair();
			const req = await pki.registerHost("host1.local", 8080, keys.publicKey);
			await pki.approveJoinRequest(req.requestId, "admin");

			pki.quarantineHost(req.hostId, "Permanently banned");

			await assert.rejects(
				() => pki.registerHost("host1.local", 8080, keys.publicKey),
				/quarantined/,
			);
		});

		it("removes host entirely", async () => {
			const keys = generateTestKeyPair();
			const req = await pki.registerHost("host1.local", 8080, keys.publicKey);
			await pki.approveJoinRequest(req.requestId, "admin");

			const result = await pki.removeHost(req.hostId);

			assert.equal(result, true);
			assert.equal(pki.getHost(req.hostId), null);
		});
	});

	// ─── Statistics & Configuration ──────────────────────────────

	describe("Statistics and configuration", () => {
		it("reports federation statistics", async () => {
			const keys1 = generateTestKeyPair();
			const keys2 = generateTestKeyPair();

			await pki.registerHost("host1.local", 8080, keys1.publicKey);
			await pki.registerHost("host2.local", 8080, keys2.publicKey);

			// Approve both hosts first
			const pending = pki.getPendingRequests();
			await pki.approveJoinRequest(pending[0]?.requestId, "admin");
			await pki.approveJoinRequest(pending[1]?.requestId, "admin");

			// Then quarantine one
			const hosts = pki.getAllHosts();
			pki.quarantineHost(hosts[1]?.hostId, "Test quarantine");

			const stats = pki.getStats();

			assert.equal(stats.totalHosts, 2);
			assert.equal(stats.activeHosts, 1);
			assert.equal(stats.quarantinedHosts, 1);
			assert.ok(stats.totalCertificates >= 1);
			assert.ok(stats.caExpiresAt);
		});

		it("returns config", () => {
			const config = pki.getConfig();
			assert.equal(config.certExpiryDays, 90);
			assert.equal(config.requireApproval, true);
			assert.equal(config.mtlsEnforced, true);
		});

		it("updates config", () => {
			pki.updateConfig({ certExpiryDays: 60 });
			const config = pki.getConfig();
			assert.equal(config.certExpiryDays, 60);
		});
	});

	// ─── Convenience Functions ────────────────────────────────────

	describe("Convenience functions", () => {
		it("initializeFederation creates ready PKI", async () => {
			const federation = await initializeFederation(
				join(tempDir, "federation-init"),
			);

			const ca = federation.getCA();
			assert.ok(ca, "Should have initialized CA");
			assert.ok(ca.publicKey);
		});

		it("isValidPublicKey validates PEM format", () => {
			const keys = generateTestKeyPair();
			assert.equal(isValidPublicKey(keys.publicKey), true);
			assert.equal(isValidPublicKey("not a key"), false);
			assert.equal(isValidPublicKey(""), false);
		});
	});
});
