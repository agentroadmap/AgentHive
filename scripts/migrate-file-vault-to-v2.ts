#!/usr/bin/env node

/**
 * Migration: File-Vault → Vault v2 (HashiCorp Vault or AWS Secrets Manager)
 *
 * This script migrates existing file-vault secrets to a new backend while
 * maintaining backward compatibility during a grace period.
 *
 * **Phase 1: Dual-read (no downtime)**
 * 1. Deploy HCV adapter alongside file-vault
 * 2. Run this script to:
 *    a. Read from file-vault (source of truth)
 *    b. Write to HCV/AWS (new backend)
 *    c. Verify round-trip (read from new backend, compare)
 *    d. Update project.dsn_secret_ref to point to new backend
 * 3. Existing connections continue using old cached DSNs during grace period (1 week)
 * 4. New connections read from HCV
 *
 * **Phase 2: Cutover**
 * All project.dsn_secret_ref entries now point to HCV/AWS
 *
 * **Phase 3: Cleanup (manual, per operator)**
 * Delete file-vault entries and archive (do not delete for audit trail)
 *
 * Usage:
 *   NODE_ENV=production AGENTHIVE_VAULT_KIND=hcv npx tsx scripts/migrate-file-vault-to-v2.ts
 *
 * Flags:
 *   --dry-run        Show what would be migrated without making changes
 *   --verbose        Log each secret being migrated
 *   --project-id     Migrate only a specific project (UUID)
 *   --start-from     Resume migration from a specific offset
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { getVault } from "../src/shared/vault/index.ts";
import type { SecretRef } from "../src/shared/vault/types.ts";
import { VaultError } from "../src/shared/vault/types.ts";

interface MigrationStats {
	total: number;
	migrated: number;
	failed: number;
	skipped: number;
	errors: Array<{
		ref: SecretRef;
		error: string;
	}>;
}

const dryRun = process.argv.includes("--dry-run");
const verbose = process.argv.includes("--verbose");
const projectIdFilter = process.argv.find(arg => arg.startsWith("--project-id="))?.split("=")[1];

const vault = getVault();

async function main(): Promise<void> {
	console.log(`
╔════════════════════════════════════════════════════════════════╗
║  Vault v2 Migration: File-Vault → KMS-backed Secrets Manager  ║
╚════════════════════════════════════════════════════════════════╝

Mode: ${dryRun ? "DRY RUN (no changes)" : "LIVE (making changes)"}
Vault kind: ${process.env.AGENTHIVE_VAULT_KIND || "file"}
  `);

	if (!process.env.AGENTHIVE_VAULT_KIND || process.env.AGENTHIVE_VAULT_KIND === "file") {
		console.error("ERROR: AGENTHIVE_VAULT_KIND must be set to 'hcv' or 'aws'");
		console.error("This script is intended to migrate FROM file-vault TO a new backend.");
		process.exit(1);
	}

	const stats: MigrationStats = {
		total: 0,
		migrated: 0,
		failed: 0,
		skipped: 0,
		errors: [],
	};

	try {
		// Step 1: Fetch all projects from database (if available)
		// For now, this is a skeleton; in production, query project.dsn_secret_ref
		// and extract vault://file/ entries
		await migrateSecrets(stats);

		// Step 2: Report results
		console.log(`
╔════════════════════════════════════════════════════════════════╗
║  Migration Summary                                             ║
╚════════════════════════════════════════════════════════════════╝

Total secrets found:     ${stats.total}
Successfully migrated:   ${stats.migrated}
Failed:                  ${stats.failed}
Skipped:                 ${stats.skipped}

${dryRun ? "DRY RUN: No changes were made." : "LIVE: All changes have been applied."}

${stats.errors.length > 0 ? "\nErrors encountered:\n" + stats.errors.map(e => `  - ${e.ref}: ${e.error}`).join("\n") : ""}
  `);

		if (stats.failed > 0) {
			process.exit(1);
		}
	} catch (err) {
		console.error("Migration failed:", (err as Error).message);
		process.exit(1);
	}
}

async function migrateSecrets(stats: MigrationStats): Promise<void> {
	// Step 1: Discover all vault://file/ secrets
	// In a full implementation, this would:
	//   1. Query database for projects with dsn_secret_ref starting with "vault://file/"
	//   2. For each secret, perform dual-read verification
	//   3. Update the database ref to point to new backend (optional in this skeleton)
	//
	// For now, this is a skeleton that demonstrates the pattern.

	const exampleSecrets: Array<{
		ref: SecretRef;
		projectId: string;
		projectSlug: string;
	}> = [
		// Example: would come from database query
		// {
		//   ref: "vault://file/project/audiobook/dsn",
		//   projectId: "550e8400-e29b-41d4-a716-446655440000",
		//   projectSlug: "audiobook"
		// },
	];

	stats.total = exampleSecrets.length;

	if (stats.total === 0) {
		console.log("No vault://file/ secrets found in database. Migration skipped.");
		console.log(
			"\nNote: This is a skeleton. In production, secrets are queried from the database.",
		);
		console.log("See comments in this script for the full implementation pattern.");
		return;
	}

	for (const { ref, projectId, projectSlug } of exampleSecrets) {
		if (projectIdFilter && projectId !== projectIdFilter) {
			stats.skipped++;
			continue;
		}

		if (verbose) {
			console.log(`Migrating: ${ref} (project: ${projectSlug})`);
		}

		try {
			// Phase 1: Read from file-vault
			const fileVaultRef = ref as SecretRef;
			const secret = await vault.read(fileVaultRef);

			// Phase 2: Write to new backend
			// Transform the ref to point to new backend
			const newBackendRef = transformRef(fileVaultRef);

			if (dryRun) {
				console.log(`  [DRY RUN] Would write to: ${newBackendRef}`);
				stats.migrated++;
				continue;
			}

			// Write to new backend
			await vault.write(newBackendRef, secret);

			// Phase 3: Verify round-trip
			const readBack = await vault.read(newBackendRef);
			if (readBack !== secret) {
				throw new Error("Round-trip verification failed: value mismatch");
			}

			// Phase 4: Update database ref (optional in this skeleton)
			// await updateProjectDsnRef(projectId, newBackendRef);

			stats.migrated++;

			if (verbose) {
				console.log(`  ✓ Migrated to: ${newBackendRef}`);
			}
		} catch (err) {
			stats.failed++;
			stats.errors.push({
				ref,
				error: (err as Error).message,
			});
			console.error(`  ✗ Failed: ${(err as Error).message}`);
		}
	}
}

function transformRef(fileRef: SecretRef): SecretRef {
	// Transform vault://file/project/audiobook/dsn → vault://hcv/tenants/audiobook/dsn
	// Or → vault://aws/agentHive/audiobook/dsn
	//
	// The choice depends on AGENTHIVE_VAULT_KIND

	const kind = process.env.AGENTHIVE_VAULT_KIND || "file";

	if (fileRef.startsWith("vault://file/")) {
		const pathPart = fileRef.substring("vault://file/".length);

		// Parse: project/<slug>/... → extract slug and secret name
		const match = pathPart.match(/^project\/([^/]+)\/(.+)$/);
		if (!match) {
			throw new Error(`Cannot parse file-vault ref format: ${fileRef}`);
		}

		const [, slug, secretName] = match;

		if (kind === "hcv") {
			// HCV: vault://hcv/tenants/<slug>/<secret-name>
			return `vault://hcv/tenants/${slug}/${secretName}` as SecretRef;
		} else if (kind === "aws") {
			// AWS: vault://aws/agentHive/<slug>/<secret-name>
			return `vault://aws/agentHive/${slug}/${secretName}` as SecretRef;
		} else {
			throw new Error(`Unknown vault kind: ${kind}`);
		}
	}

	throw new Error(`Unexpected vault scheme in ref: ${fileRef}`);
}

// Skeleton: in production, this would update the database
async function updateProjectDsnRef(projectId: string, newRef: SecretRef): Promise<void> {
	// UPDATE project SET dsn_secret_ref = $1 WHERE id = $2;
	//
	// For now, this is a no-op. The migration script is designed to be
	// idempotent and can be run multiple times safely.
	if (verbose) {
		console.log(`  [SKELETON] Would update database: project ${projectId} → ${newRef}`);
	}
}

main().catch(err => {
	console.error("Unexpected error:", err);
	process.exit(1);
});
