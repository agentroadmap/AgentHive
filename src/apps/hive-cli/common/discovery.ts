/**
 * Discovery commands per cli-hive-contract.md §8.
 *
 * Implements `hive --schema`, `hive <domain> --schema`, `hive --recipes`.
 * Each domain module registers its schema descriptor; this module assembles the output.
 */

export interface CommandParameter {
  name: string;
  type: "string" | "number" | "boolean" | "string[]";
  required?: boolean;
  repeatable?: boolean;
  description?: string;
  example?: string;
}

export interface CommandFlag {
  name: string;
  type: "string" | "number" | "boolean" | "string[]" | "enum";
  enum?: string[];
  repeatable?: boolean;
  description?: string;
  example?: string;
  default?: unknown;
}

export interface CommandSchema {
  name: string;
  aliases?: string[];
  description: string;
  signature: string;
  parameters?: CommandParameter[];
  flags?: CommandFlag[];
  output?: {
    type: "object" | "array" | "string";
    schema?: Record<string, unknown>;
  };
  idempotency?: "idempotent" | "non-idempotent";
  formats_supported?: string[];
}

export interface SubcommandSchema extends CommandSchema {
  // Additional fields for subcommands if needed
}

export interface DomainSchema {
  name: string;
  aliases?: string[];
  description: string;
  subcommands: SubcommandSchema[];
}

export interface CliSchema {
  schema_version: number;
  cli_version: string;
  mcp_protocol_version: string;
  commands: DomainSchema[];
}

export interface Recipe {
  id: string;
  title: string;
  when_to_use: string;
  steps: RecipeStep[];
  terminal_state: string;
}

export interface RecipeStep {
  cmd: string;
  reads?: string[];
  writes?: string[];
  description?: string;
}

/**
 * Global schema registry.
 * Domains call registerDomain() to add their schemas.
 */
const schemaRegistry: Map<string, DomainSchema> = new Map();
const recipeRegistry: Recipe[] = [];

/**
 * Register a domain's schema.
 */
export function registerDomain(domain: DomainSchema): void {
  schemaRegistry.set(domain.name, domain);
}

/**
 * Register a recipe.
 */
export function registerRecipe(recipe: Recipe): void {
  recipeRegistry.push(recipe);
}

/**
 * Get the full CLI schema (all domains).
 */
export function getFullSchema(cliVersion: string = "0.5.0"): CliSchema {
  return {
    schema_version: 1,
    cli_version: cliVersion,
    mcp_protocol_version: "1.0",
    commands: Array.from(schemaRegistry.values()),
  };
}

/**
 * Get schema for a specific domain.
 */
export function getDomainSchema(domainName: string): DomainSchema | undefined {
  return schemaRegistry.get(domainName);
}

/**
 * Get all recipes.
 */
export function getAllRecipes(): Recipe[] {
  return recipeRegistry;
}

/**
 * Format recipes as JSONL (one per line).
 */
export function formatRecipesAsJsonl(): string {
  return recipeRegistry.map((recipe) => JSON.stringify(recipe)).join("\n");
}

/**
 * Clear the registry (for testing).
 */
export function clearRegistry(): void {
  schemaRegistry.clear();
  recipeRegistry.length = 0;
}
