#!/usr/bin/env node
/**
 * Operator drain/stop helper for runaway AgentHive workers.
 *
 * Default mode is a dry run. Pass --apply to mark matching dispatches,
 * transition-queue rows, and running agent_runs as cancelled/failed so
 * pollers stop reissuing the same work.
 */

import { spawnSync } from "node:child_process";
import { closePool, query } from "../src/infra/postgres/pool.ts";

type Args = {
	apply: boolean;
	all: boolean;
	deleteAgencies: boolean;
	stopServices: boolean;
	proposals: string[];
	agencies: string[];
};

type Row = Record<string, unknown>;

function parseArgs(argv: string[]): Args {
	const args: Args = {
		apply: false,
		all: false,
		deleteAgencies: false,
		stopServices: false,
		proposals: [],
		agencies: [],
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--apply") args.apply = true;
		else if (arg === "--all") args.all = true;
		else if (arg === "--delete-agencies") args.deleteAgencies = true;
		else if (arg === "--stop-services") args.stopServices = true;
		else if (arg === "--proposal" || arg === "-p")
			args.proposals.push(argv[++i] ?? "");
		else if (arg === "--agency" || arg === "-a")
			args.agencies.push(argv[++i] ?? "");
		else if (arg === "--help" || arg === "-h") usage(0);
		else throw new Error(`Unknown argument: ${arg}`);
	}

	args.proposals = args.proposals.map((v) => v.trim()).filter(Boolean);
	args.agencies = args.agencies.map((v) => v.trim()).filter(Boolean);

	if (
		!args.all &&
		args.proposals.length === 0 &&
		args.agencies.length === 0 &&
		!args.deleteAgencies
	) {
		throw new Error(
			"Refusing broad stop without --all, --proposal, --agency, or --delete-agencies.",
		);
	}

	return args;
}

function usage(exitCode: number): never {
	console.log(`
Usage:
  node --import jiti/register scripts/agent-stop.ts --proposal P416
  node --import jiti/register scripts/agent-stop.ts --agency hermes-andy --apply
  node --import jiti/register scripts/agent-stop.ts --all --apply --stop-services
  node --import jiti/register scripts/agent-stop.ts --all --apply --delete-agencies

Options:
  --proposal, -p      Proposal display id (P416) or numeric DB id. Repeatable.
  --agency, -a        Agent/agency/worktree prefix to stop. Repeatable.
  --all               Match all currently active worker state.
  --apply             Mutate DB rows. Without this, prints a dry-run report.
  --delete-agencies   Deactivate agency rows and delete their capabilities.
  --stop-services     Also stop user systemd gate/orchestrator services.
`);
	process.exit(exitCode);
}

function printRows(title: string, rows: Row[]): void {
	console.log(`\n${title} (${rows.length})`);
	for (const row of rows) console.log(JSON.stringify(row));
}

async function resolveProposalIds(values: string[]): Promise<number[]> {
	if (!values.length) return [];
	const { rows } = await query<{ id: number }>(
		`SELECT id
		 FROM roadmap_proposal.proposal
		 WHERE display_id = ANY($1::text[])
		    OR id::text = ANY($1::text[])`,
		[values],
	);
	return rows.map((row) => Number(row.id)).filter(Number.isFinite);
}

