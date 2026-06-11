/**
 * P515: Migrate file-vault secrets to HashiCorp Vault
 *
 * Usage:
 *   npx ts-node scripts/migrate-file-vault-to-hcv.ts --source-file-root /etc/agenthive/secrets --hcv-addr http://localhost:8200 --role-id <id> --secret-id <id> --dry-run
 *
 * This script:
 * 1. Reads all vault://file/... references from the project table
 * 2. For each, reads the secret from file storage
 * 3. Writes the secret to HCV at vault://hcv/... path
 * 4. Verifies round-trip read
 * 5. Updates project.dsn_secret_ref to point to HCV
 * 6. Logs audit trail with timestamps
 *
 * Dry-run mode (default) shows what would be migrated without making changes.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Command } from "commander";
import { getPgPool } from "../src/db/pg.ts";
import { fileVault, hcvVault } from "../src/shared/vault/index.ts";
import type { VaultAdapter, SecretRef } from "../src/shared/vault/index.ts";

interface MigrationOptions {
	sourceFileRoot: string;
	hcvAddr: string;
	roleId: string;
	secretId: string;
	dryRun: boolean;
	verbose: boolean;
}

interface SecretRecord {
	projectSlug: string;
	currentRef: SecretRef;
	secretValue?: string;
	newRef?: SecretRef;
	success?: boolean;
	error?: string;
}

class VaultMigrator {
	private fileVault: VaultAdapter;
	private hcvVault: VaultAdapter;
	private auditLog: SecretRecord[] = [];

	constructor(opts: MigrationOptions) {
		this.fileVault = fileVault({ basePath: opts.sourceFileRoot });
		this.hcvVault = hcvVault({
			addr: opts.hcvAddr,
			roleId: opts.roleId,
			secretId: opts.secretId,
			mount: "secret", // Default KV v2 mount
		});
	}

	/**
	 * Find all vault://file/... references in the project table.
	 */
	async findFileVaultReferences(): Promise<
		Array<{ slug: string; ref: SecretRef }>
	> {
		const pool = getPgPool("agenthive");
		const result = await pool.query(
			`
      SELECT slug, dsn_secret_ref
      FROM roadmap_project.project
      WHERE dsn_secret_ref LIKE 'vault://file/%'
        AND is_deleted = false
      ORDER BY slug
    `
		);

		return result.rows.map((row: any) => ({
			slug: row.slug,
			ref: row.dsn_secret_ref as SecretRef,
		}));
	}

	/**
	 * Derive HCV path from file-vault ref.
	 *
	 * Example:
	 *   vault://file/project/audiobook/dsn → vault://hcv/tenants/audiobook/dsn
	 */
	deriveHcvPath(slug: string, fileRef: SecretRef): SecretRef {
		// Extract path component after vault://file/
		const filePath = fileRef.slice("vault://file/".length);
		const hcvPath = `vault://hcv/tenants/${slug}/dsn`;
		return hcvPath as SecretRef;
	}

	/**
	 * Migrate a single secret from file to HCV.
	 */
	async migrateSecret(
		slug: string,
		fileRef: SecretRef,
		dryRun: boolean,
		verbose: boolean
	): Promise<SecretRecord> {
		const record: SecretRecord = {
			projectSlug: slug,
			currentRef: fileRef,
		};

		try {
			// 1. Read from file-vault
			if (verbose) console.log(`  → Reading from file-vault: ${fileRef}`);
			const value = await this.fileVault.read(fileRef);
			record.secretValue = value;

			// 2. Derive HCV path
			const hcvRef = this.deriveHcvPath(slug, fileRef);
			record.newRef = hcvRef;

			if (verbose) console.log(`  → HCV target path: ${hcvRef}`);

			// 3. Write to HCV (if not dry-run)
			if (!dryRun) {
				if (verbose) console.log(`  → Writing to HCV...`);
				await this.hcvVault.write(hcvRef, value);

				// 4. Verify round-trip
				if (verbose) console.log(`  → Verifying round-trip...`);
				const readBack = await this.hcvVault.read(hcvRef);
				if (readBack !== value) {
					throw new Error(
						"Round-trip verification failed: values do not match"
					);
				}

				// 5. Update project table
				if (verbose) console.log(`  → Updating project.dsn_secret_ref...`);
				const pool = getPgPool("agenthive");
				await pool.query(
					`
          UPDATE roadmap_project.project
          SET dsn_secret_ref = $1, updated_at = NOW()
          WHERE slug = $2
        `,
					[hcvRef, slug]
				);

				record.success = true;
				if (verbose) console.log(`  ✓ Migration successful for ${slug}`);
			} else {
				record.success = true;
				if (verbose)
					console.log(`  ✓ (dry-run) Would migrate ${slug}`);
			}
		} catch (error) {
			record.success = false;
			record.error = (error as Error).message;
			if (verbose) console.error(`  ✗ Error: ${record.error}`);
		}

		return record;
	}

	/**
	 * Execute the full migration.
	 */
	async migrate(opts: MigrationOptions): Promise<void> {
		console.log("=== Vault v2 Migration (file → HCV) ===\n");

		if (opts.dryRun) {
			console.log("[DRY RUN MODE] No changes will be made.\n");
		}

		// Find all file-vault references
		console.log("Step 1: Discovering file-vault secrets...");
		const refs = await this.findFileVaultReferences();
		console.log(`Found ${refs.length} projects with file-vault secrets.\n`);

		// Migrate each one
		console.log("Step 2: Migrating secrets...");
		for (const { slug, ref } of refs) {
			console.log(`Migrating ${slug}...`);
			const record = await this.migrateSecret(slug, ref, opts.dryRun, opts.verbose);
			this.auditLog.push(record);
		}

		// Summary
		console.log("\nStep 3: Summary");
		const successful = this.auditLog.filter((r) => r.success).length;
		const failed = this.auditLog.filter((r) => !r.success).length;

		console.log(`\nMigration Results:`);
		console.log(`  ✓ Successful: ${successful}/${refs.length}`);
		if (failed > 0) {
			console.log(`  ✗ Failed: ${failed}/${refs.length}`);
		}

		// Print failures
		if (failed > 0) {
			console.log("\nFailures:");
			for (const record of this.auditLog) {
				if (!record.success) {
					console.log(`  - ${record.projectSlug}: ${record.error}`);
				}
			}
		}

		// Write audit log
		const timestamp = new Date().toISOString();
		const auditPath = `migration-${timestamp.split("T")[0]}.audit.json`;
		await fs.writeFile(auditPath, JSON.stringify(this.auditLog, null, 2));
		console.log(`\nAudit log written to: ${auditPath}`);
	}
}

