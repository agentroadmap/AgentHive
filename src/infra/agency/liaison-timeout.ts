import * as runtimeConfig from "../../shared/runtime/config.ts";
import { FlagKeys } from "../../shared/runtime/config-keys.ts";

const DEFAULT_LIAISON_LLM_TIMEOUT_MS = 30000;
const PROVIDER_DEFAULT_LIAISON_LLM_TIMEOUT_MS: Record<string, number> = {
	codex: 120000,
};

export async function resolveLiaisonLlmTimeoutMs(provider: string): Promise<number> {
	const providerKey = provider.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();

	// Per-provider env override (exotic, env-only — no DB key for each provider variant)
	const providerEnv = process.env[`AGENTHIVE_LIAISON_LLM_TIMEOUT_MS_${providerKey}`];
	if (providerEnv != null && providerEnv.trim() !== "") {
		const n = Number(providerEnv);
		if (Number.isFinite(n) && n > 0) return n;
	}

	// Global flag: DB-backed with env fallback
	try {
		return await runtimeConfig.get(FlagKeys.LIAISON_LLM_TIMEOUT_MS);
	} catch {
		const env = process.env.AGENTHIVE_LIAISON_LLM_TIMEOUT_MS;
		if (env != null && env.trim() !== "") {
			const n = Number(env);
			if (Number.isFinite(n) && n > 0) return n;
		}
	}

	return (
		PROVIDER_DEFAULT_LIAISON_LLM_TIMEOUT_MS[provider] ??
		DEFAULT_LIAISON_LLM_TIMEOUT_MS
	);
}
