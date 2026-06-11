import { randomUUID } from "node:crypto";
import type { CallToolResult } from "../types.ts";

/**
 * Standardized MCP error envelope.
 * All tool errors should conform to this structure.
 */
export interface McpErrorEnvelope {
	code: string; // e.g., "INVALID_ARGUMENT", "NOT_FOUND", "INTERNAL_ERROR"
	message: string; // Human-readable summary
	details?: unknown; // Additional context (type-specific)
	retriable: boolean; // Whether the caller can retry safely
	correlation_id: string; // Request tracking ID
	timestamp?: string; // ISO 8601
}

/**
 * Creates a standardized error envelope and returns it as a CallToolResult.
 */
export function createErrorResult(
	code: string,
	message: string,
	details?: unknown,
	retriable = false,
	correlationId?: string,
): CallToolResult {
	const envelope: McpErrorEnvelope = {
		code,
		message,
		details: details !== undefined ? details : undefined,
		retriable,
		correlation_id: correlationId || randomUUID(),
		timestamp: new Date().toISOString(),
	};

	return {
		isError: true,
		content: [
			{
				type: "text",
				text: `${code}: ${message}`,
			},
		],
		structuredContent: envelope,
	};
}

/**
 * Validates that a CallToolResult conforms to error envelope standards.
 * Used for lint-time or type-check-time verification.
 */
export function isValidErrorEnvelope(
	result: CallToolResult,
): result is CallToolResult & { structuredContent: McpErrorEnvelope } {
	if (!result.isError) {
		return false;
	}

	const sc = result.structuredContent as Record<string, unknown>;
	if (!sc) {
		return false;
	}

	// Check required fields
	return (
		typeof sc.code === "string" &&
		typeof sc.message === "string" &&
		typeof sc.retriable === "boolean" &&
		typeof sc.correlation_id === "string"
	);
}

/**
 * Wraps a handler to ensure errors always conform to the envelope.
 * Used as a guard to catch raw Error throws.
 */
export function wrapErrorHandling<T extends (...args: any[]) => any>(
	handler: T,
	correlationId?: string,
): T {
	return (async (...args: Parameters<T>) => {
		try {
			return await handler(...args);
		} catch (err) {
			const message =
				err instanceof Error ? err.message : String(err);
			return createErrorResult(
				"INTERNAL_ERROR",
				message,
				err instanceof Error ? { stack: err.stack } : undefined,
				false, // Not retriable unless explicitly marked
				correlationId,
			);
		}
	}) as T;
}

/**
 * Error codes and their standard retriability.
 */
export const ERROR_CODE_RETRIABILITY: Record<string, boolean> = {
	// Validation errors — not retriable without fixing input
	INVALID_ARGUMENT: false,
	MISSING_REQUIRED: false,
	TYPE_MISMATCH: false,

	// Not found — not retriable (resource doesn't exist)
	NOT_FOUND: false,

	// Policy errors — not retriable without auth change
	PERMISSION_DENIED: false,
	AUTHENTICATION_REQUIRED: false,

	// Server errors — retriable
	INTERNAL_ERROR: true,
	TIMEOUT: true,
	UNAVAILABLE: true,
	DATABASE_ERROR: true,

	// Conflict — retriable with backoff
	CONFLICT: true,
	RESOURCE_EXHAUSTED: true,
};

/**
 * Gets the standard retriability for a code.
 */
export function isRetriable(code: string): boolean {
	return ERROR_CODE_RETRIABILITY[code] ?? false;
}
