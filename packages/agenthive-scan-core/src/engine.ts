import fs from "fs/promises";
import path from "path";
import { readFileSync } from "fs";
import { glob } from "glob";
import type { Rule, RuleSet, Finding, ScannerConfig } from "./rules.ts";
import { getAllowlist, isAllowed } from "./allowlist.ts";

export interface ScannerResult {
  findings: Finding[];
  stats: {
    totalFiles: number;
    filesWithFindings: number;
    findingsByRule: Record<string, number>;
    findingsBySeverity: Record<string, number>;
    acknowledgedDebt: number;
    suppressed: number;
  };
  ruleLoadErrors: string[];
}

const BINARY_SIGNATURES = [
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]), // ELF
  Buffer.from([0xfe, 0xed, 0xfa]), // Mach-O
  Buffer.from([0x4d, 0x5a]), // PE
  Buffer.from([0xff, 0xd8, 0xff]), // JPEG
  Buffer.from([0x89, 0x50, 0x4e, 0x47]), // PNG
];

function isBinaryFile(buffer: Buffer): boolean {
  for (const sig of BINARY_SIGNATURES) {
    if (buffer.subarray(0, sig.length).equals(sig)) return true;
  }
  // Check for null bytes (common in binary files)
  return buffer.includes(0);
}

async function getAllFiles(
  basePath: string,
  includeGlobs: string[],
  excludeGlobs: string[]
): Promise<string[]> {
  const allFiles = await glob(includeGlobs, {
    cwd: basePath,
    ignore: excludeGlobs,
  });
  return allFiles.map((f) => path.join(basePath, f));
}

function extractContext(
  content: string,
  line: number,
  contextLines: number = 2
): { before: string[]; after: string[] } {
  const lines = content.split("\n");
  const lineIndex = line - 1;
  const before = lines
    .slice(Math.max(0, lineIndex - contextLines), lineIndex)
    .map((l) => l.substring(0, 100));
  const after = lines
    .slice(lineIndex + 1, lineIndex + 1 + contextLines)
    .map((l) => l.substring(0, 100));
  return { before, after };
}

function findAllowlistSuppression(
  content: string,
  lineNum: number,
  ruleId: string
): { suppressed: boolean; reason?: string } {
  const lines = content.split("\n");
  const targetLine = lines[lineNum - 1];

  // Single-line suppress
  const singleLineMatch = targetLine.match(
    /\/\/\s*scan:allow\s+(\S+)\s+reason="([^"]+)"/
  );
  if (singleLineMatch && singleLineMatch[1] === ruleId) {
    return { suppressed: true, reason: singleLineMatch[2] };
  }

  // Block suppress (check within 5 lines before and after)
  for (let i = Math.max(0, lineNum - 6); i < Math.min(lines.length, lineNum + 5); i++) {
    const startMatch = lines[i].match(
      /\/\*\s*scan:allow-block\s+(\S+)\s+reason="([^"]+)"/
    );
    const endMatch = lines[i].match(/scan:end-allow\s*\*\//);

    if (startMatch && startMatch[1] === ruleId) {
      // Check if we're before end marker
      for (let j = i; j < Math.min(lines.length, i + 50); j++) {
        if (lines[j].includes("scan:end-allow")) {
          if (j >= lineNum - 1) {
            return { suppressed: true, reason: startMatch[2] };
          }
          break;
        }
      }
    }
  }

  return { suppressed: false };
}

function isAcknowledgedDebt(
  content: string,
  lineNum: number,
  proposals: string[]
): boolean {
  const lines = content.split("\n");
  const searchStart = Math.max(0, lineNum - 4);
  const searchEnd = Math.min(lines.length, lineNum + 3);

  for (let i = searchStart; i < searchEnd; i++) {
    const line = lines[i];
    for (const prop of proposals) {
      if (line.includes(`TODO(${prop})`) || line.includes(`todo(${prop})`)) {
        return true;
      }
    }
  }
  return false;
}

function matchPattern(content: string, rule: Rule): Finding[] {
  const findings: Finding[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match: string | null = null;

    if (rule.pattern) {
      if (line.includes(rule.pattern)) {
        match = rule.pattern;
      }
    } else if (rule.regex) {
      const re = new RegExp(rule.regex, "g");
      const matches = line.matchAll(re);
      for (const m of matches) {
        if (m[0]) {
          match = m[0];
          break;
        }
      }
    }

    if (match) {
      const col = line.indexOf(match);
      findings.push({
        rule: rule.id,
        line: i + 1,
        col: col + 1,
        match,
        snippet: line.substring(0, 120),
        severity: rule.severity,
        confidence: rule.confidence,
        proposal: rule.proposal,
        description: rule.description,
        fixSuggestion: rule.fix_suggestion,
        tags: rule.tags || [],
        acknowledgedDebt: false,
      });
    }
  }

  return findings;
}

