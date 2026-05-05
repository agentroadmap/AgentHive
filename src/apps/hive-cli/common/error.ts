/**
 * Typed error class for CLI errors.
 *
 * Carries structured error info (code, message, hints, details) that gets
 * converted into the JSON envelope by the top-level catch handler.
 */

import { mapErrorCodeToExitCode, isRetriable } from "./exit-codes";

/** Arbitrary key-value detail attached to HiveError. Named distinctly to avoid collision with envelope's ErrorDetail. */
export interface HiveErrorDetail {
  [key: string]: unknown;
}

export class HiveError extends Error {
  public readonly code: string;
  public override readonly message: string;
  public readonly hint?: string;
  public readonly detail?: HiveErrorDetail;
  public readonly exitCode: number;
  public readonly retriable: boolean;

  constructor(
    code: string,
    message: string,
    options?: {
      hint?: string;
      detail?: HiveErrorDetail;
    }
  ) {
    super(message);
    this.name = "HiveError";
    this.code = code;
    this.message = message;
    this.hint = options?.hint;
    this.detail = options?.detail;
    this.exitCode = mapErrorCodeToExitCode(code);
    this.retriable = isRetriable(this.exitCode);

    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, HiveError.prototype);
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint && { hint: this.hint }),
      ...(this.detail && { detail: this.detail }),
      retriable: this.retriable,
      exit_code: this.exitCode,
    };
  }
}

/**
 * Helper to throw common errors.
 */
export const Errors = {
  usage: (message: string, hint?: string) =>
    new HiveError("USAGE", message, { hint }),

  notFound: (message: string, detail?: HiveErrorDetail) =>
    new HiveError("NOT_FOUND", message, { detail }),

  conflict: (message: string, detail?: HiveErrorDetail) =>
    new HiveError("CONFLICT", message, { detail }),

  permissionDenied: (message: string, detail?: HiveErrorDetail) =>
    new HiveError("PERMISSION_DENIED", message, { detail }),

  invalidState: (message: string, detail?: HiveErrorDetail) =>
    new HiveError("INVALID_STATE", message, { detail }),

  remoteFailure: (message: string, detail?: HiveErrorDetail) =>
    new HiveError("REMOTE_FAILURE", message, { detail }),

  mcpUnreachable: (message: string, hint?: string) =>
    new HiveError("MCP_UNREACHABLE", message, { hint }),

  dbUnreachable: (message: string, hint?: string) =>
    new HiveError("DB_UNREACHABLE", message, { hint }),

  encodingError: (message: string, detail?: HiveErrorDetail) =>
    new HiveError("ENCODING_ERROR", message, { detail }),

  internal: (message: string, detail?: HiveErrorDetail) =>
    new HiveError("INTERNAL_ERROR", message, { detail }),
};
