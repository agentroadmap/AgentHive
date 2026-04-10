import type { RoadmapConfig } from "../../types/index.ts";

/**
 * Migrates config to ensure all required fields exist with default values
 */
export function migrateConfig(config: Partial<RoadmapConfig>): RoadmapConfig {
	const defaultConfig: RoadmapConfig = {
		projectName: "Untitled Project",
		defaultEditor: "",
		defaultStatus: "",
		statuses: ["Draft", "Review", "Develop", "Merge", "Complete"],
		labels: [],
		dateFormat: "YYYY-MM-DD",
		maxColumnWidth: 80,
		autoOpenBrowser: true,
		defaultPort: 6420,
		remoteOperations: true,
		autoCommit: false,
		bypassGitHooks: false,
		checkActiveBranches: true,
		activeBranchDays: 30,
	};

	// Merge provided config with defaults, ensuring all fields exist
	// Only include fields from config that are not undefined
	const filteredConfig = Object.fromEntries(
		Object.entries(config).filter(([_, value]) => value !== undefined),
	);

	const migratedConfig: RoadmapConfig = {
		...defaultConfig,
		...filteredConfig,
	};

	// Ensure arrays are not undefined
	migratedConfig.statuses = config.statuses || defaultConfig.statuses;
	migratedConfig.labels = config.labels || defaultConfig.labels;

	return migratedConfig;
}

/**
 * Checks if config needs migration (missing any expected fields)
 */
export function needsMigration(config: Partial<RoadmapConfig>): boolean {
	// Check for all expected fields including new ones
	// We need to check not just presence but also that they aren't undefined
	const expectedFieldsWithDefaults = [
		{ field: "projectName", hasDefault: true },
		{ field: "statuses", hasDefault: true },
		{ field: "defaultPort", hasDefault: true },
		{ field: "autoOpenBrowser", hasDefault: true },
		{ field: "remoteOperations", hasDefault: true },
		{ field: "autoCommit", hasDefault: true },
	];

	return expectedFieldsWithDefaults.some(({ field }) => {
		const value = config[field as keyof RoadmapConfig];
		return value === undefined;
	});
}
