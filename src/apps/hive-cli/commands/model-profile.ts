/**
 * hive model-profile — Model capability registry management.
 * List and update model capability profiles (reasoning, code quality, instruction following scores).
 * AC-6 and AC-7 implementation.
 */

import type { Command } from "commander";
import type { HiveContext } from "../common/context.ts";
import { query } from "../../../infra/postgres/pool.ts";
import { buildOkEnvelope, buildErrorEnvelope } from "../common/envelope.ts";
import { printEnvelope, printText, formatTable, formatRecord, type OutputFormat } from "../common/formatters.ts";
import { EXIT } from "../common/exit-codes.ts";

interface ModelCapabilityProfile {
  provider: string;
  model_name: string;
  cost_tier: number;
  is_free: boolean;
  reasoning_score: number;
  code_quality_score: number;
  instruction_following_score: number;
  context_window_k: number | null;
  supports_tool_use: boolean;
  supports_vision: boolean;
  can_spawn_workers: boolean;
  is_active: boolean;
  notes: string | null;
  updated_at: string;
}

/**
 * AC-6: CLI command `bun run cli model-profile list` prints capability table in tabular form.
 */
async function listProfiles(ctx: HiveContext, format: OutputFormat): Promise<void> {
  const start = Date.now();
  const { rows } = await query<ModelCapabilityProfile>(
    `SELECT provider, model_name, cost_tier, is_free,
            reasoning_score, code_quality_score, instruction_following_score,
            context_window_k, supports_tool_use, supports_vision,
            is_active, can_spawn_workers, notes, updated_at
       FROM roadmap_workforce.model_capability_profile
       ORDER BY provider ASC, model_name ASC`,
  );

  const elapsed = Date.now() - start;

  if (format === "text") {
    // Print tabular format using formatTable
    const displayRows = rows.map((row) => ({
      provider: row.provider,
      model: row.model_name,
      tier: row.cost_tier,
      free: row.is_free ? "yes" : "no",
      reason: row.reasoning_score,
      code: row.code_quality_score,
      inst: row.instruction_following_score,
      spawn: row.can_spawn_workers ? "yes" : "no",
      tool: row.supports_tool_use ? "yes" : "no",
      vision: row.supports_vision ? "yes" : "no",
      active: row.is_active ? "yes" : "no",
    }));

    if (displayRows.length === 0) {
      printText(["No models found."]);
    } else {
      const table = formatTable(displayRows, [
        "provider",
        "model",
        "tier",
        "free",
        "reason",
        "code",
        "inst",
        "spawn",
        "tool",
        "vision",
        "active",
      ]);
      printText([table]);
    }
  } else {
    // JSON/JSONL/YAML format
    const envelope = buildOkEnvelope("hive model-profile list", ctx, rows, {
      elapsed_ms: elapsed,
    });
    printEnvelope(envelope, format);
  }
}

/**
 * AC-7: CLI command `bun run cli model-profile set <model_name> <field> <value>`
 * Updates a single field. Protected fields (provider, model_name) are rejected.
 */
