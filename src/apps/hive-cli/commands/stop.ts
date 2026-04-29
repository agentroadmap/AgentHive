/**
 * hive stop — operator cancel/drain commands.
 * All destructive. Require --yes. Panic ops require --yes AND --really-yes.
 * Every action writes to control_audit.operator_action_log via MCP.
 */

import type { Command } from "commander";
import type { HiveContext } from "../common/context.ts";
import { buildOkEnvelope, buildErrorEnvelope } from "../common/envelope.ts";
import { printEnvelope, printText, printError, type OutputFormat } from "../common/formatters.ts";
import { EXIT } from "../common/exit-codes.ts";
import { mcpCall } from "../common/mcp-client.ts";

function requireYes(opts: Record<string, unknown>, action: string): boolean {
  if (!opts.yes) {
    printError(`${action} is destructive. Pass --yes to confirm.`);
    return false;
  }
  return true;
}

export function registerStop(program: Command, getContext: () => Promise<HiveContext>): void {
  const stop = program
    .command("stop")
    .description("Cancel, drain, or offline a running component (op/admin only)");

  // hive stop dispatch
  stop
    .command("dispatch <dispatch_id>")
    .description("Cancel a single dispatch (no retry)")
    .option("--reason <R>", "Reason recorded in audit log")
    .option("--project <P>", "Project slug override")
    .option("--yes", "Confirm destructive action")
    .option("--idempotency-key <KEY>", "Idempotency key")
    .option("-o, --format <FMT>", "Output format (text|json|jsonl|yaml)", "text")
    .action(async (dispatchId: string, opts) => {
      if (!requireYes(opts, "stop dispatch")) {
        process.exit(EXIT.USAGE);
      }
      const start = Date.now();
      const ctx = await getContext();
      if (opts.project) ctx.project = opts.project;
      const fmt = opts.format as OutputFormat;

      const result = await mcpCall(ctx.mcp_url, "mcp_ops", {
        action: "stop_dispatch",
        dispatch_id: dispatchId,
        reason: opts.reason,
        idempotency_key: opts.idempotencyKey,
        project: ctx.project,
      });

      const elapsed = Date.now() - start;

      if (!result.ok) {
        const envelope = buildErrorEnvelope("hive stop dispatch", ctx, {
          code: "REMOTE_FAILURE",
          message: result.error?.message ?? "Could not cancel dispatch",
          retriable: false,
        }, { elapsed_ms: elapsed });
        printEnvelope(envelope, fmt);
        process.exit(EXIT.REMOTE_FAILURE);
      }

      if (fmt === "text") {
        printText([`Dispatch ${dispatchId} cancelled. Reason: ${opts.reason ?? "(none)"}`]);
      } else {
        const envelope = buildOkEnvelope("hive stop dispatch", ctx, result.data, { elapsed_ms: elapsed });
        printEnvelope(envelope, fmt);
      }
    });

  // hive stop proposal
  stop
    .command("proposal <proposal_id>")
    .description("Cancel all active dispatches for a proposal")
    .option("--reason <R>", "Reason recorded in audit log")
    .option("--project <P>", "Project slug override")
    .option("--yes", "Confirm destructive action")
    .option("--idempotency-key <KEY>", "Idempotency key")
    .option("-o, --format <FMT>", "Output format (text|json|jsonl|yaml)", "text")
    .action(async (proposalId: string, opts) => {
      if (!requireYes(opts, "stop proposal")) {
        process.exit(EXIT.USAGE);
      }
      const start = Date.now();
      const ctx = await getContext();
      if (opts.project) ctx.project = opts.project;
      const fmt = opts.format as OutputFormat;

      const result = await mcpCall(ctx.mcp_url, "mcp_ops", {
        action: "stop_proposal",
        proposal_id: proposalId,
        reason: opts.reason,
        idempotency_key: opts.idempotencyKey,
        project: ctx.project,
      });

      const elapsed = Date.now() - start;

      if (!result.ok) {
        const envelope = buildErrorEnvelope("hive stop proposal", ctx, {
          code: "REMOTE_FAILURE",
          message: result.error?.message ?? "Could not stop proposal",
          retriable: false,
        }, { elapsed_ms: elapsed });
        printEnvelope(envelope, fmt);
        process.exit(EXIT.REMOTE_FAILURE);
      }

      if (fmt === "text") {
        printText([`Proposal ${proposalId} stopped. All dispatches cancelled.`]);
      } else {
        const envelope = buildOkEnvelope("hive stop proposal", ctx, result.data, { elapsed_ms: elapsed });
        printEnvelope(envelope, fmt);
      }
    });

  // hive stop all (panic — requires --yes AND --really-yes)
  stop
    .command("all")
    .description("Stop all running dispatches (PANIC operation — requires --yes AND --really-yes)")
    .option("--reason <R>", "Reason recorded in audit log (required)")
    .option("--project <P>", "Project slug override")
    .option("--yes", "First confirmation")
    .option("--really-yes", "Second confirmation required for panic operations")
    .option("-o, --format <FMT>", "Output format (text|json|jsonl|yaml)", "text")
    .action(async (opts) => {
      if (!opts.yes || !opts.reallyYes) {
        printError("hive stop all is a PANIC operation and requires both --yes AND --really-yes.");
        process.exit(EXIT.USAGE);
      }
      if (!opts.reason) {
        printError("--reason is required for hive stop all.");
        process.exit(EXIT.USAGE);
      }

      const start = Date.now();
      const ctx = await getContext();
      if (opts.project) ctx.project = opts.project;
      const fmt = opts.format as OutputFormat;

      const result = await mcpCall(ctx.mcp_url, "mcp_ops", {
        action: "stop_all",
        reason: opts.reason,
        project: ctx.project,
      });

      const elapsed = Date.now() - start;

      if (!result.ok) {
        const envelope = buildErrorEnvelope("hive stop all", ctx, {
          code: "REMOTE_FAILURE",
          message: result.error?.message ?? "Could not stop all dispatches",
          retriable: false,
        }, { elapsed_ms: elapsed });
        printEnvelope(envelope, fmt);
        process.exit(EXIT.REMOTE_FAILURE);
      }

      if (fmt === "text") {
        printText([`STOP ALL executed. Reason: ${opts.reason}. See audit log for details.`]);
      } else {
        const envelope = buildOkEnvelope("hive stop all", ctx, result.data, { elapsed_ms: elapsed });
        printEnvelope(envelope, fmt);
      }
    });
}
