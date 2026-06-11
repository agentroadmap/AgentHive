/**
 * P1351 AC-7: Agency Roster TUI display with parent/child nesting
 *
 * Displays agencies grouped by parent_agency_id, showing:
 * - Root agencies (parent_agency_id IS NULL)
 * - Child agencies grouped under their parents
 * - Child count per parent
 */

import type { ScreenInterface } from "./blessed.ts";
import { box } from "./blessed.ts";
import { createScreen } from "./tui.ts";
import { query } from "../../infra/postgres/pool.ts";

interface AgencyRow {
  agency_id: string;
  display_name: string;
  parent_agency_id: string | null;
  provider: string;
  host_id: string;
}

interface AgencyGroup {
  parent: AgencyRow | null;
  children: AgencyRow[];
}

/**
 * Fetch all agencies and group by parent_agency_id
 */
async function fetchAgenciesGrouped(): Promise<Map<string | null, AgencyGroup>> {
  const { rows } = await query<AgencyRow>(
    `
    SELECT
      agency_id,
      display_name,
      parent_agency_id,
      provider,
      host_id
    FROM roadmap.agency
    ORDER BY parent_agency_id ASC, agency_id ASC
    `,
  );

  const groups = new Map<string | null, AgencyGroup>();

  // First pass: identify root agencies
  for (const row of rows) {
    if (!row.parent_agency_id) {
      if (!groups.has(null)) {
        groups.set(null, { parent: null, children: [] });
      }
    }
  }

  // Second pass: add all agencies
  for (const row of rows) {
    if (!row.parent_agency_id) {
      // Root agency
      groups.get(null)!.children.push(row);
    } else {
      // Child agency - create group for parent if needed
      if (!groups.has(row.parent_agency_id)) {
        groups.set(row.parent_agency_id, { parent: null, children: [] });
      }
      groups.get(row.parent_agency_id)!.children.push(row);

      // Also find and set the parent reference
      const parentRow = rows.find((r) => r.agency_id === row.parent_agency_id);
      if (parentRow) {
        groups.get(row.parent_agency_id)!.parent = parentRow;
      }
    }
  }

  return groups;
}

/**
 * Format agency display with nesting
 */
function formatAgencyTree(groups: Map<string | null, AgencyGroup>): string {
  let content = "";

  // Display root agencies first
  const rootGroup = groups.get(null);
  if (rootGroup && rootGroup.children.length > 0) {
    content += "{bold}{cyan-fg}Root Agencies:{/cyan-fg}{/bold}\n";
    for (const agency of rootGroup.children) {
      content += `  {bold}${agency.agency_id}{/bold} (${agency.display_name})\n`;
      content += `    Provider: ${agency.provider} | Host: ${agency.host_id}\n`;

      // Check if this root has children
      const childrenGroup = groups.get(agency.agency_id);
      if (childrenGroup && childrenGroup.children.length > 0) {
        content += `    {green-fg}↳ ${childrenGroup.children.length} child${childrenGroup.children.length !== 1 ? "ren" : ""}{/green-fg}\n`;
        for (const child of childrenGroup.children) {
          content += `      • ${child.agency_id} (${child.display_name})\n`;
        }
      }
      content += "\n";
    }
  }

  // Display nested agencies (those with explicit parents not in root list)
  const nonRootParents = Array.from(groups.entries()).filter(
    ([parentId]) => parentId !== null && parentId !== undefined,
  );

  if (nonRootParents.length > 0) {
    content += "{bold}{cyan-fg}Nested Agencies:{/cyan-fg}{/bold}\n";
    for (const [_parentId, group] of nonRootParents) {
      if (group.parent) {
        content += `  {bold}${group.parent.agency_id}{/bold} (${group.parent.display_name})\n`;
        content += `    Parent: {yellow-fg}${group.parent.parent_agency_id ?? "ROOT"}{/yellow-fg}\n`;
        if (group.children.length > 0) {
          content += `    {green-fg}↳ ${group.children.length} child${group.children.length !== 1 ? "ren" : ""}{/green-fg}\n`;
          for (const child of group.children) {
            content += `      • ${child.agency_id} (${child.display_name})\n`;
          }
        }
        content += "\n";
      }
    }
  }

  if (content === "") {
    content = "{gray-fg}No agencies registered{/gray-fg}\n";
  }

  return content;
}

/**
 * Render the agency roster in an interactive TUI
 */
export async function renderAgencyRosterTui(): Promise<void> {
  // If not in TTY, fall back to plain text output
  if (!process.stdout.isTTY) {
    try {
      const groups = await fetchAgenciesGrouped();
      const tree = formatAgencyTree(groups);
      console.log(tree.replace(/{[^}]+}/g, "")); // Strip tags for plain text
    } catch (err) {
      console.error("Failed to fetch agencies:", err);
    }
    return;
  }

  return new Promise<void>((resolve) => {
    const screen = createScreen({ title: "Agency Roster" });

    // Main container
    const container = box({
      parent: screen,
      width: "100%",
      height: "100%",
    });

    // Title
    box({
      parent: container,
      top: 0,
      left: "center",
      width: "shrink",
      height: 3,
      content: "{center}{bold}Agency Roster — Parent/Child Nesting{/bold}\n{dim}Hierarchical view of registered agencies{/dim}{/center}",
      tags: true,
      style: {
        fg: "white",
      },
    });

    // Agencies display (main content area)
    const agenciesBox = box({
      parent: container,
      top: 3,
      left: 0,
      width: "100%",
      height: "100%-3",
      border: { type: "line" },
      label: " Agencies ",
      style: {
        border: { fg: "gray" },
      },
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      mouse: true,
    });

    // Fetch and display agencies
    fetchAgenciesGrouped()
      .then((groups) => {
        const content = formatAgencyTree(groups);
        agenciesBox.setContent(content);
      })
      .catch((err) => {
        agenciesBox.setContent(
          `{red-fg}Error loading agencies:{/red-fg} ${(err as Error).message}`,
        );
      });

    // Handle keyboard quit
    screen.key(["escape", "q", "C-c"], () => {
      screen.destroy();
      resolve();
    });

    screen.render();
  });
}
