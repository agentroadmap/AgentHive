#!/usr/bin/env node
/**
 * P925: CLI wrapper for agent display alias rename.
 *
 * Calls PgAgentHandlers.renameAgent directly — the same DB write path
 * exposed by the agent_rename MCP tool.
 *
 * Usage:
 *   node --import jiti/register scripts/rename-agent.ts <identity-or-alias> <new-alias> [--force]
 *
 * Exit codes:
 *   0  success
 *   1  agent not found
 *   2  alias collision (active agent holds alias; use --force to override if stale)
 *   3  invalid alias format
 *   4  force required — prior owner has a fresh heartbeat
 */

import { closePool } from "../src/infra/postgres/pool.ts";
import { PgAgentHandlers } from "../src/apps/mcp-server/tools/agents/pg-handlers.ts";

function usage(): never {
	console.log(`
Usage: rename-agent.ts <identity-or-alias> <new-alias> [--force] [--operator <id>]

Arguments:
  identity-or-alias  Agent's agent_identity or current display_alias
  new-alias          New display_alias (must match ^[A-Z][A-Za-z0-9-]{2,63}$)

Options:
  --force            Override alias collision from an inactive/stale-heartbeat (>90s) prior owner
  --operator <id>    Operator identity recorded in the audit trail (defaults to "operator")

Exit codes:
  0  success
  1  agent not found
  2  alias collision (active agent with fresh heartbeat)
  3  invalid alias format
  4  force required — prior owner is active but stale; re-run with --force
`);
	process.exit(1);
}

function parseArgs(): { identity: string; alias: string; force: boolean; operator?: string } {
	const argv = process.argv.slice(2);
	const positional = argv.filter((a) => !a.startsWith("--"));
	const force = argv.includes("--force");
	const opIdx = argv.indexOf("--operator");
	const operator = opIdx !== -1 ? argv[opIdx + 1] : undefined;

	if (positional.length < 2) usage();

	return { identity: positional[0]!, alias: positional[1]!, force, operator };
}

async function main(): Promise<void> {
	const args = parseArgs();
	const handlers = new PgAgentHandlers();
	const result = await handlers.renameAgent({
		identity: args.identity,
		alias: args.alias,
		force: args.force,
		operator: args.operator,
	});

	const text: string =
		(result.content[0] as { type: string; text: string } | undefined)?.text ?? "";

	let parsed: Record<string, unknown> = {};
	try {
		parsed = JSON.parse(text) as Record<string, unknown>;
	} catch {
		console.error("Unexpected response:", text);
		process.exitCode = 1;
		return;
	}

	if (result.isError || parsed.error) {
		const code = String(parsed.error ?? "error");
		const msg = String(parsed.message ?? text);
		console.error(`Error [${code}]: ${msg}`);

		switch (code) {
			case "agent_not_found":
				process.exitCode = 1;
				break;
			case "alias_in_use":
				// Distinguish between "needs --force" and "force can't help"
				process.exitCode = msg.includes("fresh heartbeat") ? 2 : 4;
				break;
			case "invalid_alias_format":
				process.exitCode = 3;
				break;
			default:
				process.exitCode = 1;
		}
		return;
	}

	const prior = parsed.prior_alias ? `"${parsed.prior_alias}"` : "(none)";
	console.log(`Renamed: ${parsed.identity}`);
	console.log(`  ${prior}  →  "${parsed.new_alias}"`);
	if (parsed.note) console.log(`  note: ${parsed.note}`);
}

main()
	.catch((err) => {
		console.error(err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
	})
	.finally(async () => {
		await closePool().catch(() => {});
	});
