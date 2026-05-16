/**
 * P675 — origin tracing.
 *
 * Given a missing column/relation name, walk git history to find the
 * commit that dropped or renamed it, then extract the originating proposal
 * id (P\d+) from the commit subject if present. Falls back to scanning
 * migration filenames (`scripts/migrations/NNN-pXXX-*.sql`) for a P-id.
 */

import { execFileSync } from "node:child_process";

export interface OriginGuess {
	commitSha: string | null;
	proposalDisplayId: string | null;   // e.g. "P634"
	proposalNumericId: number | null;   // 634
	source: "git_pickaxe" | "git_diff" | "proposal_event" | "none";
}

export interface OriginTracerDeps {
	repoRoot: string;
	exec?: (cmd: string, args: string[], cwd: string) => string;
}

const PROP_RE = /\bP(\d+)\b/;

export function traceOrigin(
	missingName: string,
	deps: OriginTracerDeps,
): OriginGuess {
	const exec = deps.exec ?? defaultExec;

	// 1. Pickaxe: any commit that added or removed lines containing the name.
	//    `--diff-filter=D` would only show deletions, but renames sometimes
	//    register as add+del — better to pickaxe broadly and then narrow.
	let pickaxeOutput: string;
	try {
		pickaxeOutput = exec(
			"git",
			[
				"log",
				"origin/main",
				"-S",
				missingName,
				"--pickaxe-regex",
				"--all",
				"-n", "50",
				"--pretty=format:%H\t%s",
			],
			deps.repoRoot,
		);
	} catch {
		pickaxeOutput = "";
	}

	const lines = pickaxeOutput.split(/\r?\n/).filter(Boolean);
	for (const line of lines) {
		const tab = line.indexOf("\t");
		if (tab < 0) continue;
		const sha = line.slice(0, tab);
		const subject = line.slice(tab + 1);
		const m = PROP_RE.exec(subject);
		if (m) {
			return {
				commitSha: sha,
				proposalDisplayId: `P${m[1]}`,
				proposalNumericId: Number(m[1]),
				source: "git_pickaxe",
			};
		}
	}

	// 2. Diff-oriented history pass over SQL-bearing paths to catch explicit
	//    DROP/RENAME statements even when the pickaxe subject lacks a proposal id.
	let diffOutput = "";
	try {
		diffOutput = exec(
			"git",
			[
				"log",
				"origin/main",
				"-G",
				`(DROP COLUMN|RENAME COLUMN).*${escapeRegex(missingName)}`,
				"-n",
				"50",
				"--pretty=format:%H\t%s",
				"--",
				"scripts/migrations",
				"database",
			],
			deps.repoRoot,
		);
	} catch {
		diffOutput = "";
	}

	for (const line of diffOutput.split(/\r?\n/).filter(Boolean)) {
		const tab = line.indexOf("\t");
		if (tab < 0) continue;
		const sha = line.slice(0, tab);
		const subject = line.slice(tab + 1);
		const m = PROP_RE.exec(subject);
		if (m) {
			return {
				commitSha: sha,
				proposalDisplayId: `P${m[1]}`,
				proposalNumericId: Number(m[1]),
				source: "git_diff",
			};
		}
	}

	// 3. We have a sha but no P-id, return what we have.
	if (lines.length > 0) {
		const tab = lines[0].indexOf("\t");
		const sha = tab >= 0 ? lines[0].slice(0, tab) : lines[0];
		return {
			commitSha: sha,
			proposalDisplayId: null,
			proposalNumericId: null,
			source: "git_pickaxe",
		};
	}

	return {
		commitSha: null,
		proposalDisplayId: null,
		proposalNumericId: null,
		source: "none",
	};
}

function defaultExec(cmd: string, args: string[], cwd: string): string {
	return execFileSync(cmd, args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
