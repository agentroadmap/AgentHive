/**
 * P1445 (Layer 1, AC-1): refuse to spawn a worker in the shared repo root.
 *
 * A git BRANCH is a shared label but a WORKING DIRECTORY is a single mutable
 * cursor: `git checkout`/`reset` in a shared dir moves another agent's HEAD and
 * swaps their files mid-edit (the 2026-05-30 "file vanished" incident). The only
 * structural fix is that EVERY dispatch-spawned worker runs in its own
 * `git worktree` checkout, never the shared root (`/data/code/AgentHive`).
 *
 * This guard is the mechanical enforcement of that rule. It is intentionally a
 * pure, side-effect-free function so it is trivially unit-testable and so the
 * wiring site in agent-spawner.ts is a single call that an LLM cannot "forget".
 */

import { resolve } from "node:path";

/** Thrown when a spawn would run in the shared repo root instead of a worktree. */
export class RepoRootSpawnRefused extends Error {
	constructor(
		readonly cwd: string,
		readonly repoRoot: string,
	) {
		super(
			`[P1445] Refusing to spawn worker in the shared repo root "${repoRoot}". ` +
				`Every dispatch-spawned agent MUST run in a dedicated git worktree ` +
				`(see CONVENTIONS.md §7a). Resolved spawn cwd was "${cwd}". ` +
				`Allocate a worktree via claimWorktreeForDispatch() and pass it as the ` +
				`worktree_hint — do not fall back to the repo root.`,
		);
		this.name = "RepoRootSpawnRefused";
	}
}

/**
 * Normalise a filesystem path for identity comparison: resolve `.`/`..`/symlink-
 * free relative segments and strip a single trailing slash. We deliberately do
 * NOT call `fs.realpath` here so the function stays pure (no I/O) and unit
 * testable without a real filesystem; callers that need symlink canonicalisation
 * should resolve before calling.
 */
function canonical(p: string): string {
	const r = resolve(p);
	return r.length > 1 && r.endsWith("/") ? r.slice(0, -1) : r;
}

/**
 * Assert that `cwd` is NOT the shared repo root.
 *
 * Refuses (throws RepoRootSpawnRefused) when the resolved spawn cwd is exactly
 * the resolved repo root. A worktree that merely lives *under* the repo root
 * (e.g. `.claude/worktrees/<id>`) is allowed — only the root itself is forbidden,
 * because that is the single shared mutable checkout every agent collides on.
 *
 * @param cwd       the resolved working directory the worker would spawn in
 * @param repoRoot  the shared repo root (operator-only checkout)
 */
export function assertNotRepoRoot(cwd: string, repoRoot: string): void {
	if (canonical(cwd) === canonical(repoRoot)) {
		throw new RepoRootSpawnRefused(cwd, repoRoot);
	}
}

/**
 * Boolean form for callers that want to branch rather than throw.
 * Returns true when the cwd is safe (i.e. NOT the shared repo root).
 */
export function isWorktreeCwd(cwd: string, repoRoot: string): boolean {
	return canonical(cwd) !== canonical(repoRoot);
}
