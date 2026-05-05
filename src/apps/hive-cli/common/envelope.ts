/**
 * Universal JSON envelope for all hive CLI responses.
 * Every command produces this envelope when --format json/jsonl/yaml is used.
 * Schema is versioned; increment SCHEMA_VERSION on breaking changes.
 */

import type { HiveContext } from "./context.ts";
import type { ErrorCode } from "./exit-codes.ts";
import { exitCodeForError } from "./exit-codes.ts";
import type { HiveError } from "./error.ts";

/** Partial context accepted by envelope builders (allows test/handler callers to omit derived fields). */
export type EnvelopeContext = Partial<HiveContext> & { resolved_at: string };

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

/** Error envelope variant where `error` is guaranteed present. */
export type HiveErrorEnvelope = Omit<HiveEnvelope<never>, 'error'> & { error: ErrorDetail };

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

/** Convenience wrapper: (data, command, context, opts?) */
export function successEnvelope<T>(
  data: T,
  command: string,
  context: EnvelopeContext,
  opts: { elapsed_ms?: number; warnings?: Warning[] } = {},
): HiveEnvelope<T> {
  return {
    schema_version: SCHEMA_VERSION,
    command,
    context: context as HiveContext,
    ok: true,
    data,
    warnings: opts.warnings ?? [],
    next_cursor: null,
    elapsed_ms: opts.elapsed_ms ?? 0,
  };
}

/** Convenience wrapper for lists: (items, command, context, opts?) */
export function successListEnvelope<T>(
  items: T[],
  command: string,
  context: EnvelopeContext,
  opts: { next_cursor?: string | null; elapsed_ms?: number; warnings?: Warning[] } = {},
): HiveEnvelope<T[]> {
  return {
    schema_version: SCHEMA_VERSION,
    command,
    context: context as HiveContext,
    ok: true,
    data: items,
    warnings: opts.warnings ?? [],
    next_cursor: opts.next_cursor ?? null,
    elapsed_ms: opts.elapsed_ms ?? 0,
  };
}

/** Convenience wrapper: (hiveError, command, context, opts?) */
export function errorEnvelope(
  error: HiveError,
  command: string,
  context: EnvelopeContext,
  opts: { elapsed_ms?: number; warnings?: Warning[] } = {},
): HiveErrorEnvelope {
  return {
    schema_version: SCHEMA_VERSION,
    command,
    context: context as HiveContext,
    ok: false,
    error: {
      code: error.code as ErrorCode,
      message: error.message,
      hint: error.hint,
      detail: error.detail as Record<string, unknown> | undefined,
      retriable: error.retriable,
      exit_code: error.exitCode,
    },
    warnings: opts.warnings ?? [],
    next_cursor: null,
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
