/**
 * Vault Adapter Chooser (P496 + P515)
 *
 * Scheme-based routing adapter: dispatches each operation to the appropriate
 * backend based on the SecretRef scheme prefix.
 *
 *   vault://file/<path>  → file-vault (always available; dev/single-host)
 *   vault://hcv/<path>   → HashiCorp Vault KV v2  (AGENTHIVE_VAULT_KIND=hcv)
 *   vault://aws/<name>   → AWS Secrets Manager     (AGENTHIVE_VAULT_KIND=aws)
 *
 * The file-vault backend is always initialized as the dev/fallback adapter.
 * HCV and AWS backends are only initialized when AGENTHIVE_VAULT_KIND is set.
 *
 * Configuration via environment:
 *   AGENTHIVE_VAULT_KIND      file | hcv | aws   (default: file)
 *   AGENTHIVE_VAULT_ROOT      base path for file-vault
 *   AGENTHIVE_HCV_ADDR        Vault server address (http://127.0.0.1:8200)
 *   AGENTHIVE_HCV_ROLE_ID_FILE  path to AppRole role_id file
 *   AGENTHIVE_HCV_SECRET_ID_FILE  path to AppRole secret_id file
 *   AGENTHIVE_HCV_MOUNT       KV v2 mount name (default: secret)
 *   AGENTHIVE_HCV_NAMESPACE   Vault Enterprise namespace
 *   AGENTHIVE_HCV_AUDIT_LOG   path to audit log file (default: stderr)
 *   AGENTHIVE_AWS_REGION      AWS region for Secrets Manager
 */

import { fileVault } from "./file-vault.ts";
import { hcvVault } from "./hcv-vault.ts";
import { awsVault } from "./aws-vault.ts";
import type { VaultAdapter, SecretRef } from "./types.ts";
import { VaultInvalidRefError } from "./types.ts";
import {
	fetchActiveProvider,
	type QueryablePool,
	type VaultProviderType,
} from "./db-provider.ts";

export type { VaultAdapter, SecretRef } from "./types.ts";
export {
	VaultError,
	VaultPermissionError,
	VaultSymlinkDetectedError,
	VaultCorruptedError,
	VaultInvalidRefError,
	VaultUnavailableError,
	VaultAuthError,
} from "./types.ts";

export { fileVault } from "./file-vault.ts";
export type { FileVaultOptions } from "./file-vault.ts";
export { hcvVault } from "./hcv-vault.ts";
export type { HcvVaultOptions } from "./hcv-vault.ts";
export { awsVault } from "./aws-vault.ts";
export type { AwsVaultOptions } from "./aws-vault.ts";

/**
 * Build the scheme-routing adapter for a resolved vault `kind`.
 *
 * `kind` is the *active* backend (file | hcv | aws). When omitted, it is read
 * from AGENTHIVE_VAULT_KIND (default "file") — the original env-only behaviour,
 * preserved as the fallback path for the DB cutover.
 */
