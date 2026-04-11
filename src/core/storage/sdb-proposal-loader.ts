/**
 * SpacetimeDB Proposal Loader
 *
 * Bridges SpacetimeDB 'proposal' table → UI Proposal format.
 * No dependency on 'spacetime' CLI. Uses unified SDB client.
 */

import { querySdbSync, getSdbConfigSync } from "./sdb-client.ts";
import { AcceptanceCriteriaManager, extractStructuredSection } from "../../markdown/structured-sections.ts";
import type { Proposal, Directive, ProposalClaim } from "../../types/index.ts";

/** Convert microsecond timestamp to milliseconds */
function toMs(timestamp: any): number {
  if (!timestamp) return 0;
  const num = Number(timestamp);
  if (num > 1e15) return Math.floor(num / 1000);
  return num;
}

/** Convert an SDB row to the Proposal format expected by UI components */
function rowToProposal(row: any): Proposal {
  const id = String(row.display_id || row.id);
  let status = row.status || "Draft";

  // Map legacy statuses to new workflow
  if (status === "New" || status === "Potential") {
      status = "Draft";
  } else if (status === "Active") {
      status = "Building";
  } else if (status === "Reached") {
      status = "Complete";
  }

  const bodyText = String(row.body_markdown || "");

  // Fetch criteria for this proposal (would be better in a separate query but keeping it compatible with existing loader signature for now)
  // Actually, we can't easily do it inside rowToProposal sync without another query.
  // For now, let's parse body for criteria as fallback.
  const acceptanceCriteriaItems = AcceptanceCriteriaManager.parseAllCriteria(bodyText);

  return {
    id: String(id),
    title: String(row.title),
    rawContent: bodyText,
    description: String(row.description || "") || extractStructuredSection(bodyText, "description") || "",
    implementationPlan: extractStructuredSection(bodyText, "implementationPlan") || undefined,
    implementationNotes: String(row.process_logic || "") || extractStructuredSection(bodyText, "implementationNotes") || "",
    finalSummary: extractStructuredSection(bodyText, "finalSummary") || "",
    acceptanceCriteriaItems,
    status,
    assignee: [], // Will be populated from workforce_pulse if needed
    priority: String(row.priority || "none").toLowerCase() as any,
    labels: row.tags ? String(row.tags).split(",").map((s: string) => s.trim()).filter(Boolean) : [],
    dependencies: [], // No longer a column, should be fetched from parent_id or hierarchy
    parentProposalId: row.parent_id ? String(row.parent_id) : undefined,
    proof: [],
    directive: row.parent_id ? String(row.parent_id) : undefined,
    maturity: row.maturity_level === 0 ? "new" : (row.maturity_level === 1 ? "active" : (row.maturity_level === 2 ? "mature" : "obsolete")),
    ready: status === "Complete",
    createdDate: row.created_at ? new Date(toMs(row.created_at)).toISOString() : new Date().toISOString(),
    updatedDate: row.updated_at ? new Date(toMs(row.updated_at)).toISOString() : undefined,
    budgetLimitUsd: row.budget_limit_usd,
    domainId: row.domain_id,
    proposalType: row.proposal_type,
    category: row.category,
  };
}

/** Load all proposals from SpacetimeDB */
export function loadAllProposals(): Proposal[] {
  const rows = querySdbSync("SELECT * FROM proposal");
  return rows.map(rowToProposal);
}

/** Load proposals filtered by status */
export function loadProposalsByStatus(status: string): Proposal[] {
  const rows = querySdbSync(`SELECT * FROM proposal WHERE status = '${status}'`);
  return rows.map(rowToProposal);
}

/** Load a single proposal by ID */
export function loadProposal(id: string): Proposal | null {
  const rows = querySdbSync(`SELECT * FROM proposal WHERE id = '${id}' OR display_id = '${id}'`);
  if (rows.length === 0) return null;
  return rowToProposal(rows[0]);
}

/** Load all directives from SpacetimeDB */
export function loadAllDirectives(): Directive[] {
  const rows = querySdbSync("SELECT id, display_id, title, body_markdown as description, status FROM proposal WHERE proposal_type = 'DIRECTIVE'");
  return rows.map((row: any) => ({
    id: String(row.display_id || row.id),
    title: String(row.title),
    description: String(row.description || ""),
    status: String(row.status || "New"),
    rawContent: "",
  }));
}

/** Load proposals for statistics calculation */
export function loadProposalsForStatistics(): {
  proposals: Proposal[];
  drafts: Proposal[];
  statuses: string[];
} {
  const allProposals = loadAllProposals();
  const drafts = allProposals.filter((p) => p.status === "Proposal" || p.status === "Draft");
  const proposals = allProposals.filter((p) => p.status !== "Proposal" && p.status !== "Draft");
  const statusSet = new Set(allProposals.map((p) => p.status));
  const statuses = Array.from(statusSet);
  return { proposals, drafts, statuses };
}
