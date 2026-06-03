import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

interface RequiredPattern {
	file: string;
	description: string;
	pattern: RegExp;
}

const repoRoot = resolve(import.meta.dirname, "../..");

const requiredPatterns: RequiredPattern[] = [
	{
		file: "src/core/pipeline/post-work-offer.ts",
		description: "postWorkOffer refuses gate_scanner_paused proposals before inserting dispatch",
		pattern:
			/SELECT\s+project_id,\s+status,\s+maturity,\s+gate_scanner_paused[\s\S]*FROM\s+roadmap_proposal\.proposal[\s\S]*ctx\.gate_scanner_paused[\s\S]*dispatch refused/,
	},
	{
		file: "src/core/orchestration/legacy-dispatch.ts",
		description: "claimImplicitGateReady reads through v_dispatchable_proposal",
		pattern:
			/function\s+claimImplicitGateReady[\s\S]*FROM\s+roadmap_proposal\.v_dispatchable_proposal\s+p/,
	},
	{
		file: "src/core/orchestration/legacy-dispatch.ts",
		description: "claimEnhancementRevisionReady reads through v_dispatchable_proposal",
		pattern:
			/function\s+claimEnhancementRevisionReady[\s\S]*FROM\s+roadmap_proposal\.v_dispatchable_proposal\s+p/,
	},
	{
		file: "src/core/orchestration/orchestrator.ts",
		description: "state poll fallback joins v_dispatchable_proposal",
		pattern:
			/_statePollTick[\s\S]*JOIN\s+roadmap_proposal\.v_dispatchable_proposal\s+p\s+ON\s+p\.id\s+=\s+w\.proposal_id/,
	},
	{
		file: "src/core/orchestration/orchestrator.ts",
		description: "stall escalation reads through v_dispatchable_proposal",
		pattern:
			/checkStalls[\s\S]*FROM\s+roadmap_proposal\.v_dispatchable_proposal\s+p/,
	},
	{
		file: "src/core/proposal/gate-scanner-v2.ts",
		description: "gate scanner reads the mature queue view",
		pattern: /FROM\s+roadmap_proposal\.v_mature_queue\s+mq/,
	},
	{
		file: "src/apps/hive-cli/domains/dispatch/handlers/queue.ts",
		description: "dispatch queue command filters gate_scanner_paused proposals",
		pattern:
			/FROM\s+roadmap_proposal\.proposal\s+p[\s\S]*p\.gate_scanner_paused\s+=\s+false/,
	},
	{
		file: "scripts/migrations/175-p1411-dispatchable-proposal-view.sql",
		description: "v_dispatchable_proposal defines the canonical pause predicate",
		pattern:
			/CREATE\s+OR\s+REPLACE\s+VIEW\s+roadmap_proposal\.v_dispatchable_proposal[\s\S]*WHERE\s+gate_scanner_paused\s+=\s+false/,
	},
	{
		file: "scripts/migrations/175-p1411-dispatchable-proposal-view.sql",
		description: "v_mature_queue is rebuilt from v_dispatchable_proposal",
		pattern:
			/CREATE\s+OR\s+REPLACE\s+VIEW\s+roadmap_proposal\.v_mature_queue[\s\S]*FROM\s+roadmap_proposal\.v_dispatchable_proposal\s+p/,
	},
];

export function auditDispatchProposalSelectors(): string[] {
	const failures: string[] = [];
	for (const requirement of requiredPatterns) {
		const absolutePath = resolve(repoRoot, requirement.file);
		const source = readFileSync(absolutePath, "utf8");
		if (!requirement.pattern.test(source)) {
			failures.push(
				`${relative(repoRoot, absolutePath)}: ${requirement.description}`,
			);
		}
	}
	return failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const failures = auditDispatchProposalSelectors();
	if (failures.length > 0) {
		console.error("Dispatch proposal selector audit failed:");
		for (const failure of failures) {
			console.error(`- ${failure}`);
		}
		process.exit(1);
	}
	console.log("Dispatch proposal selector audit passed.");
}
