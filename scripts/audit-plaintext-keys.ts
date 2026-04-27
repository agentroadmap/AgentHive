#!/usr/bin/env node
/**
 * P472 AC#104 — Audit script: verify no plaintext private keys on disk.
 *
 * Exits 0 if clean, 1 if any PEM private key headers found outside allowed paths.
 *
 * Usage:
 *   node --import jiti/register scripts/audit-plaintext-keys.ts [--root <dir>]
 */

import { auditNoplaintextKeys } from "../src/core/security/key-storage.ts";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const rootIdx = args.indexOf("--root");
const root = rootIdx !== -1 && args[rootIdx + 1]
	? resolve(args[rootIdx + 1])
	: resolve(process.cwd());

// Paths where test fixtures or examples may legitimately contain key headers
const allowlist = [
	resolve(root, "tests"),
	resolve(root, "src/test"),
	resolve(root, "docs/examples"),
];

(async () => {
	console.log(`Scanning ${root} for plaintext private keys…`);
	const result = await auditNoplaintextKeys(root, allowlist);
	if (result.clean) {
		console.log("✓ No plaintext private keys found.");
		process.exit(0);
	} else {
		console.error(`✗ ${result.violations.length} violation(s) found:\n`);
		for (const v of result.violations) {
			console.error(`  ${v.file}:${v.line}  →  ${v.match}`);
		}
		process.exit(1);
	}
})();
