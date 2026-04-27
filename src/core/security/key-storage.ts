/**
 * P472 — Secure Key Storage (AC#104)
 *
 * Private keys for agency Ed25519 keypairs MUST NOT be written to plaintext
 * disk.  This module provides two backends:
 *
 *   1. OsKeyringStorage  — uses the OS keychain via `keytar`; preferred on
 *                          developer workstations and macOS/Linux/Windows.
 *   2. VaultKeyStorage   — delegates to HashiCorp Vault KV v2; preferred in
 *                          production deployments.
 *   3. EncryptedFileStorage — fallback for environments without keytar/Vault;
 *                             AES-256-GCM encrypted at rest; key derived from
 *                             env var AGENTHIVE_KEY_ENCRYPTION_KEY.
 *
 * Callers never touch plaintext private key bytes directly — they call
 * `store`, `retrieve`, and `delete`; the backend decides where they live.
 *
 * The `auditNoplaintextKeys` function scans the working directory for PEM
 * private key patterns and fails if any are found outside expected paths.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// ── Abstraction ───────────────────────────────────────────────────────────────

export interface KeyStorage {
	/** Store a private key; returns a storage handle (opaque key reference). */
	store(handle: string, privateKeyPem: string): Promise<void>;
	/** Retrieve a stored private key by handle; null if not found. */
	retrieve(handle: string): Promise<string | null>;
	/** Delete a private key from storage (e.g., on principal revocation). */
	delete(handle: string): Promise<void>;
}

// ── OS Keyring backend (node-keytar) ─────────────────────────────────────────

const KEYTAR_SERVICE = "agenthive-agency-keys";

/**
 * Uses the OS credential store via `keytar`.
 * On Linux this requires `libsecret`; on macOS, the system Keychain.
 * On environments without keytar installed, falls through to EncryptedFileStorage.
 */
export class OsKeyringStorage implements KeyStorage {
	async store(handle: string, privateKeyPem: string): Promise<void> {
		const keytar = await _loadKeytar();
		await keytar.setPassword(KEYTAR_SERVICE, handle, privateKeyPem);
	}

	async retrieve(handle: string): Promise<string | null> {
		const keytar = await _loadKeytar();
		return keytar.getPassword(KEYTAR_SERVICE, handle);
	}

	async delete(handle: string): Promise<void> {
		const keytar = await _loadKeytar();
		await keytar.deletePassword(KEYTAR_SERVICE, handle);
	}
}

// ── HashiCorp Vault backend ───────────────────────────────────────────────────

export interface VaultConfig {
	/** e.g. http://127.0.0.1:8200 */
	address: string;
	/** Vault token or AppRole token */
	token: string;
	/** KV v2 mount path, e.g. 'secret' */
	mountPath?: string;
}

export class VaultKeyStorage implements KeyStorage {
	private readonly cfg: Required<VaultConfig>;

	constructor(cfg: VaultConfig) {
		this.cfg = { mountPath: "secret", ...cfg };
	}

	async store(handle: string, privateKeyPem: string): Promise<void> {
		const url = `${this.cfg.address}/v1/${this.cfg.mountPath}/data/${_vaultPath(handle)}`;
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"X-Vault-Token": this.cfg.token,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ data: { private_key: privateKeyPem } }),
		});
		if (!res.ok) {
			const body = await res.text();
			throw new Error(`Vault store failed for ${handle}: ${res.status} ${body}`);
		}
	}

	async retrieve(handle: string): Promise<string | null> {
		const url = `${this.cfg.address}/v1/${this.cfg.mountPath}/data/${_vaultPath(handle)}`;
		const res = await fetch(url, {
			headers: { "X-Vault-Token": this.cfg.token },
		});
		if (res.status === 404) return null;
		if (!res.ok) return null;
		const json = (await res.json()) as {
			data?: { data?: { private_key?: string } };
		};
		return json.data?.data?.private_key ?? null;
	}

	async delete(handle: string): Promise<void> {
		const url = `${this.cfg.address}/v1/${this.cfg.mountPath}/metadata/${_vaultPath(handle)}`;
		await fetch(url, {
			method: "DELETE",
			headers: { "X-Vault-Token": this.cfg.token },
		});
	}
}

// ── Encrypted-file fallback ───────────────────────────────────────────────────
//
// Private keys are encrypted with AES-256-GCM.  The encryption key is derived
// from AGENTHIVE_KEY_ENCRYPTION_KEY env var (32-byte hex or base64).
// The ciphertext is stored in a JSON file; the private key bytes NEVER appear
// in plaintext at rest.

const ENCRYPTED_KEY_DIR =
	process.env.AGENTHIVE_KEY_DIR ?? join(process.cwd(), ".agenthive-keys");

export class EncryptedFileStorage implements KeyStorage {
	async store(handle: string, privateKeyPem: string): Promise<void> {
		const { mkdir, writeFile } = await import("node:fs/promises");
		await mkdir(ENCRYPTED_KEY_DIR, { recursive: true, mode: 0o700 });
		const encKey = _getEncryptionKey();
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", encKey, iv);
		const ct = Buffer.concat([
			cipher.update(privateKeyPem, "utf8"),
			cipher.final(),
		]);
		const tag = cipher.getAuthTag();
		const payload = JSON.stringify({
			iv: iv.toString("base64"),
			tag: tag.toString("base64"),
			ct: ct.toString("base64"),
		});
		// Mode 0o600 — owner read/write only
		await writeFile(_keyFilePath(handle), payload, { encoding: "utf8", mode: 0o600 });
	}

