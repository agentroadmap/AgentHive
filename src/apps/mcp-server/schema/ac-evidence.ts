/**
 * AC evidence schema types and validator (P707 / P378).
 *
 * Canonical location for the evidence schema module (AC-6, P378).
 * Used by verifyAC (MCP layer) and AutoEvaluator (gate layer) to enforce the
 * phantom-pass guard introduced in P707.
 *
 * Every verify_ac call with status='pass' MUST supply verification_notes as a
 * JSON string matching one of these schemas.  Null or empty notes = phantom pass.
 */

export const AC_SCHEMA_VERSION = "v1";

export type AcCategory =
	| "schema/migration"
	| "file/module"
	| "mcp_tool"
	| "behavioral/test";

export interface SchemaMigrationEvidence {
	category: "schema/migration";
	migration_file: string;
	tables: string[];
	applied: boolean;
}

export interface FileModuleEvidence {
	category: "file/module";
	files: string[];
	symbols: string[];
	grep_evidence: string;
}

export interface McpToolEvidence {
	category: "mcp_tool";
	tool_name: string;
	action: string;
	call_verified: boolean;
	response_sample: string;
}

export interface BehavioralTestEvidence {
	category: "behavioral/test";
	test_file: string;
	test_names: string[];
	result: "pass" | "fail";
	output_snippet: string;
}

export type AcEvidence =
	| SchemaMigrationEvidence
	| FileModuleEvidence
	| McpToolEvidence
	| BehavioralTestEvidence;

/**
 * Returns an error message if notes are invalid, or null if valid.
 */
export function validateAcEvidence(notes: string | null | undefined): string | null {
	if (!notes || notes.trim() === "") {
		return "verification_notes is required for status='pass' — null/empty is a phantom pass (P707 §AC-Verification)";
	}
	let obj: Record<string, unknown>;
	try {
		const parsed = JSON.parse(notes);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return "verification_notes must be a JSON object, not a primitive or array";
		}
		obj = parsed as Record<string, unknown>;
	} catch {
		return "verification_notes must be valid JSON (see CONVENTIONS.md §AC-Verification)";
	}

	const cat = obj["category"] as AcCategory | undefined;
	if (!cat) {
		return "verification_notes must include a 'category' field: schema/migration | file/module | mcp_tool | behavioral/test";
	}

	switch (cat) {
		case "schema/migration":
			if (!obj["migration_file"]) return "schema/migration evidence requires 'migration_file'";
			if (!Array.isArray(obj["tables"])) return "schema/migration evidence requires 'tables' (string[])";
			if (typeof obj["applied"] !== "boolean") return "schema/migration evidence requires 'applied' (bool)";
			break;
		case "file/module":
			if (!Array.isArray(obj["files"]) || (obj["files"] as unknown[]).length === 0)
				return "file/module evidence requires non-empty 'files' array";
			if (!Array.isArray(obj["symbols"])) return "file/module evidence requires 'symbols' array";
			if (!obj["grep_evidence"]) return "file/module evidence requires 'grep_evidence' string";
			break;
		case "mcp_tool":
			if (!obj["tool_name"]) return "mcp_tool evidence requires 'tool_name'";
			if (!obj["action"]) return "mcp_tool evidence requires 'action'";
			if (typeof obj["call_verified"] !== "boolean") return "mcp_tool evidence requires 'call_verified' (bool)";
			if (!obj["response_sample"]) return "mcp_tool evidence requires 'response_sample'";
			break;
		case "behavioral/test":
			if (!obj["test_file"]) return "behavioral/test evidence requires 'test_file'";
			if (!Array.isArray(obj["test_names"])) return "behavioral/test evidence requires 'test_names' array";
			if (obj["result"] !== "pass" && obj["result"] !== "fail")
				return "behavioral/test evidence requires result='pass' or result='fail'";
			if (!obj["output_snippet"]) return "behavioral/test evidence requires 'output_snippet'";
			break;
		default:
			return `Unknown evidence category '${cat}'. Valid: schema/migration | file/module | mcp_tool | behavioral/test`;
	}
	return null;
}