export async function runScan(
  config: ScannerConfig,
  rules: Rule[]
): Promise<ScannerResult> {
  const result: ScannerResult = {
    findings: [],
    stats: {
      totalFiles: 0,
      filesWithFindings: 0,
      findingsByRule: {},
      findingsBySeverity: {},
      acknowledgedDebt: 0,
      suppressed: 0,
    },
    ruleLoadErrors: [],
  };

  const allowlist = await getAllowlist(config.allowlistPath || ".scanignore.yaml");

  // Default globs if not specified
  const defaultGlobs = [
    "src/**/*.{ts,tsx,js,jsx}",
    "scripts/**/*.{ts,sh,js,cjs}",
    "database/**/*.{sql,ts}",
    "docs/**/*.md",
  ];

  const scanGlobs = config.paths?.length ? config.paths : defaultGlobs;
  const excludeGlobs = [
    "node_modules/**",
    "dist/**",
    "build/**",
    "**/*.test.{ts,js}",
    "**/*.spec.{ts,js}",
    ".git/**",
  ];

  // Get all files to scan
  const baseDir = process.cwd();
  let filesToScan: string[] = [];

  if (config.gitStaged || config.gitChanged) {
    // Use git to get file list
    const { execSync } = await import("child_process");
    try {
      const gitCmd = config.gitStaged ? "git diff --cached --name-only" : "git diff --name-only main...HEAD";
      const output = execSync(gitCmd, { cwd: baseDir }).toString();
      filesToScan = output
        .split("\n")
        .filter(Boolean)
        .map((f) => path.join(baseDir, f));
    } catch {
      result.ruleLoadErrors.push("Failed to get git file list");
      return result;
    }
  } else {
    filesToScan = await getAllFiles(baseDir, scanGlobs, excludeGlobs);
  }

  result.stats.totalFiles = filesToScan.length;

  // Filter rules
  const filteredRules = rules.filter((r) => {
    if (config.rule && !config.rule.includes(r.id)) return false;
    if (config.ruleTag && !r.tags?.includes(config.ruleTag)) return false;
    if (config.minConfidence) {
      const confidenceLevels = { high: 3, medium: 2, low: 1 };
      if (
        (confidenceLevels[r.confidence] || 0) <
        (confidenceLevels[config.minConfidence] || 0)
      ) {
        return false;
      }
    }
    if (config.minSeverity) {
      const severityLevels = { critical: 4, high: 3, medium: 2, low: 1 };
      if (
        (severityLevels[r.severity] || 0) <
        (severityLevels[config.minSeverity] || 0)
      ) {
        return false;
      }
    }
    return true;
  });

  // Scan files
  for (const filePath of filesToScan) {
    try {
      // Check allowlist
      const allowlistEntry = allowlist.find((e) =>
        e.path === filePath || filePath.endsWith(e.path)
      );

      if (allowlistEntry?.rules?.includes("*")) {
        result.stats.suppressed += 1;
        continue;
      }

      // Read file
      let content: string;
      try {
        const buffer = readFileSync(filePath);

        // Check if binary
        if (!config.includeBinary && isBinaryFile(buffer)) {
          continue;
        }

        content = buffer.toString("utf-8");
      } catch {
        continue; // Skip unreadable files
      }

      // Apply rules
      let fileHasFindings = false;

      for (const rule of filteredRules) {
        // Check rule glob patterns
        if (rule.file_glob) {
          const matches = rule.file_glob.some((pattern) =>
            filePath.includes(pattern.replace("**", "").replace("/*", ""))
          );
          if (!matches) continue;
        }

        if (rule.file_glob_exclude) {
          const excluded = rule.file_glob_exclude.some((pattern) =>
            filePath.includes(pattern.replace("**", "").replace("/*", ""))
          );
          if (excluded) continue;
        }

        const findings = matchPattern(content, rule);

        for (const finding of findings) {
          // Check allowlist for this rule
          if (allowlistEntry?.rules?.includes(finding.rule)) {
            result.stats.suppressed += 1;
            continue;
          }

          // Check inline suppressions
          const suppression = findAllowlistSuppression(content, finding.line, finding.rule);
          if (suppression.suppressed) {
            result.stats.suppressed += 1;
            continue;
          }

          // Check for acknowledged debt
          if (isAcknowledgedDebt(content, finding.line, [rule.proposal])) {
            finding.acknowledgedDebt = true;
            result.stats.acknowledgedDebt += 1;
            // Reduce severity
            const severityLevels = { critical: 3, high: 2, medium: 1, low: 0 };
            const newLevel = severityLevels[finding.severity];
            if (newLevel > 0) {
              const levelNames = ["low", "medium", "high", "critical"];
              finding.severity = levelNames[newLevel - 1] as any;
            }
          }

          finding.file = filePath;
          const context = extractContext(content, finding.line);
          finding.context_before = context.before;
          finding.context_after = context.after;

          result.findings.push(finding);
          fileHasFindings = true;

          // Update stats
          result.stats.findingsByRule[finding.rule] =
            (result.stats.findingsByRule[finding.rule] || 0) + 1;
          result.stats.findingsBySeverity[finding.severity] =
            (result.stats.findingsBySeverity[finding.severity] || 0) + 1;
        }
      }

      if (fileHasFindings) {
        result.stats.filesWithFindings += 1;
      }
    } catch (e) {
      result.ruleLoadErrors.push(`Error scanning ${filePath}: ${String(e)}`);
    }
  }

  return result;
}