function buildRoutingVault(kind?: string): VaultAdapter {
	kind = kind || process.env.AGENTHIVE_VAULT_KIND || "file";

	const fileAdapter = fileVault();

	let hcvAdapter: VaultAdapter | null = null;
	let awsAdapter: VaultAdapter | null = null;

	if (kind === "hcv") {
		const addr = process.env.AGENTHIVE_HCV_ADDR;
		if (!addr) {
			throw new Error(
				"AGENTHIVE_HCV_ADDR is required when AGENTHIVE_VAULT_KIND=hcv",
			);
		}
		hcvAdapter = hcvVault({
			addr,
			roleIdFile: process.env.AGENTHIVE_HCV_ROLE_ID_FILE,
			secretIdFile: process.env.AGENTHIVE_HCV_SECRET_ID_FILE,
			mount: process.env.AGENTHIVE_HCV_MOUNT,
			namespace: process.env.AGENTHIVE_HCV_NAMESPACE,
			auditLogPath: process.env.AGENTHIVE_HCV_AUDIT_LOG,
		});
	} else if (kind === "aws") {
		const region = process.env.AGENTHIVE_AWS_REGION;
		if (!region) {
			throw new Error(
				"AGENTHIVE_AWS_REGION is required when AGENTHIVE_VAULT_KIND=aws",
			);
		}
		awsAdapter = awsVault({ region });
	}

	const routingAdapter: VaultAdapter = {
		read(ref: SecretRef) {
			if (ref.startsWith("vault://file/")) return fileAdapter.read(ref);
			if (ref.startsWith("vault://hcv/")) {
				if (!hcvAdapter) {
					throw new VaultInvalidRefError(
						ref,
						"read",
						"HCV vault ref received but AGENTHIVE_VAULT_KIND≠hcv; set AGENTHIVE_VAULT_KIND=hcv",
					);
				}
				return hcvAdapter.read(ref);
			}
			if (ref.startsWith("vault://aws/")) {
				if (!awsAdapter) {
					throw new VaultInvalidRefError(
						ref,
						"read",
						"AWS vault ref received but AGENTHIVE_VAULT_KIND≠aws; set AGENTHIVE_VAULT_KIND=aws",
					);
				}
				return awsAdapter.read(ref);
			}
			throw new VaultInvalidRefError(
				ref,
				"read",
				`Unknown vault scheme in ref: ${ref}`,
			);
		},
		write(ref: SecretRef, value: string) {
			if (ref.startsWith("vault://file/")) return fileAdapter.write(ref, value);
			if (ref.startsWith("vault://hcv/")) {
				if (!hcvAdapter)
					throw new VaultInvalidRefError(
						ref,
						"write",
						"HCV vault ref received but AGENTHIVE_VAULT_KIND≠hcv",
					);
				return hcvAdapter.write(ref, value);
			}
			if (ref.startsWith("vault://aws/")) {
				if (!awsAdapter)
					throw new VaultInvalidRefError(
						ref,
						"write",
						"AWS vault ref received but AGENTHIVE_VAULT_KIND≠aws",
					);
				return awsAdapter.write(ref, value);
			}
			throw new VaultInvalidRefError(
				ref,
				"write",
				`Unknown vault scheme in ref: ${ref}`,
			);
		},
		rotate(ref: SecretRef, newValue: string) {
			if (ref.startsWith("vault://file/"))
				return fileAdapter.rotate(ref, newValue);
			if (ref.startsWith("vault://hcv/")) {
				if (!hcvAdapter)
					throw new VaultInvalidRefError(
						ref,
						"rotate",
						"HCV vault ref received but AGENTHIVE_VAULT_KIND≠hcv",
					);
				return hcvAdapter.rotate(ref, newValue);
			}
			if (ref.startsWith("vault://aws/")) {
				if (!awsAdapter)
					throw new VaultInvalidRefError(
						ref,
						"rotate",
						"AWS vault ref received but AGENTHIVE_VAULT_KIND≠aws",
					);
				return awsAdapter.rotate(ref, newValue);
			}
			throw new VaultInvalidRefError(
				ref,
				"rotate",
				`Unknown vault scheme in ref: ${ref}`,
			);
		},
		exists(ref: SecretRef) {
			if (ref.startsWith("vault://file/")) return fileAdapter.exists(ref);
			if (ref.startsWith("vault://hcv/")) {
				if (!hcvAdapter)
					throw new VaultInvalidRefError(
						ref,
						"exists",
						"HCV vault ref received but AGENTHIVE_VAULT_KIND≠hcv",
					);
				return hcvAdapter.exists(ref);
			}
			if (ref.startsWith("vault://aws/")) {
				if (!awsAdapter)
					throw new VaultInvalidRefError(
						ref,
						"exists",
						"AWS vault ref received but AGENTHIVE_VAULT_KIND≠aws",
					);
				return awsAdapter.exists(ref);
			}
			throw new VaultInvalidRefError(
				ref,
				"exists",
				`Unknown vault scheme in ref: ${ref}`,
			);
		},
	};

	return routingAdapter;
}

// ---------------------------------------------------------------------------
// P1072: DB-driven provider selection + sync→async getVault() cutover
//
// No-log policy (AC-7): the [vault] init logs below intentionally emit ONLY
// non-sensitive identifiers — provider_type and the provider slug — never a
// secret value. Secret values are returned by VaultAdapter.read() at call time
// and are never passed to console.* anywhere in this package. Secrets are held
// encrypted-at-rest in the backing vault; this module only resolves *which*
// adapter/ref to use. See docs/vault/encryption-at-rest.md.
// ---------------------------------------------------------------------------

/**
 * Map a DB `vault_provider.provider_type` to the routing `kind` used by
 * buildRoutingVault(). Pure — no DB, no env. (AC-22)
 *
 *   file        → file
 *   hcp_vault   → hcv
 *   aws_secrets → aws
 *   env         → env   (no vault:// scheme; secrets read from process.env)
 */
export function mapProviderTypeToKind(
	providerType: VaultProviderType,
): "file" | "hcv" | "aws" | "env" {
	switch (providerType) {
		case "file":
			return "file";
		case "hcp_vault":
			return "hcv";
		case "aws_secrets":
			return "aws";
		case "env":
			return "env";
	}
}

/**
 * Build a vault:// SecretRef for a provider type + vault path. Pure — no DB.
 * `env` providers have no vault scheme, so they return null. (AC-21)
 *
 *   file        → vault://file/<path>
 *   hcp_vault   → vault://hcv/<path>
 *   aws_secrets → vault://aws/<path>
 *   env         → null
 *
 * Leading slashes on `vaultPath` are trimmed so the result is a well-formed
 * `vault://<scheme>/<path>` ref (matches db-provider.fetchCredentialRef).
 */
