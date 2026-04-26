/**
 * Vault Adapter Chooser (P496)
 *
 * Entry point for vault operations. Selects the appropriate adapter
 * based on configuration.
 *
 * Supported adapters:
 * - file: File-based storage (v1, P496)
 * - hcv: HashiCorp Vault (v2, P515)
 * - aws: AWS Secrets Manager (v2, P515)
 */

import { fileVault } from "./file-vault.ts";
import type { VaultAdapter } from "./types.ts";

export type { VaultAdapter, SecretRef } from "./types.ts";
export {
	VaultError,
	VaultPermissionError,
	VaultSymlinkDetectedError,
	VaultCorruptedError,
	VaultInvalidRefError,
} from "./types.ts";

const vaultInstance = (() => {
	// Get vault kind from environment or config (default: file)
	// TODO: integrate with config.get(VAULT_KIND) when P474 lands
	const kind = process.env.AGENTHIVE_VAULT_KIND || "file";

	switch (kind) {
		case "file":
			return fileVault();
		// TODO: case 'hcv': return hashicorpVault() (P515)
		// TODO: case 'aws': return awsSecretsManager() (P515)
		default:
			throw new Error(`Unknown vault kind: ${kind}`);
	}
})();

/**
 * Get the configured vault adapter instance.
 *
 * @returns VaultAdapter instance
 */
export function getVault(): VaultAdapter {
	return vaultInstance;
}
