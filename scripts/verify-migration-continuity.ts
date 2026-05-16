#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execSync } from "child_process";

interface MigrationRecord {
  filename: string;
  checksum_sha256: string;
}

interface MigrationFile {
  name: string;
  path: string;
  checksum: string;
}

/**
 * Verify migration continuity: all migration files with numeric prefixes
 * are recorded in roadmap.migration_history with matching checksums.
 */
async function verifyMigrationContinuity(): Promise<void> {
  const migrationDirs = [
    "scripts/migrations",
    "database/migrations", // legacy, but check anyway
  ];

  const projectRoot = execSync("git rev-parse --show-toplevel", {
    encoding: "utf8",
  }).trim();

  // Collect all migration files
  const migrationFiles: MigrationFile[] = [];

  for (const dir of migrationDirs) {
    const fullPath = path.join(projectRoot, dir);
    if (!fs.existsSync(fullPath)) {
      continue;
    }

    const files = fs.readdirSync(fullPath).filter((f) => f.endsWith(".sql"));

    for (const file of files) {
      // Extract numeric prefix
      const match = file.match(/^(\d+)-/);
      if (!match) continue;

      const filePath = path.join(fullPath, file);
      const content = fs.readFileSync(filePath, "utf8");
      const checksum = crypto
        .createHash("sha256")
        .update(content)
        .digest("hex");

      migrationFiles.push({
        name: file,
        path: filePath,
        checksum,
      });
    }
  }

  // Sort by numeric prefix
  migrationFiles.sort((a, b) => {
    const numA = parseInt(a.name.split("-")[0]);
    const numB = parseInt(b.name.split("-")[0]);
    return numA - numB;
  });

  // Query migration_history from DB
  let historyRecords: MigrationRecord[] = [];
  try {
    const result = execSync(
      `psql -h 127.0.0.1 -U admin -d agenthive -t -c "SELECT filename, checksum_sha256 FROM roadmap.migration_history ORDER BY id;"`,
      { encoding: "utf8" }
    );

    // Parse psql output: "filename | checksum_sha256"
    historyRecords = result
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const parts = line.split("|").map((p) => p.trim());
        return {
          filename: parts[0],
          checksum_sha256: parts[1],
        };
      });
  } catch (err) {
    console.error(
      "Failed to query migration_history. Check DB connection.",
      err
    );
    process.exit(1);
  }

  // Analyze
  const historySet = new Set(historyRecords.map((r) => r.filename));
  const historyMap = new Map(
    historyRecords.map((r) => [r.filename, r.checksum_sha256])
  );

  let issueCount = 0;

  // Check for files not in history
  console.log("=== Migration Continuity Report ===\n");

  for (const mf of migrationFiles) {
    if (!historySet.has(mf.name)) {
      console.log(`MISSING: ${mf.name}`);
      console.log(`  File exists on disk: ${mf.path}`);
      console.log(`  Checksum: ${mf.checksum}`);
      console.log(`  Not in roadmap.migration_history\n`);
      issueCount++;
    }
  }

  // Check for checksum mismatches
  for (const mf of migrationFiles) {
    const historyChecksum = historyMap.get(mf.name);
    if (historyChecksum && historyChecksum !== mf.checksum) {
      console.log(`MISMATCH: ${mf.name}`);
      console.log(`  On-disk checksum: ${mf.checksum}`);
      console.log(`  History checksum: ${historyChecksum}\n`);
      issueCount++;
    }
  }

  // Summary
  if (issueCount === 0) {
    console.log("✓ All migration files are recorded with matching checksums.");
    process.exit(0);
  } else {
    console.log(
      `✗ Found ${issueCount} issue(s) in migration history continuity.`
    );
    process.exit(1);
  }
}

verifyMigrationContinuity().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
