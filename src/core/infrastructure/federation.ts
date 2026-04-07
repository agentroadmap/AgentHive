/**
 * Federation PKI & Host Authentication (STATE-56)
 *
 * Certificate authority, mutual TLS, and host registry for secure
 * multi-host federation (STATE-46 prerequisite).
 *
 * AC#1: Internal CA for agent certificates
 * AC#2: mTLS enforced on all federation connections
 * AC#3: Host registry with join approval workflow
 * AC#4: Certificate rotation with 90-day expiry
 * AC#5: Rogue host quarantine capability
 */

import {
	createHash,
	createSign,
	createVerify,
	generateKeyPairSync,
	randomBytes,
	randomUUID,
} from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ─── Types ───────────────────────────────────────────────────────────

export type HostStatus =
	| "pending"
	| "approved"
	| "active"
	| "quarantined"
	| "revoked";

export type CertificateType = "ca" | "server" | "client";

export interface Certificate {
	certId: string;
	type: CertificateType;
	hostId: string;
	publicKey: string; // PEM
	// In production, would contain full X.509 fields
	serialNumber: string;
	issuer: string; // CA subject
	subject: string; // Host identity
	notBefore: string; // ISO date
	notAfter: string; // ISO date
	signature: string; // CA signature over cert data
	revoked: boolean;
	createdAt: string;
}

export interface CACertificate {
	certId: string;
	keyPair: {
		publicKey: string;
		privateKey: string; // Stored securely
	};
	subject: string;
	serialNumber: string;
	notBefore: string;
	notAfter: string;
	version: number;
}

export interface Host {
	hostId: string;
	hostname: string;
	port: number;
	status: HostStatus;
	certificateId?: string;
	joinedAt: string;
	approvedBy?: string;
	approvedAt?: string;
	lastConnection?: string;
	fingerprint: string; // SHA-256 of public key
	quarantineReason?: string;
	quarantinedAt?: string;
}

export interface JoinRequest {
	requestId: string;
	hostId: string;
	hostname: string;
	port: number;
	fingerprint: string;
	publicKey: string;
	requestedAt: string;
	status: "pending" | "approved" | "denied";
	reviewedBy?: string;
	reviewedAt?: string;
	reason?: string;
}

export interface FederationConfig {
	configDir: string;
	certExpiryDays: number; // Default 90
	caExpiryDays: number; // Default 365
	requireApproval: boolean;
	autoRevokeExpired: boolean;
	mtlsEnforced: boolean;
}

export interface TLSConnection {
	connectionId: string;
	sourceHostId: string;
	targetHostId: string;
	timestamp: string;
	mtlsVerified: boolean;
	certValid: boolean;
	certId: string;
	error?: string;
}

// ─── Constants ───────────────────────────────────────────────────────

const DEFAULT_CONFIG: FederationConfig = {
	configDir: ".roadmap/federation",
	certExpiryDays: 90,
	caExpiryDays: 365,
	requireApproval: true,
	autoRevokeExpired: true,
	mtlsEnforced: true,
};

const CA_FILE = "ca.json";
const HOSTS_FILE = "hosts.json";
const CERTS_DIR = "certs";
const JOIN_REQUESTS_FILE = "join-requests.json";
const CONNECTIONS_FILE = "connections.json";

const _YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// ─── Federation PKI Implementation ──────────────────────────────────

export class FederationPKI {
	private config: FederationConfig;
	private ca: CACertificate | null = null;
	private hosts: Map<string, Host> = new Map();
	private certificates: Map<string, Certificate> = new Map();
	private joinRequests: JoinRequest[] = [];
	private connections: TLSConnection[] = [];

	constructor(config?: Partial<FederationConfig>) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Initialize the federation PKI system.
	 */
	async initialize(): Promise<void> {
		await mkdir(this.config.configDir, { recursive: true });
		await mkdir(join(this.config.configDir, CERTS_DIR), { recursive: true });
		await this.loadCA();
		await this.loadHosts();
		await this.loadCertificates();
		await this.loadJoinRequests();
		await this.loadConnections();
	}

	// ─── AC#1: Internal CA for Agent Certificates ──────────────────

