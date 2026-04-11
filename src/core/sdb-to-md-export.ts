/**
 * sdb-to-md-export.ts
 *
 * SDB → Markdown Export: Establishes the physical Git-mirror of the SDB "Soul".
 *
 * Reads proposals, criteria, decisions, and attachments from SpacetimeDB
 * and writes them as structured markdown files for version control.
 *
 * Usage:
 *   npx tsx src/core/sdb-to-md-export.ts              # Export all
 *   npx tsx src/core/sdb-to-md-export.ts --id RFC-105  # Export single
 *   npx tsx src/core/sdb-to-md-export.ts --since 1h    # Export changed since
 */

import { SDB_CONFIG } from "../constants/index.js";
import { writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import { execSync } from 'child_process';

// ─── Config ─────────────────────────────────────────────────────────

const SDB_URL = SDB_CONFIG.SDB_URL;
const DB_ID = SDB_CONFIG.DB_ID;
const EXPORT_ROOT = process.env.EXPORT_ROOT || 'product/proposals';
const SYNC_LEDGER = process.env.SYNC_LEDGER || '.sdb-sync-ledger.json';

// ─── Types ───────────────────────────────────────────────────────────

interface Proposal {
  id: bigint;
  displayId: string;
  parentId: bigint | null;
  proposalType: string;
  category: string;
  domainId: string;
  title: string;
  status: string;
  priority: string;
  bodyMarkdown: string | null;
  processLogic: string | null;
  maturityLevel: number | null;
  repositoryPath: string | null;
  budgetLimitUsd: number;
  tags: string | null;
  createdAt: bigint;
  updatedAt: bigint;
}

interface Criteria {
  id: bigint;
  proposalId: bigint;
  description: string;
  isVerified: boolean;
}

interface Decision {
  id: bigint;
  proposalId: bigint;
  title: string;
  decisionSummary: string;
  rationale: string;
  status: string;
  createdAt: bigint;
}

interface Attachment {
  id: bigint;
  proposalId: bigint;
  displayId: string;
  fileName: string;
  relativePath: string;
  fileType: string;
  contentHash: string;
  visionSummary: string | null;
  timestamp: bigint;
}

interface SyncEntry {
  artifactPath: string;
  lastSdbHash: string;
  lastGitCommit: string;
  syncStatus: string;
  lastSyncedAt: number;
  errorMessage?: string;
}

// ─── SDB Query Helpers ───────────────────────────────────────────────

function sdbSql(query: string): any[][] {
  try {
    const result = execSync(
      `curl -s "${SDB_URL}/v1/database/${DB_ID}/sql" -H "Content-Type: application/json" -d '${JSON.stringify({ query })}'`,
      { encoding: 'utf8', timeout: 10000 }
    );
    const parsed = JSON.parse(result);
    if (parsed.error) throw new Error(parsed.error);
    return parsed.rows || [];
  } catch (e: any) {
    throw new Error(`SDB query failed: ${e.message}`);
  }
}

function fetchAllProposals(): Proposal[] {
  const rows = sdbSql('SELECT * FROM proposal');
  return rows.map(r => ({
    id: BigInt(r[0]),
    displayId: r[1],
    parentId: r[2] != null ? BigInt(r[2]) : null,
    proposalType: r[3],
    category: r[4],
    domainId: r[5],
    title: r[6],
    status: r[7],
    priority: r[8],
    bodyMarkdown: r[9],
    processLogic: r[10],
    maturityLevel: r[11],
    repositoryPath: r[12],
    budgetLimitUsd: Number(r[13]),
    tags: r[14],
    createdAt: BigInt(r[15]),
    updatedAt: BigInt(r[16]),
  }));
}

function fetchCriteria(proposalId: bigint): Criteria[] {
  const rows = sdbSql(`SELECT * FROM proposal_criteria WHERE proposal_id = ${proposalId}`);
  return rows.map(r => ({
    id: BigInt(r[0]),
    proposalId: BigInt(r[1]),
    description: r[2],
    isVerified: Boolean(r[3]),
  }));
}

function fetchDecisions(proposalId: bigint): Decision[] {
  const rows = sdbSql(`SELECT * FROM proposal_decision WHERE proposal_id = ${proposalId}`);
  return rows.map(r => ({
    id: BigInt(r[0]),
    proposalId: BigInt(r[1]),
    title: r[2],
    decisionSummary: r[3],
    rationale: r[4],
    status: r[5],
    createdAt: BigInt(r[6]),
  }));
}

function fetchAttachments(proposalId: bigint): Attachment[] {
  const rows = sdbSql(`SELECT * FROM attachment_registry WHERE proposal_id = ${proposalId}`);
  return rows.map(r => ({
    id: BigInt(r[0]),
    proposalId: BigInt(r[1]),
    displayId: r[2],
    fileName: r[3],
    relativePath: r[4],
    fileType: r[5],
    contentHash: r[6],
    visionSummary: r[7],
    timestamp: BigInt(r[8]),
  }));
}

// ─── Markdown Rendering ─────────────────────────────────────────────

function formatDate(micros: bigint): string {
  return new Date(Number(micros) / 1000).toISOString().split('T')[0];
}

function renderProposal(proposal: Proposal, criteria: Criteria[], decisions: Decision[], attachments: Attachment[]): string {
  const lines: string[] = [];

  // Frontmatter
  lines.push('---');
  lines.push(`display_id: "${proposal.displayId}"`);
  lines.push(`title: "${proposal.title.replace(/"/g, '\\"')}"`);
  lines.push(`type: "${proposal.proposalType}"`);
  lines.push(`category: "${proposal.category}"`);
  lines.push(`domain: "${proposal.domainId}"`);
  lines.push(`status: "${proposal.status}"`);
  lines.push(`priority: "${proposal.priority}"`);
  if (proposal.maturityLevel != null) lines.push(`maturity: ${proposal.maturityLevel}`);
  if (proposal.parentId != null) lines.push(`parent_id: ${proposal.parentId}`);
  if (proposal.repositoryPath) lines.push(`repo: "${proposal.repositoryPath}"`);
  lines.push(`budget_usd: ${proposal.budgetLimitUsd}`);
  if (proposal.tags) lines.push(`tags: "${proposal.tags}"`);
  lines.push(`created: "${formatDate(proposal.createdAt)}"`);
  lines.push(`updated: "${formatDate(proposal.updatedAt)}"`);
  lines.push('---');
  lines.push('');

  // Title
  lines.push(`# ${proposal.displayId}: ${proposal.title}`);
  lines.push('');

  // Status badge
  lines.push(`**Status:** ${proposal.status} | **Priority:** ${proposal.priority} | **Type:** ${proposal.proposalType}`);
  lines.push('');

  // Body
  if (proposal.bodyMarkdown) {
    lines.push(proposal.bodyMarkdown);
    lines.push('');
  }

  // Process Logic
  if (proposal.processLogic) {
    lines.push('## Process Logic');
    lines.push('');
    lines.push(proposal.processLogic);
    lines.push('');
  }

  // Acceptance Criteria
  if (criteria.length > 0) {
    lines.push('## Acceptance Criteria');
    lines.push('');
    for (const c of criteria) {
      const check = c.isVerified ? 'x' : ' ';
      lines.push(`- [${check}] ${c.description}`);
    }
    lines.push('');
  }

  // Decisions (ADR section)
  if (decisions.length > 0) {
    lines.push('## Decisions');
    lines.push('');
    for (const d of decisions) {
      lines.push(`### ${d.title}`);
      lines.push('');
      lines.push(`**Summary:** ${d.decisionSummary}`);
      lines.push('');
      lines.push(`**Rationale:** ${d.rationale}`);
      lines.push('');
      lines.push(`**Status:** ${d.status} | **Date:** ${formatDate(d.createdAt)}`);
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  // Attachments
  if (attachments.length > 0) {
    lines.push('## Attachments');
    lines.push('');
    for (const a of attachments) {
      const vision = a.visionSummary ? ` — ${a.visionSummary}` : '';
      lines.push(`- [${a.fileName}](${a.relativePath}) (${a.fileType})${vision}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Sync Ledger ─────────────────────────────────────────────────────

function loadSyncLedger(): Map<string, SyncEntry> {
  if (!existsSync(SYNC_LEDGER)) return new Map();
  try {
    const data = JSON.parse(require('fs').readFileSync(SYNC_LEDGER, 'utf8'));
    return new Map(Object.entries(data));
  } catch {
    return new Map();
  }
}

function saveSyncLedger(ledger: Map<string, SyncEntry>): void {
  const obj: Record<string, SyncEntry> = {};
  for (const [k, v] of ledger) obj[k] = v;
  writeFileSync(SYNC_LEDGER, JSON.stringify(obj, null, 2));
}

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// ─── Export Logic ────────────────────────────────────────────────────

function getExportDir(proposal: Proposal): string {
  // Group by type: product/proposals/RFC/RFC-105.md
  const typeDir = proposal.proposalType.toLowerCase().replace('_', '-');
  return join(EXPORT_ROOT, typeDir);
}

function getExportPath(proposal: Proposal): string {
  return join(getExportDir(proposal), `${proposal.displayId}.md`);
}

function gitCommit(message: string): string | null {
  try {
    execSync('git add -A', { cwd: process.cwd() });
    const result = execSync(`git commit -m "${message}" --allow-empty`, {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    const sha = execSync('git rev-parse HEAD', { cwd: process.cwd(), encoding: 'utf8' }).trim();
    console.log(`  ✅ Committed: ${sha.slice(0, 8)} — ${message}`);
    return sha;
  } catch (e: any) {
    console.error(`  ❌ Git commit failed: ${e.message}`);
    return null;
  }
}

// ─── Main ────────────────────────────────────────────────────────────

export function exportProposal(proposal: Proposal, syncLedger: Map<string, SyncEntry>): boolean {
  const criteria = fetchCriteria(proposal.id);
  const decisions = fetchDecisions(proposal.id);
  const attachments = fetchAttachments(proposal.id);

  const content = renderProposal(proposal, criteria, decisions, attachments);
  const hash = contentHash(content);
  const exportPath = getExportPath(proposal);
  const relPath = exportPath.replace(process.cwd() + '/', '');

  // Check if content changed
  const existing = syncLedger.get(relPath);
  if (existing && existing.lastSdbHash === hash) {
    return false; // No change
  }

  // Write file
  const dir = dirname(exportPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(exportPath, content);

  // Update sync ledger
  syncLedger.set(relPath, {
    artifactPath: relPath,
    lastSdbHash: hash,
    lastGitCommit: '',
    syncStatus: 'PENDING',
    lastSyncedAt: Date.now(),
  });

  console.log(`  📄 ${relPath} (${criteria.length} AC, ${decisions.length} decisions)`);
  return true;
}

export function exportAll(sinceMs?: number): { exported: number; skipped: number; errors: number } {
  console.log('🔄 SDB → Markdown Export');
  console.log(`   Database: ${DB_ID.slice(0, 12)}...`);
  console.log(`   Export dir: ${EXPORT_ROOT}`);
  console.log('');

  const proposals = fetchAllProposals();
  console.log(`📋 Found ${proposals.length} proposals in SDB`);
  console.log('');

  const syncLedger = loadSyncLedger();
  let exported = 0;
  let skipped = 0;
  let errors = 0;

  for (const proposal of proposals) {
    // Filter by time if requested
    if (sinceMs && Number(proposal.updatedAt) / 1000 < sinceMs) {
      skipped++;
      continue;
    }

    try {
      if (exportProposal(proposal, syncLedger)) {
        exported++;
      } else {
        skipped++;
      }
    } catch (e: any) {
      console.error(`  ❌ ${proposal.displayId}: ${e.message}`);
      errors++;
    }
  }

  // Git commit if anything changed
  if (exported > 0) {
    const gitSha = gitCommit(`sync: ${exported} proposals updated from SDB`);

    // Update sync ledger with git SHAs
    if (gitSha) {
      for (const [, entry] of syncLedger) {
        if (entry.syncStatus === 'PENDING') {
          entry.lastGitCommit = gitSha;
          entry.syncStatus = 'SYNCED';
        }
      }
    }
  }

  saveSyncLedger(syncLedger);

  console.log('');
  console.log(`✅ Export complete: ${exported} updated, ${skipped} unchanged, ${errors} errors`);

  return { exported, skipped, errors };
}

export function exportSingle(displayId: string): void {
  const proposals = fetchAllProposals();
  const proposal = proposals.find(p => p.displayId === displayId);
  if (!proposal) {
    console.error(`❌ Proposal not found: ${displayId}`);
    process.exit(1);
  }

  const syncLedger = loadSyncLedger();
  exportProposal(proposal, syncLedger);

  if (syncLedger.get(getExportPath(proposal).replace(process.cwd() + '/', ''))?.syncStatus === 'PENDING') {
    const sha = gitCommit(`sync: ${displayId} updated from SDB`);
    if (sha) {
      const relPath = getExportPath(proposal).replace(process.cwd() + '/', '');
      const entry = syncLedger.get(relPath);
      if (entry) {
        entry.lastGitCommit = sha;
        entry.syncStatus = 'SYNCED';
      }
    }
  }

  saveSyncLedger(syncLedger);
  console.log(`✅ Exported: ${displayId}`);
}

// ─── CLI ─────────────────────────────────────────────────────────────

function parseSince(arg: string): number {
  const match = arg.match(/^(\d+)([hmd])$/);
  if (!match) throw new Error(`Invalid --since format: ${arg} (use e.g. 1h, 24h, 7d)`);
  const num = parseInt(match[1]);
  const unit = match[2];
  const multiplier = unit === 'h' ? 3600 : unit === 'd' ? 86400 : unit === 'm' ? 60 : 1;
  return Date.now() - num * multiplier * 1000;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const idIdx = args.indexOf('--id');
  const sinceIdx = args.indexOf('--since');

  if (idIdx !== -1 && args[idIdx + 1]) {
    exportSingle(args[idIdx + 1]);
  } else if (sinceIdx !== -1 && args[sinceIdx + 1]) {
    const sinceMs = parseSince(args[sinceIdx + 1]);
    exportAll(sinceMs);
  } else {
    exportAll();
  }
}
