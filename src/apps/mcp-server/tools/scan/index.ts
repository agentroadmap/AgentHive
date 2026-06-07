import type { McpServer } from "../../server.ts";
import type { McpToolHandler } from "../../types.ts";
import { ScanHandlers, type ScanArgs } from "./handlers.ts";

const scanInputSchema = {
  type: "object",
  properties: {
    paths: {
      type: "array",
      items: { type: "string" },
      description:
        "File/directory paths to scan (default: src/**/*.ts, scripts/**/*.ts).",
    },
    proposal_id: {
      type: "number",
      description:
        "If provided, scan result summary is emitted into proposal_event for this proposal. Gate pipeline can require a clean scan before advancing.",
    },
    format: {
      type: "string",
      enum: ["human", "jsonl"],
      description: "Output format. 'jsonl' is machine-readable for downstream consumers.",
    },
    min_severity: {
      type: "string",
      enum: ["critical", "high", "medium", "low"],
      description: "Minimum severity to report (default: medium).",
    },
    min_confidence: {
      type: "string",
      enum: ["high", "medium", "low"],
      description: "Minimum confidence level to report (default: medium).",
    },
    rule_tag: {
      type: "string",
      description: "Filter rules by tag (e.g. 'paths', 'credentials', 'models').",
    },
    git_changed: {
      type: "boolean",
      description: "Scan only files changed since main branch.",
    },
  },
};

export function registerScanTools(server: McpServer, projectRoot: string): void {
  const handlers = new ScanHandlers(projectRoot);

  const mcpScanTool: McpToolHandler = {
    name: "mcp_scan",
    description:
      "Run the hardcoding scanner against the codebase. Returns findings in human or JSONL format. " +
      "When proposal_id is supplied, emits a scan_result event into proposal_event so the gate pipeline " +
      "can require a clean scan before advancing transitions. " +
      "Schema: schema_version=1, see src/tools/scanner/schema/findings.schema.json.",
    inputSchema: scanInputSchema,
    async handler(input: Record<string, unknown>): Promise<ReturnType<ScanHandlers["runScan"]>> {
      return handlers.runScan(input as ScanArgs);
    },
  };

  server.addTool(mcpScanTool);
}
