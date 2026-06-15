/**
 * P1389 AC-4: MCP Parameter Fidelity Linter
 *
 * Checks that every parameter declared in an MCP tool's inputSchema
 * is consumed by the corresponding handler. Fails CI if a schema declares
 * a field that the handler never references.
 *
 * Approach:
 * - Read MCP tool schemas from registered tools
 * - For each schema property, grep the handler source for the property name
 * - Allowlist for legitimate cases (params consumed indirectly)
 * - Return non-zero exit code if unconsumed params found
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

// Types for tool registry
interface ToolSchema {
	type: string;
	properties?: Record<string, unknown>;
	required?: string[];
	additionalProperties?: unknown;
}

interface MaybeError<T> {
	isError?: boolean;
	content?: T;
}

interface McpToolDef {
	name: string;
	description: string;
	inputSchema: ToolSchema;
	[key: string]: unknown;
}

interface Allowlist {
	[toolName: string]: {
		[paramName: string]: string; // justification
	};
}

/**
 * Legitimate use cases for param consumption that string-match may miss:
 * - Params consumed via object destructuring or spread syntax
 * - Params passed through to other functions
 * - Params used in template literals or string interpolation
 * - Params consumed indirectly via conditional logic on their values
 */
const allowlist: Allowlist = {
	// Proposals domain
	prop_create: {},
	prop_claim: {},
	add_acceptance_criteria: {},
	add_discussion: {},
	submit_review: {},
	verify_ac: {},
	set_maturity: {},
	prop_transition: {},
	add_dependency: {},
	add_reference: {},
	set_parent: {},
	record_gate_decision: {},

	// RFC domain (rfc/pg-handlers)
	cubic_recycle: {},

	// Agency/Ops domain
	agency_cap_set: {},
	spending_set_cap: {},

	// Message domain
	msg_send: {},

	// Memory domain
	memory_set: {},

	// Document domain
	document_pg_create: {},
};

/**
 * Read tool schemas from a file
 * Returns a flat map of tool name -> schema
 */
function extractToolSchemas(filePath: string): Map<string, ToolSchema> {
	const schemas = new Map<string, ToolSchema>();

	if (!fs.existsSync(filePath)) {
		return schemas;
	}

	const content = fs.readFileSync(filePath, "utf-8");

	// Simple regex to find `export const <name>Schema = { ... }`
	// This is a heuristic; for complex nested objects, AST parsing would be more robust.
	const schemaRegex =
		/export\s+const\s+(\w+)Schema\s*=\s*\{([^}]+(?:\{[^}]*\})*[^}]*)\}/g;
	let match;

	while ((match = schemaRegex.exec(content)) !== null) {
		const toolName = match[1]
			.replace(/([A-Z])/g, "_$1")
			.toLowerCase()
			.replace(/^_/, "")
			.replace(/_schema$/, "");

		// For now, skip detailed parsing; we'll use grep-based checks instead.
		// A proper implementation would parse the JSON or use ts-morph.
		schemas.set(toolName, {
			type: "object",
			properties: {},
		});
	}

	return schemas;
}

/**
 * Search handler source for a parameter name.
 * Returns true if the param appears in the source code (string-based heuristic).
 */
function isParamConsumed(
	handlerSource: string,
	paramName: string,
	toolName: string,
): boolean {
	// Check allowlist first
	if (allowlist[toolName]?.[paramName] !== undefined) {
		return true; // Allowlisted as legitimate
	}

	// Heuristics for param consumption:
	// 1. Direct reference: args.paramName
	// 2. Destructuring: { paramName }
	// 3. In template literals: ${paramName} or `...paramName...`
	// 4. In string matching: "paramName" (weak heuristic)
	// 5. Property access chain: paramName.foo

	const patterns = [
		new RegExp(`args\\.${paramName}\\b`, "i"),
		new RegExp(`\\b${paramName}\\b(?=\\s*[,}]|$|\\s*:)`, "i"), // destructuring or assignment
		new RegExp(`\\$\\{.*?${paramName}.*?\\}`, "i"), // template literal
		new RegExp(`"${paramName}"`, "i"),
		new RegExp(`'${paramName}'`, "i"),
		new RegExp(`params\\[.*?${paramName}`, "i"), // positional params array
		new RegExp(`\\$\\d+.*?${paramName}`, "i"), // SQL positional params
	];

	for (const pattern of patterns) {
		if (pattern.test(handlerSource)) {
			return true;
		}
	}

	return false;
}

/**
 * Return the balanced { ... } block starting at `openIdx` (which must point
 * at an opening brace), inclusive. Returns null if unbalanced.
 */
function extractBracedBlock(source: string, openIdx: number): string | null {
	if (source[openIdx] !== "{") return null;
	let depth = 0;
	for (let i = openIdx; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}") {
			depth--;
			if (depth === 0) return source.slice(openIdx, i + 1);
		}
	}
	return null;
}

/**
 * Main linter: walk tool definitions and check param fidelity
 */
