/**
 * P1072: DB-driven vault provider — read the active vault provider + credential
 * references from the hiveCentral control plane (control_credential schema)
 * instead of from environment variables.
 *
 * Pure data-access layer: every function takes its pool/client explicitly, so
 * the module holds NO global handle and is fully unit-testable with a mocked
 * pool (the P827/P828 pattern). The LIVE wiring — calling these from vault
 * bootstrap against the real hiveCentral control pool, and the breaking
 * sync→async getVault() migration — is a separate, higher-blast-radius step
 * tracked by AC-4/AC-14 and is NOT done here.
 *
 * Schema (verified live in hiveCentral):
 *   control_credential.vault_provider(id, slug, provider_type CHECK
 *     IN env|file|hcp_vault|aws_secrets, config jsonb, lifecycle_status
 *     CHECK IN active|deprecated|retired|blocked, ...)
 *   control_credential.v_active_credentials(credential_name, credential_type,
 *     vault_path, provider_slug, provider_type, ...) — active creds joined to
 *     their active provider.
 *
 * ── Encryption-at-rest & no-log policy (AC-7) ──────────────────────────────
 * The control plane stores only POINTERS, never secret material:
 *   - control_credential.vault_provider holds provider config (paths, mount
 *     names, region) — no secret values.
 *   - control_credential.credential holds `vault_path` (a location reference)
 *     and metadata (type, rotation schedule, owner DID) — there is NO plaintext
 *     `credential` value column. The actual secret bytes live encrypted-at-rest
 *     in the backing vault (file-vault 0600 files, HashiCorp Vault KV v2, or
 *     AWS Secrets Manager), which this layer never reads.
 * Consequently, NOTHING in this module ever holds a decrypted secret value, so
 * none can be logged. The only thing read here is the *reference* (vault_path /
 * vault:// ref) plus non-sensitive metadata. The hard rule for this whole
 * package: log refs, provider_type, and slugs — NEVER a secret value returned
 * by VaultAdapter.read(). See the matching guarantee in ./index.ts and the
 * policy doc at docs/vault/encryption-at-rest.md.
 */

import type { SecretRef } from "./types.ts";

/** Minimal structural pool used for plain reads — easy to mock in tests. */
export interface QueryablePool {
	query<R = Record<string, unknown>>(
		sql: string,
		params?: unknown[],
	): Promise<{ rows: R[] }>;
}

/** Minimal structural client for a held transaction (withPrincipal). */
export interface TxnClient {
	query(sql: string, params?: unknown[]): Promise<unknown>;
	release(): void;
}

/** Pool that can hand out a held client. */
export interface ConnectablePool {
	connect(): Promise<TxnClient>;
}

export type VaultProviderType = "env" | "file" | "hcp_vault" | "aws_secrets";

export interface ActiveVaultProvider {
	id: string;
	slug: string;
	provider_type: VaultProviderType;
	config: Record<string, unknown>;
}

/**
 * The active vault provider of a given type, or the single active provider when
 * `providerType` is omitted. Returns null when none is active.
 *
 * Fully-qualified table name; never throws on "no rows" (returns null).
 */
export async function fetchActiveProvider(
	pool: QueryablePool,
	providerType?: VaultProviderType,
): Promise<ActiveVaultProvider | null> {
	const rows = providerType
		? (
				await pool.query<ActiveVaultProvider>(
					`SELECT id, slug, provider_type, config
					   FROM control_credential.vault_provider
					  WHERE lifecycle_status = 'active' AND provider_type = $1
					  ORDER BY updated_at DESC
					  LIMIT 1`,
					[providerType],
				)
			).rows
		: (
				await pool.query<ActiveVaultProvider>(
					`SELECT id, slug, provider_type, config
					   FROM control_credential.vault_provider
					  WHERE lifecycle_status = 'active'
					  ORDER BY updated_at DESC
					  LIMIT 1`,
				)
			).rows;
	return rows[0] ?? null;
}

/** provider_type → the vault:// scheme prefix. `env` has no vault scheme. */
function schemeFor(providerType: VaultProviderType): "file" | "hcv" | "aws" | null {
	switch (providerType) {
		case "file":
			return "file";
		case "hcp_vault":
			return "hcv";
		case "aws_secrets":
			return "aws";
		case "env":
			return null;
	}
}

export interface CredentialRefResult {
	/**
	 * For vault-backed providers (file/hcp_vault/aws_secrets): a `vault://<scheme>/<path>`
	 * SecretRef. For an `env` provider: the raw env var name (vault_path), since
	 * env secrets are read directly from process.env, not via a vault:// ref.
	 */
	ref: SecretRef | string;
	provider_type: VaultProviderType;
	/** True when `ref` is a vault:// SecretRef (vs. a bare env var name). */
	isVaultRef: boolean;
}

/**
 * Resolve an active credential by name into a vault reference. Returns null when
 * the credential is not active / not found. Reads the joined active view so a
 * credential bound to a deprecated provider is invisible.
 */
export async function fetchCredentialRef(
	pool: QueryablePool,
	credentialName: string,
): Promise<CredentialRefResult | null> {
	const { rows } = await pool.query<{
		vault_path: string;
		provider_type: VaultProviderType;
	}>(
		`SELECT vault_path, provider_type
		   FROM control_credential.v_active_credentials
		  WHERE credential_name = $1
		  LIMIT 1`,
		[credentialName],
	);
	const row = rows[0];
	if (!row) return null;

	const scheme = schemeFor(row.provider_type);
	if (scheme == null) {
		// env provider: the "ref" is the env var name itself.
		return { ref: row.vault_path, provider_type: row.provider_type, isVaultRef: false };
	}
	const path = row.vault_path.replace(/^\/+/, "");
	return {
		ref: `vault://${scheme}/${path}` as SecretRef,
		provider_type: row.provider_type,
		isVaultRef: true,
	};
}

/**
 * Run `fn` inside a transaction that has `app.current_principal_did` set for the
 * duration (so RLS / audit triggers in control_credential attribute the read to
 * the caller's DID). Always commits on success, rolls back on error, and always
 * releases the client. SET LOCAL is scoped to the transaction, so the GUC is
 * cleared automatically when the txn ends.
 */
export async function withPrincipal<T>(
	pool: ConnectablePool,
	principalDid: string,
	fn: (client: TxnClient) => Promise<T>,
): Promise<T> {
	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		// set_config(..., is_local=true) — scoped to this transaction only.
		await client.query("SELECT set_config('app.current_principal_did', $1, true)", [
			principalDid,
		]);
		const result = await fn(client);
		await client.query("COMMIT");
		return result;
	} catch (err) {
		await (client.query("ROLLBACK") as Promise<unknown>).catch(() => {});
		throw err;
	} finally {
		client.release();
	}
}
