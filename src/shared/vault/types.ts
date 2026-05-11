/**
 * Vault Adapter Interface and Types (P496)
 *
 * Abstraction layer for secret storage backends.
 * v1 supports file-based vaults; v2 (P515) adds KMS + HashiCorp Vault.
 */

/**
 * SecretRef identifies a secret in vault-storage notation.
 * Format: vault://scheme/path
 *
 * Examples:
 *   vault://file/project/audiobook/dsn
 *   vault://file/project/audiobook/db_password
 *   vault://hcv/tenants/audiobook/dsn (P515 — HashiCorp Vault KV v2 path)
 *   vault://aws/agentHive/audiobook/dsn (P515 — AWS Secrets Manager name)
 */
export type SecretRef =
	| `vault://file/${string}`
	| `vault://hcv/${string}`
	| `vault://aws/${string}`;

/**
 * Parsed components of a vault://hcv/... SecretRef.
 */
export interface HcvRefParts {
	scheme: "hcv";
	path: string; // KV v2 path relative to configured mount
}

/**
 * Parsed components of a vault://aws/... SecretRef.
 */
export interface AwsRefParts {
	scheme: "aws";
	name: string; // Secrets Manager secret name/ARN
}

/**
 * Authentication methods for HashiCorp Vault.
 *
 * - approle: roleId + secretId (recommended for server-to-server; secrets injected by orchestrator)
 * - k8s:     Kubernetes ServiceAccount JWT auto-mounted at /var/run/secrets/kubernetes.io/serviceaccount/token
 * - aws:     SigV4-signed EC2/ECS instance identity (no explicit credentials in config)
 */
export type HcvAuthMethod =
	| { method: "approle"; roleId: string; secretId: string }
	| { method: "k8s"; role: string; jwtPath?: string }
	| { method: "aws"; role: string; region?: string };

/**
 * Vault adapter interface for reading, writing, and rotating secrets.
 */
export interface VaultAdapter {
	/**
	 * Read a secret from the vault.
	 *
	 * @param ref Secret reference
	 * @returns Secret value
	 * @throws VaultError subclass on failure
	 */
	read(ref: SecretRef): Promise<string>;

	/**
	 * Write a secret to the vault.
	 *
	 * Atomic write; if process crashes mid-write, subsequent read fails fast
	 * with VaultCorrupted error.
	 *
	 * @param ref Secret reference
	 * @param value Secret value
	 * @throws VaultError subclass on failure
	 */
	write(ref: SecretRef, value: string): Promise<void>;

	/**
	 * Rotate (replace) a secret and invalidate in-process cache.
	 *
	 * Equivalent to write() but also clears the read cache for the ref
	 * so subsequent reads see the new value immediately (no 60s TTL wait).
	 *
	 * @param ref Secret reference
	 * @param newValue New secret value
	 * @throws VaultError subclass on failure
	 */
	rotate(ref: SecretRef, newValue: string): Promise<void>;

	/**
	 * Check if a secret exists in the vault.
	 *
	 * @param ref Secret reference
	 * @returns true if the secret file exists and is readable, false otherwise
	 * @throws VaultError subclass on fatal errors (permission denied, etc.)
	 */
	exists(ref: SecretRef): Promise<boolean>;
}

/**
 * Thrown when vault backend is unreachable and no usable stale cache exists.
 */
export class VaultBackendUnavailable extends Error {
	constructor(
		public readonly ref: SecretRef,
		public readonly operation: "read" | "write" | "rotate" | "exists",
		public readonly cause: Error,
	) {
		super(`Vault backend unreachable for ${operation} on "${ref}": ${cause.message}`);
		this.name = "VaultBackendUnavailable";
	}
}

/**
 * Base error class for vault operations.
 */
export class VaultError extends Error {
	constructor(
		public readonly ref: SecretRef,
		public readonly operation: "read" | "write" | "rotate" | "exists",
		message: string,
	) {
		super(message);
		this.name = "VaultError";
	}
}

/**
 * Thrown when file permissions are incorrect.
 *
 * - File mode has bits set in 0o077 (group/other readable/writable)
 * - File mode has bits set outside 0o700 (directory)
 * - File owner UID doesn't match process UID
 */
export class VaultPermissionError extends VaultError {
	constructor(
		ref: SecretRef,
		operation: "read" | "write" | "rotate" | "exists",
		public readonly actualMode: number,
		public readonly actualUid: number | undefined,
		message: string,
	) {
		super(ref, operation, message);
		this.name = "VaultPermissionError";
	}
}

/**
 * Thrown when a symlink is detected before read/write.
 */
export class VaultSymlinkDetectedError extends VaultError {
	constructor(
		ref: SecretRef,
		operation: "read" | "write" | "rotate" | "exists",
		public readonly path: string,
	) {
		super(
			ref,
			operation,
			`Symlink detected at ${path} (vault ref: ${ref}); symlinks are not allowed`,
		);
		this.name = "VaultSymlinkDetectedError";
	}
}

/**
 * Thrown when a file is partially written (corrupted).
 *
 * Indicates a crash during write; the vault file is in an inconsistent state.
 */
export class VaultCorruptedError extends VaultError {
	constructor(
		ref: SecretRef,
		operation: "read" | "write" | "rotate" | "exists",
		message: string,
	) {
		super(ref, operation, message);
		this.name = "VaultCorruptedError";
	}
}

/**
 * Thrown when SecretRef format is invalid.
 */
export class VaultInvalidRefError extends VaultError {
	constructor(
		ref: SecretRef,
		operation: "read" | "write" | "rotate" | "exists",
		message: string,
	) {
		super(ref, operation, message);
		this.name = "VaultInvalidRefError";
	}
}
