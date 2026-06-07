import { join } from "node:path";
import { loadRules } from "../../../../tools/scanner/rules.ts";
import { runScan } from "../../../../tools/scanner/engine.ts";
import { outputJsonl, outputHuman } from "../../../../tools/scanner/output.ts";
import { query } from "../../../../infra/postgres/pool.ts";
import type { CallToolResult } from "../../types.ts";

export interface ScanArgs {
  paths?: string[];
  proposal_id?: number;
  format?: "human" | "jsonl";
  min_severity?: "critical" | "high" | "medium" | "low";
  min_confidence?: "high" | "medium" | "low";
  rule_tag?: string;
  git_changed?: boolean;
}

export class ScanHandlers {
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  async runScan(args: ScanArgs): Promise<CallToolResult> {
    const rulesDir = join(this.projectRoot, "src/tools/scanner/rules");

    const { rules, errors: ruleErrors } = await loadRules(rulesDir);

    if (rules.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to load rules: ${ruleErrors.join("; ")}`,
          },
        ],
      };
    }

    const result = await runScan(
      {
        paths: args.paths,
        minSeverity: args.min_severity ?? "medium",
        minConfidence: args.min_confidence ?? "medium",
        ruleTag: args.rule_tag,
        gitChanged: args.git_changed,
      },
      rules
    );

    // Emit to proposal_event if proposal_id is provided (AC6)
    if (args.proposal_id) {
      try {
        await query(
          `INSERT INTO roadmap_proposal.proposal_event (proposal_id, event_type, payload)
           VALUES ($1, 'scan_result', $2::jsonb)`,
          [
            args.proposal_id,
            JSON.stringify({
              total: result.findings.length,
              by_severity: result.stats.findingsBySeverity,
              top_rules: Object.entries(result.stats.findingsByRule)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([rule, count]) => ({ rule, count })),
              ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
            }),
          ]
        );
      } catch (e) {
        // Log but don't fail the scan — proposal_event write is best-effort
        console.error("[mcp_scan] proposal_event insert failed:", e);
      }
    }

    const format = args.format ?? "human";
    let output: string;
    if (format === "jsonl") {
      output = await outputJsonl(result);
    } else {
      output = await outputHuman(result, false);
    }

    if (ruleErrors.length > 0) {
      output += `\n\nRule load warnings:\n${ruleErrors.map((e) => `  - ${e}`).join("\n")}`;
    }

    return {
      content: [{ type: "text", text: output || "No findings." }],
    };
  }
}
