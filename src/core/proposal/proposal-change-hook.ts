import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/**
 * Post Proposal Change Hook
 * 
 * Automatically exports SDB → markdown after any proposal change.
 * This keeps Git-tracked markdown files in sync with SDB (source of truth).
 */

import { execSync } from "node:child_process";

const EXPORT_SCRIPT = path.join(__dirname, '..', 'sdb-to-md-export.ts');
const DEBOUNCE_MS = 2000; // Don't export more than once per 2 seconds

let lastExportTime = 0;
let pendingExport = false;

/**
 * Trigger a markdown export after proposal change.
 * Debounced to avoid multiple rapid exports.
 */
export function triggerExport(): void {
  if (pendingExport) return; // Already scheduled
  
  const now = Date.now();
  const timeSinceLastExport = now - lastExportTime;
  
  if (timeSinceLastExport < DEBOUNCE_MS) {
    // Schedule export after debounce period
    pendingExport = true;
    setTimeout(() => {
      pendingExport = false;
      runExport();
    }, DEBOUNCE_MS - timeSinceLastExport);
    return;
  }
  
  runExport();
}

function runExport(): void {
  try {
    lastExportTime = Date.now();
    execSync(`node --experimental-strip-types ${EXPORT_SCRIPT}`, {
      encoding: "utf8",
      timeout: 60000,
      stdio: "pipe",
    });
  } catch (e) {
    // Silent fail - don't break proposal changes
    console.error("Export failed:", (e as Error).message.slice(0, 100));
  }
}

/**
 * Force immediate export (ignores debounce)
 */
export function forceExportNow(): { exported: number; errors: number } {
  const result = execSync(`node --experimental-strip-types ${EXPORT_SCRIPT}`, {
    encoding: "utf8",
    timeout: 60000,
  });
  console.log(result);
  lastExportTime = Date.now();
  return { exported: 0, errors: 0 }; // Parse from result if needed
}
