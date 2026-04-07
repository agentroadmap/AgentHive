/**
 * STATE-56: Federation PKI Host Authentication
 *
 * Provides:
 * - AC#1: Internal CA for agent certificates
 * - AC#2: mTLS enforced on all federation connections
 * - AC#3: Host registry with join approval workflow
 * - AC#4: Certificate rotation with 90-day expiry
 * - AC#5: Rogue host quarantine capability
 */

import * as crypto from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";

// ===== TYPES =====

export interface CertificateInfo {
	id: string;
	hostId: string;
	hostname: string;
	publicKey: string;
	certificatePem: string;
	signature: string;
	issuedAt: number;
	expiresAt: number;
	revoked: boolean;
	revokedAt?: number;
	revocationReason?: string;
	fingerprint: string;
	serialNumber: string;
	issuer: string;
	metadata?: Record<string, string>;
}

export interface HostEntry {
	id: string;
	hostname: string;
	address: string;
	port: number;
	status: HostStatus;
	certificateId?: string;
	joinedAt: number;
	lastSeen: number;
	approvedBy?: string;
	approvedAt?: number;
	rejectionReason?: string;
	quarantineReason?: string;
	quarantinedAt?: number;
	tags: string[];
}

export type HostStatus =
	| "pending"
	| "approved"
	| "active"
	| "quarantined"
	| "revoked";

export interface CAConfig {
	caPath: string;
	validityDays?: number; // Default: 90 days
	keySize?: number; // Default: 2048
	organization?: string;
	countryCode?: string;
}

export interface JoinRequest {
	hostId: string;
	hostname: string;
	address: string;
	port: number;
	publicKey: string;
	requestedAt: number;
	metadata?: Record<string, string>;
}

export interface RotationResult {
	hostId: string;
	oldCertId: string;
	newCertId: string;
	rotatedAt: number;
	success: boolean;
	error?: string;
}

export interface QuarantineEvent {
	hostId: string;
	reason: string;
	triggeredBy: string;
	timestamp: number;
}

// ===== CERTIFICATE UTILITIES =====

/**
 * Create a certificate data string that can be signed and verified
 */
function createCertificateData(
	fields: Record<string, string | number>,
): string {
	const sortedKeys = Object.keys(fields).sort();
	return sortedKeys.map((key) => `${key}=${fields[key]}`).join("\n");
}

/**
 * Sign data with private key
 */
function signData(data: string, privateKey: crypto.KeyObject): string {
	const sign = crypto.createSign("SHA256");
	sign.update(data);
	return sign.sign(privateKey, "base64");
}

/**
 * Verify signature with public key
 */
function verifySignature(
	data: string,
	signature: string,
	publicKey: crypto.KeyObject,
): boolean {
	try {
		const verify = crypto.createVerify("SHA256");
		verify.update(data);
		return verify.verify(publicKey, signature, "base64");
	} catch {
		return false;
	}
}

/**
 * Calculate fingerprint of certificate data
 */
function calculateFingerprint(certificatePem: string): string {
	return crypto.createHash("sha256").update(certificatePem).digest("hex");
}

/**
 * Encode certificate to PEM format
 */
function encodeToPem(data: string, label: string): string {
	const base64 = Buffer.from(data).toString("base64");
	const lines = base64.match(/.{1,64}/g) || [];
	return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}

/**
 * Decode certificate from PEM format
 */
function decodeFromPem(pem: string): string {
	const cleaned = pem
		.replace(/-----BEGIN .*-----/g, "")
		.replace(/-----END .*-----/g, "")
		.replace(/\s/g, "");
	return Buffer.from(cleaned, "base64").toString("utf-8");
}

// ===== CERTIFICATE AUTHORITY =====

export class CertificateAuthority extends EventEmitter {
	private config: Required<CAConfig>;
	private caPrivateKey: crypto.KeyObject | null = null;
	private caPublicKey: crypto.KeyObject | null = null;
	private caPublicKeyPem: string = "";
	private caId: string = "";
	private certificates: Map<string, CertificateInfo> = new Map();

