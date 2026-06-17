import * as runtimeConfig from "../../shared/runtime/config.ts";
import { FlagKeys } from "../../shared/runtime/config-keys.ts";

const DEFAULT_LIAISON_LLM_TIMEOUT_MS = 30000;
const PROVIDER_DEFAULT_LIAISON_LLM_TIMEOUT_MS: Record<string, number> = {
	codex: 120000,
};

export async function resolveLiaisonLlmTimeoutMs(provider: string): Promise<number> {
	const providerKey = provider.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();

	// Per-provider env override still reads process.env directly (dynamic key, no static ConfigKey)
	const providerEnv = process.env[`AGENTHIVE_LIAISON_LLM_TIMEOUT_MS_${providerKey}`];
	if (providerEnv != null && providerEnv.trim() !== "") {
		const parsed = Number(providerEnv);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}

	// Default timeout from config (DB or env fallback)
	try {
		const fromConfig = await runtimeConfig.getOptional(FlagKeys.AGENTHIVE_LIAISON_LLM_TIMEOUT_MS);
		if (fromConfig != null) return fromConfig;
	} catch {
		// Resolver not initialized (e.g. test environment) — fall through to process.env
		const raw = process.env.AGENTHIVE_LIAISON_LLM_TIMEOUT_MS;
		if (raw != null && raw.trim() !== "") {
			const parsed = Number(raw);
			if (Number.isFinite(parsed) && parsed > 0) return parsed;
		}
	}

	return (
		PROVIDER_DEFAULT_LIAISON_LLM_TIMEOUT_MS[provider] ??
		DEFAULT_LIAISON_LLM_TIMEOUT_MS
	);
}
