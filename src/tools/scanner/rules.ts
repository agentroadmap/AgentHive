import fs from "fs/promises";
import path from "path";
import yaml from "js-yaml";

export type Severity = "critical" | "high" | "medium" | "low";
export type Confidence = "high" | "medium" | "low";

export interface AutoFixDescriptor {
  transform: "path-replace" | "model-replace" | "state-name-replace";
  target_module: string;
  target_export: string;
}

export interface Rule {
  id: string;
  description: string;
  severity: Severity;
  confidence: Confidence;
  proposal: string;
  pattern?: string;
  regex?: string;
  ast_query?: string;
  file_glob?: string[];
  file_glob_exclude?: string[];
  fix_suggestion: string;
  examples_match: string[];
  examples_no_match: string[];
  tags?: string[];
  auto_fix?: AutoFixDescriptor;
}

export interface RuleSet {
  ruleset: string;
  description: string;
  rules: Rule[];
}

export interface ScannerConfig {
  rules?: string;
  rule?: string[];
  ruleTag?: string;
  minConfidence?: Confidence;
  minSeverity?: Severity;
  format?: "human" | "jsonl" | "sarif" | "mcp";
  out?: string;
  failOn?: Severity;
  allowlistPath?: string;
  selfTest?: boolean;
  explain?: string;
  listRules?: boolean;
  baseline?: string;
  emitBaseline?: string;
  concurrency?: number;
  includeBinary?: boolean;
  gitStaged?: boolean;
  gitChanged?: boolean;
  verbose?: boolean;
  paths?: string[];
}

export interface Finding {
  rule: string;
  file?: string;
  line: number;
  col: number;
  match: string;
  snippet: string;
  severity: Severity;
  confidence: Confidence;
  proposal: string;
  description: string;
  fixSuggestion: string;
  tags: string[];
  acknowledgedDebt: boolean;
  context_before?: string[];
  context_after?: string[];
}

async function validateRule(rule: Rule): Promise<string[]> {
  const errors: string[] = [];

  if (!rule.id || !/^[a-z0-9.-]+$/.test(rule.id)) {
    errors.push(`Invalid rule id: ${rule.id} (must be kebab-case or category.rule-name)`);
  }
  if (!rule.description) errors.push("Missing description");
  if (!["critical", "high", "medium", "low"].includes(rule.severity)) {
    errors.push(`Invalid severity: ${rule.severity}`);
  }
  if (!["high", "medium", "low"].includes(rule.confidence)) {
    errors.push(`Invalid confidence: ${rule.confidence}`);
  }
  if (!rule.proposal) errors.push("Missing proposal");
  if (!rule.pattern && !rule.regex && !rule.ast_query) {
    errors.push("Must have pattern, regex, or ast_query");
  }
  if (rule.regex) {
    try {
      new RegExp(rule.regex);
    } catch (e) {
      errors.push(`Invalid regex: ${String(e)}`);
    }
  }
  if (!rule.fix_suggestion) errors.push("Missing fix_suggestion");
  if (!rule.examples_match || rule.examples_match.length === 0) {
    errors.push("Missing examples_match");
  }
  if (!rule.examples_no_match || rule.examples_no_match.length === 0) {
    errors.push("Missing examples_no_match");
  }

  return errors;
}

function testRuleExamples(rule: Rule): string[] {
  const errors: string[] = [];

  // Test match examples
  for (const example of rule.examples_match) {
    let matches = false;

    if (rule.pattern && example.includes(rule.pattern)) {
      matches = true;
    } else if (rule.regex) {
      matches = new RegExp(rule.regex).test(example);
    }

    if (!matches) {
      errors.push(`examples_match failed: "${example}" should match rule ${rule.id}`);
    }
  }

  // Test no-match examples
  for (const example of rule.examples_no_match) {
    let matches = false;

    if (rule.pattern && example.includes(rule.pattern)) {
      matches = true;
    } else if (rule.regex) {
      matches = new RegExp(rule.regex).test(example);
    }

    if (matches) {
      errors.push(
        `examples_no_match failed: "${example}" should NOT match rule ${rule.id}`
      );
    }
  }

  return errors;
}

export async function loadRules(rulesDir: string): Promise<{
  rules: Rule[];
  errors: string[];
}> {
  const rules: Rule[] = [];
  const errors: string[] = [];

  try {
    const files = await fs.readdir(rulesDir);
    const yamlFiles = files
      .filter((f) => (f.endsWith(".yaml") || f.endsWith(".yml")) && !f.includes(".draft"))
      .sort();

    for (const file of yamlFiles) {
      try {
        const content = await fs.readFile(path.join(rulesDir, file), "utf-8");
        const parsed = yaml.load(content) as RuleSet;

        if (!parsed || typeof parsed !== 'object' || !('rules' in parsed)) {
          // Skip non-ruleset files (like SCHEMA.yaml)
          continue;
        }

        if (!parsed.rules) {
          errors.push(`No rules found in ${file}`);
          continue;
        }

        for (const rule of parsed.rules) {
          // Validate structure
          const validationErrors = await validateRule(rule);
          for (const err of validationErrors) {
            errors.push(`${file}:${rule.id}: ${err}`);
          }

          // Test examples
          const exampleErrors = testRuleExamples(rule);
          for (const err of exampleErrors) {
            errors.push(`${file}:${rule.id}: ${err}`);
          }

          if (validationErrors.length === 0 && exampleErrors.length === 0) {
            rules.push(rule);
          }
        }
      } catch (e) {
        errors.push(`Error parsing ${file}: ${String(e)}`);
      }
    }

    // Check for duplicate rule IDs
    const ids = new Set<string>();
    for (const rule of rules) {
      if (ids.has(rule.id)) {
        errors.push(`Duplicate rule id: ${rule.id}`);
      }
      ids.add(rule.id);
    }
  } catch (e) {
    errors.push(`Error reading rules directory: ${String(e)}`);
  }

  return { rules, errors };
}

export async function saveBaseline(
  findings: Finding[],
  outputPath: string
): Promise<void> {
  const jsonl = findings
    .map((f) => JSON.stringify({
      rule: f.rule,
      file: f.file,
      line: f.line,
      col: f.col,
      severity: f.severity,
      confidence: f.confidence,
      proposal: f.proposal,
    }))
    .join("\n");

  await fs.writeFile(outputPath, jsonl, "utf-8");
}

export async function loadBaseline(
  baselinePath: string
): Promise<Set<string>> {
  try {
    const content = await fs.readFile(baselinePath, "utf-8");
    const baseline = new Set<string>();

    for (const line of content.split("\n")) {
      if (!line) continue;
      const finding = JSON.parse(line);
      baseline.add(
        `${finding.file}:${finding.line}:${finding.col}:${finding.rule}`
      );
    }

    return baseline;
  } catch {
    return new Set();
  }
}

export function diffBaseline(
  current: Finding[],
  baseline: Set<string>
): { new: Finding[]; resolved: number } {
  const new_findings: Finding[] = [];

  for (const finding of current) {
    const key = `${finding.file}:${finding.line}:${finding.col}:${finding.rule}`;
    if (!baseline.has(key)) {
      new_findings.push(finding);
    }
  }

  return {
    new: new_findings,
    resolved: baseline.size - new_findings.length,
  };
}