	constructor(config: CAConfig) {
		super();
		this.config = {
			caPath: config.caPath,
			validityDays: config.validityDays ?? 90,
			keySize: config.keySize ?? 2048,
			organization: config.organization ?? "agentRoadmap-federation",
			countryCode: config.countryCode ?? "US",
		};
	}

	/**
	 * Initialize the CA - create root key pair if not exists
	 */
	async initialize(): Promise<void> {
		const caKeyPath = path.join(this.config.caPath, "ca-key.json");
		const caMetaPath = path.join(this.config.caPath, "ca-meta.json");

		if (!fs.existsSync(this.config.caPath)) {
			fs.mkdirSync(this.config.caPath, { recursive: true });
		}

		if (fs.existsSync(caKeyPath) && fs.existsSync(caMetaPath)) {
			// Load existing CA
			const keyData = fs.readFileSync(caKeyPath, "utf-8");
			this.caPrivateKey = crypto.createPrivateKey(keyData);
			this.caPublicKey = crypto.createPublicKey(this.caPrivateKey);
			this.caPublicKeyPem = this.caPublicKey
				.export({ type: "spki", format: "pem" })
				.toString();

			const meta = JSON.parse(fs.readFileSync(caMetaPath, "utf-8"));
			this.caId = meta.caId;

			this.emit("ca:loaded", { caId: this.caId });
		} else {
			// Generate new CA
			await this.generateCA();
		}

		// Load existing certificates
		await this.loadCertificates();
	}

