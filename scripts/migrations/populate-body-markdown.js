#!/usr/bin/env node
// Populate body_markdown for proposals from local roadmap files
// Usage: PG_PASSWORD=xxx node scripts/migrations/populate-body-markdown.js

import { Client } from 'pg';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const PROPOSALS_DIR = join(ROOT, 'roadmap', 'proposals');

const FILE_MAP = {
  'P001': 'CHILD-RFCS-CREATED.md',
  'P002': 'proposal-001 - Test-Team-Memory-Sprint.md',
  'P003': 'proposal-002 - Fix-hardcoded-SDB-database-names.md',
  'P004': 'proposal-003 - Fix-hardcoded-SDB-database-names.md',
  'P005': 'proposal-004 - Agent-Profile-Upgrade-—-GitHub-Sync-Personality-Injection.md',
  'P006': 'proposal-005 - Messaging-Synchronization.md',
  'P007': 'RFC-20260401-BUSINESS-DESIGN.md',
  'P008': 'RFC-20260401-BUSINESS-STRATEGY.md',
  'P009': 'RFC-20260401-CONFIG-REDESIGN.md',
  'P010': 'RFC-20260401-DATA-MODEL.md',
  'P011': 'RFC-20260401-MCP-TOOL-SPEC.md',
  'P012': 'RFC-20260401-MESSAGES-PULSE.md',
  'P013': 'RFC-20260401-MESSAGING.md',
  'P014': 'RFC-20260401-MOBILE-ALERT.md',
  'P015': 'RFC-20260401-MOBILE-VISIONARY.md',
  'P016': 'RFC-20260401-PIPELINE-PREFLIGHT.md',
  'P017': 'RFC-20260401-PIPELINE-VERIFICATION.md',
  'P018': 'RFC-20260401-PRODUCT-STATEMACHINE.md',
  'P019': 'RFC-20260401-PRODUCT-TEMPLATE.md',
  'P020': 'RFC-20260401-SECURITY-CHILD-051.md',
  'P021': 'RFC-20260401-SECURITY-CHILD-052.md',
  'P022': 'RFC-20260401-SECURITY-CHILD-054.md',
  'P023': 'RFC-20260401-SECURITY-CHILD-056.md',
  'P024': 'RFC-20260401-SECURITY.md',
  'P025': 'RFC-20260401-SPENDING-VISIBILITY.md',
  'P026': 'RFC-20260401-TUI-COCKPIT.md',
  'P027': 'RFC-20260401-WORKFORCE-CORE.md',
};

async function main() {
  const client = new Client({
    host: 'localhost',
    port: 5432,
    database: 'agenthive',
    user: 'admin',
    password: process.env.PG_PASSWORD || '',
  });

  await client.connect();
  let updated = 0;
  let skipped = 0;

  for (const [displayId, filename] of Object.entries(FILE_MAP)) {
    const filePath = join(PROPOSALS_DIR, filename);
    try {
      const body = readFileSync(filePath, 'utf-8');
      if (!body || body.trim().length < 10) {
        console.log(`⊘ ${displayId}: file too short (${body.length} bytes)`);
        skipped++;
        continue;
      }
      const result = await client.query(
        'UPDATE proposal SET body_markdown = $1 WHERE display_id = $2',
        [body, displayId]
      );
      if (result.rowCount > 0) {
        console.log(`✓ ${displayId}: ${body.length} bytes`);
        updated++;
      } else {
        console.log(`✗ ${displayId}: no matching row`);
        skipped++;
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log(`✗ ${displayId}: file not found (${filename})`);
        skipped++;
      } else {
        console.error(`✗ ${displayId}: ${err.message}`);
      }
    }
  }

  // Also delete orphaned proposals (no display_id)
  const orphans = await client.query(
    "DELETE FROM proposal WHERE display_id IS NULL OR display_id = ''"
  );
  if (orphans.rowCount > 0) {
    console.log(`🗑 Deleted ${orphans.rowCount} orphaned proposals`);
  }

  await client.end();
  console.log(`\nDone: ${updated} updated, ${skipped} skipped`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
