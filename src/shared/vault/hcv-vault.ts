/**
 * HashiCorp Vault adapter (P515)
 *
 * KV v2 backend with AppRole authentication. No plaintext tokens in config.
 *
 * Auth flow:
 *  1. Read role_id from opts.roleIdFile (or opts.roleId string)
 *  2. Read secret_id from opts.secretIdFile (file path is preferred; avoids env exposure)
 *  3. POST /v1/auth/approle/login → receive client_token + lease_duration
 *  4. Renew token automatically before expiry (at 75% of lease_duration)
 *
 * Read cache: 60s TTL per ref. On vault outage, stale cache is served for up
 * to cacheStaleThreshold (default 5 min). After that, VaultUnavailableError.
 *
 * SecretRef scheme: vault://hcv/<kv-path>
 *   e.g.  vault://hcv/tenants/audiobook/dsn
 *   resolves to KV v2 path: <mount>/data/tenants/audiobook/dsn
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";

import {
	type VaultAdapter,
	type SecretRef,
	VaultError,
	VaultInvalidRefError,
	VaultUnavailableError,
	VaultAuthError,
} from "./types.ts";

const SCHEME = "vault://hcv/";
const DEFAULT_MOUNT = "secret";
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_STALE_THRESHOLD_MS = 300_000; // 5 min stale cache on outage
const TOKEN_RENEW_FRACTION = 0.75; // renew at 75% of lease_duration

export interface HcvVaultOptions {
	/** Vault server address, e.g. http://127.0.0.1:8200 */
	addr: string;
	/** Path to file containing the AppRole role_id */
	roleIdFile?: string;
	/** Inline role_id (use roleIdFile in production) */
	roleId?: string;
	/** Path to file containing the AppRole secret_id */
	secretIdFile?: string;
	/** Inline secret_id (roleIdFile + secretIdFile preferred) */
	secretId?: string;
	/** KV v2 mount name (default: "secret") */
	mount?: string;
	/** Vault namespace (Enterprise only) */
	namespace?: string;
	/** Read cache TTL in ms (default: 60 000) */
	cacheMaxAge?: number;
	/** Serve stale cache when vault is unreachable for up to this many ms (default: 300 000) */
	cacheStaleThreshold?: number;
	/** Path to write audit log JSONL (default: stderr) */
	auditLogPath?: string;
}

interface CacheEntry {
	value: string;
	cachedAt: number;
	expiresAt: number;
}

interface TokenState {
	token: string;
	expiresAt: number;
	renewAt: number;
}

/**
 * Factory function for HashiCorp Vault KV v2 adapter.
 */
export function hcvVault(opts: HcvVaultOptions): VaultAdapter {
	return new HcvVaultImpl(opts);
}

class HcvVaultImpl implements VaultAdapter {
	private readonly addr: string;
	private readonly mount: string;
	private readonly namespace?: string;
	private readonly cacheMaxAge: number;
	private readonly staleThreshold: number;
	private readonly auditLogPath: string | null;

	private cache = new Map<string, CacheEntry>();
	private token: TokenState | null = null;
	private tokenRefreshPromise: Promise<void> | null = null;

	constructor(private readonly opts: HcvVaultOptions) {
		this.addr = opts.addr.replace(/\/$/, "");
		this.mount = opts.mount ?? DEFAULT_MOUNT;
		this.namespace = opts.namespace;
		this.cacheMaxAge = opts.cacheMaxAge ?? DEFAULT_CACHE_TTL_MS;
		this.staleThreshold = opts.cacheStaleThreshold ?? DEFAULT_STALE_THRESHOLD_MS;
		this.auditLogPath = opts.auditLogPath ?? null;
	}

	async read(ref: SecretRef): Promise<string> {
		const kvPath = this.extractPath(ref, "read");
		const now = Date.now();

		const cached = this.cache.get(kvPath);
		if (cached && now < cached.expiresAt) {
			this.audit(ref, "read", true);
			return cached.value;
		}

		try {
			await this.ensureToken();
			const value = await this.kvGet(kvPath, ref);
			this.cache.set(kvPath, {
				value,
				cachedAt: now,
				expiresAt: now + this.cacheMaxAge,
			});
			this.audit(ref, "read", true);
			return value;
		} catch (err) {
			// Serve stale cache on vault outage
			if (cached && now - cached.cachedAt < this.staleThreshold) {
				this.audit(ref, "read", true, undefined, "stale-cache");
				return cached.value;
			}
			if (err instanceof VaultError) {
				this.audit(ref, "read", false, (err as Error).message);
				throw err;
			}
			const wrapped = new VaultUnavailableError(
				ref,
				"read",
				err as Error,
				`HCV unavailable: ${(err as Error).message}`,
			);
			this.audit(ref, "read", false, wrapped.message);
			throw wrapped;
		}
	}

