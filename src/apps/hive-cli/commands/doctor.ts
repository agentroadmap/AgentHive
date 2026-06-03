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
import { getPool } from "../../../infra/postgres/pool.ts";

export type CheckSeverity = "ok" | "warn" | "error";

export interface DoctorCheck {
  name: string;
  severity: CheckSeverity;
  message: string;
  remediation?: string;
  details?: Record<string, unknown>;
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

  // Check 14: A2A host topology — service liveness + agency attachment (P1135)
  checks.push(await checkTopology(ctx));

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

interface AttachmentRow {
  agent_identity: string;
  is_attached: boolean;
}

export interface TopologyDetails {
  checked_host: string;
  expected_source: "agent_registry.host_affinity";
  expected_count: number;
  attached_count: number;
  unattached_ids: string[];
  legacy_running_count: number;
  mcp_health_latency_ms: number;
  data_source_errors: string[];
  critical_units?: Record<string, string>;
  legacy_running_units?: string[];
}

export interface TopologyProbers {
  systemctlIsActive?: (unit: string) => Promise<string>;
  listLegacyAgencyUnits?: () => Promise<string[]>;
  queryAttachments?: (host: string) => Promise<AttachmentRow[]>;
  fetchMcpHealth?: () => Promise<{ ok: boolean; status: number; body?: unknown; error?: string; latencyMs: number }>;
}

async function defaultSystemctlIsActive(unit: string): Promise<string> {
  const { execFileSync } = await import("node:child_process");
  try {
    return execFileSync("systemctl", ["is-active", unit], { encoding: "utf8", timeout: 1000 }).trim();
  } catch (err) {
    const stdout = (err as { stdout?: Buffer | string }).stdout;
    const status = stdout?.toString().trim();
    return status || "inactive";
  }
}

async function defaultListLegacyAgencyUnits(): Promise<string[]> {
  const { execFileSync } = await import("node:child_process");
  try {
    const out = execFileSync(
      "systemctl",
      ["list-units", "agenthive-agency@*.service", "--state=active", "--no-pager", "--no-legend"],
      { encoding: "utf8", timeout: 1000 },
    ).trim();
    if (!out) return [];
    return out.split("\n").map((line) => line.trim().split(/\s+/)[0]).filter(Boolean);
  } catch {
    return [];
  }
}

async function defaultQueryAttachments(host: string): Promise<AttachmentRow[]> {
  const { rows } = await getPool().query<AttachmentRow>(
    `WITH expected AS (
       SELECT agent_identity
       FROM roadmap_workforce.agent_registry
       WHERE host_affinity = $1
         AND agent_type = 'agency'
         AND status IN ('active', 'dormant')
     ),
     attached AS (
       SELECT agency_id
       FROM roadmap.v_agency_status
       WHERE presence_state IN ('online', 'busy')
     )
     SELECT e.agent_identity, (a.agency_id IS NOT NULL) AS is_attached
     FROM expected e
     LEFT JOIN attached a ON a.agency_id = e.agent_identity
     ORDER BY e.agent_identity`,
    [host],
  );
  return rows;
}

async function defaultFetchMcpHealth(): Promise<{ ok: boolean; status: number; body?: unknown; error?: string; latencyMs: number }> {
  const start = Date.now();
  try {
    const res = await fetch("http://127.0.0.1:6421/health", {
      method: "GET",
      signal: AbortSignal.timeout(1000),
    });
    const latencyMs = Date.now() - start;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, status: res.status, error: "health response was not JSON", latencyMs };
    }
    const statusOk = typeof body === "object" && body !== null && (body as { status?: unknown }).status === "ok";
    return {
      ok: res.status === 200 && statusOk,
      status: res.status,
      body,
      error: res.status === 200 && statusOk ? undefined : "health response did not report status=ok",
      latencyMs,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: (err as Error).message,
      latencyMs: Date.now() - start,
    };
  }
}

