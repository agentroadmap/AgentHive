/**
 * Re-export directive utilities from core for backward compatibility
 * All business logic lives in src/core/directives.ts
 */
export {
	buildDirectiveBuckets,
	buildDirectiveSummary,
	collectArchivedDirectiveKeys,
	collectDirectiveIds,
	directiveKey,
	getDirectiveLabel,
	isReachedStatus,
	normalizeDirectiveName,
	validateDirectiveName,
} from "../../../core/proposal/directives.ts";

// Re-export types from core types
export type {
	DirectiveBucket,
	DirectiveSummary,
} from "../../../shared/types/index.ts";
