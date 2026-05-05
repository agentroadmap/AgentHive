/**
 * hive workflow — state machine inspection commands.
 * Read-only; no mutations in this domain.
 */

import type { Command } from "commander";
import type { HiveContext } from "../common/context.ts";
import { buildOkEnvelope, buildErrorEnvelope } from "../common/envelope.ts";
import { printEnvelope, printText, formatTable, formatRecord, type OutputFormat } from "../common/formatters.ts";
import { EXIT } from "../common/exit-codes.ts";
import { mcpCall } from "../common/mcp-client.ts";

export function registerWorkflow(program: Command, getContext: () => Promise<HiveContext>): void {
  const workflow = program
    .command("workflow")
    .description("Workflow template and state machine inspection");

  workflow
    .command("list")
    .description("List all workflow templates in the control plane")
    .option("--project <P>", "Project slug override")
    .option("-o, --format <FMT>", "Output format (text|json|jsonl|yaml)", "text")
    .option("-q, --quiet", "Suppress output")
    .action(async (opts) => {
      const start = Date.now();
      const ctx = await getContext();
      if (opts.project) ctx.project = opts.project;
      const fmt = opts.format as OutputFormat;

      const result = await mcpCall(ctx.mcp_url, "mcp_ops", {
        action: "list_workflow_templates",
        project: ctx.project,
      });

      const elapsed = Date.now() - start;

      if (!result.ok) {
        const envelope = buildErrorEnvelope("hive workflow list", ctx, {
          code: "REMOTE_FAILURE",
          message: result.error?.message ?? "Could not fetch workflow templates",
          retriable: true,
        }, { elapsed_ms: elapsed });
        if (!opts.quiet) printEnvelope(envelope, fmt);
        process.exit(EXIT.REMOTE_FAILURE);
      }

      const items = (result.data as unknown[]) ?? [];

      if (!opts.quiet) {
        if (fmt === "text") {
          if (items.length === 0) {
            printText(["No workflow templates found."]);
          } else {
            const rows = (items as Record<string, unknown>[]).map((w) => ({
              name: w.name ?? w.template_name ?? "",
              type: w.type ?? "",
              states: Array.isArray(w.states) ? w.states.length : "?",
            }));
            printText([formatTable(rows, ["name", "type", "states"])]);
          }
        } else {
          const envelope = buildOkEnvelope("hive workflow list", ctx, items, { elapsed_ms: elapsed });
          printEnvelope(envelope, fmt);
        }
      }
    });

  workflow
    .command("show <template>")
    .description("Show the state machine for a workflow template")
    .option("--project <P>", "Project slug override")
    .option("-o, --format <FMT>", "Output format (text|json|jsonl|yaml)", "text")
    .action(async (template: string, opts) => {
      const start = Date.now();
      const ctx = await getContext();
      if (opts.project) ctx.project = opts.project;
      const fmt = opts.format as OutputFormat;

      const result = await mcpCall(ctx.mcp_url, "mcp_ops", {
        action: "get_workflow_template",
        name: template,
        project: ctx.project,
      });

      const elapsed = Date.now() - start;

      if (!result.ok) {
        const envelope = buildErrorEnvelope("hive workflow show", ctx, {
          code: "NOT_FOUND",
          message: result.error?.message ?? `Template '${template}' not found`,
          hint: "Run `hive workflow list` to see available templates.",
          detail: { template },
          retriable: false,
        }, { elapsed_ms: elapsed });
        printEnvelope(envelope, fmt);
        process.exit(EXIT.NOT_FOUND);
      }

      if (fmt === "text") {
        printText([formatRecord(result.data as Record<string, unknown>)]);
      } else {
        const envelope = buildOkEnvelope("hive workflow show", ctx, result.data, { elapsed_ms: elapsed });
        printEnvelope(envelope, fmt);
      }
    });

  workflow
    .command("gates")
    .description("Show gating rules and acceptance criteria schema for workflow states")
    .option("--project <P>", "Project slug override")
    .option("--state <STATE>", "Filter to a specific state")
    .option("-o, --format <FMT>", "Output format (text|json|jsonl|yaml)", "text")
    .action(async (opts) => {
      const start = Date.now();
      const ctx = await getContext();
      if (opts.project) ctx.project = opts.project;
      const fmt = opts.format as OutputFormat;

      const result = await mcpCall(ctx.mcp_url, "mcp_ops", {
        action: "list_gates",
        state: opts.state,
        project: ctx.project,
      });

      const elapsed = Date.now() - start;

      if (!result.ok) {
        const envelope = buildErrorEnvelope("hive workflow gates", ctx, {
          code: "REMOTE_FAILURE",
          message: result.error?.message ?? "Could not fetch gates",
          retriable: true,
        }, { elapsed_ms: elapsed });
        printEnvelope(envelope, fmt);
        process.exit(EXIT.REMOTE_FAILURE);
      }

      if (fmt === "text") {
        const items = (result.data as Record<string, unknown>[]) ?? [];
        printText([formatTable(items, ["state", "gate_type", "criteria_count"])]);
      } else {
        const envelope = buildOkEnvelope("hive workflow gates", ctx, result.data, { elapsed_ms: elapsed });
        printEnvelope(envelope, fmt);
      }
    });
}

