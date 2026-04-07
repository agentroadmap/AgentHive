export * from "./readme.ts";

// Types

export { SearchService } from "../core/infrastructure/search-service.ts";
// Core entry point
export { Core } from "../core/roadmap.ts";
// File system operations
export { FileSystem } from "../infra/file-system/operations.ts";
// Git operations
export {
	GitOperations,
	initializeGitRepository,
	isGitRepository,
} from "../infra/git/operations.ts";
// Constants
export * from "../shared/constants/index.ts";
// Markdown operations
export * from "../shared/markdown/parser.ts";
export * from "../shared/markdown/serializer.ts";
export * from "../types/index.ts";
// Project root discovery
export {
	findRoadmapRoot,
	getProjectRoot,
	requireProjectRoot,
} from "../utils/project-root.ts";
export {
	_loadAgentGuideline,
	type AgentInstructionFile,
	addAgentInstructions,
	type EnsureMcpGuidelinesResult,
	ensureMcpGuidelines,
	installClaudeAgent,
} from "./agent-instructions.ts";