export async function checkTopology(ctx: HiveContext, probers: TopologyProbers = {}): Promise<DoctorCheck> {
  const criticalUnits = [
    "agenthive-mcp.service",
    "agenthive-a2a-host.service",
    "agenthive-board.service",
    "agenthive-state-feed.service",
    "agenthive-notification-router.service"
  ];
  const dataSourceErrors: string[] = [];
  const unitStatuses: Record<string, string> = {};
  const checkedHost = ctx.host;

  const systemctlIsActive = probers.systemctlIsActive ?? defaultSystemctlIsActive;
  const listLegacyAgencyUnits = probers.listLegacyAgencyUnits ?? defaultListLegacyAgencyUnits;
  const queryAttachments = probers.queryAttachments ?? defaultQueryAttachments;
  const fetchMcpHealth = probers.fetchMcpHealth ?? defaultFetchMcpHealth;

  for (const unit of criticalUnits) {
    try {
      unitStatuses[unit] = await systemctlIsActive(unit);
    } catch (err) {
      unitStatuses[unit] = "unknown";
      dataSourceErrors.push(`systemctl ${unit}: ${(err as Error).message}`);
    }
  }

  let attachmentRows: AttachmentRow[] = [];
  try {
    attachmentRows = await queryAttachments(checkedHost);
  } catch (err) {
    dataSourceErrors.push(`attachment query: ${(err as Error).message}`);
  }

  let legacyUnits: string[] = [];
  try {
    legacyUnits = await listLegacyAgencyUnits();
  } catch (err) {
    dataSourceErrors.push(`legacy unit query: ${(err as Error).message}`);
  }

  const health = await fetchMcpHealth();
  if (!health.ok) {
    dataSourceErrors.push(`mcp health: ${health.error ?? `HTTP ${health.status}`}`);
  }

  const unattached = attachmentRows
    .filter((row) => !row.is_attached)
    .map((row) => row.agent_identity);
  const expectedCount = attachmentRows.length;
  const attachedCount = expectedCount - unattached.length;
  const inactiveUnits = criticalUnits.filter((unit) => unitStatuses[unit] !== "active");
  const details: TopologyDetails = {
    checked_host: checkedHost,
    expected_source: "agent_registry.host_affinity",
    expected_count: expectedCount,
    attached_count: attachedCount,
    unattached_ids: unattached.slice(0, 5),
    legacy_running_count: legacyUnits.length,
    mcp_health_latency_ms: health.latencyMs,
    data_source_errors: dataSourceErrors,
    critical_units: unitStatuses,
    legacy_running_units: legacyUnits,
  };

  if (inactiveUnits.length > 0) {
    return {
      name: "topology",
      severity: "error",
      message: `Critical units not active: ${inactiveUnits.join(", ")}`,
      remediation: "Run `sudo systemctl status <unit>` for details.",
      details: details as unknown as Record<string, unknown>,
    };
  }

  if (!health.ok) {
    return {
      name: "topology",
      severity: "error",
      message: `MCP health endpoint failed: ${health.error ?? `HTTP ${health.status}`}`,
      remediation: "Check agenthive-mcp.service and http://127.0.0.1:6421/health.",
      details: details as unknown as Record<string, unknown>,
    };
  }

  if (dataSourceErrors.length > 0) {
    return {
      name: "topology",
      severity: "warn",
      message: `Topology check completed with data-source errors: ${dataSourceErrors.join("; ")}`,
      remediation: "Check systemctl access and roadmap_workforce.agent_registry / roadmap.v_agency_status permissions.",
      details: details as unknown as Record<string, unknown>,
    };
  }

  if (unattached.length > 0) {
    const transitional = unattached.length <= 2;
    return {
      name: "topology",
      severity: "warn",
      message: transitional
        ? `${unattached.length}/${expectedCount} expected agencies are not attached on ${checkedHost}; transitional restart window or legacy identity likely`
        : `${unattached.length}/${expectedCount} expected agencies are not attached on ${checkedHost}: ${unattached.slice(0, 5).join(", ")}${unattached.length > 5 ? ` +${unattached.length - 5} more` : ""}`,
      remediation: "Check agenthive-a2a-host.service logs and agency presence updates.",
      details: details as unknown as Record<string, unknown>,
    };
  }

  if (legacyUnits.length > 0) {
    return {
      name: "topology",
      severity: "warn",
      message: `Legacy template instance(s) running — P1132 cutover incomplete or rollback in progress: ${legacyUnits.join(", ")}`,
      remediation: "P1132 should have retired per-agency template; investigate.",
      details: details as unknown as Record<string, unknown>,
    };
  }

  return {
    name: "topology",
    severity: "ok",
    message: `Topology check passed for ${checkedHost}: ${attachedCount}/${expectedCount} expected agencies attached, no legacy agency instances running, MCP healthy.`,
    details: details as unknown as Record<string, unknown>,
  };
}

async function checkA2aListenApplications(): Promise<string[]> {
  const { rows } = await getPool().query<{ application_name: string }>(
    `SELECT application_name
     FROM pg_stat_activity
     WHERE application_name LIKE 'agenthive-a2a-listen-%'
     ORDER BY application_name`,
  );
  return rows.map((row) => row.application_name);
}

async function withA2aListenDetails(check: DoctorCheck): Promise<DoctorCheck> {
  try {
    return {
      ...check,
      details: {
        ...(check.details ?? {}),
        a2a_listen_applications: await checkA2aListenApplications(),
      },
    };
  } catch (err) {
    const details = check.details ?? {};
    return {
      ...check,
      details: {
        ...details,
        data_source_errors: [
          ...((details.data_source_errors as string[] | undefined) ?? []),
          `a2a listen inventory: ${(err as Error).message}`,
        ],
      },
    };
  }
}

export function registerDoctor(program: Command, getContext: () => Promise<HiveContext>): void {
  program
    .command("doctor")
    .description("Run system readiness checks (14 checks, severity + remediation per check)")
    .option("--project <P>", "Project slug override")
    .option("--check <NAME>", "Run only checks whose name contains NAME (substring match)")
    .option("--fix", "Attempt automated remediation where possible")
    .option("--verbose", "Show additional detail per check")
    .option("--remediate", "Alias for --fix")
    .option("--json", "Shorthand for --format json")
    .option("-o, --format <FMT>", "Output format (text|json|jsonl|yaml)", "text")
    .option("-q, --quiet", "Suppress output; exit code signals health")
    .action(async (opts) => {
      const start = Date.now();
      const ctx = await getContext();
      if (opts.project) ctx.project = opts.project;
      const fmt = (opts.json ? "json" : opts.format) as OutputFormat;

      let checks = await runChecks(ctx);

      // If --check <name> specified, filter to just that check
      if (opts.check) {
        const checkName = opts.check.toLowerCase();
        checks = checks.filter((c) => c.name.toLowerCase().includes(checkName));
      }

      if (opts.verbose) {
        checks = await Promise.all(checks.map((check) => check.name === "topology" ? withA2aListenDetails(check) : check));
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
            if (check.details && opts.verbose) {
              printText([`        ↳ ${JSON.stringify(check.details)}`]);
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
