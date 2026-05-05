/**
 * Stable exit code contract for the hive CLI.
 * Every error code maps to exactly one exit code.
 * These values are part of the public API — never change assigned numbers.
 */

export const EXIT = {
  OK: 0,
  USAGE: 1,
  NOT_FOUND: 2,
  PERMISSION_DENIED: 3,
  CONFLICT: 4,
  REMOTE_FAILURE: 5,
  INVALID_STATE: 6,
  BUDGET_EXHAUSTED: 7,
  POLICY_DENIED: 8,
  TIMEOUT: 9,
  RATE_LIMITED: 10,
  SCHEMA_DRIFT: 11,
  MCP_UNREACHABLE: 12,
  DB_UNREACHABLE: 13,
  ENCODING_ERROR: 14,
  INTERNAL_ERROR: 99,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Stable error code enum (SCREAMING_SNAKE_CASE).
 * Maps 1:1 to exit codes.
 */
export const ERROR_CODE = {
  USAGE: "USAGE",
  NOT_FOUND: "NOT_FOUND",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  CONFLICT: "CONFLICT",
  REMOTE_FAILURE: "REMOTE_FAILURE",
  INVALID_STATE: "INVALID_STATE",
  BUDGET_EXHAUSTED: "BUDGET_EXHAUSTED",
  POLICY_DENIED: "POLICY_DENIED",
  TIMEOUT: "TIMEOUT",
  RATE_LIMITED: "RATE_LIMITED",
  SCHEMA_DRIFT: "SCHEMA_DRIFT",
  MCP_UNREACHABLE: "MCP_UNREACHABLE",
  DB_UNREACHABLE: "DB_UNREACHABLE",
  ENCODING_ERROR: "ENCODING_ERROR",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE];

/** Map from error code to its canonical exit code. */
export const ERROR_CODE_TO_EXIT: Record<ErrorCode, ExitCode> = {
  USAGE: EXIT.USAGE,
  NOT_FOUND: EXIT.NOT_FOUND,
  PERMISSION_DENIED: EXIT.PERMISSION_DENIED,
  CONFLICT: EXIT.CONFLICT,
  REMOTE_FAILURE: EXIT.REMOTE_FAILURE,
  INVALID_STATE: EXIT.INVALID_STATE,
  BUDGET_EXHAUSTED: EXIT.BUDGET_EXHAUSTED,
  POLICY_DENIED: EXIT.POLICY_DENIED,
  TIMEOUT: EXIT.TIMEOUT,
  RATE_LIMITED: EXIT.RATE_LIMITED,
  SCHEMA_DRIFT: EXIT.SCHEMA_DRIFT,
  MCP_UNREACHABLE: EXIT.MCP_UNREACHABLE,
  DB_UNREACHABLE: EXIT.DB_UNREACHABLE,
  ENCODING_ERROR: EXIT.ENCODING_ERROR,
  INTERNAL_ERROR: EXIT.INTERNAL_ERROR,
};

export function exitCodeForError(code: ErrorCode): ExitCode {
  return ERROR_CODE_TO_EXIT[code];
}

/** Alias for exitCodeForError — used by error.ts */
export function mapErrorCodeToExitCode(code: string): number {
  return (ERROR_CODE_TO_EXIT as Record<string, number>)[code] ?? EXIT.INTERNAL_ERROR;
}

const RETRIABLE_EXIT_CODES = new Set<number>([EXIT.TIMEOUT, EXIT.RATE_LIMITED, EXIT.REMOTE_FAILURE]);

export function isRetriable(exitCode: number): boolean {
  return RETRIABLE_EXIT_CODES.has(exitCode);
}

/** Stable alias — tests import EXIT_CODES */
export const EXIT_CODES = EXIT;
