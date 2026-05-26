// AC evidence schema for verify_ac details field (P707).
// Each AC category requires specific keys; missing keys return 422 SCHEMA_MISMATCH.

export const AC_SCHEMA_VERSION = "v1";

export type AcCategory = "schema/migration" | "file/module" | "mcp_tool" | "behavioral/test";

export interface SchemaMigrationEvidence {
	migration_file: string;
	tables: string[];
	applied: boolean;
	columns_spot_check?: Array<{ table: string; column: string; type: string }>;
}

export interface FileModuleEvidence {
	files: string[];
	symbols: string[];
	grep_evidence: string;
}

export interface McpToolEvidence {
	tool_name: string;
	action: string;
	call_verified: boolean;
	response_sample: string;
}

export interface BehavioralTestEvidence {
	test_file: string;
	test_names: string[];
	result: "pass" | "fail";
	output_snippet: string;
}

type EvidenceByCategory = {
	"schema/migration": SchemaMigrationEvidence;
	"file/module": FileModuleEvidence;
	"mcp_tool": McpToolEvidence;
	"behavioral/test": BehavioralTestEvidence;
};

const REQUIRED_KEYS: Record<AcCategory, string[]> = {
	"schema/migration": ["migration_file", "tables", "applied"],
	"file/module": ["files", "symbols", "grep_evidence"],
	"mcp_tool": ["tool_name", "action", "call_verified", "response_sample"],
	"behavioral/test": ["test_file", "test_names", "result", "output_snippet"],
};

export type AcEvidence = SchemaMigrationEvidence | FileModuleEvidence | McpToolEvidence | BehavioralTestEvidence;

export interface AcEvidenceValidationResult {
	valid: boolean;
	error?: string;
	code?: "EVIDENCE_REQUIRED" | "SCHEMA_MISMATCH";
}

/**
 * Validates that a details payload is non-null, non-empty, and contains the
 * required keys for its category.  If category is omitted the check only
 * enforces non-null / non-empty (structural guard only).
 */
export function validateAcEvidence(
	details: unknown,
	category?: AcCategory,
): AcEvidenceValidationResult {
	if (details === null || details === undefined) {
		return { valid: false, code: "EVIDENCE_REQUIRED", error: "details is required and must not be null" };
	}

	if (typeof details !== "object" || Array.isArray(details)) {
		return { valid: false, code: "EVIDENCE_REQUIRED", error: "details must be a JSON object" };
	}

	const obj = details as Record<string, unknown>;
	if (Object.keys(obj).length === 0) {
		return { valid: false, code: "EVIDENCE_REQUIRED", error: "details must not be an empty object" };
	}

	if (category) {
		const required = REQUIRED_KEYS[category];
		if (required) {
			const missing = required.filter((k) => !(k in obj));
			if (missing.length > 0) {
				return {
					valid: false,
					code: "SCHEMA_MISMATCH",
					error: `details missing required keys for category '${category}': ${missing.join(", ")}`,
				};
			}
		}
	}

	return { valid: true };
}

export const AC_CATEGORIES: AcCategory[] = [
	"schema/migration",
	"file/module",
	"mcp_tool",
	"behavioral/test",
];
