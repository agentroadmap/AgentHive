/**
 * P228: Cubic Runtime Abstraction — Auth Modes
 *
 * The cubic does NOT create or manage credentials. Two modes:
 *  - host_inherit: agent CLI runs under the host's native auth (HOME set to user dir)
 *  - key_inject:  credentials injected from a vault at runtime via env vars
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type AuthMode = "host_inherit" | "key_inject";

export interface HostInheritOptions {
  /** Home directory of the authenticated user (e.g. /home/andy) */
  homeDir: string;
  /** Additional PATH entries to prepend (e.g. where the CLI is installed) */
  extraPathDirs?: string[];
}

export interface KeyInjectOptions {
  /** Home directory for config file paths */
  homeDir: string;
  /** Credential env vars to inject: { ANTHROPIC_API_KEY: "sk-...", ... } */
  apiKeyVault: Record<string, string>;
}

export interface AuthModeOptions {
  mode: AuthMode;
  hostInherit?: HostInheritOptions;
  keyInject?: KeyInjectOptions;
}

// ─── Auth env builders ────────────────────────────────────────────────────────

/**
 * Build env vars for host_inherit mode.
 *
 * Sets HOME to the authenticated user directory so the CLI finds its auth
 * files automatically (~/.claude/auth, ~/.codex/config.json, etc.).
 * PATH is inherited from the process unless extraPathDirs are specified.
 */
export function buildHostInheritEnv(opts: HostInheritOptions): Record<string, string> {
  const env: Record<string, string> = {
    HOME: opts.homeDir,
  };

  if (opts.extraPathDirs && opts.extraPathDirs.length > 0) {
    const existingPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
    env.PATH = [...opts.extraPathDirs, existingPath].join(":");
  }

  return env;
}

/**
 * Build env vars for key_inject mode.
 *
 * Injects credentials directly from a vault into the subprocess environment.
 * Auth files are not consulted; the CLI reads injected env vars instead.
 */
export function buildKeyInjectEnv(opts: KeyInjectOptions): Record<string, string> {
  return {
    HOME: opts.homeDir,
    ...opts.apiKeyVault,
  };
}

/**
 * Resolve auth env vars from AuthModeOptions.
 */
export function resolveAuthEnv(opts: AuthModeOptions): Record<string, string> {
  if (opts.mode === "key_inject" && opts.keyInject) {
    return buildKeyInjectEnv(opts.keyInject);
  }
  if (opts.mode === "host_inherit" && opts.hostInherit) {
    return buildHostInheritEnv(opts.hostInherit);
  }
  // Fallback: use process HOME (minimal isolation)
  return { HOME: process.env.HOME ?? "/var/lib/agenthive" };
}

// ─── Cubic metadata defaults ──────────────────────────────────────────────────

/** Default cubic metadata fields for P228. */
export interface CubicRuntimeMetadata {
  agent_cli: string;
  host: string;
  auth_mode: AuthMode;
  home_dir?: string;
  model_override?: string;
}

export const CUBIC_RUNTIME_DEFAULTS: CubicRuntimeMetadata = {
  agent_cli: "claude",
  host: "localhost",
  auth_mode: "host_inherit",
};

/**
 * Merge partial cubic runtime metadata with defaults.
 */
export function resolveCubicRuntimeMetadata(
  partial: Partial<CubicRuntimeMetadata>,
): CubicRuntimeMetadata {
  return { ...CUBIC_RUNTIME_DEFAULTS, ...partial };
}
