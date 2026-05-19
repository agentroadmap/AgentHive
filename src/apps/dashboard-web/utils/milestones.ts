/**
 * Re-export directive utilities for backward compatibility.
 * P301: source moved out of src/core into dashboard-web/utils/directives.
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
} from "./directives.ts";

export type {
	DirectiveBucket,
	DirectiveSummary,
} from "../../../shared/types/index.ts";
