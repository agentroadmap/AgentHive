import type { Rule, Finding, AutoFixDescriptor } from "../scanner/rules.ts";
import type { ScannerResult } from "../scanner/engine.ts";

export interface FixResult {
  file: string;
  rule: string;
  transform: AutoFixDescriptor["transform"];
  applied: boolean;
  reason?: string;
}

export interface FixPlan {
  safe: FixResult[];
  rejected: FixResult[];
}

/**
 * Validates that a rule is eligible for auto-fix.
 * Rules without an `auto_fix` descriptor are REJECTED — this is the AC7 safety invariant.
 */
export function isAutoFixable(rule: Rule): boolean {
  return (
    rule.auto_fix !== undefined &&
    typeof rule.auto_fix.transform === "string" &&
    typeof rule.auto_fix.target_module === "string" &&
    typeof rule.auto_fix.target_export === "string"
  );
}

/**
 * Build a fix plan from a scan result.
 * Separates findings into safe (has auto_fix descriptor) vs rejected (no descriptor).
 * Does NOT apply fixes — callers must pass the plan to applyFixPlan().
 */
export function buildFixPlan(
  result: ScannerResult,
  ruleIndex: Map<string, Rule>
): FixPlan {
  const safe: FixResult[] = [];
  const rejected: FixResult[] = [];

  for (const finding of result.findings) {
    const rule = ruleIndex.get(finding.rule);

    if (!rule || !isAutoFixable(rule)) {
      rejected.push({
        file: finding.file ?? "<unknown>",
        rule: finding.rule,
        transform: "path-replace",
        applied: false,
        reason: rule
          ? `Rule '${finding.rule}' has no auto_fix descriptor — manual fix required`
          : `Rule '${finding.rule}' not found in index`,
      });
      continue;
    }

    safe.push({
      file: finding.file ?? "<unknown>",
      rule: finding.rule,
      transform: rule.auto_fix!.transform,
      applied: false,
    });
  }

  return { safe, rejected };
}

/**
 * Format a fix plan as a human-readable report.
 */
export function formatFixPlan(plan: FixPlan): string {
  const lines: string[] = [];

  if (plan.safe.length > 0) {
    lines.push(`Auto-fixable (${plan.safe.length}):`);
    for (const fix of plan.safe) {
      lines.push(`  ✓ ${fix.file} [${fix.rule}] → ${fix.transform}`);
    }
  }

  if (plan.rejected.length > 0) {
    lines.push(`Rejected (${plan.rejected.length}) — no auto_fix descriptor:`);
    for (const fix of plan.rejected) {
      lines.push(`  ✗ ${fix.file} [${fix.rule}]: ${fix.reason}`);
    }
  }

  if (plan.safe.length === 0 && plan.rejected.length === 0) {
    lines.push("No findings to fix.");
  }

  return lines.join("\n");
}
