/**
 * P1445 (Layer 2/3, AC-3): gate the ad-hoc AGENTHIVE_DEFAULT_EXECUTOR_WORKTREE
 * env fallback.
 *
 * Historically four spawn/dispatch sites read AGENTHIVE_DEFAULT_EXECUTOR_WORKTREE
 * directly to pick a worktree when the orchestrator didn't hand one down. That
 * env fallback is precisely the "agents self-select a worktree from environment,
 * racing on allocation" hazard P1445 exists to remove: two dispatches reading the
 * same env value land in the SAME shared checkout and collide.
 *
 * Post-P1445 the orchestrator allocates a worktree atomically
 * (claimWorktreeForDispatch, AC-2) and passes it as worktree_hint (AC-3). The
 * env fallback is therefore demoted to an OPT-IN escape hatch: it is OFF by
 * default and only honoured when AGENTHIVE_ALLOW_ENV_WORKTREE_FALLBACK=1 is set
 * explicitly (single-agent / local-dev convenience). In the default multi-agent
 * configuration the silent fallback is gone — callers must rely on the
 * orchestrator-assigned hint, and the AC-1 repo-root guard backstops any path
 * that still resolves to the shared root.
 */

const ALLOW_ENV_FALLBACK_FLAG = "AGENTHIVE_ALLOW_ENV_WORKTREE_FALLBACK";

/**
 * Resolve the env-based executor worktree fallback, honouring the gate.
 *
 * Returns the AGENTHIVE_DEFAULT_EXECUTOR_WORKTREE value ONLY when the opt-in
 * flag is set; otherwise returns undefined so the caller falls through to its
 * own (orchestrator-assigned) value or a safe terminal default. Never returns
 * the repo root.
 *
 * @param env  process environment (injectable for tests)
 */
export function resolveExecutorWorktreeFallback(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (env[ALLOW_ENV_FALLBACK_FLAG] !== "1") {
		// Gate closed: the orchestrator owns worktree allocation (P1445 AC-2/AC-3).
		return undefined;
	}
	const raw = env.AGENTHIVE_DEFAULT_EXECUTOR_WORKTREE?.trim();
	return raw && raw.length > 0 ? raw : undefined;
}

/** True when the opt-in env fallback is enabled (single-agent / dev escape hatch). */
export function isEnvWorktreeFallbackEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env[ALLOW_ENV_FALLBACK_FLAG] === "1";
}
