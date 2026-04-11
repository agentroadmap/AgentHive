/**
 * SDB Export MCP Tool Registration
 * 
 * Registers export tools with the MCP server.
 */

import { z } from "zod";
import { exportProposals, exportADRs, exportMessages, exportDAG, exportAll } from "./sdb-export-tools.ts";

export function registerExportTools(server: any): void {
  // Export proposals
  server.addTool({
    name: "export_proposals",
    description: "Export all proposals from SDB to markdown files for Git backup",
    parameters: z.object({
      output_dir: z.string().optional().describe("Output directory (default: roadmap/exports/)"),
    }),
    execute: async (args: any) => {
      const result = exportProposals();
      return { content: [{ type: "text", text: result }] };
    },
  });

  // Export ADRs
  server.addTool({
    name: "export_adrs",
    description: "Export Architecture Decision Records from SDB to markdown",
    parameters: z.object({}),
    execute: async (args: any) => {
      const result = exportADRs();
      return { content: [{ type: "text", text: result }] };
    },
  });

  // Export messages
  server.addTool({
    name: "export_messages",
    description: "Export agent communication messages to markdown",
    parameters: z.object({
      limit: z.number().optional().describe("Max messages to export (default: all)"),
    }),
    execute: async (args: any) => {
      const result = exportMessages();
      return { content: [{ type: "text", text: result }] };
    },
  });

  // Export DAG
  server.addTool({
    name: "export_dag",
    description: "Generate dependency graph (DOT and SVG) from proposals",
    parameters: z.object({}),
    execute: async (args: any) => {
      const result = exportDAG();
      return { content: [{ type: "text", text: result }] };
    },
  });

  // Export all
  server.addTool({
    name: "export_all",
    description: "Full backup: export all SDB objects to markdown for Git",
    parameters: z.object({}),
    execute: async (args: any) => {
      const result = exportAll();
      return { content: [{ type: "text", text: result }] };
    },
  });

  // Full backup
  server.addTool({
    name: "backup_sdb",
    description: "Full SDB backup: all tables to JSON for complete recovery",
    parameters: z.object({}),
    execute: async () => {
      const { backupAllTables } = await import("./sdb-export-tools.ts");
      return { content: [{ type: "text", text: backupAllTables() }] };
    },
  });

  // Restore from backup
  server.addTool({
    name: "restore_sdb",
    description: "Restore SDB from JSON backup files",
    parameters: z.object({
      backup_dir: z.string().optional().describe("Backup directory (default: roadmap/exports/backup/)"),
    }),
    execute: async (args: any) => {
      const { restoreFromBackup } = await import("./sdb-export-tools.ts");
      return { content: [{ type: "text", text: restoreFromBackup(args.backup_dir) }] };
    },
  });
}
