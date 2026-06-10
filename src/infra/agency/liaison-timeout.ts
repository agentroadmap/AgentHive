const DEFAULT_LIAISON_LLM_TIMEOUT_MS = 30000;
const PROVIDER_DEFAULT_LIAISON_LLM_TIMEOUT_MS: Record<string, number> = {
	codex: 120000,
};

export function resolveLiaisonLlmTimeoutMs(provider: string): number {
	const providerKey = provider.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
	const candidates = [
		process.env[`AGENTHIVE_LIAISON_LLM_TIMEOUT_MS_${providerKey}`],
		process.env.AGENTHIVE_LIAISON_LLM_TIMEOUT_MS,
	];

	for (const raw of candidates) {
		if (raw == null || raw.trim() === "") continue;
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}

	return (
		PROVIDER_DEFAULT_LIAISON_LLM_TIMEOUT_MS[provider] ??
		DEFAULT_LIAISON_LLM_TIMEOUT_MS
	);
}