export function buildSecretRef(
	providerType: VaultProviderType,
	vaultPath: string,
): SecretRef | null {
	const kind = mapProviderTypeToKind(providerType);
	if (kind === "env") return null;
	const path = vaultPath.replace(/^\/+/, "");
	return `vault://${kind}/${path}` as SecretRef;
}

/**
 * Sync env/file fallback adapter, built eagerly at module load from
 * AGENTHIVE_VAULT_KIND (or "file"). This is the value returned by:
 *  - getVaultSync() always (AC-20), and
 *  - getVault() before/without a successful initVaultFromDb().
 */
let vaultInstance: VaultAdapter = buildRoutingVault();

/**
 * Synchronous fallback accessor (AC-20). Returns a functional VaultAdapter
 * even if initVaultFromDb() was never called — uses AGENTHIVE_VAULT_KIND or the
 * file default. Never throws. Existing sync call sites that cannot be made
 * async can keep using this; it just never sees DB-selected providers.
 */
export function getVaultSync(): VaultAdapter {
	return vaultInstance;
}

/**
 * Memoized init promise — guarantees initVaultFromDb() is idempotent and that
 * concurrent callers await the same promise (no duplicate DB lookups). (AC-18)
 */
let initPromise: Promise<VaultAdapter> | null = null;

/** Minimal accessor shape so this module never hard-imports pool-registry. */
type ControlPoolGetter = () => QueryablePool;

/**
 * Initialize the vault adapter from the hiveCentral control plane (AC-1/14/19).
 *
 * Order of precedence:
 *  1. AGENTHIVE_VAULT_KIND set (non-empty) → hard env override, skip DB. (AC-19)
 *  2. Active row in control_credential.vault_provider → use its provider_type. (AC-1)
 *  3. Anything fails (no control pool, DB error, no active row) → keep the
 *     eager env/file fallback. Non-fatal: logs a single [vault] warn. (AC-10/24)
 *
 * Idempotent + concurrency-safe via a memoized promise (AC-18). The resolved
 * adapter is also stored in `vaultInstance` so getVaultSync() reflects it.
 *
 * `getControlPool` is injected (defaults to the pool-registry singleton) so the
 * unit tests can drive it with a mocked pool and no live DB.
 */
export function initVaultFromDb(
	getControlPool?: ControlPoolGetter,
): Promise<VaultAdapter> {
	if (initPromise) return initPromise;
	initPromise = (async () => {
		// AC-19: hard env override — set + non-empty wins, DB untouched.
		const envKind = process.env.AGENTHIVE_VAULT_KIND;
		if (envKind && envKind.trim() !== "") {
			console.error(
				`[vault] Adapter initialized from env: AGENTHIVE_VAULT_KIND=${envKind}`,
			);
			vaultInstance = buildRoutingVault(envKind);
			return vaultInstance;
		}

		try {
			const getPool =
				getControlPool ??
				(await import("../../postgres/pool-registry.ts"))
					.getControlPool as unknown as ControlPoolGetter;
			const pool = getPool();
			const provider = await fetchActiveProvider(pool);
			if (!provider) {
				console.error(
					"[vault] No active vault_provider row; env fallback active",
				);
				return vaultInstance;
			}
			const kind = mapProviderTypeToKind(provider.provider_type);
			vaultInstance = buildRoutingVault(kind === "env" ? "file" : kind);
			console.error(
				`[vault] Adapter initialized from DB: provider_type=${provider.provider_type} (slug=${provider.slug})`,
			);
			return vaultInstance;
		} catch (err) {
			console.error(
				`[vault] DB init failed (env fallback active): ${
					(err as Error).message
				}`,
			);
			return vaultInstance;
		}
	})();
	return initPromise;
}

/** Test-only: reset the memoized init promise so each test starts clean. */
export function __resetVaultInitForTest(): void {
	initPromise = null;
	vaultInstance = buildRoutingVault();
}

/**
 * Async vault accessor (P1072 cutover). Awaits DB-driven initialization on
 * first call, then returns the resolved adapter. If init already ran, this is a
 * cheap await of the settled promise. If init was never started, it kicks off
 * the default (pool-registry-backed) init.
 *
 * BREAKING CHANGE: getVault() was synchronous (`getVault(): VaultAdapter`).
 * It is now async (`getVault(): Promise<VaultAdapter>`). All call sites must
 * `await getVault()`. Sync-only call sites should migrate to getVaultSync().
 */
export function getVault(): Promise<VaultAdapter> {
	return initPromise ?? initVaultFromDb();
}
