/**
 * Common module exports.
 *
 * Re-exports all common utilities (errors, envelope, context, formatters, discovery)
 * so domain modules can import from a single entry point.
 */

export * from "./error";
export * from "./exit-codes";
export * from "./envelope";
export * from "./context";
export * from "./formatters";
export * from "./discovery";
