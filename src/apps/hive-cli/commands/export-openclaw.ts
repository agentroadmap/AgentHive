/**
 * P1357 (P1355-B) AC-5: CLI command — `roadmap agent export-openclaw`.
 *
 * Reads an agent_registry row (or all active agents with --all-active), calls
 * the pure generator, and writes SOUL.md / IDENTITY.md / AGENTS.md to
 * ~/.openclaw/agency-agents/<display_alias>/ (created if missing).
 *
 * Operator-only: rejects principal_kind === 'agent'. The export reveals the full
 * persona + capability surface of an agency, so an agent cannot self-export.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { query } from "../../../infra/postgres/pool.ts";
import {
	generateOpenClawWorkspace,
	loadAgentProfile,
} from "../../../core/agency/openclaw-export-generator.ts";

export interface ExportOpenClawOptions {
	/** Target a single agent by identity. Mutually exclusive with all_active. */
	agent_identity?: string;
	/** Export every active agent that has a display_alias. */
	all_active?: boolean;
	/** Caller principal kind — must NOT be 'agent'. */
	principal_kind?: string;
	/** Override output root (defaults to ~/.openclaw/agency-agents). For tests. */
	output_root?: string;
}

export interface ExportOpenClawResult {
	success: boolean;
	message: string;
	exported?: Array<{ agent_identity: string; path: string }>;
}

function workspaceRoot(opts: ExportOpenClawOptions): string {
	return (
		opts.output_root ?? path.join(os.homedir(), ".openclaw", "agency-agents")
	);
}

/** Write the three files for one already-loaded profile; returns the dir path. */
function writeWorkspace(
	root: string,
	displayAlias: string,
	files: { soul_md: string; identity_md: string; agents_md: string },
): string {
	const dir = path.join(root, displayAlias);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "SOUL.md"), files.soul_md, "utf8");
	fs.writeFileSync(path.join(dir, "IDENTITY.md"), files.identity_md, "utf8");
	fs.writeFileSync(path.join(dir, "AGENTS.md"), files.agents_md, "utf8");
	return dir;
}

export async function exportOpenClaw(
	opts: ExportOpenClawOptions,
): Promise<ExportOpenClawResult> {
	// Operator-only: an agent must not export persona/capability surfaces.
	if (opts.principal_kind === "agent") {
		return {
			success: false,
			message:
				"Unauthorized. export-openclaw is operator-only (principal_kind 'agent' rejected).",
		};
	}
	if (!opts.agent_identity && !opts.all_active) {
		return {
			success: false,
			message: "Specify --agent <identity> or --all-active.",
		};
	}

	const root = workspaceRoot(opts);

	// Resolve the set of identities to export.
	let identities: string[];
	if (opts.all_active) {
		const rows = await query<{ agent_identity: string }>(
			`SELECT agent_identity
			   FROM roadmap_workforce.agent_registry
			  WHERE status = 'active' AND display_alias IS NOT NULL
			  ORDER BY display_alias`,
		);
		identities = rows.rows.map((r) => r.agent_identity);
		if (identities.length === 0) {
			return { success: false, message: "No active agents with a display_alias." };
		}
	} else {
		identities = [opts.agent_identity as string];
	}

	const exported: Array<{ agent_identity: string; path: string }> = [];
	const missing: string[] = [];
	for (const identity of identities) {
		const profile = await loadAgentProfile(identity);
		if (!profile) {
			missing.push(identity);
			continue;
		}
		const files = generateOpenClawWorkspace(profile);
		const dir = writeWorkspace(root, profile.display_alias, files);
		exported.push({ agent_identity: identity, path: dir });
	}

	if (exported.length === 0) {
		return {
			success: false,
			message: `No agents exported. Not found / no display_alias: ${missing.join(", ")}`,
		};
	}

	const head =
		exported.length === 1
			? `Exported SOUL.md, IDENTITY.md, AGENTS.md to ${exported[0].path}; run \`openclaw agencies add ${exported[0].path}\` to register.`
			: `Exported ${exported.length} workspaces under ${root}; run \`openclaw agencies add <path>\` for each.`;
	const tail = missing.length > 0 ? ` (skipped, not found: ${missing.join(", ")})` : "";
	return { success: true, message: head + tail, exported };
}