export function registerState(program: Command, getContext: () => Promise<HiveContext>): void {
  const state = program
    .command("state")
    .description("State transition inspection for proposals");

  state
    .command("next <proposal_id>")
    .description("Show valid next states for a proposal")
    .option("--verbose", "Include transition rules and required ACs")
    .option("--project <P>", "Project slug override")
    .option("-o, --format <FMT>", "Output format (text|json|jsonl|yaml)", "text")
    .action(async (proposalId: string, opts) => {
      const start = Date.now();
      const ctx = await getContext();
      if (opts.project) ctx.project = opts.project;
      const fmt = opts.format as OutputFormat;

      const result = await mcpCall(ctx.mcp_url, "mcp_proposal", {
        action: "detail",
        id: proposalId,
        project: ctx.project,
      });

      const elapsed = Date.now() - start;

      if (!result.ok) {
        const envelope = buildErrorEnvelope("hive state next", ctx, {
          code: "NOT_FOUND",
          message: `Proposal ${proposalId} not found`,
          retriable: false,
        }, { elapsed_ms: elapsed });
        printEnvelope(envelope, fmt);
        process.exit(EXIT.NOT_FOUND);
      }

      const p = result.data as Record<string, unknown>;
      const currentState = p.status ?? p.state;

      // Static next-state map (resolved from design; P453 provides DB-backed resolver)
      const nextStates: Record<string, string[]> = {
        DRAFT: ["REVIEW"],
        REVIEW: ["DEVELOP", "DRAFT"],
        DEVELOP: ["MERGE", "REVIEW"],
        MERGE: ["COMPLETE", "DEVELOP"],
        COMPLETE: [],
      };

      const validNext = nextStates[String(currentState).toUpperCase()] ?? [];
      const data = { proposal_id: proposalId, current_state: currentState, next_states: validNext };

      if (fmt === "text") {
        printText([
          `Current: ${currentState}`,
          `Next valid states: ${validNext.length ? validNext.join(", ") : "(terminal)"}`,
        ]);
      } else {
        const envelope = buildOkEnvelope("hive state next", ctx, data, { elapsed_ms: elapsed });
        printEnvelope(envelope, fmt);
      }
    });

  state
    .command("history <proposal_id>")
    .description("Show state transition history for a proposal")
    .option("--limit <N>", "Max entries (default 10)", "10")
    .option("--project <P>", "Project slug override")
    .option("-o, --format <FMT>", "Output format (text|json|jsonl|yaml)", "text")
    .action(async (proposalId: string, opts) => {
      const start = Date.now();
      const ctx = await getContext();
      if (opts.project) ctx.project = opts.project;
      const fmt = opts.format as OutputFormat;

      const result = await mcpCall(ctx.mcp_url, "mcp_proposal", {
        action: "detail",
        id: proposalId,
        include: ["events"],
        project: ctx.project,
      });

      const elapsed = Date.now() - start;

      if (!result.ok) {
        const envelope = buildErrorEnvelope("hive state history", ctx, {
          code: "NOT_FOUND",
          message: `Proposal ${proposalId} not found`,
          retriable: false,
        }, { elapsed_ms: elapsed });
        printEnvelope(envelope, fmt);
        process.exit(EXIT.NOT_FOUND);
      }

      const p = result.data as Record<string, unknown>;
      const events = (p.events as unknown[]) ?? [];
      const limited = events.slice(0, Number(opts.limit));

      if (fmt === "text") {
        if (limited.length === 0) {
          printText(["No history found."]);
        } else {
          const rows = (limited as Record<string, unknown>[]).map((e) => ({
            timestamp: e.created_at ?? e.timestamp ?? "",
            event: e.event_type ?? e.type ?? "",
            from: e.from_state ?? "",
            to: e.to_state ?? e.state ?? "",
            agent: e.agent ?? "",
          }));
          printText([formatTable(rows, ["timestamp", "event", "from", "to", "agent"])]);
        }
      } else {
        const envelope = buildOkEnvelope("hive state history", ctx, limited, { elapsed_ms: elapsed });
        printEnvelope(envelope, fmt);
      }
    });
}
