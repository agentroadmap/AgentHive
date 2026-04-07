#!/usr/bin/env node
import { FileSystem } from "../src/infra/file-system/operations.ts";
import { initPoolFromConfig, query } from "../src/infra/postgres/pool.ts";

type BoardRow = {
	display_id: string;
	title: string;
	status: string;
	type: string;
	maturity: Record<string, string> | null;
	queue_position: number | null;
	ac_total: number;
	ac_pass: number;
};

const MATURITY_ICONS: Record<string, string> = {
	New: "🌱",
	Active: "📐",
	Mature: "🧪",
	Obsolete: "🗑️",
};

function getMaturityIcon(
	maturity: Record<string, string> | null,
	status: string,
): string {
	if (!maturity || typeof maturity !== "object") {
		return "📋";
	}
	const label = maturity[status] ?? Object.values(maturity)[0];
	return label ? (MATURITY_ICONS[label] ?? "📋") : "📋";
}

async function main() {
	const fs = new FileSystem(process.cwd());
	const config = await fs.loadConfig();
	if (config?.database?.provider !== "Postgres" || !config.database) {
		throw new Error(
			"Roadmap board requires database.provider=Postgres in roadmap.yaml.",
		);
	}

	initPoolFromConfig(config.database);

	const { rows } = await query<BoardRow>(
		`SELECT
		   p.display_id,
		   p.title,
		   p.status,
		   p.type,
		   p.maturity,
		   q.queue_position,
		   COALESCE(ac.ac_total, 0)::int AS ac_total,
		   COALESCE(ac.ac_pass, 0)::int AS ac_pass
		 FROM roadmap.proposal p
		 LEFT JOIN roadmap.v_proposal_queue q ON q.id = p.id
		 LEFT JOIN (
		   SELECT
		     proposal_id,
		     COUNT(*)::int AS ac_total,
		     COUNT(*) FILTER (WHERE status = 'pass')::int AS ac_pass
		   FROM roadmap.proposal_acceptance_criteria
		   GROUP BY proposal_id
		 ) ac ON ac.proposal_id = p.id
		 ORDER BY
		   CASE WHEN q.queue_position IS NULL THEN 1 ELSE 0 END,
		   q.queue_position NULLS LAST,
		   p.id ASC`,
	);

	const configuredStatuses = config.statuses ?? [];
	const statuses = Array.from(
		new Set([...configuredStatuses, ...rows.map((row) => row.status)]),
	).filter(Boolean);
	const groups = new Map<string, BoardRow[]>(
		statuses.map((status) => [status, []]),
	);
	for (const row of rows) {
		if (!groups.has(row.status)) {
			groups.set(row.status, []);
		}
		groups.get(row.status)?.push(row);
	}

	const projectName = config.projectName || "AgentHive";
	console.log(`\n${projectName} roadmap board\n`);

	for (const status of statuses) {
		const items = groups.get(status) ?? [];
		console.log(`${status} (${items.length})`);
		console.log("─".repeat(72));

		if (items.length === 0) {
			console.log("  (none)");
			console.log("");
			continue;
		}

		for (const row of items) {
			const maturityIcon = getMaturityIcon(row.maturity, row.status);
			const queueText = row.queue_position
				? ` queue:${row.queue_position}`
				: "";
			const acText =
				row.ac_total > 0 ? ` AC:${row.ac_pass}/${row.ac_total}` : "";
			console.log(
				`  ${maturityIcon} ${row.display_id} [${row.type}]${queueText}${acText} — ${row.title}`,
			);
		}
		console.log("");
	}

	const total = rows.length;
	const totalAC = rows.reduce((sum, row) => sum + Number(row.ac_total || 0), 0);
	const totalPassAC = rows.reduce(
		(sum, row) => sum + Number(row.ac_pass || 0),
		0,
	);
	const completion =
		totalAC > 0 ? Math.round((totalPassAC / totalAC) * 100) : 0;
	console.log("─".repeat(72));
	console.log(
		`Total proposals: ${total} | Acceptance criteria passed: ${totalPassAC}/${totalAC} (${completion}%)`,
	);
	console.log("");
}

main().catch((error) => {
	console.error(
		"Failed to generate board:",
		error instanceof Error ? error.message : String(error),
	);
	process.exit(1);
});
