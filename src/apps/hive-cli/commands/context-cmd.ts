/**
 * hive context — show resolved runtime context.
 * AI agents call this first to confirm they are in the right project/agency.
 */

import type { Command } from "commander";
import type { HiveContext } from "../common/context.ts";
import { buildOkEnvelope } from "../common/envelope.ts";
import { printEnvelope, printText, formatRecord, type OutputFormat } from "../common/formatters.ts";
import { EXIT } from "../common/exit-codes.ts";

export function registerContext(program: Command, getContext: () => Promise<HiveContext>): void {
  program
    .command("context")
    .description("Show the resolved runtime context (project, agency, host, MCP URL)")
    .option("--project <P>", "Project slug override")
    .option("--agency <A>", "Agency override")
    .option("-o, --format <FMT>", "Output format (text|json|jsonl|yaml)", "text")
    .option("-q, --quiet", "Suppress output")
    .action(async (opts) => {
      const start = Date.now();
      const ctx = await getContext();
      if (opts.project) ctx.project = opts.project;
      if (opts.agency) ctx.agency = opts.agency;
      const fmt = opts.format as OutputFormat;

      if (!opts.quiet) {
        if (fmt === "text") {
          printText([
            `project:     ${ctx.project ?? "(none)"}`,
            `agency:      ${ctx.agency ?? "(none)"}`,
            `host:        ${ctx.host}`,
            `mcp_url:     ${ctx.mcp_url}`,
            `db:          ${ctx.db_host}:${ctx.db_port}`,
            `resolved_at: ${ctx.resolved_at}`,
          ]);
        } else {
          const envelope = buildOkEnvelope("hive context", ctx, ctx, {
            elapsed_ms: Date.now() - start,
          });
          printEnvelope(envelope, fmt);
        }
      }

      process.exit(EXIT.OK);
    });
}
