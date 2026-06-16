// P477 AC-7 / AC-11: route-derived project hook.
//
// Layers URL-namespace derivation on top of the existing localStorage-backed
// `useProjectScope` hook. The canonical project selection now lives in the URL
// (`/project/:projectId/*`); this hook reads that param, validates it, syncs it
// into the shared project-scope storage so the non-React data layer keeps
// emitting the correct `X-Project-Id` header, and exposes the resolved project
// (id + name/slug when cheaply available) to components.
//
// It does NOT replace useProjectScope — it sits in front of it. Components that
// only need the scoped fetch wrapper can keep using useProjectScope directly;
// components rendered under a `/project/:projectId` route should use this hook
// so the in-URL project wins over whatever was last stored.

import { useEffect } from "react";
import { useParams } from "wouter";
import { setStoredProjectId } from "../lib/project-scope-storage";
import { useProjectScope, type ProjectInfo } from "./useProjectScope";

/** The default project that legacy (non-namespaced) routes redirect into. */
export const DEFAULT_PROJECT_ID = 1;

/**
 * Legacy flat routes that predate the `/project/:projectId` namespace. Each is
 * 302-redirected (client-side) to its namespaced equivalent under
 * DEFAULT_PROJECT_ID for backwards compatibility with old bookmarks/links.
 *
 * Control-plane root sections (`/`, `/fleet`, `/efficiency`, `/identity`,
 * `/platform`) added by P3507 are intentionally NOT here — they are
 * cross-project aggregation views and stay un-namespaced.
 */
export const LEGACY_PROJECT_ROUTES = [
	"board",
	"proposals",
	"agents",
	"dispatches",
	"directives",
	"settings",
] as const;

export type ProjectScopedSection = (typeof LEGACY_PROJECT_ROUTES)[number];

/**
 * Parse a raw `:projectId` route param into a positive integer, or null when it
 * is missing / non-numeric / non-positive. Exported as a pure function so the
 * validation can be unit-tested without mounting a router.
 */
export function parseProjectId(raw: string | undefined | null): number | null {
	if (raw == null) return null;
	// Reject anything that is not a run of digits ("2" ok, "2x"/"-1"/"1.5" not).
	if (!/^\d+$/.test(raw)) return null;
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Given a legacy flat path, return the namespaced target it should redirect to,
 * or null when the path is not a known legacy project route. Pure + exported
 * for unit testing the redirect table.
 *
 *   "/board"      -> "/project/1/board"
 *   "/proposals"  -> "/project/1/proposals"
 *   "/fleet"      -> null   (control-plane root, not redirected)
 */
export function legacyRedirectTarget(
	path: string,
	defaultProjectId: number = DEFAULT_PROJECT_ID,
): string | null {
	const trimmed = path.replace(/^\/+|\/+$/g, "");
	return (LEGACY_PROJECT_ROUTES as readonly string[]).includes(trimmed)
		? `/project/${defaultProjectId}/${trimmed}`
		: null;
}

export interface ProjectContext {
	/** Numeric project id derived from the route, or null when not on a `/project/:id` route or the param is invalid. */
	projectId: number | null;
	/** True when the route carried a syntactically valid (positive-integer) projectId. */
	isValid: boolean;
	/** Resolved project name, when the projects list is loaded and contains this id. */
	projectName: string | null;
	/** Resolved project slug, when available. */
	projectSlug: string | null;
	/** Full ProjectInfo record when resolvable, else null. */
	project: ProjectInfo | null;
	/** Loading / error state proxied from the underlying useProjectScope. */
	loading: boolean;
	error: string | null;
}

/**
 * Resolve the current project from the route.
 *
 * Reads `:projectId` from wouter params, validates it, and (as a side effect)
 * pushes a valid id into the shared project-scope storage so every scoped fetch
 * carries the matching `X-Project-Id`. Returns the numeric id plus the resolved
 * name/slug when the `/api/projects` list (loaded by useProjectScope) knows it.
 */
export function useProject(): ProjectContext {
	const params = useParams<{ projectId?: string }>();
	const projectId = parseProjectId(params?.projectId);
	const { projects, loading, error } = useProjectScope();

	// Keep the localStorage-backed scope in lock-step with the URL so the
	// non-React apiClient + WebSocket emit the right X-Project-Id. The URL is
	// authoritative when we're under a /project/:id route.
	useEffect(() => {
		if (projectId != null) {
			setStoredProjectId(projectId);
		}
	}, [projectId]);

	const project =
		projectId != null
			? (projects.find((p) => p.project_id === projectId) ?? null)
			: null;

	return {
		projectId,
		isValid: projectId != null,
		projectName: project?.name ?? null,
		projectSlug: project?.slug ?? null,
		project,
		loading,
		error,
	};
}
