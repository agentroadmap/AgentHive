/**
 * MCP Tool Contract Framework
 *
 * This module provides a single-source schema for MCP tools with runtime validation,
 * help generation, and error standardization.
 *
 * Components:
 * - contract.ts: Core contract definition types and registry
 * - enforcement.ts: Runtime validation against contracts
 * - help-generator.ts: Live schema + help endpoint generation
 * - error-envelope.ts: Standardized error responses
 * - mcp_proposal.ts: Reference contract implementation
 */

export { defineContract, ContractRegistry, type ToolContract, type PersistenceLevel, type AliasMapping, type CommonError } from "./contract.ts";

export { enforceContract, enforceContractWithErrorHandling, validateAgainstSchema, checkPersistenceDeclaration, type EnforcementResult, type ParamError } from "./enforcement.ts";

export { generateHelpResponse } from "./help-generator.ts";

export { createErrorResult, wrapErrorHandling, isRetriable, isValidErrorEnvelope, type McpErrorEnvelope } from "./error-envelope.ts";

export { mcp_proposal_contract } from "./mcp_proposal.ts";

export { recordAliasUsage, generateDeprecationRemovalQuery, getDeprecationCandidates, type DeprecationCandidate } from "./alias-metrics.ts";

// Central registry instance (singleton)
import { ContractRegistry } from "./contract.ts";
import { mcp_proposal_contract } from "./mcp_proposal.ts";

export const contractRegistry = new ContractRegistry();
contractRegistry.register(mcp_proposal_contract);