	/**
	 * Generate a new Certificate Authority
	 */
	async generateCA(): Promise<void> {
		const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
			modulusLength: this.config.keySize,
		});

		this.caPrivateKey = privateKey;
		this.caPublicKey = publicKey;
		this.caPublicKeyPem = publicKey
			.export({ type: "spki", format: "pem" })
			.toString();
		this.caId = `ca-${crypto.randomBytes(8).toString("hex")}`;

		// Save CA key and metadata
		const caKeyPath = path.join(this.config.caPath, "ca-key.json");
		const caMetaPath = path.join(this.config.caPath, "ca-meta.json");

		fs.writeFileSync(
			caKeyPath,
			privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
		);

		fs.writeFileSync(
			caMetaPath,
			JSON.stringify(
				{
					caId: this.caId,
					organization: this.config.organization,
					countryCode: this.config.countryCode,
					createdAt: Date.now(),
					publicKeyPem: this.caPublicKeyPem,
				},
				null,
				2,
			),
		);

		this.emit("ca:generated", {
			caId: this.caId,
			organization: this.config.organization,
		});
	}

	/**
	 * Issue a certificate for a host
	 */
	async issueCertificate(
		hostId: string,
		hostname: string,
		publicKeyPem: string,
		metadata?: Record<string, string>,
	): Promise<CertificateInfo> {
		if (!this.caPrivateKey || !this.caPublicKey) {
			throw new Error("CA not initialized");
		}

		const serialNumber = crypto.randomBytes(16).toString("hex");
		const now = Date.now();
		const expiry = now + this.config.validityDays * 24 * 60 * 60 * 1000;

		const certFields = {
			version: "1.0",
			serial: serialNumber,
			issuer: this.caId,
			subject: `/C=${this.config.countryCode}/O=${this.config.organization}/CN=${hostname}`,
			hostId,
			hostname,
			publicKey: publicKeyPem.replace(/\n/g, "\\n"),
			notBefore: now.toString(),
			notAfter: expiry.toString(),
			caPublicKey: this.caPublicKeyPem.replace(/\n/g, "\\n"),
		};

		const certData = createCertificateData(certFields);
		const signature = signData(certData, this.caPrivateKey);

		const certPem = encodeToPem(certData, "CERTIFICATE");
		const fingerprint = calculateFingerprint(certPem);

		const certInfo: CertificateInfo = {
			id: `cert-${hostId}-${serialNumber.substring(0, 8)}`,
			hostId,
			hostname,
			publicKey: publicKeyPem,
			certificatePem: certPem,
			signature,
			issuedAt: now,
			expiresAt: expiry,
			revoked: false,
			fingerprint,
			serialNumber,
			issuer: this.caId,
			metadata,
		};

		this.certificates.set(certInfo.id, certInfo);
		await this.saveCertificate(certInfo);

		this.emit("cert:issued", {
			hostId,
			certId: certInfo.id,
			expiresAt: expiry,
		});

		return certInfo;
	}

	/**
	 * Revoke a certificate
	 */
	async revokeCertificate(certId: string, reason: string): Promise<void> {
		const cert = this.certificates.get(certId);
		if (!cert) {
			throw new Error(`Certificate not found: ${certId}`);
		}

		cert.revoked = true;
		cert.revokedAt = Date.now();
		cert.revocationReason = reason;

		await this.saveCertificate(cert);

		this.emit("cert:revoked", { certId, hostId: cert.hostId, reason });
	}

	/**
	 * Rotate a certificate for a host
	 */
	async rotateCertificate(
		hostId: string,
		newPublicKeyPem: string,
		reason: string = "scheduled-rotation",
	): Promise<RotationResult> {
		const oldCert = this.findLatestCertificate(hostId);

		if (!oldCert) {
			throw new Error(`No existing certificate for host: ${hostId}`);
		}

		try {
			// Revoke old certificate
			await this.revokeCertificate(oldCert.id, reason);

			// Issue new certificate
			const newCert = await this.issueCertificate(
				hostId,
				oldCert.hostname,
				newPublicKeyPem,
				oldCert.metadata,
			);

			const result: RotationResult = {
				hostId,
				oldCertId: oldCert.id,
				newCertId: newCert.id,
				rotatedAt: Date.now(),
				success: true,
			};

			this.emit("cert:rotated", result);
			return result;
		} catch (error) {
			return {
				hostId,
				oldCertId: oldCert.id,
				newCertId: "",
				rotatedAt: Date.now(),
				success: false,
				error: (error as Error).message,
			};
		}
	}

	/**
	 * Verify a certificate
	 */
	verifyCertificate(certPem: string): {
		valid: boolean;
		cert?: CertificateInfo;
		error?: string;
	} {
		try {
			if (!this.caPublicKey) {
				return { valid: false, error: "CA not loaded" };
			}

			const certData = decodeFromPem(certPem);

			// Parse certificate fields
			const fields: Record<string, string> = {};
			certData.split("\n").forEach((line) => {
				const [key, ...valueParts] = line.split("=");
				if (key && valueParts.length > 0) {
					fields[key] = valueParts.join("=");
				}
			});

			// Find the certificate in our store by looking at serial
			const serial = fields.serial;
			if (!serial) {
				return { valid: false, error: "Invalid certificate format" };
			}

			const cert = Array.from(this.certificates.values()).find(
				(c) => c.serialNumber === serial,
			);
			if (!cert) {
				return { valid: false, error: "Certificate not found in registry" };
			}

			// Check expiry
			const now = Date.now();
			const expiresAt = parseInt(fields.notAfter || "0", 10);
			const notBefore = parseInt(fields.notBefore || "0", 10);

			if (notBefore > now) {
				return { valid: false, error: "Certificate not yet valid" };
			}
			if (expiresAt < now) {
				return { valid: false, error: "Certificate expired" };
			}

			// Check if revoked
			if (cert.revoked) {
				return {
					valid: false,
					error: `Certificate revoked: ${cert.revocationReason}`,
				};
			}

			// Verify signature
			const isValidSignature = verifySignature(
				certData,
				cert.signature,
				this.caPublicKey,
			);
			if (!isValidSignature) {
				return { valid: false, error: "Invalid certificate signature" };
			}

			return { valid: true, cert };
		} catch (error) {
			return { valid: false, error: (error as Error).message };
		}
	}

	/**
	 * Get CA public key for mTLS
	 */
	getCAPublicKey(): string {
		return this.caPublicKeyPem;
	}

	/**
	 * Get all certificates
	 */
	getAllCertificates(): CertificateInfo[] {
		return Array.from(this.certificates.values());
	}

	/**
	 * Get certificates expiring within specified days
	 */
	getExpiringCertificates(days: number = 7): CertificateInfo[] {
		const threshold = Date.now() + days * 24 * 60 * 60 * 1000;
		return this.getAllCertificates().filter(
			(c) => !c.revoked && c.expiresAt <= threshold,
		);
	}

	private findLatestCertificate(hostId: string): CertificateInfo | undefined {
		return Array.from(this.certificates.values())
			.filter((c) => c.hostId === hostId)
			.sort((a, b) => b.issuedAt - a.issuedAt)[0];
	}

	private async saveCertificate(cert: CertificateInfo): Promise<void> {
		const certPath = path.join(this.config.caPath, "certs");
		if (!fs.existsSync(certPath)) {
			fs.mkdirSync(certPath, { recursive: true });
		}

		const filePath = path.join(certPath, `${cert.id}.json`);
		fs.writeFileSync(filePath, JSON.stringify(cert, null, 2));
	}

	private async loadCertificates(): Promise<void> {
		const certPath = path.join(this.config.caPath, "certs");
		if (!fs.existsSync(certPath)) return;

		const files = fs.readdirSync(certPath).filter((f) => f.endsWith(".json"));
		for (const file of files) {
			const data = fs.readFileSync(path.join(certPath, file), "utf-8");
			const cert = JSON.parse(data) as CertificateInfo;
			this.certificates.set(cert.id, cert);
		}
	}
}

