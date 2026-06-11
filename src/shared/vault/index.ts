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

function buildRoutingVault(): VaultAdapter {
	const kind = process.env.AGENTHIVE_VAULT_KIND || "file";

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

const vaultInstance = buildRoutingVault();

export function getVault(): VaultAdapter {
	return vaultInstance;
}
