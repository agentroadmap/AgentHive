/**
 * JSON envelope builder per cli-hive-contract.md §2.
 *
 * Every CLI response (success or error) is wrapped in a standardized envelope
 * that includes schema version, command, context, and timing info.
 */

import type { HiveError } from "./error";

export interface CliContext {
  project?: string;
  agency?: string;
  host?: string;
  mcp_url?: string;
  db_host?: string;
  db_port?: number;
  resolved_at?: string;
}

export interface Warning {
  code: string;
  message: string;
}

export interface SuccessEnvelope<T = unknown> {
  schema_version: number;
  command: string;
  context: CliContext;
  ok: true;
  data?: T;
  warnings: Warning[];
  next_cursor?: string | null;
  elapsed_ms: number;
}

export interface ErrorEnvelope {
  schema_version: number;
  command: string;
  context: CliContext;
  ok: false;
  error: {
    code: string;
    message: string;
    hint?: string;
    detail?: Record<string, unknown>;
    retriable: boolean;
    exit_code: number;
  };
  warnings: Warning[];
  elapsed_ms: number;
}

export type HiveEnvelope<T = unknown> = SuccessEnvelope<T> | ErrorEnvelope;

const SCHEMA_VERSION = 1;

/**
 * Build a success envelope.
 */
export function successEnvelope<T = unknown>(
  data: T | undefined,
  command: string,
  context: CliContext,
  options?: {
    warnings?: Warning[];
    next_cursor?: string | null;
    elapsed_ms?: number;
  }
): SuccessEnvelope<T> {
  return {
    schema_version: SCHEMA_VERSION,
    command,
    context,
    ok: true,
    ...(data !== undefined && { data }),
    warnings: options?.warnings ?? [],
    ...(options?.next_cursor !== undefined && { next_cursor: options.next_cursor }),
    elapsed_ms: options?.elapsed_ms ?? 0,
  };
}

/**
 * Build an error envelope from a HiveError.
 */
export function errorEnvelope(
  error: HiveError,
  command: string,
  context: CliContext,
  options?: {
    warnings?: Warning[];
    elapsed_ms?: number;
  }
): ErrorEnvelope {
  return {
    schema_version: SCHEMA_VERSION,
    command,
    context,
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.hint && { hint: error.hint }),
      ...(error.detail && { detail: error.detail }),
      retriable: error.retriable,
      exit_code: error.exitCode,
    },
    warnings: options?.warnings ?? [],
    elapsed_ms: options?.elapsed_ms ?? 0,
  };
}

/**
 * Build a success envelope for a list response with pagination.
 */
export function successListEnvelope<T = unknown>(
  items: T[],
  command: string,
  context: CliContext,
  options?: {
    next_cursor?: string | null;
    warnings?: Warning[];
    elapsed_ms?: number;
  }
): SuccessEnvelope<T[]> {
  return {
    schema_version: SCHEMA_VERSION,
    command,
    context,
    ok: true,
    data: items,
    warnings: options?.warnings ?? [],
    ...(options?.next_cursor !== undefined && { next_cursor: options.next_cursor }),
    elapsed_ms: options?.elapsed_ms ?? 0,
  };
}
