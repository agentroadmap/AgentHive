/**
 * P3313 AC-5: CLI for the adaptive-matcher operator override surface.
 *
 * Usage:
 *   node --import jiti/register scripts/route-match-override.ts <cmd> [args]
 *
 *   pin   <task_class> <route_id> <created_by> [reason]   force a route for a class
 *   ban   <task_class> <route_id> <created_by> [reason]   exclude a route for a class
 *   clear <task_class> <route_id> <cleared_by>            clear an active override
 *   list  [task_class]                                     active overrides
 *   decisions [limit]                                      recent match decisions panel
 *   reliability [model|agency|route]                       per-(scope,task_class) reliability panel
 *
 * created_by / cleared_by are REQUIRED so every override is audited.
 */

import {
	setOverride,
	clearOverride,
	listActiveOverrides,
	recentMatchDecisions,
	reliabilitySummary,
	type OverrideMode,
} from "../src/infra/agency/route-match-override.ts";

function usage(): never {
	console.error(
		`P3313 route-match-override\n` +
			`  pin   <task_class> <route_id> <created_by> [reason]\n` +
			`  ban   <task_class> <route_id> <created_by> [reason]\n` +
			`  clear <task_class> <route_id> <cleared_by>\n` +
			`  list  [task_class]\n` +
			`  decisions [limit]\n` +
			`  reliability [model|agency|route]`,
	);
	process.exit(2);
}

async function main() {
	const [cmd, ...rest] = process.argv.slice(2);
	switch (cmd) {
		case "pin":
		case "ban": {
			const [taskClass, routeIdRaw, createdBy, ...reasonParts] = rest;
			if (!taskClass || !routeIdRaw || !createdBy) usage();
			const row = await setOverride({
				taskClass,
				routeId: Number(routeIdRaw),
				mode: cmd as OverrideMode,
				createdBy,
				reason: reasonParts.join(" "),
			});
			console.log(JSON.stringify(row, null, 2));
			break;
		}
		case "clear": {
			const [taskClass, routeIdRaw, clearedBy] = rest;
			if (!taskClass || !routeIdRaw || !clearedBy) usage();
			const n = await clearOverride(taskClass, Number(routeIdRaw), clearedBy);
			console.log(JSON.stringify({ cleared: n }, null, 2));
			break;
		}
		case "list": {
			console.log(JSON.stringify(await listActiveOverrides(rest[0]), null, 2));
			break;
		}
		case "decisions": {
			const limit = rest[0] ? Number(rest[0]) : 50;
			console.log(JSON.stringify(await recentMatchDecisions(limit), null, 2));
			break;
		}
		case "reliability": {
			const scope = (rest[0] ?? "model") as "model" | "agency" | "route";
			console.log(JSON.stringify(await reliabilitySummary(scope), null, 2));
			break;
		}
		default:
			usage();
	}
	process.exit(0);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
