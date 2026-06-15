/**
 * P1067 AC-17 — resolve the operator principal ONCE at startup.
 *
 * Precedence:
 *   1. agentContextStorage.getStore() — a verified principal already in the
 *      async context (when the shell is launched inside an authed flow).
 *   2. AGENTHIVE_OPERATOR_IDENTITY env — the operator identity the rest of the
 *      codebase already reads (e.g. proposals/pg-handlers.ts).
 * If neither yields an operator identity, the caller must exit code 1 (AC-17).
 *
 * getStore() is consulted EXACTLY ONCE; the resolved principal is then handed to
 * every panel render so all views see the same VerifiedPrincipal.
 */

import {
	agentContextStorage,
	type VerifiedPrincipal,
} from "../../shared/identity/agent-context.ts";

export function resolveOperatorPrincipal(
	env: NodeJS.ProcessEnv = process.env,
): VerifiedPrincipal | null {
	const store = agentContextStorage.getStore();
	if (store?.verified?.principal_id) {
		return store.verified;
	}
	const ident = env.AGENTHIVE_OPERATOR_IDENTITY;
	if (ident && ident.trim()) {
		return {
			principal_id: ident.trim(),
			principal_kind: "operator",
			parent_principal_id: null,
		};
	}
	return null;
}
