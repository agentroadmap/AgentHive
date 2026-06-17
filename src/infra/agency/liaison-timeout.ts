import * as runtimeConfig from "../../shared/runtime/config.ts";
import { FlagKeys } from "../../shared/runtime/config-keys.ts";

const PROVIDER_DEFAULT_LIAISON_LLM_TIMEOUT_MS: Record<string, number> = {
	codex: 120_000,
};

export async function resolveLiaisonLlmTimeoutMs(provider: string): Promise<number> {
	// Per-provider env override (AGENTHIVE_LIAISON_LLM_TIMEOUT_MS_CODEX, etc.) — highest priority
	const providerKey = provider.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
	const providerEnv = process.env[`AGENTHIVE_LIAISON_LLM_TIMEOUT_MS_${providerKey}`];
	if (providerEnv != null && providerEnv.trim() !== "") {
		const parsed = Number(providerEnv);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}

	// Global flag (reads LIAISON_LLM_TIMEOUT_MS env, then DB value, then defaultValue=30000).
	// Per-provider hard-coded defaults only apply when the flag returns its unmodified default —
	// an explicit env or DB value overrides even per-provider defaults.
	try {
		const flagMs = await runtimeConfig.get(FlagKeys.LIAISON_LLM_TIMEOUT_MS);
		if (flagMs !== FlagKeys.LIAISON_LLM_TIMEOUT_MS.defaultValue) {
			return flagMs;
		}
		return PROVIDER_DEFAULT_LIAISON_LLM_TIMEOUT_MS[provider] ?? flagMs;
	} catch {
		return PROVIDER_DEFAULT_LIAISON_LLM_TIMEOUT_MS[provider] ?? 30_000;
	}
}
