/**
 * P1114 AC-7 — clearance audit.
 *
 * Enumerates every MCP tool reachable through the shared, DB-free registry
 * introspector (src/apps/mcp-server/tool-registry-introspect.ts) and prints
 * each tool's declared P1114 clearance: tool name, min_tier, scope — or
 * `UNDECLARED` when the tool carries no clearance field.
 *
 * Run:  node --import jiti/register scripts/clearance-audit.ts
 *
 * Exit code is always 0 (this is a report, not a gate). Use
 * scripts/clearance-drift.ts for the fail-on-undeclared cron guard.
 */

import {
	collectToolDescriptors,
	INLINE_BOOTSTRAP_FAMILIES,
} from "../src/apps/mcp-server/tool-registry-introspect.ts";

function main(): void {
	const descriptors = collectToolDescriptors(process.cwd());

	const declared = descriptors.filter((d) => d.clearance !== null);
	const undeclared = descriptors.filter((d) => d.clearance === null);

	console.log("P1114 — MCP tool clearance audit");
	console.log("=".repeat(72));
	console.log(
		`Tools enumerated: ${descriptors.length}  (declared: ${declared.length}, undeclared: ${undeclared.length})`,
	);
	console.log("");

	const nameWidth = Math.max(
		4,
		...descriptors.map((d) => d.name.length),
	);
	const header = `${"TOOL".padEnd(nameWidth)}  ${"MIN_TIER".padEnd(14)}  SCOPE`;
	console.log(header);
	console.log("-".repeat(header.length));

	for (const d of descriptors) {
		if (d.clearance) {
			console.log(
				`${d.name.padEnd(nameWidth)}  ${d.clearance.min_tier.padEnd(14)}  ${d.clearance.scope}`,
			);
		} else {
			console.log(`${d.name.padEnd(nameWidth)}  ${"UNDECLARED".padEnd(14)}  —`);
		}
	}

	console.log("");
	console.log("Coverage boundary — families registered inline in createMcpServer");
	console.log("(not reachable without booting the DB-backed server):");
	for (const fam of INLINE_BOOTSTRAP_FAMILIES) {
		console.log(`  · ${fam}`);
	}
}

main();
// Imported tool modules may register timers/listeners that keep the event loop
// alive; this is a one-shot report, so exit deterministically.
process.exit(0);