	/**
	 * Initialize the internal Certificate Authority.
	 * Creates a new CA key pair if one doesn't exist.
	 */
	async initializeCA(
		subject: string = "Roadmap Federation CA",
	): Promise<CACertificate> {
		const caPath = join(this.config.configDir, CA_FILE);

		// Check if CA already exists
		if (existsSync(caPath)) {
			await this.loadCA();
			return this.ca!;
		}

		const now = new Date();
		const notAfter = new Date(
			now.getTime() + this.config.caExpiryDays * 24 * 60 * 60 * 1000,
		);

		// Generate CA key pair (RSA 2048 for compatibility)
		const { publicKey, privateKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
			publicKeyEncoding: { type: "spki", format: "pem" },
			privateKeyEncoding: { type: "pkcs8", format: "pem" },
		});

		const ca: CACertificate = {
			certId: randomUUID(),
			keyPair: { publicKey, privateKey },
			subject,
			serialNumber: this.generateSerial(),
			notBefore: now.toISOString(),
			notAfter: notAfter.toISOString(),
			version: 1,
		};

		this.ca = ca;
		await this.saveCA();
		return ca;
	}

	/**
	 * Get the CA certificate (public info only).
	 */
	getCA(): {
		certId: string;
		subject: string;
		publicKey: string;
		notAfter: string;
	} | null {
		if (!this.ca) return null;
		return {
			certId: this.ca.certId,
			subject: this.ca.subject,
			publicKey: this.ca.keyPair.publicKey,
			notAfter: this.ca.notAfter,
		};
	}

	/**
	 * Issue a certificate for a host.
	 */
	async issueCertificate(
		hostId: string,
		publicKey: string,
		type: CertificateType = "client",
	): Promise<Certificate> {
		if (!this.ca) {
			throw new Error("CA not initialized. Call initializeCA first.");
		}

		// Check if CA is expired
		if (new Date() > new Date(this.ca.notAfter)) {
			throw new Error("CA certificate has expired");
		}

		const now = new Date();
		const notAfter = new Date(
			now.getTime() + this.config.certExpiryDays * 24 * 60 * 60 * 1000,
		);

		const certData = {
			type,
			hostId,
			serialNumber: this.generateSerial(),
			issuer: this.ca.subject,
			subject: `host:${hostId}`,
			notBefore: now.toISOString(),
			notAfter: notAfter.toISOString(),
		};

		// Sign the certificate data with CA private key
		const sign = createSign("SHA256");
		sign.update(JSON.stringify(certData));
		const signature = sign.sign(this.ca.keyPair.privateKey, "base64");

		const cert: Certificate = {
			certId: randomUUID(),
			...certData,
			publicKey,
			signature,
			revoked: false,
			createdAt: now.toISOString(),
		};

		this.certificates.set(cert.certId, cert);

		// Update host with certificate
		const host = this.hosts.get(hostId);
		if (host) {
			host.certificateId = cert.certId;
			host.fingerprint = this.computeFingerprint(publicKey);
		}

		await this.saveCertificates();
		await this.saveHosts();

		return cert;
	}

	/**
	 * Verify a certificate signature.
	 */
	verifyCertificate(certId: string): { valid: boolean; reason?: string } {
		const cert = this.certificates.get(certId);
		if (!cert) {
			return { valid: false, reason: "Certificate not found" };
		}

		if (cert.revoked) {
			return { valid: false, reason: "Certificate has been revoked" };
		}

		if (new Date() > new Date(cert.notAfter)) {
			return { valid: false, reason: "Certificate has expired" };
		}

		if (new Date() < new Date(cert.notBefore)) {
			return { valid: false, reason: "Certificate not yet valid" };
		}

		// Verify signature
		if (!this.ca) {
			return { valid: false, reason: "CA not available" };
		}

		const certData = {
			type: cert.type,
			hostId: cert.hostId,
			serialNumber: cert.serialNumber,
			issuer: cert.issuer,
			subject: cert.subject,
			notBefore: cert.notBefore,
			notAfter: cert.notAfter,
		};

		try {
			const verify = createVerify("SHA256");
			verify.update(JSON.stringify(certData));
			const isValid = verify.verify(
				this.ca.keyPair.publicKey,
				cert.signature,
				"base64",
			);

			return isValid
				? { valid: true }
				: { valid: false, reason: "Signature verification failed" };
		} catch {
			return { valid: false, reason: "Signature verification error" };
		}
	}

	/**
	 * Revoke a certificate.
	 */
	revokeCertificate(certId: string, reason?: string): boolean {
		const cert = this.certificates.get(certId);
		if (!cert) return false;

		cert.revoked = true;

		// Also quarantine the host
		const host = this.hosts.get(cert.hostId);
		if (host && host.status !== "quarantined") {
			host.status = "revoked";
			host.quarantineReason = reason ?? "Certificate revoked";
		}

		return true;
	}

	// ─── AC#2: mTLS Enforcement ────────────────────────────────────

	/**
	 * Validate an mTLS connection attempt.
	 * Both client and server certificates must be valid.
	 */
	validateMTLSConnection(
		sourceHostId: string,
		sourceCertId: string,
		targetHostId: string,
		targetCertId: string,
	): TLSConnection {
		const connectionId = randomUUID();
		const timestamp = new Date().toISOString();

		// Verify source certificate
		const sourceCert = this.certificates.get(sourceCertId);
		const sourceValid = this.verifyCertificate(sourceCertId);

		// Verify target certificate
		const targetCert = this.certificates.get(targetCertId);
		const targetValid = this.verifyCertificate(targetCertId);

		// Check both hosts are approved/active
		const sourceHost = this.hosts.get(sourceHostId);
		const targetHost = this.hosts.get(targetHostId);

		let mtlsVerified = false;
		let certValid = false;
		let error: string | undefined;

		if (!sourceHost || sourceHost.status !== "active") {
			error = `Source host ${sourceHostId} is not active`;
		} else if (!targetHost || targetHost.status !== "active") {
			error = `Target host ${targetHostId} is not active`;
		} else if (!sourceValid.valid) {
			error = `Source certificate invalid: ${sourceValid.reason}`;
		} else if (!targetValid.valid) {
			error = `Target certificate invalid: ${targetValid.reason}`;
		} else if (sourceCert?.type !== "client" && sourceCert?.type !== "server") {
			error = "Source certificate must be client or server type";
		} else if (targetCert?.type !== "client" && targetCert?.type !== "server") {
			error = "Target certificate must be client or server type";
		} else {
			mtlsVerified = true;
			certValid = true;
		}

		const connection: TLSConnection = {
			connectionId,
			sourceHostId,
			targetHostId,
			timestamp,
			mtlsVerified,
			certValid,
			certId: sourceCertId,
			error,
		};

		this.connections.push(connection);

		// Update last connection time
		if (mtlsVerified && sourceHost) {
			sourceHost.lastConnection = timestamp;
		}

		return connection;
	}

	/**
	 * Get recent connections for a host.
	 */
	getHostConnections(hostId: string, limit: number = 10): TLSConnection[] {
		return this.connections
			.filter((c) => c.sourceHostId === hostId || c.targetHostId === hostId)
			.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
			.slice(0, limit);
	}

	/**
	 * Get failed connections (for monitoring).
	 */
	getFailedConnections(limit: number = 50): TLSConnection[] {
		return this.connections
			.filter((c) => !c.mtlsVerified)
			.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
			.slice(0, limit);
	}

	// ─── AC#3: Host Registry with Join Approval ────────────────────

	/**
	 * Register a new host (creates pending join request).
	 */
	async registerHost(
		hostname: string,
		port: number,
		publicKey: string,
	): Promise<JoinRequest> {
		const hostId = this.generateHostId(hostname, port);
		const fingerprint = this.computeFingerprint(publicKey);

		// Check if host already exists
		const existing = this.hosts.get(hostId);
		if (existing && existing.status === "active") {
			throw new Error(`Host ${hostId} is already registered and active`);
		}

		if (existing && existing.status === "quarantined") {
			throw new Error(
				`Host ${hostId} is quarantined. Admin must lift quarantine first.`,
			);
		}

		const joinRequest: JoinRequest = {
			requestId: randomUUID(),
			hostId,
			hostname,
			port,
			fingerprint,
			publicKey,
			requestedAt: new Date().toISOString(),
			status: "pending", // Always start as pending, approveJoinRequest changes it
		};

		// Add to requests list first (needed for approveJoinRequest to find it)
		this.joinRequests.push(joinRequest);

		// If approval not required, auto-approve
		if (!this.config.requireApproval) {
			await this.approveJoinRequest(joinRequest.requestId, "auto");
		}

		await this.saveJoinRequests();

		return joinRequest;
	}

	/**
	 * Approve a join request.
	 */
	async approveJoinRequest(
		requestId: string,
		reviewerId: string,
	): Promise<Host> {
		const request = this.joinRequests.find((r) => r.requestId === requestId);
		if (!request) {
			throw new Error(`Join request ${requestId} not found`);
		}

		if (request.status !== "pending") {
			throw new Error(`Join request ${requestId} is not pending`);
		}

		request.status = "approved";
		request.reviewedBy = reviewerId;
		request.reviewedAt = new Date().toISOString();

		// Create the host
		const host: Host = {
			hostId: request.hostId,
			hostname: request.hostname,
			port: request.port,
			status: "approved",
			joinedAt: new Date().toISOString(),
			approvedBy: reviewerId,
			approvedAt: new Date().toISOString(),
			fingerprint: request.fingerprint,
		};

		// Issue certificate
		const cert = await this.issueCertificate(
			request.hostId,
			request.publicKey,
			"client",
		);
		host.certificateId = cert.certId;
		host.status = "active";

		this.hosts.set(host.hostId, host);
		await this.saveHosts();
		await this.saveJoinRequests();

		return host;
	}

	/**
	 * Deny a join request.
	 */
	denyJoinRequest(
		requestId: string,
		reviewerId: string,
		reason: string,
	): boolean {
		const request = this.joinRequests.find((r) => r.requestId === requestId);
		if (!request || request.status !== "pending") {
			return false;
		}

		request.status = "denied";
		request.reviewedBy = reviewerId;
		request.reviewedAt = new Date().toISOString();
		request.reason = reason;

		return true;
	}

	/**
	 * Get pending join requests.
	 */
	getPendingRequests(): JoinRequest[] {
		return this.joinRequests.filter((r) => r.status === "pending");
	}

	/**
	 * Get all join requests.
	 */
	getAllJoinRequests(): JoinRequest[] {
		return [...this.joinRequests];
	}

	/**
	 * Get a host by ID.
	 */
	getHost(hostId: string): Host | null {
		return this.hosts.get(hostId) ?? null;
	}

	/**
	 * Get all registered hosts.
	 */
	getAllHosts(): Host[] {
		return Array.from(this.hosts.values());
	}

	/**
	 * Get active hosts only.
	 */
	getActiveHosts(): Host[] {
		return Array.from(this.hosts.values()).filter((h) => h.status === "active");
	}

	// ─── AC#4: Certificate Rotation with 90-Day Expiry ────────────

	/**
	 * Rotate a host's certificate.
	 * Old certificate is revoked, new one is issued.
	 */
	async rotateCertificate(
		hostId: string,
		newPublicKey: string,
	): Promise<Certificate> {
		const host = this.hosts.get(hostId);
		if (!host) {
			throw new Error(`Host ${hostId} not found`);
		}

		if (host.status !== "active") {
			throw new Error(`Host ${hostId} is not active (status: ${host.status})`);
		}

		// Revoke old certificate
		if (host.certificateId) {
			this.revokeCertificate(host.certificateId, "Certificate rotation");
		}

		// Issue new certificate
		const newCert = await this.issueCertificate(hostId, newPublicKey, "client");
		host.certificateId = newCert.certId;

		await this.saveHosts();
		return newCert;
	}

	/**
	 * Check for certificates nearing expiry.
	 * Returns certificates expiring within the given number of days.
	 */
	getExpiringCertificates(daysThreshold: number = 14): Certificate[] {
		const threshold = new Date();
		threshold.setDate(threshold.getDate() + daysThreshold);

		return Array.from(this.certificates.values()).filter(
			(cert) =>
				!cert.revoked &&
				new Date(cert.notAfter) <= threshold &&
				new Date(cert.notAfter) > new Date(),
		);
	}

	/**
	 * Check for expired certificates and optionally revoke them.
	 */
	cleanupExpiredCertificates(): Certificate[] {
		const now = new Date();
		const expired: Certificate[] = [];

		for (const cert of this.certificates.values()) {
			if (!cert.revoked && new Date(cert.notAfter) < now) {
				cert.revoked = true;
				expired.push(cert);

				// Also mark host as inactive
				const host = this.hosts.get(cert.hostId);
				if (host && host.status === "active") {
					host.status = "revoked";
					host.quarantineReason = "Certificate expired";
				}
			}
		}

		return expired;
	}

	/**
	 * Get certificate info.
	 */
	getCertificate(certId: string): Certificate | null {
		return this.certificates.get(certId) ?? null;
	}

	/**
	 * Get certificates for a host.
	 */
	getHostCertificates(hostId: string): Certificate[] {
		return Array.from(this.certificates.values()).filter(
			(c) => c.hostId === hostId,
		);
	}

	// ─── AC#5: Rogue Host Quarantine ───────────────────────────────

	/**
	 * Quarantine a host. Blocks all connections and marks for investigation.
	 */
	quarantineHost(hostId: string, reason: string): boolean {
		const host = this.hosts.get(hostId);
		if (!host) return false;

		host.status = "quarantined";
		host.quarantineReason = reason;
		host.quarantinedAt = new Date().toISOString();

		// Revoke certificate
		if (host.certificateId) {
			this.revokeCertificate(host.certificateId, `Host quarantined: ${reason}`);
		}

		return true;
	}

	/**
	 * Lift quarantine and restore host to approved status.
	 */
	liftQuarantine(hostId: string, reviewerId: string): boolean {
		const host = this.hosts.get(hostId);
		if (!host || host.status !== "quarantined") return false;

		host.status = "approved";
		host.quarantineReason = undefined;
		host.quarantinedAt = undefined;
		host.approvedBy = reviewerId;
		host.approvedAt = new Date().toISOString();

		return true;
	}

	/**
	 * Get quarantined hosts.
	 */
	getQuarantinedHosts(): Host[] {
		return Array.from(this.hosts.values()).filter(
			(h) => h.status === "quarantined",
		);
	}

	/**
	 * Remove a host entirely ( revoke + delete).
	 */
	async removeHost(hostId: string): Promise<boolean> {
		const host = this.hosts.get(hostId);
		if (!host) return false;

		// Revoke certificate
		if (host.certificateId) {
			this.revokeCertificate(host.certificateId, "Host removed");
		}

		this.hosts.delete(hostId);
		await this.saveHosts();

		return true;
	}

	// ─── Statistics ────────────────────────────────────────────────

	/**
	 * Get federation statistics.
	 */
	getStats(): {
		totalHosts: number;
		activeHosts: number;
		quarantinedHosts: number;
		revokedHosts: number;
		totalCertificates: number;
		revokedCertificates: number;
		expiringCertificates: number;
		pendingJoinRequests: number;
		totalConnections: number;
		failedConnections: number;
		caExpiresAt: string | null;
	} {
		const hosts = Array.from(this.hosts.values());
		const certs = Array.from(this.certificates.values());
		const expiring = this.getExpiringCertificates(14);

		return {
			totalHosts: hosts.length,
			activeHosts: hosts.filter((h) => h.status === "active").length,
			quarantinedHosts: hosts.filter((h) => h.status === "quarantined").length,
			revokedHosts: hosts.filter((h) => h.status === "revoked").length,
			totalCertificates: certs.length,
			revokedCertificates: certs.filter((c) => c.revoked).length,
			expiringCertificates: expiring.length,
			pendingJoinRequests: this.getPendingRequests().length,
			totalConnections: this.connections.length,
			failedConnections: this.connections.filter((c) => !c.mtlsVerified).length,
			caExpiresAt: this.ca?.notAfter ?? null,
		};
	}

	// ─── Configuration ─────────────────────────────────────────────

	getConfig(): FederationConfig {
		return { ...this.config };
	}

	updateConfig(config: Partial<FederationConfig>): FederationConfig {
		this.config = { ...this.config, ...config };
		return this.config;
	}

	// ─── Internal Helpers ──────────────────────────────────────────

	private generateSerial(): string {
		return randomBytes(16).toString("hex");
	}

	private generateHostId(hostname: string, port: number): string {
		// Deterministic host ID based on hostname:port using SHA-256
		const data = `${hostname}:${port}`;
		const hash = createHash("sha256").update(data).digest("hex").slice(0, 16);
		return `host-${hash}`;
	}

	private computeFingerprint(publicKey: string): string {
		// SHA-256 fingerprint of public key
		return createHash("sha256").update(publicKey).digest("hex");
	}

	private async loadCA(): Promise<void> {
		const caPath = join(this.config.configDir, CA_FILE);
		try {
			await access(caPath);
			const raw = await readFile(caPath, "utf-8");
			this.ca = JSON.parse(raw) as CACertificate;
		} catch {
			// No CA yet
		}
	}

	private async saveCA(): Promise<void> {
		if (!this.ca) return;
		const caPath = join(this.config.configDir, CA_FILE);
		await writeFile(caPath, JSON.stringify(this.ca, null, 2), { mode: 0o600 });
	}

	private async loadHosts(): Promise<void> {
		const hostsPath = join(this.config.configDir, HOSTS_FILE);
		try {
			await access(hostsPath);
			const raw = await readFile(hostsPath, "utf-8");
			const data = JSON.parse(raw) as Host[];
			this.hosts = new Map(data.map((h) => [h.hostId, h]));
		} catch {
			// No hosts yet
		}
	}

	private async saveHosts(): Promise<void> {
		const hostsPath = join(this.config.configDir, HOSTS_FILE);
		const data = Array.from(this.hosts.values());
		await writeFile(hostsPath, JSON.stringify(data, null, 2));
	}

	private async loadCertificates(): Promise<void> {
		const certsDir = join(this.config.configDir, CERTS_DIR);
		try {
			const files = await readdir(certsDir);
			for (const file of files) {
				if (file.endsWith(".json")) {
					const raw = await readFile(join(certsDir, file), "utf-8");
					const cert = JSON.parse(raw) as Certificate;
					this.certificates.set(cert.certId, cert);
				}
			}
		} catch {
			// No certificates yet
		}
	}

	private async saveCertificates(): Promise<void> {
		const certsDir = join(this.config.configDir, CERTS_DIR);
		await mkdir(certsDir, { recursive: true });

		for (const cert of this.certificates.values()) {
			const certPath = join(certsDir, `${cert.certId}.json`);
			await writeFile(certPath, JSON.stringify(cert, null, 2));
		}
	}

	private async loadJoinRequests(): Promise<void> {
		const path = join(this.config.configDir, JOIN_REQUESTS_FILE);
		try {
			await access(path);
			const raw = await readFile(path, "utf-8");
			this.joinRequests = JSON.parse(raw) as JoinRequest[];
		} catch {
			// No join requests yet
		}
	}

	private async saveJoinRequests(): Promise<void> {
		const path = join(this.config.configDir, JOIN_REQUESTS_FILE);
		await writeFile(path, JSON.stringify(this.joinRequests, null, 2));
	}

	private async loadConnections(): Promise<void> {
		const path = join(this.config.configDir, CONNECTIONS_FILE);
		try {
			await access(path);
			const raw = await readFile(path, "utf-8");
			this.connections = JSON.parse(raw) as TLSConnection[];
		} catch {
			// No connections yet
		}
	}
}

// ─── Convenience Functions ──────────────────────────────────────────

/**
 * Quick setup: Initialize CA and federation in one call.
 */
export async function initializeFederation(
	configDir: string,
): Promise<FederationPKI> {
	const pki = new FederationPKI({ configDir });
	await pki.initialize();
	await pki.initializeCA();
	return pki;
}

/**
 * Validate a PEM public key format.
 */
export function isValidPublicKey(key: string): boolean {
	return key.includes("BEGIN PUBLIC KEY") && key.includes("END PUBLIC KEY");
}