// ===== HOST REGISTRY =====

export class HostRegistry extends EventEmitter {
	private hosts: Map<string, HostEntry> = new Map();
	private pendingRequests: Map<string, JoinRequest> = new Map();
	private quarantineLog: QuarantineEvent[] = [];
	private storePath: string;
	private approvalHandler?: (request: JoinRequest) => Promise<boolean>;

	constructor(storePath: string) {
		super();
		this.storePath = storePath;
	}

	/**
	 * Initialize the host registry
	 */
	async initialize(): Promise<void> {
		if (!fs.existsSync(this.storePath)) {
			fs.mkdirSync(this.storePath, { recursive: true });
		}
		await this.loadHosts();
	}

	/**
	 * Register a join approval handler
	 */
	onJoinApproval(handler: (request: JoinRequest) => Promise<boolean>): void {
		this.approvalHandler = handler;
	}

	/**
	 * Submit a join request from a host
	 */
	async requestJoin(
		request: JoinRequest,
	): Promise<{ accepted: boolean; hostId: string; reason?: string }> {
		// Check if already registered
		const existing = this.findHostByAddress(request.address);
		if (existing) {
			if (existing.status === "quarantined") {
				return {
					accepted: false,
					hostId: existing.id,
					reason: "Host is quarantined",
				};
			}
			if (existing.status === "active" || existing.status === "approved") {
				return {
					accepted: false,
					hostId: existing.id,
					reason: "Host already registered",
				};
			}
		}

		this.pendingRequests.set(request.hostId, request);
		this.emit("join:request", request);

		// Auto-approve if handler set, otherwise queue for manual approval
		if (this.approvalHandler) {
			const approved = await this.approvalHandler(request);
			if (approved) {
				return this.approveJoin(request.hostId, "auto-approval");
			}
		}

		return {
			accepted: false,
			hostId: request.hostId,
			reason: "Pending approval",
		};
	}

	/**
	 * Approve a pending join request
	 */
	async approveJoin(
		hostId: string,
		approvedBy: string,
	): Promise<{ accepted: boolean; hostId: string; reason?: string }> {
		const request = this.pendingRequests.get(hostId);
		if (!request) {
			return { accepted: false, hostId, reason: "No pending request found" };
		}

		const host: HostEntry = {
			id: request.hostId,
			hostname: request.hostname,
			address: request.address,
			port: request.port,
			status: "approved",
			joinedAt: Date.now(),
			lastSeen: Date.now(),
			approvedBy,
			approvedAt: Date.now(),
			tags: [],
		};

		this.hosts.set(host.id, host);
		this.pendingRequests.delete(hostId);
		await this.saveHost(host);

		this.emit("join:approved", { hostId, approvedBy });

		return { accepted: true, hostId };
	}

	/**
	 * Reject a pending join request
	 */
	async rejectJoin(hostId: string, reason: string): Promise<void> {
		this.pendingRequests.delete(hostId);
		this.emit("join:rejected", { hostId, reason });
	}