	async write(ref: SecretRef, value: string): Promise<void> {
		const kvPath = this.extractPath(ref, "write");
		try {
			await this.ensureToken();
			await this.kvPut(kvPath, value, ref);
			this.cache.delete(kvPath);
			this.audit(ref, "write", true);
		} catch (err) {
			if (err instanceof VaultError) {
				this.audit(ref, "write", false, (err as Error).message);
				throw err;
			}
			const wrapped = new VaultUnavailableError(
				ref,
				"write",
				err as Error,
				`HCV unavailable: ${(err as Error).message}`,
			);
			this.audit(ref, "write", false, wrapped.message);
			throw wrapped;
		}
	}

	async rotate(ref: SecretRef, newValue: string): Promise<void> {
		const kvPath = this.extractPath(ref, "rotate");
		try {
			await this.ensureToken();
			await this.kvPut(kvPath, newValue, ref);
			this.cache.delete(kvPath);
			this.audit(ref, "rotate", true);
		} catch (err) {
			if (err instanceof VaultError) {
				this.audit(ref, "rotate", false, (err as Error).message);
				throw err;
			}
			const wrapped = new VaultUnavailableError(
				ref,
				"rotate",
				err as Error,
				`HCV unavailable: ${(err as Error).message}`,
			);
			this.audit(ref, "rotate", false, wrapped.message);
			throw wrapped;
		}
	}

	async exists(ref: SecretRef): Promise<boolean> {
		const kvPath = this.extractPath(ref, "exists");
		const now = Date.now();

		const cached = this.cache.get(kvPath);
		if (cached && now < cached.expiresAt) {
			this.audit(ref, "exists", true);
			return true;
		}

		try {
			await this.ensureToken();
			const result = await this.kvExists(kvPath, ref);
			this.audit(ref, "exists", true);
			return result;
		} catch (err) {
			if (err instanceof VaultError) {
				this.audit(ref, "exists", false, (err as Error).message);
				throw err;
			}
			const wrapped = new VaultUnavailableError(
				ref,
				"exists",
				err as Error,
				`HCV unavailable: ${(err as Error).message}`,
			);
			this.audit(ref, "exists", false, wrapped.message);
			throw wrapped;
		}
	}

	// ─── Auth ────────────────────────────────────────────────────────────────

	private async ensureToken(): Promise<void> {
		const now = Date.now();
		if (this.token && now < this.token.renewAt) return;

		// Serialize token refresh to avoid concurrent login storms
		if (!this.tokenRefreshPromise) {
			this.tokenRefreshPromise = this.refreshToken().finally(() => {
				this.tokenRefreshPromise = null;
			});
		}
		await this.tokenRefreshPromise;
	}

	private async refreshToken(): Promise<void> {
		const roleId = await this.readCredential(
			this.opts.roleIdFile,
			this.opts.roleId,
			"role_id",
		);
		const secretId = await this.readCredential(
			this.opts.secretIdFile,
			this.opts.secretId,
			"secret_id",
		);

		const res = await this.vaultRequest("POST", "/v1/auth/approle/login", {
			role_id: roleId,
			secret_id: secretId,
		});

		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new VaultAuthError(
				"vault://hcv/" as SecretRef,
				"read",
				res.status,
				`AppRole login failed (HTTP ${res.status}): ${body.slice(0, 200)}`,
			);
		}