function buildFilters(input: {
	all: boolean;
	proposalIds: number[];
	agencies: string[];
	agentColumn: string;
	startParam: number;
}): { sql: string; params: unknown[] } {
	if (input.all) return { sql: "", params: [] };

	const clauses: string[] = [];
	const params: unknown[] = [];
	let next = input.startParam;

	if (input.proposalIds.length > 0) {
		params.push(input.proposalIds);
		clauses.push(`proposal_id = ANY($${next++}::bigint[])`);
	}

	if (input.agencies.length > 0) {
		params.push(input.agencies.map((agency) => `${agency}%`));
		clauses.push(`${input.agentColumn} LIKE ANY($${next++}::text[])`);
	}

	return {
		sql: clauses.length ? ` AND (${clauses.join(" OR ")})` : " AND false",
		params,
	};
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const proposalIds = await resolveProposalIds(args.proposals);

	if (args.proposals.length > 0 && proposalIds.length === 0) {
		throw new Error(`No proposals matched: ${args.proposals.join(", ")}`);
	}

	const runFilter = buildFilters({
		all: args.all,
		proposalIds,
		agencies: args.agencies,
		agentColumn: "agent_identity",
		startParam: 1,
	});
	const dispatchFilter = buildFilters({
		all: args.all,
		proposalIds,
		agencies: args.agencies,
		agentColumn: "COALESCE(agent_identity, metadata->>'worktree_hint', '')",
		startParam: 1,
	});
	const agencies = await query(
		`SELECT ar.agent_identity, ar.agent_type, ar.status, ar.role, ar.preferred_model,
		        COALESCE(string_agg(ac.capability, ',' ORDER BY ac.capability), '') AS capabilities
		 FROM roadmap_workforce.agent_registry ar
		 LEFT JOIN roadmap_workforce.agent_capability ac ON ac.agent_id = ar.id
		 WHERE ar.agent_type = 'agency'
		 GROUP BY ar.agent_identity, ar.agent_type, ar.status, ar.role, ar.preferred_model
		 ORDER BY ar.agent_identity`,
	);
	printRows("Registered Agencies", agencies.rows as Row[]);

	const routes = await query(
		`SELECT model_name, route_provider, agent_provider, agent_cli, is_enabled, is_default,
		        CASE
		          WHEN api_key_primary IS NOT NULL THEN 'db:primary'
		          WHEN api_key_secondary IS NOT NULL THEN 'db:secondary'
		          WHEN api_key_env IS NOT NULL THEN 'env:' || api_key_env
		          WHEN api_key_fallback_env IS NOT NULL THEN 'env:' || api_key_fallback_env
		          ELSE 'none'
		        END AS auth_source,
		        spawn_toolsets, spawn_delegate
		 FROM roadmap.model_routes
		 ORDER BY agent_provider, priority, model_name`,
	);
	printRows("Model Routes", routes.rows as Row[]);

	const activeRuns = await query(
		`SELECT id, proposal_id, agent_identity, stage, model_used, status, started_at
		 FROM roadmap_workforce.agent_runs
		 WHERE status = 'running'${runFilter.sql}
		 ORDER BY started_at DESC
		 LIMIT 100`,
		runFilter.params,
	);
	printRows("Matching Running Agent Runs", activeRuns.rows as Row[]);

	const activeDispatches = await query(
		`SELECT id, proposal_id, agent_identity, dispatch_role, dispatch_status,
		        offer_status, assigned_at, metadata
		 FROM roadmap_workforce.squad_dispatch
		 WHERE (completed_at IS NULL OR dispatch_status IN ('assigned','active','blocked')
		        OR offer_status IN ('open','claimed','activated'))${dispatchFilter.sql}
		 ORDER BY assigned_at DESC
		 LIMIT 100`,
		dispatchFilter.params,
	);
	printRows("Matching Dispatches", activeDispatches.rows as Row[]);

	if (!args.apply) {
		console.log("\nDry run only. Re-run with --apply to cancel matching rows.");
		return;
	}

	const reason = "operator stop requested by scripts/agent-stop.ts";

	const cancelledRuns = await query(
		`UPDATE roadmap_workforce.agent_runs
		 SET status = 'cancelled',
		     completed_at = COALESCE(completed_at, now()),
		     error_detail = COALESCE(error_detail || E'\n', '') || $1
		 WHERE status = 'running'${
				buildFilters({
					all: args.all,
					proposalIds,
					agencies: args.agencies,
					agentColumn: "agent_identity",
					startParam: 2,
				}).sql
			}
		 RETURNING id`,
		[reason, ...runFilter.params],
	);

	const cancelledDispatches = await query(
		`UPDATE roadmap_workforce.squad_dispatch
		 SET dispatch_status = 'cancelled',
		     offer_status = CASE
		       WHEN offer_status IN ('open','claimed','activated') THEN 'failed'
		       ELSE offer_status
		     END,
		     completed_at = COALESCE(completed_at, now()),
		     metadata = COALESCE(metadata, '{}'::jsonb) ||
		       jsonb_build_object('stop_requested_at', to_jsonb(now()), 'stop_reason', $1)
		 WHERE (completed_at IS NULL OR dispatch_status IN ('assigned','active','blocked')
		        OR offer_status IN ('open','claimed','activated'))${
							buildFilters({
								all: args.all,
								proposalIds,
								agencies: args.agencies,
								agentColumn:
									"COALESCE(agent_identity, metadata->>'worktree_hint', '')",
								startParam: 2,
							}).sql
						}
		 RETURNING id`,
		[reason, ...dispatchFilter.params],
	);

	console.log(
		`\nCancelled rows: agent_runs=${cancelledRuns.rowCount ?? 0}, dispatches=${cancelledDispatches.rowCount ?? 0}`,
	);

	if (args.deleteAgencies) {
		const agencyIdentityFilter =
			args.all || args.agencies.length === 0
				? { sql: "", params: [] as unknown[] }
				: {
						sql: " AND agent_identity LIKE ANY($1::text[])",
						params: [args.agencies.map((agency) => `${agency}%`)],
					};
		const deletedCapabilities = await query(
			`DELETE FROM roadmap_workforce.agent_capability ac
			  USING roadmap_workforce.agent_registry ar
			  WHERE ac.agent_id = ar.id
			    AND ar.agent_type = 'agency'${agencyIdentityFilter.sql}`,
			agencyIdentityFilter.params,
		);
		const deactivatedAgencies = await query(
			`UPDATE roadmap_workforce.agent_registry
			    SET status = 'inactive',
			        updated_at = now()
			  WHERE agent_type = 'agency'${agencyIdentityFilter.sql}`,
			agencyIdentityFilter.params,
		);
		const deactivatedWorkers = await query(
			`UPDATE roadmap_workforce.agent_registry worker
			    SET status = 'inactive',
			        updated_at = now()
			   FROM roadmap_workforce.agent_registry agency
			  WHERE worker.agency_id = agency.id
			    AND agency.agent_type = 'agency'${agencyIdentityFilter.sql.replaceAll("agent_identity", "agency.agent_identity")}`,
			agencyIdentityFilter.params,
		);
		console.log(
			`Agency cleanup: capabilities_deleted=${deletedCapabilities.rowCount ?? 0}, agencies_deactivated=${deactivatedAgencies.rowCount ?? 0}, workers_deactivated=${deactivatedWorkers.rowCount ?? 0}`,
		);
	}

	if (args.stopServices) {
		for (const service of [
			"agenthive-orchestrator.service",
		]) {
			const result = spawnSync("systemctl", ["--user", "stop", service], {
				stdio: "inherit",
			});
			if (result.status !== 0) {
				console.error(
					`systemctl stop failed for ${service} (status ${result.status})`,
				);
			}
		}
	}
}

main()
	.catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	})
	.finally(async () => {
		await closePool().catch(() => {});
	});