	async retrieve(handle: string): Promise<string | null> {
		try {
			const raw = await readFile(_keyFilePath(handle), "utf8");
			const { iv, tag, ct } = JSON.parse(raw) as {
				iv: string;
				tag: string;
				ct: string;
			};
			const encKey = _getEncryptionKey();
			const decipher = createDecipheriv(
				"aes-256-gcm",
				encKey,
				Buffer.from(iv, "base64"),
			);
			decipher.setAuthTag(Buffer.from(tag, "base64"));
			return decipher.update(Buffer.from(ct, "base64")).toString("utf8") + decipher.final("utf8");
		} catch {
			return null;
		}
	}

	async delete(handle: string): Promise<void> {
		const { unlink } = await import("node:fs/promises");
		try {
			await unlink(_keyFilePath(handle));
		} catch {
			/* already gone */
		}
	}
}

// ── Audit: no plaintext private keys on disk (AC#104) ───────────────────────

export interface AuditResult {
	clean: boolean;
	violations: Array<{ file: string; line: number; match: string }>;
}

const PLAINTEXT_PRIVATE_KEY_RE =
	/-----BEGIN (?:EC |RSA |DSA |OPENSSH )?PRIVATE KEY-----/;

/**
 * Scan a directory tree for PEM private key headers.
 * Skips `node_modules`, `.git`, and paths in `allowlist`.
 *
 * Returns violations; `clean` is true when violations is empty.
 */
export async function auditNoplaintextKeys(
	root: string,
	allowlist: string[] = [],
): Promise<AuditResult> {
	const violations: AuditResult["violations"] = [];
	await _walkDir(root, async (filePath) => {
		if (allowlist.some((a) => filePath.startsWith(a))) return;
		if (!filePath.endsWith(".pem") && !filePath.endsWith(".key") &&
			!filePath.endsWith(".txt") && !filePath.endsWith(".ts") &&
			!filePath.endsWith(".js") && !filePath.endsWith(".json") &&
			!filePath.endsWith(".env")) return;
		try {
			const content = await readFile(filePath, "utf8");
			const lines = content.split("\n");
			lines.forEach((line, i) => {
				if (PLAINTEXT_PRIVATE_KEY_RE.test(line)) {
					violations.push({ file: filePath, line: i + 1, match: line.trim() });
				}
			});
		} catch {
			/* unreadable file — skip */
		}
	});
	return { clean: violations.length === 0, violations };
}

async function _walkDir(
	dir: string,
	visitor: (filePath: string) => Promise<void>,
): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry === "node_modules" || entry === ".git" || entry === ".agenthive-keys")
			continue;
		const full = join(dir, entry);
		let s;
		try {
			s = await stat(full);
		} catch {
			continue;
		}
		if (s.isDirectory()) {
			await _walkDir(full, visitor);
		} else {
			await visitor(full);
		}
	}
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Returns the best available KeyStorage backend for the current environment.
 * Priority: Vault (if VAULT_ADDR + VAULT_TOKEN set) > OS keyring > Encrypted file.
 */
export async function createKeyStorage(): Promise<KeyStorage> {
	if (process.env.VAULT_ADDR && process.env.VAULT_TOKEN) {
		return new VaultKeyStorage({
			address: process.env.VAULT_ADDR,
			token: process.env.VAULT_TOKEN,
		});
	}
	try {
		await _loadKeytar();
		return new OsKeyringStorage();
	} catch {
		return new EncryptedFileStorage();
	}
}

// ── Private helpers ───────────────────────────────────────────────────────────

async function _loadKeytar(): Promise<{
	setPassword(service: string, account: string, password: string): Promise<void>;
	getPassword(service: string, account: string): Promise<string | null>;
	deletePassword(service: string, account: string): Promise<boolean>;
}> {
	// Dynamic import so the module is optional at runtime
	try {
		const kt = await import("keytar");
		return (kt as { default?: typeof kt }).default ?? kt;
	} catch {
		throw new Error(
			"keytar not available — install it or use VaultKeyStorage/EncryptedFileStorage",
		);
	}
}

function _getEncryptionKey(): Buffer {
	const raw = process.env.AGENTHIVE_KEY_ENCRYPTION_KEY;
	if (!raw) {
		throw new Error(
			"AGENTHIVE_KEY_ENCRYPTION_KEY must be set for EncryptedFileStorage",
		);
	}
	const buf = raw.length === 64
		? Buffer.from(raw, "hex")
		: Buffer.from(raw, "base64");
	if (buf.length !== 32) {
		throw new Error(
			"AGENTHIVE_KEY_ENCRYPTION_KEY must be 32 bytes (64 hex chars or 44 base64 chars)",
		);
	}
	return buf;
}

function _keyFilePath(handle: string): string {
	// Sanitise handle to prevent path traversal
	const safe = handle.replace(/[^a-zA-Z0-9_\-.:]/g, "_");
	return join(ENCRYPTED_KEY_DIR, `${safe}.enc`);
}

function _vaultPath(handle: string): string {
	return `agenthive/agency-keys/${handle.replace(/[^a-zA-Z0-9_\-.:/]/g, "_")}`;
}