		const json = (await res.json()) as {
			auth: { client_token: string; lease_duration: number };
		};
		const leaseSec = json.auth.lease_duration;
		const now = Date.now();
		this.token = {
			token: json.auth.client_token,
			expiresAt: now + leaseSec * 1000,
			renewAt: now + leaseSec * 1000 * TOKEN_RENEW_FRACTION,
		};
	}

	/** Read a credential from a file or inline value. File takes precedence. */
	private async readCredential(
		filePath: string | undefined,
		inline: string | undefined,
		name: string,
	): Promise<string> {
		if (filePath) {
			const content = await fs.readFile(filePath, "utf-8");
			return content.trim();
		}
		if (inline) return inline;
		throw new Error(
			`HCV vault: ${name} not configured; set ${name === "role_id" ? "roleIdFile or roleId" : "secretIdFile or secretId"} in HcvVaultOptions`,
		);
	}

	// ─── KV v2 operations ────────────────────────────────────────────────────

	/** GET /v1/<mount>/data/<path> */
	private async kvGet(kvPath: string, ref: SecretRef): Promise<string> {
		const url = `/v1/${this.mount}/data/${kvPath}`;
		const res = await this.vaultRequest("GET", url);

		if (res.status === 404) {
			throw new VaultError(ref, "read", `Secret not found: ${ref}`);
		}
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new VaultError(
				ref,
				"read",
				`KV read failed (HTTP ${res.status}): ${body.slice(0, 200)}`,
			);
		}

		const json = (await res.json()) as {
			data?: { data?: Record<string, string> };
		};
		const value = json.data?.data?.["value"];
		if (typeof value !== "string") {
			throw new VaultError(
				ref,
				"read",
				`KV secret at ${kvPath} has no "value" key in data map`,
			);
		}
		return value;
	}

	/** POST /v1/<mount>/data/<path> with { data: { value } } */
	private async kvPut(
		kvPath: string,
		value: string,
		ref: SecretRef,
	): Promise<void> {
		const url = `/v1/${this.mount}/data/${kvPath}`;
		const res = await this.vaultRequest("POST", url, { data: { value } });

		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new VaultError(
				ref,
				"write",
				`KV write failed (HTTP ${res.status}): ${body.slice(0, 200)}`,
			);
		}
	}

	/** HEAD /v1/<mount>/metadata/<path> to check existence */
	private async kvExists(kvPath: string, ref: SecretRef): Promise<boolean> {
		const url = `/v1/${this.mount}/metadata/${kvPath}`;
		const res = await this.vaultRequest("GET", url);

		if (res.status === 404) return false;
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new VaultError(
				ref,
				"exists",
				`KV metadata check failed (HTTP ${res.status}): ${body.slice(0, 200)}`,
			);
		}
		return true;
	}

	// ─── HTTP helpers ─────────────────────────────────────────────────────────

	private async vaultRequest(
		method: string,
		urlPath: string,
		body?: unknown,
	): Promise<Response> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};

		if (this.token) {
			headers["X-Vault-Token"] = this.token.token;
		}
		if (this.namespace) {
			headers["X-Vault-Namespace"] = this.namespace;
		}

		const res = await fetch(`${this.addr}${urlPath}`, {
			method,
			headers,
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});

		return res;
	}

	// ─── Path extraction ──────────────────────────────────────────────────────

	private extractPath(ref: SecretRef, op: string): string {
		if (!ref.startsWith(SCHEME)) {
			throw new VaultInvalidRefError(
				ref,
				op as "read" | "write" | "rotate" | "exists",
				`HCV adapter only handles ${SCHEME}* refs; got: ${ref}`,
			);
		}
		const kvPath = ref.slice(SCHEME.length);
		if (!kvPath || kvPath.includes("..") || kvPath.startsWith(".")) {
			throw new VaultInvalidRefError(
				ref,
				op as "read" | "write" | "rotate" | "exists",
				`Invalid path in HCV ref: ${kvPath}`,
			);
		}
		return kvPath;
	}

	// ─── Audit ────────────────────────────────────────────────────────────────

	private audit(
		ref: SecretRef,
		op: "read" | "write" | "rotate" | "exists",
		success: boolean,
		error?: string,
		note?: string,
	): void {
		const entry = {
			ts: new Date().toISOString(),
			backend: "hcv",
			op,
			ref,
			caller_pid: process.pid,
			success,
			...(error && { error }),
			...(note && { note }),
		};
		const line = JSON.stringify(entry) + "\n";

		try {
			if (this.auditLogPath) {
				fsSync.appendFileSync(this.auditLogPath, line);
			} else {
				process.stderr.write(line);
			}
		} catch {
			// Audit must never crash the caller
		}
	}
}
