/**
 * SDB Export MCP Tools
 * 
 * Export SDB objects to markdown for Git backup:
 * - Proposals (with all metadata and content)
 * - Decisions (ADRs)
 * - Discussions (messages)
 * - DAG SVG (visual dependency graph)
 * - Full backup (all of the above)
 */

import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { requireProjectRoot } from "../../../utils/project-root.ts";

const DB_NAME = process.env.SDB_NAME ?? "roadmap2";

async function getExportPaths() {
  const projectRoot = await requireProjectRoot();
  const roadmapRoot = join(projectRoot, "roadmap");
  const exportDir = join(roadmapRoot, "exports");
  return { projectRoot, roadmapRoot, exportDir };
}

function query(sql: string): any[] {
  try {
    const result = execSync(`spacetime sql --server local ${DB_NAME} "${sql}"`, {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 100 * 1024 * 1024,
    });

    const lines = result.trim().split("\n").filter(l => !l.includes("WARNING"));
    if (lines.length < 3) return [];

    const headers = lines[0].split("|").map(h => h.trim()).filter(Boolean);

    // Merge multi-line rows - new row starts with space+quote
    const merged: string[] = [];
    let current = "";

    for (let i = 2; i < lines.length; i++) {
      const line = lines[i];
      // New row starts with optional space + quote
      const isNewRow = line.match(/^\s*"/);

      if (!current) {
        current = line;
      } else if (isNewRow) {
        merged.push(current);
        current = line;
      } else {
        current += "\n" + line;
      }
    }
    if (current) merged.push(current);

    return merged.map(row => {
      const values = row.split("|").map(v => v.trim());
      const obj: any = {};
      headers.forEach((h, i) => {
        obj[h] = (i < values.length) ? values[i] : "";
      });
      return obj;
    });
  } catch {
    return [];
  }
}

function clean(v: string): string {
  if (!v) return "";
  return v.replace(/^"|"$/g, '').replace(/\\n/g, '\n').trim();
}

function toDate(micros: string): string {
  const ms = parseInt(micros.replace(/[^0-9]/g, '')) / 1000;
  if (isNaN(ms) || ms === 0) return "";
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Export all proposals to markdown
 */
export async function exportProposals(): Promise<string> {
  const { roadmapRoot, exportDir } = await getExportPaths();
  mkdirSync(join(exportDir, "proposals"), { recursive: true });
  
  const proposals = query("SELECT id, title, status, priority, labels, dependencies, claimed_by, created_at, updated_at FROM step");
  
  // Get bodies separately
  const bodies = new Map<string, string>();
  try {
    const bodyResult = execSync(`spacetime sql --server local ${DB_NAME} "SELECT id, body FROM step"`, {
      encoding: "utf8", timeout: 30000, maxBuffer: 50 * 1024 * 1024,
    });
    const lines = bodyResult.split('\n');
    let currentId = '';
    let bodyLines: string[] = [];
    
    for (const line of lines) {
      if (line.includes('WARNING') || line.includes('---') || line.includes('id')) continue;
      
      const idMatch = line.match(/^\s*"([^"]+)"/);
      if (idMatch && line.includes('body')) {
        if (currentId && bodyLines.length > 0) {
          bodies.set(currentId, bodyLines.join('\n'));
        }
        currentId = idMatch[1];
        bodyLines = [];
        const bodyContent = line.match(/body\s+"([\s\S]*)/);
        if (bodyContent) bodyLines.push(bodyContent[1]);
      } else if (currentId && line.match(/^\s*"/)) {
        if (bodyLines.length > 0) {
          bodies.set(currentId, bodyLines.join('\n').replace(/\s*"$/, ''));
        }
        currentId = '';
        bodyLines = [];
      } else if (currentId) {
        bodyLines.push(line);
      }
    }
    if (currentId && bodyLines.length > 0) {
      bodies.set(currentId, bodyLines.join('\n').replace(/\s*"$/, ''));
    }
  } catch {}
  
  let count = 0;
  for (const proposal of proposals) {
    const id = clean(proposal[" id"] || proposal.id || "");
    const title = clean(proposal[" title"] || proposal.title || "");
    const status = clean(proposal[" status"] || proposal.status || "");
    const priority = clean(proposal[" priority"] || proposal.priority || "medium");
    const labels = clean(proposal[" labels"] || proposal.labels || "");
    const claimedBy = clean(proposal[" claimed_by"] || proposal.claimed_by || "");
    const createdAt = clean(proposal[" created_at"] || proposal.created_at || "");
    const updatedAt = clean(proposal[" updated_at"] || proposal.updated_at || "");
    const body = bodies.get(id) || "";
    
    if (!id || !title) continue;
    
    // Try to read original markdown for richer content
    const origBody = readOriginalBody(id, roadmapRoot);
    const finalBody = origBody || body;
    
    let md = "---\n";
    md += `id: ${id}\n`;
    md += `title: "${title}"\n`;
    md += `status: ${status}\n`;
    md += `priority: ${priority}\n`;
    if (labels) md += `labels: [${labels}]\n`;
    if (claimedBy) md += `assignee: ["${claimedBy}"]\n`;
    if (createdAt) md += `created_date: '${toDate(createdAt)}'\n`;
    if (updatedAt) md += `updated_date: '${updatedAt}'\n`;
    md += `sdb_source: true\n`;
    md += `exported_at: '${new Date().toISOString()}'\n`;
    md += "---\n\n";
    md += `# ${title}\n\n`;
    md += finalBody || "(no content)\n";
    if (!md.endsWith("\n")) md += "\n";
    
    const safeTitle = title.replace(/[^a-zA-Z0-9 -]/g, '').replace(/ /g, '-').slice(0, 60);
    const file = `${id.toLowerCase()} - ${safeTitle}.md`;
    const dir = ['Complete', 'Parked', 'Rejected'].includes(status) ? join(exportDir, "completed") : join(exportDir, "proposals");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), md);
    count++;
  }
  
  return `Exported ${count} proposals to ${exportDir}/proposals/ and ${exportDir}/completed/`;
}

/**
 * Read original markdown body (from git-tracked files)
 */
function readOriginalBody(id: string, roadmapRoot: string): string | null {
  const dirs = [
    join(roadmapRoot, "proposals"),
    join(roadmapRoot, "completed"),
    join(roadmapRoot, "tmp1/proposals"),
    join(roadmapRoot, "tmp1/completed"),
  ];
  
  const idLower = id.toLowerCase();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir).filter(f => f.toLowerCase().startsWith(idLower));
      if (files.length > 0) {
        const content = readFileSync(join(dir, files[0]), 'utf-8');
        // Extract body (after frontmatter and title)
        const parts = content.split('---');
        if (parts.length >= 3) {
          let body = parts.slice(2).join('---').trim();
          if (body.startsWith('# ')) body = body.slice(body.indexOf('\n') + 1).trim();
          return body;
        }
      }
    } catch {}
  }
  return null;
}

/**
 * Export all ADRs to markdown
 */
export async function exportADRs(): Promise<string> {
  const { exportDir } = await getExportPaths();
  mkdirSync(join(exportDir, "adrs"), { recursive: true });
  
  const adrs = query("SELECT id, stepId, teamId, title, decision, rationale, createdAt FROM adr");
  let count = 0;
  
  for (const adr of adrs) {
    const id = clean(adr[" id"] || adr.id || "");
    const stepId = clean(adr[" stepId"] || adr.stepId || "");
    const title = clean(adr[" title"] || adr.title || "");
    const decision = clean(adr[" decision"] || adr.decision || "");
    const rationale = clean(adr[" rationale"] || adr.rationale || "");
    const createdAt = clean(adr[" createdAt"] || adr.created_at || "");
    
    if (!id) continue;
    
    let md = `# ADR: ${title}\n\n`;
    md += `**ID:** ${id}\n`;
    if (stepId) md += `**Related Proposal:** ${stepId}\n`;
    if (createdAt) md += `**Created:** ${toDate(createdAt)}\n\n`;
    md += `## Decision\n\n${decision || "(no decision recorded)"}\n\n`;
    md += `## Rationale\n\n${rationale || "(no rationale recorded)"}\n\n`;
    
    writeFileSync(join(exportDir, "adrs", `${id.toLowerCase()}.md`), md);
    count++;
  }
  
  return `Exported ${count} ADRs to ${exportDir}/adrs/`;
}

/**
 * Export messages/discussions to markdown
 */
export async function exportMessages(): Promise<string> {
  const { exportDir } = await getExportPaths();
  mkdirSync(join(exportDir, "messages"), { recursive: true });
  
  const msgs = query("SELECT msgId, fromAgentId, toAgentId, chanId, text, priority, timestamp, read FROM msg ORDER BY timestamp DESC");
  
  let md = "# Agent Messages\n\n";
  md += `> Exported: ${new Date().toISOString()}\n\n`;
  
  let count = 0;
  for (const msg of msgs) {
    const from = clean(msg[" fromAgentId"] || "");
    const to = clean(msg[" toAgentId"] || "") || "(broadcast)";
    const chan = clean(msg[" chanId"] || "") || "(direct)";
    const text = clean(msg[" text"] || "");
    const priority = clean(msg[" priority"] || "normal");
    const timestamp = clean(msg[" timestamp"] || "");
    
    md += `### ${from} → ${to}\n`;
    if (chan !== "(direct)") md += `**Channel:** ${chan}\n`;
    if (priority !== "normal") md += `**Priority:** ${priority}\n`;
    md += `**Time:** ${toDate(timestamp)}\n\n`;
    md += `${text || "(no content)"}\n\n---\n\n`;
    count++;
  }
  
  writeFileSync(join(exportDir, "messages", "agent-messages.md"), md);
  return `Exported ${count} messages to ${exportDir}/messages/`;
}

/**
 * Generate DAG SVG visualization
 */
export async function exportDAG(): Promise<string> {
  const { exportDir } = await getExportPaths();
  mkdirSync(join(exportDir, "dag"), { recursive: true });
  
  const proposals = query("SELECT id, title, status, dependencies FROM step");
  
  // Generate DOT format
  let dot = `digraph Roadmap {\n`;
  dot += `  rankdir=LR;\n`;
  dot += `  node [shape=box, style=filled, fontsize=10];\n\n`;
  
  // Color by status
  const statusColors: Record<string, string> = {
    "Proposal": "#FFEAA7",
    "Draft": "#81ECEC",
    "Accepted": "#74B9FF",
    "Active": "#55EFC4",
    "Review": "#A29BFE",
    "Complete": "#DFE6E9",
    "Parked": "#B2BEC3",
    "Rejected": "#FF7675",
  };
  
  for (const proposal of proposals) {
    const id = clean(proposal[" id"] || "");
    const title = (clean(proposal[" title"] || "") || "").replace(/"/g, '\\"').slice(0, 40);
    const status = clean(proposal[" status"] || "");
    const color = statusColors[status] || "#FFFFFF";
    
    if (id) {
      dot += `  "${id}" [label="${id}\\n${title}" fillcolor="${color}"];\n`;
    }
  }
  
  // Add edges from dependencies
  dot += `\n`;
  for (const proposal of proposals) {
    const id = clean(proposal[" id"] || "");
    const deps = clean(proposal[" dependencies"] || "");
    if (id && deps) {
      deps.split(/[,;]/).forEach((dep: string) => {
        const depClean = dep.trim().replace(/[\[\]"]/g, '');
        if (depClean) {
          dot += `  "${depClean}" -> "${id}";\n`;
        }
      });
    }
  }
  
  dot += `}\n`;
  
  // Save DOT file
  writeFileSync(join(exportDir, "dag", "roadmap.dot"), dot);
  
  // Try to generate SVG
  try {
    execSync(`dot -Tsvg ${join(exportDir, "dag", "roadmap.dot")} -o ${join(exportDir, "dag", "roadmap.svg")}`, {
      timeout: 10000,
    });
    return `DAG exported: ${exportDir}/dag/roadmap.dot + roadmap.svg`;
  } catch {
    return `DAG exported: ${exportDir}/dag/roadmap.dot (install graphviz for SVG)`;
  }
}

/**
 * Export all data (full backup)
 */
export async function exportAll(): Promise<string> {
  const { exportDir } = await getExportPaths();
  mkdirSync(exportDir, { recursive: true });
  
  const results: string[] = [];
  results.push(await exportProposals());
  results.push(await exportADRs());
  results.push(await exportMessages());
  results.push(await exportDAG());
  
  // Create index
  let index = `# Roadmap SDB Export\n\n`;
  index += `**Exported:** ${new Date().toISOString()}\n\n`;
  index += `## Contents\n\n`;
  index += `- [Proposals](proposals/) — All proposals with metadata and content\n`;
  index += `- [ADRs](adrs/) — Architecture Decision Records\n`;
  index += `- [Messages](messages/) — Agent communication logs\n`;
  index += `- [DAG](dag/) — Dependency graph visualization\n\n`;
  index += `## Source\n\n`;
  index += `All data sourced from SpacetimeDB (${process.env.SDB_NAME ?? "roadmap2"}).\n`;
  index += `Markdown files are Git artifacts — edit via MCP/CLI, not directly.\n`;
  
  writeFileSync(join(exportDir, "README.md"), index);
  
  return results.join('\n');
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2] || 'all';
  
  (async () => {
    switch (command) {
      case 'proposals': console.log(await exportProposals()); break;
      case 'adrs': console.log(await exportADRs()); break;
      case 'messages': console.log(await exportMessages()); break;
      case 'dag': console.log(await exportDAG()); break;
      case 'all': console.log(await exportAll()); break;
      default: console.log('Usage: sdb-export-tools.ts [proposals|adrs|messages|dag|all]');
    }
  })();
}

/**
 * Full SDB backup - all tables to JSON
 */
export async function backupAllTables(): Promise<string> {
  const { exportDir } = await getExportPaths();
  mkdirSync(join(exportDir, "backup"), { recursive: true });
  
  const tables = [
    "step", "ac", "agent", "team", "member", "chan", "msg", 
    "prop", "goal", "directive", "knowledge", "sbx", "role", "claim"
  ];
  
  let totalRows = 0;
  
  for (const table of tables) {
    try {
      const rows = query(`SELECT * FROM ${table}`);
      const json = JSON.stringify(rows, null, 2);
      writeFileSync(join(exportDir, "backup", `${table}.json`), json);
      totalRows += rows.length;
    } catch (e) {
      console.warn(`Failed to export ${table}:`, (e as Error).message.slice(0, 80));
    }
  }
  
  // Create manifest
  const manifest = {
    exported_at: new Date().toISOString(),
    database: DB_NAME,
    tables,
    total_rows: totalRows,
  };
  writeFileSync(join(exportDir, "backup", "manifest.json"), JSON.stringify(manifest, null, 2));
  
  return `Full backup: ${totalRows} rows from ${tables.length} tables → ${exportDir}/backup/`;
}

/**
 * Restore from backup JSON files
 */
export async function restoreFromBackup(backupDir?: string): Promise<string> {
  const { exportDir } = await getExportPaths();
  const dir = backupDir || join(exportDir, "backup");
  if (!existsSync(dir)) return `No backup found at ${dir}`;
  
  const files = readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'manifest.json');
  
  let restored = 0;
  
  for (const file of files) {
    const table = file.replace('.json', '');
    const jsonPath = join(dir, file);
    
    try {
      const data = JSON.parse(readFileSync(jsonPath, 'utf-8'));
      
      for (const row of data) {
        const cols = Object.keys(row);
        const values = cols.map(c => {
          const v = row[c];
          if (v === null || v === undefined) return 'NULL';
          if (typeof v === 'number') return v.toString();
          if (typeof v === 'boolean') return v ? 'true' : 'false';
          if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
          return `'${String(v).replace(/'/g, "''")}'`;
        });
        
        const colList = cols.join(', ');
        const valList = values.join(', ');
        
        // Use INSERT or UPDATE
        const idCol = cols.find(c => c === 'id' || c === 'msgId' || c === 'ac_id');
        if (idCol && row[idCol]) {
          // Upsert
          const updates = cols.filter(c => c !== idCol).map((c, i) => `${c} = ${values[i]}`);
          const sql = `UPDATE ${table} SET ${updates.join(', ')} WHERE ${idCol} = ${values[cols.indexOf(idCol)]}`;
          execSync(`spacetime sql --server local ${DB_NAME} "${sql}"`, { encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
        }
        restored++;
      }
    } catch (e) {
      console.warn(`Failed to restore ${table}:`, (e as Error).message.slice(0, 80));
    }
  }
  
  return `Restored ${restored} rows from ${files.length} tables`;
}
