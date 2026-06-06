#!/usr/bin/env node
/**
 * MCP bundle integrity gate.
 *
 * Bundles the MCP SSE server entry through its REAL local import graph and fails
 * on the merge-corruption pattern that crash-loops agenthive-mcp at runtime:
 *   1. duplicate const/function/class declarations  (esbuild reports these)
 *   2. duplicate import bindings                     (esbuild DEDUPES imports and
 *      will not report them, so we scan the graph files ourselves)
 *
 * Why this exists: tsconfig.check.json only typechecks hive-cli / cubic-agents /
 * core/gate — it does NOT cover src/apps/mcp-server. So dup-declaration
 * corruption in the MCP server passes `npm run typecheck` clean and reaches main,
 * only surfacing as a runtime ParseError on service restart (and the runtime
 * shows only the FIRST error per boot). See memory: mcp-merge-corruption-ci-gap.
 *
 * Scope: only files actually in the MCP import graph (esbuild metafile), so
 * unrelated dup-imports elsewhere (e.g. test files) don't fail this gate.
 *
 * Usage: node scripts/check-mcp-bundle.mjs   (exit 0 = clean, 1 = corruption)
 */
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "scripts/mcp-sse-server.js");
const DUP = /already been declared/i;

function reportDups(messages) {
	const dups = (messages || []).filter((m) => DUP.test(m.text));
	for (const d of dups) {
		const loc = d.location ? `${d.location.file}:${d.location.line}` : "?";
		console.error(`  ${loc}  ${d.text}`);
	}
	return dups.length;
}

// Extract local binding names from a file's import statements and return any
// name imported more than once (a redeclaration the runtime rejects).
function duplicateImportBindings(code) {
	const importRe = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"][^'"]+['"]/g;
	const counts = new Map();
	const bump = (n) => n && counts.set(n, (counts.get(n) || 0) + 1);
	let m;
	while ((m = importRe.exec(code))) {
		const clause = m[1].trim();
		const ns = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
		if (ns) bump(ns[1]);
		const braces = clause.match(/\{([\s\S]*?)\}/);
		if (braces) {
			for (const part of braces[1].split(",")) {
				const p = part.trim();
				if (!p) continue;
				const as = p.match(/\bas\s+([A-Za-z_$][\w$]*)/);
				bump(as ? as[1] : p.replace(/^type\s+/, "").trim());
			}
		}
		const def = clause.match(/^([A-Za-z_$][\w$]*)\s*(?:,|$)/);
		if (def && !clause.startsWith("{") && !ns) bump(def[1]);
	}
	return [...counts.entries()].filter(([, c]) => c > 1).map(([n, c]) => ({ n, c }));
}

function scanGraphImports(metafile) {
	let total = 0;
	for (const input of Object.keys(metafile.inputs)) {
		if (!/\.tsx?$/.test(input)) continue;
		let code;
		try {
			code = readFileSync(join(root, input), "utf8");
		} catch {
			continue;
		}
		for (const { n, c } of duplicateImportBindings(code)) {
			total++;
			console.error(`  ${input}  '${n}' imported ${c}x (duplicate import binding)`);
		}
	}
	return total;
}

try {
	const result = await build({
		entryPoints: [entry],
		bundle: true,
		platform: "node",
		format: "esm",
		packages: "external", // follow local .ts only; don't pull npm deps
		write: false,
		metafile: true,
		logLevel: "silent",
		absWorkingDir: root,
	});
	let n = reportDups(result.warnings);
	n += scanGraphImports(result.metafile);
	if (n > 0) {
		console.error(`✗ MCP import graph has ${n} duplicate-declaration(s) (merge corruption). Deduplicate before committing/merging.`);
		process.exit(1);
	}
	console.log("✓ MCP import graph clean (no duplicate-declaration corruption).");
	process.exit(0);
} catch (err) {
	const n = reportDups(err.errors);
	if (n > 0) {
		console.error(`✗ MCP bundle FAILED: ${n} duplicate-declaration(s) (merge corruption). Deduplicate before committing/merging.`);
	} else {
		console.error(`✗ MCP bundle failed (non-corruption error): ${err.message}`);
		for (const m of err.errors || []) console.error(`  ${m.text}`);
	}
	process.exit(1);
}
