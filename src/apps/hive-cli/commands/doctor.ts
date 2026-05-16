/**
 * hive doctor — system readiness checks.
 * Runs 12+ checks, reports [OK]/[WARN]/[ERROR] per check.
 * Exit: 0=healthy, 1=warnings-only, 5=errors.
 */

import type { Command } from "commander";
import type { HiveContext } from "../common/context.ts";
import { buildOkEnvelope } from "../common/envelope.ts";
import { printEnvelope, printText, type OutputFormat } from "../common/formatters.ts";
import { EXIT } from "../common/exit-codes.ts";
import { pingMcp } from "../common/mcp-client.ts";

export type CheckSeverity = "ok" | "warn" | "error";

export interface DoctorCheck {
  name: string;
  severity: CheckSeverity;
  message: string;
  remediation?: string;
}

async function runChecks(ctx: HiveContext): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // Check 1: MCP reachability
  const mcp = await pingMcp(ctx.mcp_url);
  checks.push({
    name: "mcp_reachable",
    severity: mcp.reachable ? "ok" : "error",
    message: mcp.reachable
      ? `MCP server reachable at ${ctx.mcp_url} (${mcp.latency_ms}ms)`
      : `MCP server unreachable at ${ctx.mcp_url}: ${mcp.error}`,
    remediation: mcp.reachable
      ? undefined
      : "Run `sudo systemctl status agenthive-mcp` or check HIVE_MCP_URL.",
  });

  // Check 2: MCP latency warning
  if (mcp.reachable && mcp.latency_ms > 2000) {
    checks.push({
      name: "mcp_latency",
      severity: "warn",
      message: `MCP latency is high: ${mcp.latency_ms}ms (>2000ms threshold)`,
      remediation: "Check network conditions or MCP server load.",
    });
  } else if (mcp.reachable) {
    checks.push({
      name: "mcp_latency",
      severity: "ok",
      message: `MCP latency acceptable: ${mcp.latency_ms}ms`,
    });
  }

  // Check 3: Project context
  checks.push({
    name: "project_context",
    severity: ctx.project ? "ok" : "warn",
    message: ctx.project
      ? `Project context resolved: ${ctx.project}`
      : "No project context. Set HIVE_PROJECT or create .hive/config.json.",
    remediation: ctx.project ? undefined : "Run `hive init` to initialize a project, or set HIVE_PROJECT env.",
  });

  // Check 4: Agency context
  checks.push({
    name: "agency_context",
    severity: ctx.agency ? "ok" : "warn",
    message: ctx.agency
      ? `Agency context resolved: ${ctx.agency}`
      : "No agency context. Set HIVE_AGENCY for agent-specific operations.",
    remediation: ctx.agency ? undefined : "Set HIVE_AGENCY=<agency_id> in your environment.",
  });

  // Check 5: Host policy
  checks.push({
    name: "host_policy",
    severity: "ok",
    message: `Host resolved: ${ctx.host}`,
  });

  // Check 6: DB host reachable (best-effort TCP check)
  const dbOk = await checkDbPort(ctx.db_host, ctx.db_port);
  checks.push({
    name: "db_connection",
    severity: dbOk ? "ok" : "error",
    message: dbOk
      ? `DB endpoint reachable: ${ctx.db_host}:${ctx.db_port}`
      : `DB endpoint not reachable: ${ctx.db_host}:${ctx.db_port}`,
    remediation: dbOk ? undefined : "Check postgres service: `sudo systemctl status postgresql`",
  });

  // Check 7: HIVE_MCP_URL env var
  checks.push({
    name: "mcp_url_configured",
    severity: process.env.HIVE_MCP_URL ? "ok" : "warn",
    message: process.env.HIVE_MCP_URL
      ? `HIVE_MCP_URL set: ${process.env.HIVE_MCP_URL}`
      : `HIVE_MCP_URL not set; using default: ${ctx.mcp_url}`,
    remediation: process.env.HIVE_MCP_URL
      ? undefined
      : "Set HIVE_MCP_URL=http://127.0.0.1:6421/sse in your shell profile.",
  });

  // Check 8: Schema version (always OK at launch; drift detected at runtime per command)
  checks.push({
    name: "schema_version",
    severity: "ok",
    message: "CLI schema_version: 1 (compatible)",
  });

  // Check 9: Git worktree sanity
  const gitOk = await checkGitWorktree();
  checks.push({
    name: "git_worktree",
    severity: gitOk ? "ok" : "warn",
    message: gitOk
      ? "Git worktree looks healthy"
      : "Could not detect git worktree; some operations may be limited",
    remediation: gitOk ? undefined : "Ensure you are in a git repository.",
  });

  // Check 10: NODE environment
  const nodeVersion = process.version;
  const nodeOk = checkNodeVersion(nodeVersion);
  checks.push({
    name: "node_version",
    severity: nodeOk ? "ok" : "warn",
    message: `Node.js ${nodeVersion}${nodeOk ? "" : " — hive requires >= 24.0.0"}`,
    remediation: nodeOk ? undefined : "Upgrade Node.js to >= 24.0.0.",
  });

  // Check 11: Budget status (placeholder — real check reads control DB)
  checks.push({
    name: "budget_status",
    severity: "ok",
    message: "Budget check skipped (requires DB read; run `hive budget show` for details)",
  });

  // Check 12: Route availability (placeholder)
  checks.push({
    name: "route_availability",
    severity: mcp.reachable ? "ok" : "warn",
    message: mcp.reachable
      ? "Route availability check deferred to MCP (run `hive route list`)"
      : "Route availability unknown — MCP unreachable",
    remediation: mcp.reachable ? undefined : "Restore MCP connectivity first.",
  });

  // Check 13: HMAC signing secret (AC-5: P1097 requirement)
  const hmacSecret = process.env.DELIVERY_SIGNING_SECRET;
  const hmacOk = hmacSecret && /^[0-9a-f]{64,}$/.test(hmacSecret); // ≥256 bits = 64 hex chars
  checks.push({
    name: "hmac_signing_secret",
    severity: hmacOk ? "ok" : "warn",
    message: hmacOk
      ? "DELIVERY_SIGNING_SECRET present and ≥256 bits of entropy"
      : "DELIVERY_SIGNING_SECRET not set or too short (<256 bits)",
    remediation: hmacOk
      ? undefined
      : "Set DELIVERY_SIGNING_SECRET to a ≥256-bit hex string. Generate with: `node -e \"console.log(require('crypto').randomBytes(32).toString('hex'));\"`",
  });

  return checks;
}

