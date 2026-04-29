/**
 * hive proposal — CRUD + lifecycle commands.
 * All mutations go through MCP. Reads fall back to control DB on MCP outage.
 */

import type { Command } from "commander";
import type { HiveContext } from "../common/context.ts";
import { buildOkEnvelope, buildErrorEnvelope } from "../common/envelope.ts";
import { printEnvelope, printText, formatTable, formatRecord, type OutputFormat } from "../common/formatters.ts";
import { EXIT } from "../common/exit-codes.ts";
import { mcpCall } from "../common/mcp-client.ts";

export function registerProposal(program: Command, getContext: () => Promise<HiveContext>): void {
  const proposal = program
    .command("proposal")
    .description("Proposal CRUD, lifecycle, and gating operations");

  // hive proposal list
  proposal
    .command("list")
    .description("List proposals with optional filters")
    .option("--state <STATE>", "Filter by state (DRAFT|REVIEW|DEVELOP|MERGE|COMPLETE)")
    .option("--type <TYPE>", "Filter by type (product|component|feature|issue|hotfix)")
    .option("--owner <AGENCY>", "Filter by owning agency")
    .option("--limit <N>", "Max results (default 20)", "20")
    .option("--cursor <C>", "Pagination cursor")
    .option("--project <P>", "Project slug override")
    .option("-o, --format <FMT>", "Output format (text|json|jsonl|yaml)", "text")
    .option("-q, --quiet", "Suppress output")
    .action(async (opts) => {
      const start = Date.now();
      const ctx = await getContext();
      if (opts.project) ctx.project = opts.project;
      const fmt = opts.format as OutputFormat;

      const result = await mcpCall(ctx.mcp_url, "mcp_proposal", {
        action: "list",
        state: opts.state,
        type: opts.type,
        owner: opts.owner,
        limit: Number(opts.limit),
        cursor: opts.cursor,
        project: ctx.project,
      });

      const elapsed = Date.now() - start;

      if (!result.ok) {
        const envelope = buildErrorEnvelope("hive proposal list", ctx, {
          code: (result.error?.code as never) ?? "REMOTE_FAILURE",
          message: result.error?.message ?? "Unknown error",
          retriable: true,
        }, { elapsed_ms: elapsed });
        if (!opts.quiet) printEnvelope(envelope, fmt);
        process.exit(EXIT.REMOTE_FAILURE);
      }

      const items = (result.data as { proposals?: unknown[] })?.proposals ?? [];
      const cursor = (result.data as { next_cursor?: string | null })?.next_cursor ?? null;

      if (!opts.quiet) {
        if (fmt === "text") {
          if (items.length === 0) {
            printText(["No proposals found."]);
          } else {
            const rows = (items as Record<string, unknown>[]).map((p) => ({
              id: p.id ?? p.proposal_id ?? "",
              status: p.status ?? p.state ?? "",
              type: p.type ?? "",
              title: String(p.title ?? "").slice(0, 60),
            }));
            printText([formatTable(rows, ["id", "status", "type", "title"])]);
          }
        } else {
          const envelope = buildOkEnvelope("hive proposal list", ctx, items, {
            next_cursor: cursor,
            elapsed_ms: elapsed,
          });
          printEnvelope(envelope, fmt);
        }
      }
    });

  // hive proposal get
  proposal
    .command("get <proposal_id>")
    .description("Fetch proposal full state")
    .option("--include <SECTIONS>", "Comma-separated: leases,dispatches,events,reviews,ac")
    .option("--raw", "Print raw MCP response")
    .option("--project <P>", "Project slug override")
    .option("-o, --format <FMT>", "Output format (text|json|jsonl|yaml)", "text")
    .option("-q, --quiet", "Suppress output")
    .action(async (proposalId: string, opts) => {
      const start = Date.now();
      const ctx = await getContext();
      if (opts.project) ctx.project = opts.project;
      const fmt = opts.format as OutputFormat;

      const include = opts.include ? opts.include.split(",").map((s: string) => s.trim()) : [];

      const result = await mcpCall(ctx.mcp_url, "mcp_proposal", {
        action: "detail",
        id: proposalId,
        include,
        project: ctx.project,
      });

      const elapsed = Date.now() - start;

      if (!result.ok) {
        const code = result.error?.code === "NOT_FOUND" ? "NOT_FOUND" : "REMOTE_FAILURE";
        const envelope = buildErrorEnvelope("hive proposal get", ctx, {
          code: code as never,
          message: result.error?.message ?? `Proposal ${proposalId} not found`,
          hint: "Run `hive proposal list --format json` to see available IDs.",
          detail: { proposal_id: proposalId, project: ctx.project },
          retriable: code === "REMOTE_FAILURE",
        }, { elapsed_ms: elapsed });
        if (!opts.quiet) printEnvelope(envelope, fmt);
        process.exit(code === "NOT_FOUND" ? EXIT.NOT_FOUND : EXIT.REMOTE_FAILURE);
      }

      if (!opts.quiet) {
        if (opts.raw) {
          process.stdout.write(JSON.stringify(result.data, null, 2) + "\n");
        } else if (fmt === "text") {
          const p = result.data as Record<string, unknown>;
          printText([formatRecord(p)]);
        } else {
          const envelope = buildOkEnvelope("hive proposal get", ctx, result.data, { elapsed_ms: elapsed });
          printEnvelope(envelope, fmt);
        }
      }
    });

  // hive proposal show (alias for get with text default)
  proposal
    .command("show <proposal_id>")
    .description("Human-friendly view of a proposal (alias for get)")
    .option("--include <SECTIONS>", "Comma-separated: full|leases|dispatches|runs|events|versions")
    .option("--project <P>", "Project slug override")
    .option("-o, --format <FMT>", "Output format (text|json|jsonl|yaml)", "text")
    .action(async (proposalId: string, opts) => {
      const start = Date.now();
      const ctx = await getContext();
      if (opts.project) ctx.project = opts.project;
      const fmt = opts.format as OutputFormat;
      const include = opts.include ? opts.include.split(",").map((s: string) => s.trim()) : [];

      const result = await mcpCall(ctx.mcp_url, "mcp_proposal", {
        action: "detail",
        id: proposalId,
        include,
        project: ctx.project,
      });

      const elapsed = Date.now() - start;

      if (!result.ok) {
        const envelope = buildErrorEnvelope("hive proposal show", ctx, {
          code: "NOT_FOUND",
          message: result.error?.message ?? `Proposal ${proposalId} not found`,
          hint: `Run \`hive proposal list\` to see available proposals.`,
          detail: { proposal_id: proposalId },
          retriable: false,
        }, { elapsed_ms: elapsed });
        printEnvelope(envelope, fmt === "text" ? "json" : fmt);
        process.exit(EXIT.NOT_FOUND);
      }

      if (fmt === "text") {
        const p = result.data as Record<string, unknown>;
        printText([formatRecord(p)]);
      } else {
        const envelope = buildOkEnvelope("hive proposal show", ctx, result.data, { elapsed_ms: elapsed });
        printEnvelope(envelope, fmt);
      }
    });

  // hive proposal next
  proposal
    .command("next")
    .description("Show the next actionable proposal for this agency")
    .option("--project <P>", "Project slug override")
    .option("-o, --format <FMT>", "Output format (text|json|jsonl|yaml)", "text")
    .option("-q, --quiet", "Suppress output")
    .action(async (opts) => {
      const start = Date.now();
      const ctx = await getContext();
      if (opts.project) ctx.project = opts.project;
      const fmt = opts.format as OutputFormat;

      const result = await mcpCall(ctx.mcp_url, "mcp_proposal", {
        action: "list",
        state: "DEVELOP",
        maturity: "new",
        limit: 1,
        project: ctx.project,
      });

      const elapsed = Date.now() - start;

      if (!result.ok) {
        const envelope = buildErrorEnvelope("hive proposal next", ctx, {
          code: "REMOTE_FAILURE",
          message: result.error?.message ?? "Could not fetch next proposal",
          retriable: true,
        }, { elapsed_ms: elapsed });
        if (!opts.quiet) printEnvelope(envelope, fmt);
        process.exit(EXIT.REMOTE_FAILURE);
      }

      const items = (result.data as { proposals?: unknown[] })?.proposals ?? [];
      const next = items[0] ?? null;

      if (!opts.quiet) {
        if (fmt === "text") {
          if (!next) {
            printText(["No actionable proposals found."]);
          } else {
            const p = next as Record<string, unknown>;
            printText([`Next: ${p.id ?? p.proposal_id} — ${p.title}`]);
          }
        } else {
          const envelope = buildOkEnvelope("hive proposal next", ctx, next, { elapsed_ms: elapsed });
          printEnvelope(envelope, fmt);
        }
      }
    });

  // hive proposal claim
  proposal
    .command("claim <proposal_id>")
    .description("Acquire a work lease on a proposal")
    .option("--duration-minutes <N>", "Lease duration in minutes (default 120)", "120")
    .option("--project <P>", "Project slug override")
    .option("--idempotency-key <KEY>", "Idempotency key (UUID) to prevent duplicate claims")
    .option("-o, --format <FMT>", "Output format (text|json|jsonl|yaml)", "text")
    .option("--yes", "Skip confirmation")
    .action(async (proposalId: string, opts) => {
      const start = Date.now();
      const ctx = await getContext();
      if (opts.project) ctx.project = opts.project;
      const fmt = opts.format as OutputFormat;

      const result = await mcpCall(ctx.mcp_url, "mcp_proposal", {
        action: "claim",
        id: proposalId,
        duration_minutes: Number(opts.durationMinutes),
        idempotency_key: opts.idempotencyKey,
        project: ctx.project,
      });

      const elapsed = Date.now() - start;

      if (!result.ok) {
        const errCode = result.error?.code ?? "REMOTE_FAILURE";
        const envelope = buildErrorEnvelope("hive proposal claim", ctx, {
          code: errCode as never,
          message: result.error?.message ?? "Claim failed",
          hint: "Check if the proposal is already leased: `hive lease list --proposal " + proposalId + "`",
          detail: { proposal_id: proposalId },
          retriable: errCode === "REMOTE_FAILURE",
        }, { elapsed_ms: elapsed });
        printEnvelope(envelope, fmt);
        process.exit(EXIT.CONFLICT);
      }

      if (fmt === "text") {
        printText([`Claimed ${proposalId}. Lease active.`]);
      } else {
        const envelope = buildOkEnvelope("hive proposal claim", ctx, result.data, { elapsed_ms: elapsed });
        printEnvelope(envelope, fmt);
      }
    });

  // hive proposal maturity
  proposal
    .command("maturity <proposal_id> <maturity>")
    .description("Set maturity within the current state (new|active|mature|obsolete)")
    .option("--with-message <M>", "Discussion entry explaining the maturity change")
    .option("--project <P>", "Project slug override")
    .option("--idempotency-key <KEY>", "Idempotency key")
    .option("-o, --format <FMT>", "Output format (text|json|jsonl|yaml)", "text")
    .action(async (proposalId: string, maturity: string, opts) => {
      const start = Date.now();
      const ctx = await getContext();
      if (opts.project) ctx.project = opts.project;
      const fmt = opts.format as OutputFormat;

      const valid = ["new", "active", "mature", "obsolete"];
      if (!valid.includes(maturity)) {
        const envelope = buildErrorEnvelope("hive proposal maturity", ctx, {
          code: "USAGE",
          message: `Invalid maturity '${maturity}'. Valid: ${valid.join(", ")}`,
          retriable: false,
        }, { elapsed_ms: Date.now() - start });
        printEnvelope(envelope, fmt);
        process.exit(EXIT.USAGE);
      }

      const result = await mcpCall(ctx.mcp_url, "mcp_proposal", {
        action: "set_maturity",
        id: proposalId,
        maturity,
        message: opts.withMessage,
        idempotency_key: opts.idempotencyKey,
        project: ctx.project,
      });

      const elapsed = Date.now() - start;

      if (!result.ok) {
        const envelope = buildErrorEnvelope("hive proposal maturity", ctx, {
          code: "REMOTE_FAILURE",
          message: result.error?.message ?? "Maturity update failed",
          retriable: true,
        }, { elapsed_ms: elapsed });
        printEnvelope(envelope, fmt);
        process.exit(EXIT.REMOTE_FAILURE);
      }

      if (fmt === "text") {
        printText([`${proposalId} maturity set to ${maturity}.`]);
      } else {
        const envelope = buildOkEnvelope("hive proposal maturity", ctx, result.data, { elapsed_ms: elapsed });
        printEnvelope(envelope, fmt);
      }
    });

  // hive proposal ac list
  const ac = proposal
    .command("ac")
    .description("Acceptance criteria management");

  ac
    .command("list <proposal_id>")
    .description("List acceptance criteria for a proposal")
    .option("--status <S>", "Filter by status (pending|satisfied|failed)")
    .option("--project <P>", "Project slug override")
    .option("-o, --format <FMT>", "Output format (text|json|jsonl|yaml)", "text")
    .action(async (proposalId: string, opts) => {
      const start = Date.now();
      const ctx = await getContext();
      if (opts.project) ctx.project = opts.project;
      const fmt = opts.format as OutputFormat;

      const result = await mcpCall(ctx.mcp_url, "mcp_proposal", {
        action: "list_ac",
        proposal_id: proposalId,
        status: opts.status,
        project: ctx.project,
      });

      const elapsed = Date.now() - start;

      if (!result.ok) {
        const envelope = buildErrorEnvelope("hive proposal ac list", ctx, {
          code: "REMOTE_FAILURE",
          message: result.error?.message ?? "Could not fetch ACs",
          retriable: true,
        }, { elapsed_ms: elapsed });
        printEnvelope(envelope, fmt);
        process.exit(EXIT.REMOTE_FAILURE);
      }

      const items = (result.data as unknown[] | null) ?? [];
      if (fmt === "text") {
        if (items.length === 0) {
          printText(["No acceptance criteria found."]);
        } else {
          const rows = (items as Record<string, unknown>[]).map((a) => ({
            id: a.id ?? a.criteria_id ?? "",
            status: a.status ?? "pending",
            body: String(a.body ?? a.description ?? "").slice(0, 70),
          }));
          printText([formatTable(rows, ["id", "status", "body"])]);
        }
      } else {
        const envelope = buildOkEnvelope("hive proposal ac list", ctx, items, { elapsed_ms: elapsed });
        printEnvelope(envelope, fmt);
      }
    });

  ac
    .command("add <proposal_id> <ac_id>")
    .description("Add an acceptance criterion")
    .option("--body <B>", "Criterion body text")
    .option("--stdin", "Read body from stdin")
    .option("--verification-type <T>", "manual|test|script", "manual")
    .option("--project <P>", "Project slug override")
    .option("--idempotency-key <KEY>", "Idempotency key")
    .option("-o, --format <FMT>", "Output format (text|json|jsonl|yaml)", "text")
    .action(async (proposalId: string, acId: string, opts) => {
      const start = Date.now();
      const ctx = await getContext();
      if (opts.project) ctx.project = opts.project;
      const fmt = opts.format as OutputFormat;

      const result = await mcpCall(ctx.mcp_url, "mcp_proposal", {
        action: "add_criteria",
        proposal_id: proposalId,
        criteria: [opts.body ?? acId],
        verification_type: opts.verificationType,
        idempotency_key: opts.idempotencyKey,
        project: ctx.project,
      });

      const elapsed = Date.now() - start;

      if (!result.ok) {
        const envelope = buildErrorEnvelope("hive proposal ac add", ctx, {
          code: "REMOTE_FAILURE",
          message: result.error?.message ?? "Could not add AC",
          retriable: true,
        }, { elapsed_ms: elapsed });
        printEnvelope(envelope, fmt);
        process.exit(EXIT.REMOTE_FAILURE);
      }

      if (fmt === "text") {
        printText([`AC '${acId}' added to ${proposalId}.`]);
      } else {
        const envelope = buildOkEnvelope("hive proposal ac add", ctx, result.data, { elapsed_ms: elapsed });
        printEnvelope(envelope, fmt);
      }
    });
}
