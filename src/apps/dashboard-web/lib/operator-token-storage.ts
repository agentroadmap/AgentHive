// Operator bearer-token storage.
//
// Mutating dashboard actions (agency pause/resume/drain/retire, operator
// control stop/suspend/drain/terminate) are gated server-side by
// requireOperator, which expects `Authorization: Bearer <token>` (or
// `x-operator-token`). The token is hashed and matched against
// roadmap.operator_token. This module is the single place the token is
// stored so the non-React API client (lib/api.ts) and any settings UI agree
// on one key — mirroring project-scope-storage.ts.
//
// Provision a token with `npm run operator:issue -- --name=<you> --allowed='*'`
// (printed once), then paste it into the dashboard. It is never sent anywhere
// except as the Authorization header on same-origin API calls.

const STORAGE_KEY = "operator.token";
const CHANGE_EVENT = "roadmap:operator-token-changed";

export function getStoredOperatorToken(): string | null {
	if (typeof window === "undefined") return null;
	const raw = window.localStorage.getItem(STORAGE_KEY);
	return raw && raw.trim().length > 0 ? raw.trim() : null;
}

export function setStoredOperatorToken(token: string | null): void {
	if (typeof window === "undefined") return;
	if (token == null || token.trim().length === 0) {
		window.localStorage.removeItem(STORAGE_KEY);
	} else {
		window.localStorage.setItem(STORAGE_KEY, token.trim());
	}
	window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { hasToken: token != null } }));
}

export function onOperatorTokenChange(handler: (hasToken: boolean) => void): () => void {
	if (typeof window === "undefined") return () => {};
	const listener = (ev: Event) => {
		const detail = (ev as CustomEvent<{ hasToken: boolean }>).detail;
		handler(Boolean(detail?.hasToken));
	};
	window.addEventListener(CHANGE_EVENT, listener as EventListener);
	const storageListener = (ev: StorageEvent) => {
		if (ev.key === STORAGE_KEY) handler(Boolean(ev.newValue));
	};
	window.addEventListener("storage", storageListener);
	return () => {
		window.removeEventListener(CHANGE_EVENT, listener as EventListener);
		window.removeEventListener("storage", storageListener);
	};
}
