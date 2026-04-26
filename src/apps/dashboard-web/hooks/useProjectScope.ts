// P477 AC-2: client-side project-scope hook + fetch wrapper.
//
// Stores the operator's selected project_id in localStorage (shared
// with lib/project-scope-storage.ts so the non-React apiClient can
// read the same value), exposes the list of available projects from
// /api/projects, and offers a `scopedFetch` helper that adds the
// `X-Project-Id` header on every request.

import { useCallback, useEffect, useState } from "react";
import {
	getStoredProjectId,
	onProjectScopeChange,
	setStoredProjectId,
} from "../lib/project-scope-storage";

export interface ProjectInfo {
	project_id: number;
	slug: string;
	name: string;
	worktree_root: string;
	bootstrap_status: string;
	host: string;
	port: number;
	db_name: string | null;
}

interface ProjectsListResponse {
	projects: ProjectInfo[];
	default_project_id: number | null;
}

let cached: ProjectsListResponse | null = null;
let inflight: Promise<ProjectsListResponse> | null = null;

async function loadProjects(): Promise<ProjectsListResponse> {
	if (cached) return cached;
	if (!inflight) {
		inflight = fetch("/api/projects", { headers: { Accept: "application/json" } })
			.then(async (res) => {
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const data = (await res.json()) as ProjectsListResponse;
				cached = data;
				inflight = null;
				return data;
			})
			.catch((err) => {
				inflight = null;
				throw err;
			});
	}
	return inflight;
}

// localStorage I/O lives in lib/project-scope-storage so apiClient
// (non-React) can use the same source of truth.

export interface ProjectScope {
	loading: boolean;
	error: string | null;
	projects: ProjectInfo[];
	current: ProjectInfo | null;
	setProjectId: (id: number) => void;
	scopedFetch: typeof fetch;
}

/**
 * React hook returning the operator's current project scope.
 *
 * Falls back to the server's default_project_id when nothing is stored.
 * The returned `scopedFetch` mirrors the fetch signature but adds an
 * `X-Project-Id` header on every request — components should use it
 * instead of `window.fetch` for any data that should be project-scoped.
 */
export function useProjectScope(): ProjectScope {
	const [projects, setProjects] = useState<ProjectInfo[]>([]);
	const [defaultId, setDefaultId] = useState<number | null>(null);
	const [storedId, setStoredId] = useState<number | null>(getStoredProjectId());
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		const off = onProjectScopeChange((id) => setStoredId(id));
		return off;
	}, []);

	useEffect(() => {
		let cancelled = false;
		loadProjects()
			.then((res) => {
				if (cancelled) return;
				setProjects(res.projects);
				setDefaultId(res.default_project_id);
				setError(null);
			})
			.catch((err) => {
				if (cancelled) return;
				setError((err as Error).message);
			})
			.finally(() => {
				if (cancelled) return;
				setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const setProjectId = useCallback((id: number) => {
		setStoredProjectId(id);
		// onProjectScopeChange listener above will update local state too.
	}, []);

	const effectiveId = storedId ?? defaultId;
	const current =
		projects.find((p) => p.project_id === effectiveId) ?? projects[0] ?? null;

	const scopedFetch = useCallback<typeof fetch>(
		(input, init) => {
			const headers = new Headers(init?.headers ?? {});
			if (effectiveId != null && !headers.has("X-Project-Id")) {
				headers.set("X-Project-Id", String(effectiveId));
			}
			return fetch(input, { ...(init ?? {}), headers });
		},
		[effectiveId],
	);

	return {
		loading,
		error,
		projects,
		current,
		setProjectId,
		scopedFetch,
	};
}
