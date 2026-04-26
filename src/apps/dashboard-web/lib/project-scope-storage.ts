// P477 AC-2: shared project-scope storage.
//
// Both the React hook (useProjectScope) and the non-React API client
// (lib/api.ts) read the operator's selected project from one place so
// every fetch (REST, WebSocket subscribe, polling) carries the same
// X-Project-Id header without each component having to plumb it.

const STORAGE_KEY = "roadmap.project_scope.v1";
const CHANGE_EVENT = "roadmap:project-scope-changed";

export function getStoredProjectId(): number | null {
	if (typeof window === "undefined") return null;
	const raw = window.localStorage.getItem(STORAGE_KEY);
	if (!raw) return null;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : null;
}

export function setStoredProjectId(id: number | null): void {
	if (typeof window === "undefined") return;
	if (id == null) window.localStorage.removeItem(STORAGE_KEY);
	else window.localStorage.setItem(STORAGE_KEY, String(id));
	// Notify in-tab listeners (apiClient, useWebSocket) so they refetch.
	window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { projectId: id } }));
}

export function onProjectScopeChange(handler: (id: number | null) => void): () => void {
	if (typeof window === "undefined") return () => {};
	const listener = (ev: Event) => {
		const detail = (ev as CustomEvent<{ projectId: number | null }>).detail;
		handler(detail?.projectId ?? null);
	};
	window.addEventListener(CHANGE_EVENT, listener as EventListener);
	// Also handle storage events fired by other tabs.
	const storageListener = (ev: StorageEvent) => {
		if (ev.key === STORAGE_KEY) {
			handler(ev.newValue ? Number(ev.newValue) : null);
		}
	};
	window.addEventListener("storage", storageListener);
	return () => {
		window.removeEventListener(CHANGE_EVENT, listener as EventListener);
		window.removeEventListener("storage", storageListener);
	};
}
