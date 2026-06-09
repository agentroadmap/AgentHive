import type { Finding, Severity } from "./rules.ts";
import type { ScannerResult } from "./engine.ts";
import fs from "fs/promises";

const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
};

const SEVERITY_COLOR: Record<Severity, string> = {
  critical: COLORS.red,
  high: COLORS.red,
  medium: COLORS.yellow,
  low: COLORS.dim,
};

export async function outputHuman(
  result: ScannerResult,
  verbose: boolean = false
): Promise<string> {
  const lines: string[] = [];

  // Group findings by file
  const byFile = new Map<string, Finding[]>();
  for (const finding of result.findings) {
    if (!byFile.has(finding.file || "unknown")) {
      byFile.set(finding.file || "unknown", []);
    }
    byFile.get(finding.file || "unknown")!.push(finding);
  }

  // Sort by severity
  const severityOrder: Record<Severity, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  };

  const sortedFindings = Array.from(result.findings).sort(
    (a, b) => severityOrder[b.severity] - severityOrder[a.severity]
  );

  // Print findings
  for (const finding of sortedFindings) {
    const color = SEVERITY_COLOR[finding.severity];
    lines.push(
      `${finding.file}:${finding.line}:${finding.col}  ${color}${finding.severity}${COLORS.reset}  ${finding.rule}  ${finding.proposal}`
    );
    lines.push(`  | ${finding.snippet}`);
    lines.push(`  | Fix: ${finding.fixSuggestion}`);
    lines.push("");
  }

  // Print summary
  lines.push("Summary:");
  lines.push(
    `  ${result.findings.length} findings across ${result.stats.filesWithFindings} files`
  );

  const severityCounts = Object.entries(result.stats.findingsBySeverity)
    .map(([sev, count]) => `${sev}: ${count}`)
    .join("  ");
  lines.push(`   |  ${severityCounts}`);

  const topRules = Object.entries(result.stats.findingsByRule)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([rule, count]) => `${rule} (${count})`)
    .join(", ");
  if (topRules) lines.push(`  Top rules: ${topRules}`);

  if (result.stats.acknowledgedDebt > 0) {
    lines.push(`  Acknowledged debt (TODO): ${result.stats.acknowledgedDebt} findings`);
  }
  if (result.stats.suppressed > 0) {
    lines.push(`  Suppressed (allowlist): ${result.stats.suppressed} findings`);
  }

  if (result.ruleLoadErrors.length > 0) {
    lines.push("");
    lines.push("Rule Load Errors:");
    for (const err of result.ruleLoadErrors) {
      lines.push(`  - ${err}`);
    }
  }

  return lines.join("\n");
}

export async function outputJsonl(result: ScannerResult): Promise<string> {
  const lines: string[] = [];

  for (const finding of result.findings) {
    lines.push(
      JSON.stringify({
        schema_version: 1,
        rule: finding.rule,
        file: finding.file,
        line: finding.line,
        col: finding.col,
        severity: finding.severity,
        confidence: finding.confidence,
        proposal: finding.proposal,
        match: finding.match,
        snippet: finding.snippet,
        fix: finding.fixSuggestion,
        tags: finding.tags,
        acknowledged_debt: finding.acknowledgedDebt,
        context_before: finding.context_before,
        context_after: finding.context_after,
      })
    );
  }

  return lines.join("\n");
}

export async function outputMcp(result: ScannerResult): Promise<string> {
  return JSON.stringify({
    schema_version: 1,
    total: result.findings.length,
    stats: result.stats,
    findings: result.findings.map((f) => ({
      schema_version: 1,
      rule: f.rule,
      file: f.file,
      line: f.line,
      col: f.col,
      severity: f.severity,
      confidence: f.confidence,
      proposal: f.proposal,
      match: f.match,
      snippet: f.snippet,
      fix: f.fixSuggestion,
      tags: f.tags,
      acknowledged_debt: f.acknowledgedDebt,
      context_before: f.context_before,
      context_after: f.context_after,
    })),
  });
}

export async function outputSarif(result: ScannerResult): Promise<string> {
  const rules = new Map<string, Finding>();
  for (const finding of result.findings) {
    if (!rules.has(finding.rule)) {
      rules.set(finding.rule, finding);
    }
  }

  return JSON.stringify(
    {
      version: "2.1.0",
      $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
      runs: [
        {
          tool: {
            driver: {
              name: "hardcoding-scanner",
              version: "1.0.0",
              rules: Array.from(rules.values()).map((r) => ({
                id: r.rule,
                shortDescription: {
                  text: r.description,
                },
                help: {
                  text: r.fixSuggestion,
                },
                properties: {
                  proposal: r.proposal,
                  tags: r.tags,
                },
              })),
            },
          },
          results: result.findings.map((f) => ({
            ruleId: f.rule,
            level: f.severity === "critical" ? "error" : f.severity === "high" ? "error" : "warning",
            message: {
              text: f.description,
            },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: {
                    uri: f.file,
                  },
                  region: {
                    startLine: f.line,
                    startColumn: f.col,
                  },
                },
              },
            ],
            properties: {
              proposal: f.proposal,
              acknowledgedDebt: f.acknowledgedDebt,
            },
          })),
        },
      ],
    },
    null,
    2
  );
}

export async function writeOutput(
  format: string,
  result: ScannerResult,
  outPath?: string,
  verbose?: boolean
): Promise<string> {
  let output = "";

  if (format === "human") {
    output = await outputHuman(result, verbose);
  } else if (format === "jsonl") {
    output = await outputJsonl(result);
  } else if (format === "sarif") {
    output = await outputSarif(result);
  } else if (format === "mcp") {
    output = await outputMcp(result);
  } else {
    output = await outputHuman(result, verbose);
  }

  if (outPath) {
    await fs.writeFile(outPath, output, "utf-8");
  }

  return output;
}

export function shouldFail(
  result: ScannerResult,
  failOn?: Severity
): boolean {
  if (!failOn) return false;

  const severityOrder: Record<Severity, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  };

  const threshold = severityOrder[failOn] || 0;

  for (const finding of result.findings) {
    if (severityOrder[finding.severity] >= threshold) {
      return true;
    }
  }

  return false;
}
