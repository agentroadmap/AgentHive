// Populate body_markdown from local markdown files into Postgres
// Run: cd /data/code/AgentHive && node scripts/migrations/fill-body.cjs

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROPOSALS_DIR = path.join(__dirname, '../../roadmap/proposals');

// Map display_id -> md filename
const map = {
  P001: 'CHILD-RFCS-CREATED.md',
  P002: 'proposal-001 - Test-Team-Memory-Sprint.md',
  P003: 'proposal-002 - Fix-hardcoded-SDB-database-names.md',
  P004: 'proposal-003 - Fix-hardcoded-SDB-database-names.md',
  P005: 'proposal-004 - Agent-Profile-Upgrade-—-GitHub-Sync-Personality-Injection.md',
  P006: 'proposal-005 - Messaging-Synchronization.md',
  P007: 'RFC-20260401-BUSINESS-DESIGN.md',
  P008: 'RFC-20260401-BUSINESS-STRATEGY.md',
  P009: 'RFC-20260401-CONFIG-REDESIGN.md',
  P010: 'RFC-20260401-DATA-MODEL.md',
  P011: 'RFC-20260401-MCP-TOOL-SPEC.md',
  P012: 'RFC-20260401-MESSAGES-PULSE.md',
  P013: 'RFC-20260401-MESSAGING.md',
  P014: 'RFC-20260401-MOBILE-ALERT.md',
  P015: 'RFC-20260401-MOBILE-VISIONARY.md',
  P016: 'RFC-20260401-PIPELINE-PREFLIGHT.md',
  P017: 'RFC-20260401-PIPELINE-VERIFICATION.md',
  P018: 'RFC-20260401-PRODUCT-STATEMACHINE.md',
  P019: 'RFC-20260401-PRODUCT-TEMPLATE.md',
  P020: 'RFC-20260401-SECURITY-CHILD-051.md',
  P021: 'RFC-20260401-SECURITY-CHILD-052.md',
  P022: 'RFC-20260401-SECURITY-CHILD-054.md',
  P023: 'RFC-20260401-SECURITY-CHILD-056.md',
  P024: 'RFC-20260401-SECURITY.md',
  P025: 'RFC-20260401-SPENDING-VISIBILITY.md',
  P026: 'RFC-20260401-TUI-COCKPIT.md',
  P027: 'RFC-20260401-WORKFORCE-CORE.md',
};

console.log('=== Populating body_markdown from local files ===');

const updates = [];
let updated = 0;
let missing = 0;
let total = 0;

for (const [id, fname] of Object.entries(map)) {
  total++;
  const fpath = path.join(PROPOSALS_DIR, fname);
  if (!fs.existsSync(fpath)) {
    console.log(`  MISSING: ${id} -> ${fname}`);
    missing++;
    continue;
  }
  const content = fs.readFileSync(fpath, 'utf-8');
  // Escape single quotes for SQL
  const escaped = content.replace(/'/g, "''");
  const sql = `UPDATE proposal SET body_markdown = '${escaped}' WHERE display_id = '${id}';`;
  updates.push(sql);
  updated++;
}

// Also delete orphan proposals (no display_id)
updates.push("DELETE FROM proposal WHERE display_id IS NULL OR trim(display_id) = '';");

if (updates.length === 0) {
  console.log('No updates to write');
  process.exit(0);
}

// Write SQL file
const sqlFile = '/tmp/fill-body-markdown.sql';
const allSql = `BEGIN;\n\n${updates.join('\n')}\n\nCOMMIT;`;
fs.writeFileSync(sqlFile, allSql);

console.log(`\nSQL file: ${sqlFile}`);
console.log(`Updates: ${updated}/${total}, Missing: ${missing}`);

// Execute it
const cmd = `docker exec -i postgres-db psql -U admin -d agenthive -f ${sqlFile}`;
console.log(`\nExecuting: ${updates.length} statements + COMMIT...\n`);
try {
  const result = execSync(cmd, { encoding: 'utf-8', timeout: 30000 });
  console.log(result);
} catch (err) {
  console.error('EXEC ERROR:', err.stderr || err.stdout || err.message);
}
