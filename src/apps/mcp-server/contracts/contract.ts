import type { CallToolResult } from "../types.ts";

/**
 * Persistence level declaration for a tool handler.
 *
 * - "durable": handler MUST only read/write durable storage (DB, files, etc)
 * - "stateless": handler computes without side effects
 */
export type PersistenceLevel = "durable" | "stateless";

/**
 * Alias mapping for deprecated parameter names.
 * Enables backward compatibility while tracking usage for deprecation.
 */
export interface AliasMapping {
	/** Legacy parameter name */
	deprecated: string;
	/** Canonical parameter name to map to */
	canonical: string;
	/** Optional removal date (ISO 8601) */
	removedAt?: string;
}

/**
 * Common error patterns that a tool can emit.
 */
export interface CommonError {
	code: string;
	message: string;
	example?: string;
}

/**
 * Tool action schema — defines the contract for a single MCP tool action.
 */
export interface ToolContract {
	/** Tool name (e.g., "mcp_proposal") */
	name: string;

	/** Human description of the tool */
	description: string;

	/** Input schema (JSON Schema compatible) */
	argsSchema: Record<string, unknown>;

	/** Aliases for deprecated parameter names */
	aliases?: AliasMapping[];

	/** Persistence guarantee declared by the handler */
	persistence: PersistenceLevel;

	/** Handler function */
	handler: (args: Record<string, unknown>) => Promise<CallToolResult>;

	/** Sample call for documentation */
	sampleCall?: Record<string, unknown>;

	/** Common error codes and messages this tool can emit */
	commonErrors?: CommonError[];

	/** Additional metadata */
	metadata?: {
		// Version of the contract (for future evolution)
		version?: string;
		// Aliases for the tool name itself (e.g., legacy short names)
		nameAliases?: string[];
	};
}

/**
 * Contract registry for type-safe access and validation.
 */
export class ContractRegistry {
	private contracts = new Map<string, ToolContract>();

	register(contract: ToolContract): void {
		const existing = this.contracts.get(contract.name);
		if (existing) {
			throw new Error(
				`Contract already registered for tool '${contract.name}'`,
			);
		}
		this.contracts.set(contract.name, contract);
	}

	get(toolName: string): ToolContract | undefined {
		return this.contracts.get(toolName);
	}

	getAll(): ToolContract[] {
		return Array.from(this.contracts.values());
	}

	has(toolName: string): boolean {
		return this.contracts.has(toolName);
	}
}

/**
 * Factory for defining tool contracts.
 * Ensures type safety and consistent schema format.
 */
export function defineContract(
	config: Omit<ToolContract, "metadata"> & { metadata?: ToolContract["metadata"] },
): ToolContract {
	return {
		...config,
		metadata: config.metadata ?? {},
	};
}
