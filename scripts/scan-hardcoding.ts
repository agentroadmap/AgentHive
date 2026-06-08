#!/usr/bin/env node
import { Command } from "commander";
import { loadRules, type ScannerConfig, saveBaseline, loadBaseline, diffBaseline } from "../src/tools/scanner/rules.ts";
import { runScan } from "../src/tools/scanner/engine.ts";
import { writeOutput, shouldFail } from "../src/tools/scanner/output.ts";
import { createAllowlistTemplate } from "../src/tools/scanner/allowlist.ts";
import fs from "fs/promises";
import path from "path";

const program = new Command();

program
  .name("scan-hardcoding")
  .description("Scan for hardcoded paths, credentials, and configuration in AgentHive codebase")
  .version("1.0.0");

program
  .argument("[paths...]", "Paths to scan (default: all)")
  .option("--rules <dir>", "Rule directory", "src/tools/scanner/rules")
  .option("--rule <id>", "Run only this rule (repeatable)", (val, prev) => [...((prev as string[]) || []), val])
  .option("--rule-tag <tag>", "Run only rules with this tag (repeatable)")
  .option("--min-confidence <lvl>", "Minimum confidence (high|medium|low)", "medium")
  .option("--min-severity <lvl>", "Minimum severity (critical|high|medium|low)", "low")
  .option("--format <fmt>", "Output format (human|jsonl|sarif|mcp)", "human")
  .option("--out <file>", "Write findings to file")
  .option("--fail-on <severity>", "Exit code 1 if findings >= severity")
  .option("--allowlist <file>", "Custom allowlist YAML", ".scanignore.yaml")
  .option("--self-test", "Run examples_match / examples_no_match for all rules")
  .option("--explain <rule-id>", "Print rule details and exit")
  .option("--list-rules", "Print all loaded rules and exit")
  .option("--baseline <file>", "Compare against baseline JSONL; exit 0 if no NEW findings")
  .option("--emit-baseline <file>", "Write current findings to baseline file")
  .option("--concurrency <n>", "File-walk parallelism", String(require("os").cpus().length))
  .option("--include-binary", "Don't skip binary files", false)
  .option("--git-staged", "Scan only git staged files", false)
  .option("--git-changed", "Scan only files changed since main", false)
  .option("-v, --verbose", "Per-file progress", false)
  .option("--init-allowlist", "Create .scanignore.yaml template and exit", false)
  .action(async (paths, options) => {
    try {
      const config: ScannerConfig = {
        rules: options.rules,
        rule: options.rule,
        ruleTag: options.ruleTag,
        minConfidence: options.minConfidence as any,
        minSeverity: options.minSeverity as any,
        format: options.format as any,
        out: options.out,
        failOn: options.failOn as any,
        allowlistPath: options.allowlist,
        selfTest: options.selfTest,
        explain: options.explain,
        listRules: options.listRules,
        baseline: options.baseline,
        emitBaseline: options.emitBaseline,
        concurrency: parseInt(options.concurrency),
        includeBinary: options.includeBinary,
        gitStaged: options.gitStaged,
        gitChanged: options.gitChanged,
        verbose: options.verbose,
        paths: paths.length > 0 ? paths : undefined,
      };

      // Handle init-allowlist
      if (options.initAllowlist) {
        const template = await createAllowlistTemplate();
        await fs.writeFile(".scanignore.yaml", template, "utf-8");
        console.log("Created .scanignore.yaml");
        process.exit(0);
      }

      // Load rules
      const rulesDir = path.resolve(config.rules || "src/tools/scanner/rules");
      const { rules, errors: ruleErrors } = await loadRules(rulesDir);

      if (ruleErrors.length > 0) {
        console.error("Rule load errors:");
        for (const err of ruleErrors) {
          console.error(`  ${err}`);
        }
        if (rules.length === 0) {
          // Only exit if NO rules loaded successfully
          process.exit(1);
        }
      }

      // Handle --explain
      if (config.explain) {
        const rule = rules.find((r) => r.id === config.explain);
        if (!rule) {
          console.error(`Rule not found: ${config.explain}`);
          process.exit(1);
        }

        console.log(`Rule: ${rule.id}`);
        console.log(`Description: ${rule.description}`);
        console.log(`Severity: ${rule.severity}`);
        console.log(`Confidence: ${rule.confidence}`);
        console.log(`Proposal: ${rule.proposal}`);
        console.log(`Tags: ${rule.tags?.join(", ") || "none"}`);
        console.log(`\nFix Suggestion:\n${rule.fix_suggestion}`);
        console.log(`\nExamples that SHOULD match:`);
        for (const ex of rule.examples_match) {
          console.log(`  ${ex}`);
        }
        console.log(`\nExamples that should NOT match:`);
        for (const ex of rule.examples_no_match) {
          console.log(`  ${ex}`);
        }
        process.exit(0);
      }

      // Handle --list-rules
      if (config.listRules) {
        const sorted = rules.sort((a, b) => a.id.localeCompare(b.id));
        console.log("Loaded Rules:");
        for (const rule of sorted) {
          console.log(`  ${rule.id.padEnd(40)} [${rule.severity.padEnd(8)}] ${rule.proposal}`);
        }
        process.exit(0);
      }

      // Handle --self-test
      if (config.selfTest) {
        let passCount = 0;
        let failCount = 0;

        for (const rule of rules) {
          if (rule.examples_match.length === 0 && rule.examples_no_match.length === 0) {
            console.log(`⊘ ${rule.id}: no examples defined`);
            failCount++;
            continue;
          }

          // Test match examples
          let rulePass = true;
          for (const example of rule.examples_match) {
            let matches = false;
            if (rule.pattern && example.includes(rule.pattern)) {
              matches = true;
            } else if (rule.regex) {
              matches = new RegExp(rule.regex).test(example);
            }

            if (!matches) {
              console.log(`✗ ${rule.id}: examples_match failed`);
              console.log(`    Expected: "${example}"`);
              rulePass = false;
              failCount++;
              break;
            }
          }

          if (rulePass) {
            // Test no-match examples
            for (const example of rule.examples_no_match) {
              let matches = false;
              if (rule.pattern && example.includes(rule.pattern)) {
                matches = true;
              } else if (rule.regex) {
                matches = new RegExp(rule.regex).test(example);
              }

              if (matches) {
                console.log(`✗ ${rule.id}: examples_no_match failed`);
                console.log(`    Unexpected match: "${example}"`);
                rulePass = false;
                failCount++;
                break;
              }
            }
          }

          if (rulePass) {
            console.log(`✓ ${rule.id}`);
            passCount++;
          }
        }

        console.log(`\nResults: ${passCount} pass, ${failCount} fail`);
        process.exit(failCount > 0 ? 1 : 0);
      }

      // Run scan
      const result = await runScan(config, rules);

      // Handle baseline
      if (config.baseline) {
        const baseline = await loadBaseline(config.baseline);
        const diff = diffBaseline(result.findings, baseline);
        result.findings = diff.new;
        console.log(
          `Baseline comparison: ${diff.new.length} new findings, ${diff.resolved} resolved`
        );
      }

      // Emit baseline
      if (config.emitBaseline) {
        await saveBaseline(result.findings, config.emitBaseline);
        console.log(`Baseline saved to ${config.emitBaseline}`);
      }

      // Write output
      const output = await writeOutput(
        config.format || "human",
        result,
        config.out,
        config.verbose
      );
      if (!config.out) {
        console.log(output);
      }

      // Check fail condition
      if (shouldFail(result, config.failOn)) {
        process.exit(1);
      }
    } catch (e) {
      console.error("Fatal error:", e);
      process.exit(1);
    }
  });

program.parse();
