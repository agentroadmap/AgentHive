/**
 * Universal JSON envelope for all hive CLI responses.
 * Every command produces this envelope when --format json/jsonl/yaml is used.
 * Schema is versioned; increment SCHEMA_VERSION on breaking changes.
 */

import type { HiveContext } from "./context.ts";
import type { ErrorCode } from "./exit-codes.ts";
import { exitCodeForError } from "./exit-codes.ts";

export const SCHEMA_VERSION = 1;

export interface Warning {
  code: string;
  message: string;
  retriable: boolean;
}

export interface ErrorDetail {
  code: ErrorCode;
  message: string;
  hint?: string;
  detail?: Record<string, unknown>;
  retriable: boolean;
  exit_code: number;
}

export interface HiveEnvelope<T = unknown> {
  schema_version: typeof SCHEMA_VERSION;
  command: string;
  context: HiveContext;
  ok: boolean;
  data?: T;
  error?: ErrorDetail;
  warnings: Warning[];
  next_cursor: string | null;
  elapsed_ms: number;
}

export function buildOkEnvelope<T>(
  command: string,
  context: HiveContext,
  data: T,
  opts: {
    warnings?: Warning[];
    next_cursor?: string | null;
    elapsed_ms?: number;
  } = {},
): HiveEnvelope<T> {
  return {
    schema_version: SCHEMA_VERSION,
    command,
    context,
    ok: true,
    data,
    warnings: opts.warnings ?? [],
    next_cursor: opts.next_cursor ?? null,
    elapsed_ms: opts.elapsed_ms ?? 0,
  };
}

export function buildErrorEnvelope(
  command: string,
  context: HiveContext,
  error: {
    code: ErrorCode;
    message: string;
    hint?: string;
    detail?: Record<string, unknown>;
    retriable?: boolean;
  },
  opts: {
    warnings?: Warning[];
    elapsed_ms?: number;
  } = {},
): HiveEnvelope<never> {
  const exit_code = exitCodeForError(error.code);
  return {
    schema_version: SCHEMA_VERSION,
    command,
    context,
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      hint: error.hint,
      detail: error.detail,
      retriable: error.retriable ?? false,
      exit_code,
    },
    warnings: opts.warnings ?? [],
    next_cursor: null,
    elapsed_ms: opts.elapsed_ms ?? 0,
  };
}