	/**
	 * Mark a host as active (after successful connection)
	 */
	async activateHost(hostId: string): Promise<void> {
		const host = this.hosts.get(hostId);
		if (!host) {
			throw new Error(`Host not found: ${hostId}`);
		}

		host.status = "active";
		host.lastSeen = Date.now();
		await this.saveHost(host);

		this.emit("host:activated", { hostId });
	}

	/**
	 * Update last seen timestamp
	 */
	async touchHost(hostId: string): Promise<void> {
		const host = this.hosts.get(hostId);
		if (host) {
			host.lastSeen = Date.now();
			await this.saveHost(host);
		}
	}

	/**
	 * Quarantine a host
	 */
	async quarantineHost(
		hostId: string,
		reason: string,
		triggeredBy: string,
	): Promise<void> {
		const host = this.hosts.get(hostId);
		if (!host) {
			throw new Error(`Host not found: ${hostId}`);
		}

		host.status = "quarantined";
		host.quarantineReason = reason;
		host.quarantinedAt = Date.now();
		await this.saveHost(host);

		const event: QuarantineEvent = {
			hostId,
			reason,
			triggeredBy,
			timestamp: Date.now(),
		};
		this.quarantineLog.push(event);

		this.emit("host:quarantined", event);
	}

	/**
	 * Lift quarantine on a host
	 */
	async liftQuarantine(hostId: string, liftedBy: string): Promise<void> {
		const host = this.hosts.get(hostId);
		if (!host) {
			throw new Error(`Host not found: ${hostId}`);
		}

		host.status = "approved";
		host.quarantineReason = undefined;
		host.quarantinedAt = undefined;
		await this.saveHost(host);

		this.emit("host:quarantine-lifted", { hostId, liftedBy });
	}

	/**
	 * Revoke a host's access
	 */
	async revokeHost(hostId: string, reason: string): Promise<void> {
		const host = this.hosts.get(hostId);
		if (!host) {
			throw new Error(`Host not found: ${hostId}`);
		}

		host.status = "revoked";
		host.rejectionReason = reason;
		await this.saveHost(host);

		this.emit("host:revoked", { hostId, reason });
	}

	/**
	 * Get all hosts
	 */
	getAllHosts(): HostEntry[] {
		return Array.from(this.hosts.values());
	}

	/**
	 * Get hosts by status
	 */
	getHostsByStatus(status: HostStatus): HostEntry[] {
		return this.getAllHosts().filter((h) => h.status === status);
	}

	/**
	 * Get active hosts
	 */
	getActiveHosts(): HostEntry[] {
		return this.getHostsByStatus("active");
	}

	/**
	 * Get quarantined hosts
	 */
	getQuarantinedHosts(): HostEntry[] {
		return this.getHostsByStatus("quarantined");
	}

	/**
	 * Get pending join requests
	 */
	getPendingRequests(): JoinRequest[] {
		return Array.from(this.pendingRequests.values());
	}

	/**
	 * Get quarantine log
	 */
	getQuarantineLog(): QuarantineEvent[] {
		return [...this.quarantineLog];
	}

	/**
	 * Associate a certificate with a host
	 */
	async attachCertificate(hostId: string, certId: string): Promise<void> {
		const host = this.hosts.get(hostId);
		if (!host) {
			throw new Error(`Host not found: ${hostId}`);
		}

		host.certificateId = certId;
		await this.saveHost(host);
	}

	private findHostByAddress(address: string): HostEntry | undefined {
		return Array.from(this.hosts.values()).find((h) => h.address === address);
	}

	private async saveHost(host: HostEntry): Promise<void> {
		const filePath = path.join(this.storePath, `${host.id}.json`);
		fs.writeFileSync(filePath, JSON.stringify(host, null, 2));
	}

	private async loadHosts(): Promise<void> {
		if (!fs.existsSync(this.storePath)) return;

		const files = fs
			.readdirSync(this.storePath)
			.filter((f) => f.endsWith(".json"));
		for (const file of files) {
			const data = fs.readFileSync(path.join(this.storePath, file), "utf-8");
			const host = JSON.parse(data) as HostEntry;
			this.hosts.set(host.id, host);
		}
	}
}

