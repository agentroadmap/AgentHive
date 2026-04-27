/**
 * Output formatters per cli-hive-contract.md §2 and design.md §2.
 *
 * Supports: text (TTY), json, jsonl, yaml, sarif.
 * Each formatter is a pure function that takes data + context and returns a string.
 */

import { CliContext } from "./envelope";

export type OutputFormat = "text" | "json" | "jsonl" | "yaml" | "sarif";

export interface FormatterOptions {
  format: OutputFormat;
  isTty: boolean;
  noColor: boolean;
}

/**
 * Auto-detect default format based on TTY status.
 * TTY defaults to "text"; non-TTY defaults to "json".
 */
export function detectDefaultFormat(isTty: boolean): OutputFormat {
  return isTty ? "text" : "json";
}

/**
 * Format a list of items for output.
 */
export function formatList(
  items: unknown[],
  format: OutputFormat,
  options?: {
    isTty?: boolean;
    noColor?: boolean;
    next_cursor?: string | null;
  }
): string {
  const isTty = options?.isTty ?? true;
  const noColor = options?.noColor ?? false;

  switch (format) {
    case "text":
      return formatListAsText(items, isTty, noColor);
    case "json":
      return formatListAsJson(items, options?.next_cursor);
    case "jsonl":
      return formatListAsJsonl(items);
    case "yaml":
      return formatListAsYaml(items);
    case "sarif":
      return formatListAsSarif(items);
    default:
      throw new Error(`Unknown format: ${format}`);
  }
}

/**
 * Format a single record for output.
 */
export function formatRecord(
  record: unknown,
  format: OutputFormat,
  options?: {
    isTty?: boolean;
    noColor?: boolean;
  }
): string {
  const isTty = options?.isTty ?? true;
  const noColor = options?.noColor ?? false;

  switch (format) {
    case "text":
      return formatRecordAsText(record, isTty, noColor);
    case "json":
      return formatRecordAsJson(record);
    case "jsonl":
      return formatRecordAsJsonl(record);
    case "yaml":
      return formatRecordAsYaml(record);
    case "sarif":
      // Single record is not suitable for SARIF; treat as array of 1
      return formatListAsSarif([record]);
    default:
      throw new Error(`Unknown format: ${format}`);
  }
}

// ===== Text Formatters =====

function formatListAsText(
  items: unknown[],
  isTty: boolean,
  noColor: boolean
): string {
  if (items.length === 0) {
    return "(no results)";
  }

  // For now, simple JSON-like pretty printing in text mode.
  // A production implementation would detect TTY and use colored tables,
  // but for Round 2 this is sufficient.
  return items.map((item) => formatRecordAsText(item, isTty, noColor)).join("\n");
}

function formatRecordAsText(
  record: unknown,
  _isTty: boolean,
  _noColor: boolean
): string {
  // Stub: Pretty-print as indented JSON.
  // Production: Use chalk + table library for colored, formatted output.
  return JSON.stringify(record, null, 2);
}

// ===== JSON Formatters =====

function formatListAsJson(
  items: unknown[],
  next_cursor?: string | null
): string {
  const output: Record<string, unknown> = {
    items,
  };
  if (next_cursor !== undefined) {
    output.next_cursor = next_cursor;
  }
  return JSON.stringify(output, null, 2);
}

function formatRecordAsJson(record: unknown): string {
  return JSON.stringify(record, null, 2);
}

// ===== JSONL Formatters =====

function formatListAsJsonl(items: unknown[]): string {
  return items.map((item) => JSON.stringify(item)).join("\n");
}

function formatRecordAsJsonl(record: unknown): string {
  return JSON.stringify(record);
}

// ===== YAML Formatters =====

function formatListAsYaml(items: unknown[]): string {
  // Stub: Convert to YAML format.
  // Production: Use js-yaml library (already in package.json).
  // For now, return JSON representation with YAML-like comments.
  return (
    "# List of items\n" +
    JSON.stringify(items, null, 2)
      .split("\n")
      .map((line) => "  " + line)
      .join("\n")
  );
}

function formatRecordAsYaml(record: unknown): string {
  // Stub: Convert to YAML format.
  return "# Record\n" + JSON.stringify(record, null, 2);
}

// ===== SARIF Formatters =====

/**
 * Format items as SARIF v2.1.0 (Static Analysis Results Interchange Format).
 *
 * Used by `hive scan` to output findings in CI/CD-compatible format.
 * Stub for now; production implementation will follow SARIF spec.
 */
function formatListAsSarif(items: unknown[]): string {
  const results = items.map((item, index) => ({
    ruleId: `hive-scan-${index}`,
    message: {
      text: String(item),
    },
    level: "warning" as const,
  }));

  return JSON.stringify(
    {
      version: "2.1.0",
      $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json",
      runs: [
        {
          tool: {
            driver: {
              name: "hive-scan",
              version: "0.5.0",
            },
          },
          results,
        },
      ],
    },
    null,
    2
  );
}

/**
 * Check if stdout is a TTY (terminal) or pipe/file.
 */
export function isTtyOutput(stream: NodeJS.WriteStream = process.stdout): boolean {
  return stream.isTTY ?? false;
}

/**
 * Check if NO_COLOR env var is set (disables ANSI color codes).
 */
export function shouldDisableColor(env: Record<string, string | undefined> = process.env): boolean {
  return env.NO_COLOR === "1" || env.NO_COLOR === "true";
}