async function setProfile(
  ctx: HiveContext,
  modelName: string,
  field: string,
  value: string,
  format: OutputFormat,
): Promise<void> {
  const start = Date.now();
  const elapsed_start = Date.now() - start;

  // Protected fields that cannot be updated
  const protectedFields = ["provider", "model_name", "id", "created_at"];
  if (protectedFields.includes(field)) {
    const envelope = buildErrorEnvelope("hive model-profile set", ctx, {
      code: "USAGE",
      message: `Cannot update protected field '${field}'`,
      retriable: false,
    }, { elapsed_ms: elapsed_start });
    printEnvelope(envelope, format);
    process.exit(EXIT.USAGE);
  }

  // Parse the value based on the field type
  let parsedValue: unknown = value;
  const numericFields = [
    "cost_tier",
    "reasoning_score",
    "code_quality_score",
    "instruction_following_score",
    "context_window_k",
  ];
  const booleanFields = [
    "is_free",
    "supports_tool_use",
    "supports_vision",
    "is_active",
    "can_spawn_workers",
  ];

  if (numericFields.includes(field)) {
    parsedValue = parseInt(value, 10);
    if (Number.isNaN(parsedValue)) {
      const envelope = buildErrorEnvelope("hive model-profile set", ctx, {
        code: "USAGE",
        message: `Field '${field}' requires an integer value, got '${value}'`,
        retriable: false,
      }, { elapsed_ms: elapsed_start });
      printEnvelope(envelope, format);
      process.exit(EXIT.USAGE);
    }
  } else if (booleanFields.includes(field)) {
    if (!["true", "false", "yes", "no", "1", "0"].includes(value.toLowerCase())) {
      const envelope = buildErrorEnvelope("hive model-profile set", ctx, {
        code: "USAGE",
        message: `Field '${field}' requires a boolean value (true/false/yes/no/1/0), got '${value}'`,
        retriable: false,
      }, { elapsed_ms: elapsed_start });
      printEnvelope(envelope, format);
      process.exit(EXIT.USAGE);
    }
    parsedValue = ["true", "yes", "1"].includes(value.toLowerCase());
  }

  // Update the field
  try {
    const updateSql = `UPDATE roadmap_workforce.model_capability_profile
                       SET ${field} = $2, updated_at = now()
                       WHERE model_name = $1
                       RETURNING provider, model_name, cost_tier, is_free,
                               reasoning_score, code_quality_score, instruction_following_score,
                               context_window_k, supports_tool_use, supports_vision,
                               is_active, can_spawn_workers, notes, updated_at`;

    const { rows: updatedRows } = await query<ModelCapabilityProfile>(updateSql, [modelName, parsedValue]);

    const elapsed = Date.now() - start;

    if (updatedRows.length === 0) {
      const envelope = buildErrorEnvelope("hive model-profile set", ctx, {
        code: "NOT_FOUND",
        message: `Model '${modelName}' not found in capability profile`,
        retriable: false,
      }, { elapsed_ms: elapsed });
      printEnvelope(envelope, format);
      process.exit(EXIT.NOT_FOUND);
    }

    const updated = updatedRows[0];
    if (format === "text") {
      printText([`Updated ${modelName}.${field}:`, formatRecord(updated as unknown as Record<string, unknown>)]);
    } else {
      const envelope = buildOkEnvelope("hive model-profile set", ctx, updated, {
        elapsed_ms: elapsed,
      });
      printEnvelope(envelope, format);
    }
  } catch (err) {
    const elapsed = Date.now() - start;
    const envelope = buildErrorEnvelope("hive model-profile set", ctx, {
      code: "DB_UNREACHABLE",
      message: (err as Error).message,
      retriable: true,
    }, { elapsed_ms: elapsed });
    printEnvelope(envelope, format);
    process.exit(EXIT.DB_UNREACHABLE);
  }
}

export function registerModelProfile(program: Command, getContext: () => Promise<HiveContext>): void {
  const modelProfileCmd = program
    .command("model-profile")
    .description("Manage model capability profiles (AC-6, AC-7)");

  // list subcommand
  modelProfileCmd
    .command("list")
    .description("List all model capability profiles in tabular form (AC-6)")
    .option("-o, --format <FMT>", "Output format (text|json|jsonl|yaml)", "text")
    .action(async (opts) => {
      const ctx = await getContext();
      const fmt = opts.format as OutputFormat;
      try {
        await listProfiles(ctx, fmt);
      } catch (err) {
        const envelope = buildErrorEnvelope("hive model-profile list", ctx, {
          code: "DB_UNREACHABLE",
          message: (err as Error).message,
          retriable: true,
        });
        printEnvelope(envelope, fmt);
        process.exit(EXIT.DB_UNREACHABLE);
      }
    });

  // set subcommand
  modelProfileCmd
    .command("set <model_name> <field> <value>")
    .description("Update a single field in a model capability profile (AC-7)")
    .option("-o, --format <FMT>", "Output format (text|json|jsonl|yaml)", "text")
    .action(async (modelName: string, field: string, value: string, opts) => {
      const ctx = await getContext();
      const fmt = opts.format as OutputFormat;
      try {
        await setProfile(ctx, modelName, field, value, fmt);
      } catch (err) {
        const envelope = buildErrorEnvelope("hive model-profile set", ctx, {
          code: "DB_UNREACHABLE",
          message: (err as Error).message,
          retriable: true,
        });
        printEnvelope(envelope, fmt);
        process.exit(EXIT.DB_UNREACHABLE);
      }
    });
}
