/**
 * Post Proposal Change Hook
 * 
 * The Postgres model is now the source of truth. Markdown export is no longer
 * triggered from proposal writes.
 */

/**
 * Compatibility hook for callers that still notify after proposal changes.
 */
export function triggerExport(): void {
  // no-op: markdown export is no longer triggered from proposal writes.
}

/**
 * Compatibility hook for callers that force a sync.
 */
export function forceExportNow(): { exported: number; errors: number } {
  return { exported: 0, errors: 0 };
}
