import type { RoadmapConfig } from "../types/index.ts";

export type BoardDataSource = "file" | "postgres";

export function resolveBoardDataSource(
	source: string | undefined,
	config: Pick<RoadmapConfig, "database"> | null | undefined,
): BoardDataSource {
	const normalized = source?.trim().toLowerCase() || "auto";
	if (normalized === "auto") {
		return config?.database?.provider === "Postgres" ? "postgres" : "file";
	}
	if (normalized === "postgres" || normalized === "file") {
		return normalized;
	}
	throw new Error(
		`Invalid board source "${source}". Expected one of: auto, file, postgres.`,
	);
}