async function checkMcpParamFidelity(): Promise<boolean> {
	const toolsDir = path.join(process.cwd(), "src/apps/mcp-server/tools");
	const errors: string[] = [];

	// Helper to find handler files
	function findHandlers(dir: string): string[] {
		const handlers: string[] = [];
		for (const file of fs.readdirSync(dir)) {
			const fullPath = path.join(dir, file);
			const stat = fs.statSync(fullPath);
			if (stat.isDirectory() && file !== "__tests__" && file !== "node_modules") {
				// Check for pg-handlers.ts or handlers.ts
				const pgHandlersPath = path.join(fullPath, "pg-handlers.ts");
				const handlersPath = path.join(fullPath, "handlers.ts");
				if (fs.existsSync(pgHandlersPath)) {
					handlers.push(pgHandlersPath);
				}
				if (fs.existsSync(handlersPath)) {
					handlers.push(handlersPath);
				}
			}
		}
		return handlers;
	}

	const handlerFiles = findHandlers(toolsDir);

	// P1389 baseline ratchet: pre-existing findings recorded 2026-06-12 are
	// tolerated (pending triage); anything NEW fails the gate.
	const baselinePath = path.join(
		process.cwd(),
		"scripts/ci/mcp-param-fidelity-baseline.json",
	);
	const baseline: Record<string, string[]> = fs.existsSync(baselinePath)
		? JSON.parse(fs.readFileSync(baselinePath, "utf-8")).baseline
		: {};
	let baselined = 0;

	// Read consolidated.ts to get action -> tool name mappings
	const consolidatedPath = path.join(toolsDir, "consolidated.ts");
	if (!fs.existsSync(consolidatedPath)) {
		console.error("consolidated.ts not found");
		return false;
	}

	const consolidatedContent = fs.readFileSync(consolidatedPath, "utf-8");

	// Extract route maps (simple regex-based parsing)
	const routeRegex = /const\s+(\w+Routes):\s*RouteMap\s*=\s*\{([\s\S]*?)\n\s*\}/g;
	const toolToHandler = new Map<string, string>();
	let match;

	while ((match = routeRegex.exec(consolidatedContent)) !== null) {
		const routesContent = match[2];
		const actionRegex = /(\w+):\s*"([^"]+)"/g;
		let actionMatch;
		while ((actionMatch = actionRegex.exec(routesContent)) !== null) {
			const actionName = actionMatch[2];
			toolToHandler.set(actionName, actionName); // Map 1:1 for now
		}
	}

	// For each handler file, check schemas
	for (const handlerPath of handlerFiles) {
		const handlerSource = fs.readFileSync(handlerPath, "utf-8");
		const handlerDir = path.dirname(handlerPath);
		const schemasPath = path.join(handlerDir, "schemas.ts");

		if (!fs.existsSync(schemasPath)) {
			continue; // No schemas to check
		}

		const schemasSource = fs.readFileSync(schemasPath, "utf-8");

		// Find all exported schemas. Tolerates an optional type annotation
		// (export const fooSchema: JsonSchema = { ... }) — the original regex
		// silently skipped every annotated schema, making the gate a no-op.
		const schemaHeadRegex =
			/export\s+const\s+(\w+?)[Ss]chema\s*(?::\s*[\w.$<>\[\]| ]+)?\s*=\s*\{/g;
		let schemaMatch: RegExpExecArray | null;

		while ((schemaMatch = schemaHeadRegex.exec(schemasSource)) !== null) {
			const schemaName = schemaMatch[1];
			const bodyStart = schemaHeadRegex.lastIndex - 1; // points at the opening brace
			const schemaBody = extractBracedBlock(schemasSource, bodyStart);
			if (!schemaBody) continue;

			// Only inspect the properties: { ... } block, top-level keys.
			const propsIdx = schemaBody.search(/\bproperties\s*:\s*\{/);
			const foundProps = new Set<string>();
			if (propsIdx >= 0) {
				const propsOpen = schemaBody.indexOf("{", propsIdx + "properties".length);
				const propsBlock = extractBracedBlock(schemaBody, propsOpen);
				if (propsBlock) {
					// Top-level keys: at brace depth 1 within the properties block.
					let depth = 0;
					const keyRegex = /(\w+)\s*:\s*\{/g;
					let km: RegExpExecArray | null;
					while ((km = keyRegex.exec(propsBlock)) !== null) {
						depth = 0;
						for (let i = 0; i < km.index; i++) {
							if (propsBlock[i] === "{") depth++;
							else if (propsBlock[i] === "}") depth--;
						}
						if (depth === 1) foundProps.add(km[1]);
					}
				}
			}

			// Check if each property is consumed in the handler
			for (const prop of foundProps) {
				if (!isParamConsumed(handlerSource, prop, schemaName)) {
					if (baseline[schemaName]?.includes(prop)) {
						baselined++;
						continue; // pre-existing finding, ratcheted (see baseline JSON)
					}
					errors.push(
						`Tool '${schemaName}': parameter '${prop}' declared in schema but not consumed in handler (${handlerPath})`,
					);
				}
			}
		}
	}

	// Report results
	if (errors.length > 0) {
		console.error("\n[GATE] audit:mcp-param-fidelity (P1389 AC-4)");
		console.error("FAILED: Unconsumed schema parameters detected:\n");
		for (const err of errors) {
			console.error(`  - ${err}`);
		}
		console.error(`\nTotal unconsumed params: ${errors.length}`);
		return false;
	}

	console.log(
		`[GATE] audit:mcp-param-fidelity (P1389 AC-4) PASSED: no NEW unconsumed schema params (${baselined} pre-existing baselined, pending triage).`,
	);
	return true;
}

// Run the linter
checkMcpParamFidelity()
	.then((success) => {
		process.exit(success ? 0 : 1);
	})
	.catch((err) => {
		console.error("Linter error:", err);
		process.exit(1);
	});