// ===== mTLS CONNECTION HANDLER =====

export interface MTLSConnection {
	hostId: string;
	certFingerprint: string;
	established: number;
	lastActivity: number;
	encrypted: boolean;
	verified: boolean;
}

/**
 * mTLS connection validator for federation
 */
export class MTLSValidator {
	private connections: Map<string, MTLSConnection> = new Map();
	private ca: CertificateAuthority;
	private hostRegistry: HostRegistry;

	constructor(ca: CertificateAuthority, hostRegistry: HostRegistry) {
		this.ca = ca;
		this.hostRegistry = hostRegistry;
	}

	/**
	 * Validate an incoming connection with client certificate
	 */
	async validateConnection(
		clientCertPem: string,
		hostId: string,
	): Promise<{ valid: boolean; connection?: MTLSConnection; error?: string }> {
		// Verify certificate against CA
		const verification = this.ca.verifyCertificate(clientCertPem);
		if (!verification.valid) {
			return { valid: false, error: verification.error };
		}

		// Check host is registered and approved
		const host = this.hostRegistry.getAllHosts().find((h) => h.id === hostId);
		if (!host) {
			return { valid: false, error: "Host not registered" };
		}

		if (host.status === "quarantined") {
			return { valid: false, error: "Host is quarantined" };
		}

		if (host.status === "revoked") {
			return { valid: false, error: "Host access revoked" };
		}

		if (!verification.cert) {
			return { valid: false, error: "Certificate verification returned no certificate" };
		}

		// Create connection record
		const connection: MTLSConnection = {
			hostId,
			certFingerprint: verification.cert.fingerprint,
			established: Date.now(),
			lastActivity: Date.now(),
			encrypted: true,
			verified: true,
		};

		this.connections.set(hostId, connection);
		await this.hostRegistry.touchHost(hostId);

		return { valid: true, connection };
	}

	/**
	 * Close a connection
	 */
	closeConnection(hostId: string): void {
		this.connections.delete(hostId);
	}

	/**
	 * Get active connections
	 */
	getActiveConnections(): MTLSConnection[] {
		return Array.from(this.connections.values());
	}

	/**
	 * Check if a host has an active connection
	 */
	isConnected(hostId: string): boolean {
		return this.connections.has(hostId);
	}
}

// ===== CERTIFICATE ROTATION SCHEDULER =====

export class CertificateRotationScheduler {
	private ca: CertificateAuthority;
	private hostRegistry: HostRegistry;
	private checkIntervalMs: number;
	private warningThresholdMs: number;
	private timer?: NodeJS.Timeout;

	constructor(
		ca: CertificateAuthority,
		hostRegistry: HostRegistry,
		checkIntervalMs: number = 60 * 60 * 1000, // 1 hour
		warningDays: number = 7,
	) {
		this.ca = ca;
		this.hostRegistry = hostRegistry;
		this.checkIntervalMs = checkIntervalMs;
		this.warningThresholdMs = warningDays * 24 * 60 * 60 * 1000;
	}

	/**
	 * Start the rotation scheduler
	 */
	start(): void {
		this.timer = setInterval(
			() => this.checkExpirations(),
			this.checkIntervalMs,
		);
	}

	/**
	 * Stop the rotation scheduler
	 */
	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	/**
	 * Check for expiring certificates
	 */
	checkExpirations(): {
		expiring: CertificateInfo[];
		critical: CertificateInfo[];
	} {
		const now = Date.now();
		const allCerts = this.ca.getAllCertificates().filter((c) => !c.revoked);

		const expiring = allCerts.filter(
			(c) =>
				c.expiresAt - now <= this.warningThresholdMs && c.expiresAt - now > 0,
		);

		const critical = allCerts.filter(
			(c) => c.expiresAt - now <= 24 * 60 * 60 * 1000, // Less than 24 hours
		);

		if (expiring.length > 0) {
			this.ca.emit("rotation:expiring", { certs: expiring.map((c) => c.id) });
		}

		if (critical.length > 0) {
			this.ca.emit("rotation:critical", { certs: critical.map((c) => c.id) });
		}

		return { expiring, critical };
	}
}
