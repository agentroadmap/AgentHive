/**
 * P925: Operator rename CLI — rename a display alias for an agent.
 *
 * Usage:
 *   node --import jiti/register scripts/rename-agent.ts <identity-or-alias> <new-alias> [--force] [--operator=<name>]
 *
 * Alias format: ^[A-Z][A-Za-z0-9-]{2,63}$
 *   - Must start with an uppercase letter
 *   - Followed by 2–63 alphanumeric or dash characters
 *   - Total length: 3–64 characters
 *   - Examples: Claude-Bot, Codex-Mac-Architect, Gilbert-Reviewer
 *   - No spaces, slashes, underscores, or leading lowercase
 *
 * Exit codes:
 *   0  success
 *   1  agent not found
 *   2  alias already in use (pass --force to reclaim from stale holder)
 *   3  invalid alias format
 *   4  force required (alias holder is alive and recent)
 */

import { parseArgs } from "node:util";
import { closePool } from "../src/infra/postgres/pool.ts";
import { PgAgentHandlers } from "../src/apps/mcp-server/tools/agents/pg-handlers.ts";

const ALIAS_FORMAT_HELP = `
Alias format rules:
  - Must start with an uppercase letter (A–Z)
  - Followed by 2–63 alphanumeric or dash characters
  - Total length: 3–64 characters
  - Pattern: ^[A-Z][A-Za-z0-9-]{2,63}$
  - Valid examples:   Claude-Bot, Codex-Mac-Architect, Gilbert-Reviewer
  - Invalid examples: claude-bot (no leading lowercase), Claude Bot (no spaces),
                      Claude_Bot (no underscores), AB (too short)
`;

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2),
		options: {
			force: { type: "boolean", default: false },
			operator: { type: "string", default: "operator" },
			help: { type: "boolean", default: false },
		},
		allowPositionals: true,
	});

	if (values.help || positionals.length === 0) {
		console.log(`Usage: rename-agent <identity-or-alias> <new-alias> [--force] [--operator=<name>]`);
		console.log(ALIAS_FORMAT_HELP);
		process.exit(0);
	}

	if (positionals.length < 2) {
		console.error("Error: both <identity-or-alias> and <new-alias> are required.");
		console.log(`Usage: rename-agent <identity-or-alias> <new-alias> [--force] [--operator=<name>]`);
		process.exit(3);
	}

	const [identity, alias] = positionals;
	const force = values.force as boolean;
	const operator = values.operator as string;

	const handlers = new PgAgentHandlers();
	const result = await handlers.renameAgent({ identity, alias, force, operator });

	const text = result.content[0]?.type === "text" ? result.content[0].text : "";

	let parsed: Record<string, unknown> | null = null;
	try {
		parsed = JSON.parse(text);
	} catch {
		// Non-JSON response from error helper
		console.error(text);
		process.exit(1);
	}

	if (result.isError || parsed?.error) {
		const errorCode = parsed?.error as string | undefined;
		console.error(parsed?.message ?? text);

		if (errorCode === "agent_not_found") {
			process.exit(1);
		}
		if (errorCode === "alias_in_use") {
			console.error(`\nHint: pass --force to reclaim the alias from a stale/inactive holder.`);
			process.exit(2);
		}
		if (errorCode === "invalid_alias_format") {
			console.error(ALIAS_FORMAT_HELP);
			process.exit(3);
		}
		if (errorCode === "alias_owner_still_alive") {
			console.error(`\nThe current alias holder is alive and recent (heartbeat <90s). Cannot force-reclaim.`);
			process.exit(4);
		}
		// Generic error
		process.exit(1);
	}

	const from = parsed?.from ?? "(none)";
	const to = parsed?.to;
	const agentIdentity = parsed?.agent_identity;
	console.log(`${agentIdentity}: ${from} → ${to}`);
}

main().catch((err) => {
	console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
	process.exit(1);
}).finally(() => closePool());