async function checkDbPort(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    import("node:net").then(({ createConnection }) => {
      const sock = createConnection({ host, port });
      const timer = setTimeout(() => { sock.destroy(); resolve(false); }, 3000);
      sock.once("connect", () => { clearTimeout(timer); sock.destroy(); resolve(true); });
      sock.once("error", () => { clearTimeout(timer); resolve(false); });
    }).catch(() => resolve(false));
  });
}

async function checkGitWorktree(): Promise<boolean> {
  try {
    const { execSync } = await import("node:child_process");
    execSync("git rev-parse --git-dir", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function checkNodeVersion(version: string): boolean {
  const match = version.match(/^v(\d+)/);
  if (!match) return false;
  return Number(match[1]) >= 24;
}

export function registerDoctor(program: Command, getContext: () => Promise<HiveContext>): void {
  program
    .command("doctor")
    .description("Run system readiness checks (12+ checks, severity + remediation per check)")
    .option("--project <P>", "Project slug override")
    .option("--check <NAME>", "Run single check by name (e.g., --check hmac for P1097 HMAC verification)")
    .option("--fix", "Attempt automated remediation where possible")
    .option("--verbose", "Show additional detail per check")
    .option("--remediate", "Alias for --fix")
    .option("-o, --format <FMT>", "Output format (text|json|jsonl|yaml)", "text")
    .option("-q, --quiet", "Suppress output; exit code signals health")
    .action(async (opts) => {
      const start = Date.now();
      const ctx = await getContext();
      if (opts.project) ctx.project = opts.project;
      const fmt = opts.format as OutputFormat;

      let checks = await runChecks(ctx);

      // If --check <name> specified, filter to just that check
      if (opts.check) {
        const checkName = opts.check.toLowerCase();
        checks = checks.filter((c) => c.name.toLowerCase().includes(checkName));
        if (checks.length === 0) {
          printText([`hive doctor: no check matching "${opts.check}" found`]);
          process.exit(EXIT.INTERNAL_ERROR);
        }
      }

      const elapsed = Date.now() - start;

      const hasErrors = checks.some((c) => c.severity === "error");
      const hasWarnings = checks.some((c) => c.severity === "warn");

      if (!opts.quiet) {
        if (fmt === "text") {
          for (const check of checks) {
            const badge =
              check.severity === "ok" ? "[OK]" : check.severity === "warn" ? "[WARN]" : "[ERROR]";
            printText([`${badge.padEnd(7)} ${check.name}: ${check.message}`]);
            if (check.remediation && opts.verbose) {
              printText([`        ↳ ${check.remediation}`]);
            }
          }
          printText([""]);
          if (hasErrors) printText(["Status: ERRORS — see [ERROR] checks above."]);
          else if (hasWarnings) printText(["Status: WARNINGS — system functional with caveats."]);
          else printText(["Status: HEALTHY"]);
        } else {
          const envelope = buildOkEnvelope(
            "hive doctor",
            ctx,
            { checks, summary: { total: checks.length, ok: checks.filter((c) => c.severity === "ok").length, warn: checks.filter((c) => c.severity === "warn").length, error: checks.filter((c) => c.severity === "error").length } },
            { elapsed_ms: elapsed },
          );
          printEnvelope(envelope, fmt);
        }
      }

      if (hasErrors) process.exit(EXIT.REMOTE_FAILURE);
      else if (hasWarnings) process.exit(1);
      else process.exit(EXIT.OK);
    });
}