/**
 * Main entry point.
 */
async function main() {
	const program = new Command();

	program
		.name("migrate-file-vault-to-hcv")
		.description("Migrate file-vault secrets to HashiCorp Vault")
		.option(
			"--source-file-root <path>",
			"Root directory for file-vault storage",
			"/etc/agenthive/secrets/"
		)
		.option(
			"--hcv-addr <url>",
			"HashiCorp Vault server address",
			"http://localhost:8200"
		)
		.option("--role-id <id>", "HCV AppRole role_id")
		.option("--secret-id <id>", "HCV AppRole secret_id")
		.option("--dry-run", "Dry-run mode (no changes)", true)
		.option("--no-dry-run", "Actually perform migration")
		.option("-v, --verbose", "Verbose output", false)
		.parse(process.argv);

	const opts = program.opts();

	if (!opts.roleId || !opts.secretId) {
		console.error("Error: --role-id and --secret-id are required");
		process.exit(1);
	}

	const migrator = new VaultMigrator(opts);

	try {
		await migrator.migrate({
			sourceFileRoot: opts.sourceFileRoot,
			hcvAddr: opts.hcvAddr,
			roleId: opts.roleId,
			secretId: opts.secretId,
			dryRun: opts.dryRun,
			verbose: opts.verbose,
		});
	} catch (error) {
		console.error("Migration failed:", error);
		process.exit(1);
	}
}

main();
