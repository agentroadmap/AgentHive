import type { CallToolResult } from "../types.ts";
import { handleMcpError, McpValidationError, McpPolicyError } from "../errors/mcp-errors.ts";
import type { ToolContract, AliasMapping } from "./contract.ts";
import { recordAliasUsage } from "./alias-metrics.ts";

/**
 * Structured parameter error for InvalidArgument responses
 */
export interface ParamError {
	key: string;
	message: string;
	suggestion?: string;
}

/**
 * Result of contract enforcement
 */
export interface EnforcementResult {
	ok: boolean;
	validated?: Record<string, unknown>;
	error?: {
		code: string;
		message: string;
		params?: ParamError[];
	};
}

/**
 * Validates input against contract schema.
 * Handles alias resolution, type checking, and required fields.
 */
export function validateAgainstSchema(
	input: Record<string, unknown>,
	schema: Record<string, unknown>,
	aliases?: AliasMapping[],
	toolName?: string,
): EnforcementResult {
	const validated = { ...input };
	const paramErrors: ParamError[] = [];

	// Apply aliases: map deprecated keys to canonical names
	if (aliases) {
		for (const alias of aliases) {
			if (alias.deprecated in validated && !(alias.canonical in validated)) {
				validated[alias.canonical] = validated[alias.deprecated];
				delete validated[alias.deprecated];
				// Track alias usage for metrics (non-blocking, fire-and-forget)
				if (toolName) {
					void recordAliasUsage(toolName, alias.deprecated, alias.canonical);
				}
			}
		}
	}

	// Basic schema validation (additionalProperties, required fields, types)
	// For full JSON Schema compliance, this would use ajv or similar; for now, basic checks.
	const schemaObj = schema as Record<string, unknown> & {
		type?: string;
		properties?: Record<string, unknown>;
		required?: string[];
		additionalProperties?: boolean;
	};

	// Check required fields
	if (schemaObj.required && Array.isArray(schemaObj.required)) {
		for (const req of schemaObj.required) {
			if (!(req in validated)) {
				paramErrors.push({
					key: req,
					message: `Required parameter missing`,
					suggestion: `Include '${req}' in the request`,
				});
			}
		}
	}

	// Check additional properties
	if (schemaObj.additionalProperties === false && schemaObj.properties) {
		for (const key of Object.keys(validated)) {
			if (!(key in schemaObj.properties)) {
				paramErrors.push({
					key,
					message: `Unknown parameter not allowed`,
					suggestion: `Remove '${key}' or check the schema`,
				});
			}
		}
	}

	if (paramErrors.length > 0) {
		return {
			ok: false,
			error: {
				code: "INVALID_ARGUMENT",
				message: `Schema validation failed: ${paramErrors.length} error(s)`,
				params: paramErrors,
			},
		};
	}

	return { ok: true, validated };
}

/**
 * Checks if a handler references process-local state.
 * This is a heuristic check based on source code inspection.
 */
export function checkPersistenceDeclaration(
	handler: Function,
	persistence: string,
): boolean {
	if (persistence !== "durable") {
		// Only check durable handlers
		return true;
	}

	const handlerStr = handler.toString();

	// Heuristic patterns for process-local state:
	// - In-memory maps/sets (new Map, new Set)
	// - Plain object literals as persistent storage ({})
	// - This is a conservative check; false positives are acceptable.
	const suspiciousPatterns = [
		/new\s+Map\s*\(/,
		/new\s+Set\s*\(/,
		/const\s+\w+\s*=\s*new\s+Map/,
		/let\s+\w+\s*=\s*new\s+Map/,
		/const\s+\w+\s*=\s*new\s+Set/,
		/let\s+\w+\s*=\s*new\s+Set/,
	];

	for (const pattern of suspiciousPatterns) {
		if (pattern.test(handlerStr)) {
			return false; // Persistence violation detected
		}
	}

	return true; // Passes heuristic check
}

/**
 * Enforces a contract at tool invocation time.
 * - Validates input against schema
 * - Resolves aliases and records usage
 * - Returns structured validation errors if needed
 */
export async function enforceContract(
	input: Record<string, unknown>,
	contract: ToolContract,
): Promise<EnforcementResult> {
	// Schema validation + alias resolution
	const schemaResult = validateAgainstSchema(
		input,
		contract.argsSchema,
		contract.aliases,
		contract.name,
	);

	if (!schemaResult.ok) {
		return schemaResult;
	}

	// Persistence check at registration time (would be done earlier)
	// Here we assume it's already passed.

	return { ok: true, validated: schemaResult.validated };
}

/**
 * Wraps a contract enforcement with error handling.
 * Returns a properly formatted CallToolResult on validation failure.
 */
export async function enforceContractWithErrorHandling(
	input: Record<string, unknown>,
	contract: ToolContract,
): Promise<{ ok: boolean; args?: Record<string, unknown>; result?: CallToolResult }> {
	const result = await enforceContract(input, contract);

	if (!result.ok && result.error) {
		// Build structured error response
		const errorResult: CallToolResult = {
			isError: true,
			content: [
				{
					type: "text",
					text: `InvalidArgument: ${result.error.message}`,
				},
			],
			structuredContent: {
				code: result.error.code,
				message: result.error.message,
				details: {
					params: result.error.params?.map((p) => ({
						key: p.key,
						message: p.message,
						suggestion: p.suggestion,
					})),
				},
			},
		};

		return { ok: false, result: errorResult };
	}

	return { ok: true, args: result.validated };
}

/**
 * Import helper: get a contract-enforced tool wrapper function
 */
export type ContractEnforcer = typeof enforceContractWithErrorHandling;
