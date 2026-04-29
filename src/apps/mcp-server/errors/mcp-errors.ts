import { randomUUID } from "node:crypto";
import type { CallToolResult } from "../types.ts";

export function generateRequestId(): string {
	return randomUUID();
}

/**
 * Base MCP error class for all MCP-related errors
 */
export class McpError extends Error {
	public code: string;
	public details?: unknown;

	constructor(message: string, code: string, details?: unknown) {
		super(message);
		this.code = code;
		this.details = details;
		this.name = "McpError";
	}
}

/** Input validation failures */
export class McpValidationError extends McpError {
	constructor(message: string, validationError?: unknown) {
		super(message, "validation_error", validationError);
	}
}

/** Authentication / authorisation failures */
export class McpAuthenticationError extends McpError {
	constructor(message = "Authentication required") {
		super(message, "policy_error");
	}
}

/** Transport-level connection failures */
export class McpConnectionError extends McpError {
	constructor(message: string, details?: unknown) {
		super(message, "internal_error", details);
	}
}

/** Database query / connectivity failures */
export class McpDatabaseError extends McpError {
	constructor(message: string, details?: unknown) {
		super(message, "db_error", details);
	}
}

/** Policy / permission violations */
export class McpPolicyError extends McpError {
	constructor(message: string, details?: unknown) {
		super(message, "policy_error", details);
	}
}

/** Unexpected internal failures */
export class McpInternalError extends McpError {
	constructor(message = "An unexpected error occurred", details?: unknown) {
		super(message, "internal_error", details);
	}
}

/**
 * Builds a structured MCP error result.
 *
 * Structured envelope: {code, message, request_id, timestamp}
 * Never throws — safe to call from any tool handler so the transport stays open.
 */
function buildErrorResult(
	code: string,
	message: string,
	details?: unknown,
	requestId?: string,
): CallToolResult {
	const includeDetails = !!process.env.DEBUG;
	return {
		content: [
			{
				type: "text",
				text: formatErrorMarkdown(code, message, details, includeDetails),
			},
		],
		isError: true,
		structuredContent: {
			code,
			message,
			request_id: requestId ?? generateRequestId(),
			timestamp: new Date().toISOString(),
			...(includeDetails && details !== undefined ? { details } : {}),
		},
	};
}

export function handleMcpError(error: unknown, requestId?: string): CallToolResult {
	if (error instanceof McpError) {
		return buildErrorResult(error.code, error.message, error.details, requestId);
	}

	console.error("Unexpected MCP error:", error);

	const message =
		error instanceof Error ? error.message : "An unexpected error occurred";

	return buildErrorResult("internal_error", message, error, requestId);
}

/**
 * Formats successful responses in a consistent structure
 */
export function handleMcpSuccess(data: unknown): CallToolResult {
	return {
		content: [
			{
				type: "text",
				text: "OK",
			},
		],
		structuredContent: {
			success: true,
			data,
		},
	};
}

/**
 * Format error messages in markdown for consistent MCP error responses
 */
export function formatErrorMarkdown(
	code: string,
	message: string,
	details?: unknown,
	includeDetails = false,
): string {
	if (includeDetails && details) {
		let result = `${code}: ${message}`;
		const detailsText =
			typeof details === "string" ? details : JSON.stringify(details, null, 2);
		result += `\n  ${detailsText}`;
		return result;
	}
	return message;
}
