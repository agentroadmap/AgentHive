/**
 * Domain-agnostic output formatters for hive CLI.
 * Never wrap output to terminal width when format != "text".
 */

import type { HiveEnvelope } from "./envelope.ts";

export type OutputFormat = "text" | "json" | "jsonl" | "yaml" | "sarif";

export function isStructuredFormat(fmt: OutputFormat): boolean {
  return fmt !== "text";
}

export function printEnvelope(envelope: HiveEnvelope, format: OutputFormat): void {
  switch (format) {
    case "json":
      process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
      break;
    case "jsonl":
      process.stdout.write(JSON.stringify(envelope) + "\n");
      break;
    case "yaml":
      process.stdout.write(toYaml(envelope) + "\n");
      break;
    case "sarif":
      // Only scan/lint output is sarif; other commands fall back to json
      process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
      break;
    case "text":
      // Callers handle text rendering themselves
      break;
  }
}

export function printText(lines: string[]): void {
  for (const line of lines) {
    process.stdout.write(line + "\n");
  }
}

export function printError(message: string): void {
  process.stderr.write(`error: ${message}\n`);
}

/** Minimal YAML serializer — handles the subset of types the envelope uses. */
function toYaml(value: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (value === null || value === undefined) return `${pad}~`;
  if (typeof value === "boolean") return `${pad}${value}`;
  if (typeof value === "number") return `${pad}${value}`;
  if (typeof value === "string") {
    if (value.includes("\n") || value.includes('"')) {
      return `${pad}|\n${value.split("\n").map((l) => `${pad}  ${l}`).join("\n")}`;
    }
    return `${pad}${JSON.stringify(value)}`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    return value.map((item) => `${pad}- ${toYaml(item, indent).trimStart()}`).join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    if (entries.length === 0) return `${pad}{}`;
    return entries
      .map(([k, v]) => {
        const vStr = toYaml(v, indent + 1);
        const inline = vStr.trimStart();
        if (typeof v === "object" && v !== null && !Array.isArray(v)) {
          return `${pad}${k}:\n${vStr}`;
        }
        if (Array.isArray(v) && v.length > 0) {
          return `${pad}${k}:\n${vStr}`;
        }
        return `${pad}${k}: ${inline}`;
      })
      .join("\n");
  }
  return `${pad}${String(value)}`;
}

/** Format a list of records as an aligned text table. */
export function formatTable(
  rows: Record<string, unknown>[],
  columns: string[],
): string {
  if (rows.length === 0) return "(empty)";
  const widths: number[] = columns.map((c) => c.length);
  for (const row of rows) {
    columns.forEach((col, i) => {
      const cell = String(row[col] ?? "");
      widths[i] = Math.max(widths[i], cell.length);
    });
  }
  const header = columns.map((c, i) => c.padEnd(widths[i])).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const body = rows
    .map((row) => columns.map((col, i) => String(row[col] ?? "").padEnd(widths[i])).join("  "))
    .join("\n");
  return [header, sep, body].join("\n");
}

/** Format a single record as key: value pairs. */
export function formatRecord(record: Record<string, unknown>): string {
  return Object.entries(record)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join("\n");
}
