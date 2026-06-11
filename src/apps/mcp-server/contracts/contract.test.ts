import { describe, it, expect } from "bun:test";
import {
	defineContract,
	ContractRegistry,
	type ToolContract,
} from "./contract.ts";
import {
	enforceContract,
	enforceContractWithErrorHandling,
	validateAgainstSchema,
	checkPersistenceDeclaration,
} from "./enforcement.ts";
import { generateHelpResponse } from "./help-generator.ts";
import { createErrorResult, isValidErrorEnvelope, isRetriable } from "./error-envelope.ts";
import { mcp_proposal_contract } from "./mcp_proposal.ts";

describe("Contract Framework (P475)", () => {
	// AC-2: Contracts directory and defineContract export
	describe("AC-2: Contract Definition", () => {
		it("should define a contract with all required fields", () => {
			const contract = defineContract({
				name: "test_tool",
				description: "A test tool",
				argsSchema: {
					type: "object",
					properties: {
						id: { type: "number" },
					},
					required: ["id"],
				},
				persistence: "durable",
				handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
			});

			expect(contract.name).toBe("test_tool");
			expect(contract.persistence).toBe("durable");
			expect(contract.handler).toBeDefined();
		});

		it("should support optional metadata", () => {
			const contract = defineContract({
				name: "test",
				description: "test",
				argsSchema: {},
				persistence: "stateless",
				handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
				metadata: {
					version: "1.0",
					nameAliases: ["test_alias"],
				},
			});

			expect(contract.metadata?.version).toBe("1.0");
			expect(contract.metadata?.nameAliases).toContain("test_alias");
		});

		it("mcp_proposal_contract should be properly defined", () => {
			expect(mcp_proposal_contract.name).toBe("mcp_proposal");
			expect(mcp_proposal_contract.persistence).toBe("durable");
			expect(mcp_proposal_contract.argsSchema.properties?.action).toBeDefined();
		});
	});

	// AC-3: Dispatch layer validates against contract schema
	describe("AC-3: Schema Validation at Dispatch", () => {
		const simpleContract = defineContract({
			name: "simple",
			description: "Simple tool",
			argsSchema: {
				type: "object",
				properties: {
					required_field: { type: "string" },
					optional_field: { type: "number" },
				},
				required: ["required_field"],
				additionalProperties: false,
			},
			persistence: "stateless",
			handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
		});

		it("should accept valid input", async () => {
			const result = await enforceContract(
				{ required_field: "test" },
				simpleContract,
			);
			expect(result.ok).toBe(true);
			expect(result.validated).toBeDefined();
		});

		it("should reject missing required fields", async () => {
			const result = await enforceContract({}, simpleContract);
			expect(result.ok).toBe(false);
			expect(result.error?.code).toBe("INVALID_ARGUMENT");
			expect(result.error?.params).toContainEqual({
				key: "required_field",
				message: "Required parameter missing",
				suggestion: expect.any(String),
			});
		});

		it("should reject unknown fields when additionalProperties=false", async () => {
			const result = await enforceContract(
				{ required_field: "test", unknown_field: "bad" },
				simpleContract,
			);
			expect(result.ok).toBe(false);
			expect(result.error?.params).toContainEqual({
				key: "unknown_field",
				message: "Unknown parameter not allowed",
				suggestion: expect.any(String),
			});
		});

		it("should return structured CallToolResult on validation failure", async () => {
			const result = await enforceContractWithErrorHandling(
				{ unknown_field: "test" },
				simpleContract,
			);
			expect(result.ok).toBe(false);
			expect(result.result?.isError).toBe(true);
			expect(result.result?.structuredContent).toBeDefined();
		});
	});

	// AC-4: Help system with live schema
	describe("AC-4: Help System (action=help)", () => {
		const toolContract = defineContract({
			name: "test_help",
			description: "A tool with help",
			argsSchema: {
				type: "object",
				properties: {
					action: { type: "string" },
					id: { type: "number" },
				},
				required: ["action"],
			},
			persistence: "durable",
			handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
			sampleCall: { action: "get", id: 123 },
			commonErrors: [
				{
					code: "NOT_FOUND",
					message: "Resource not found",
					example: "id=99999",
				},
			],
			aliases: [
				{
					deprecated: "resource_id",
					canonical: "id",
					removedAt: "2026-09-01",
				},
			],
		});

		it("should generate help response with live schema", () => {
			const result = generateHelpResponse(toolContract);
			expect(result.isError).toBeFalsy();
			expect(result.content).toBeDefined();
			expect(result.structuredContent).toMatchObject({
				tool_name: "test_help",
				description: "A tool with help",
				args_schema: expect.any(Object),
				sample_call: { action: "get", id: 123 },
			});
		});

		it("should include aliases in help response", () => {
			const result = generateHelpResponse(toolContract);
			const sc = result.structuredContent as Record<string, unknown>;
			expect(Array.isArray(sc.aliases)).toBe(true);
			expect(sc.aliases).toContainEqual({
				deprecated: "resource_id",
				canonical: "id",
				removedAt: "2026-09-01",
			});
		});

		it("should include common errors in help response", () => {
			const result = generateHelpResponse(toolContract);
			const sc = result.structuredContent as Record<string, unknown>;
			expect(Array.isArray(sc.common_errors)).toBe(true);
			expect(sc.common_errors).toContainEqual({
				code: "NOT_FOUND",
				message: "Resource not found",
				example: "id=99999",
			});
		});

		it("should format help as markdown", () => {
			const result = generateHelpResponse(toolContract);
			const text = result.content[0];
			expect(text.type).toBe("text");
			expect((text as Record<string, unknown>).text).toContain("test_help");
			expect((text as Record<string, unknown>).text).toContain("Input Schema");
			expect((text as Record<string, unknown>).text).toContain("Sample Call");
		});
	});

	// AC-5: Persistence declaration checking
	describe("AC-5: Persistence Guarantees", () => {
		it("should pass durable handler that uses only DB", () => {
			// Handler that only calls DB (no in-memory state)
			const durableHandler = async (args: Record<string, unknown>) => {
				console.log(args);
				return { content: [{ type: "text", text: "ok" }] };
			};

			const passes = checkPersistenceDeclaration(durableHandler, "durable");
			expect(passes).toBe(true);
		});

		it("should reject handler that creates in-memory map", () => {
			// This function has new Map() in its source
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			const badHandler = async function handler() {
				const cache = new Map();
				return { content: [{ type: "text", text: "ok" }] };
			};

			const passes = checkPersistenceDeclaration(badHandler, "durable");
			expect(passes).toBe(false);
		});

		it("should reject handler that creates const with new Set", () => {
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			const badHandler = async function handler() {
				const items = new Set();
				return { content: [{ type: "text", text: "ok" }] };
			};

			const passes = checkPersistenceDeclaration(badHandler, "durable");
			expect(passes).toBe(false);
		});

		it("should accept stateless handlers without check", () => {
			const stateless = async () => ({ content: [{ type: "text", text: "ok" }] });
			const passes = checkPersistenceDeclaration(stateless, "stateless");
			expect(passes).toBe(true);
		});
	});

	// AC-8: Error envelope standard
	describe("AC-8: Error Envelope Standard", () => {
		it("should create valid error result with envelope", () => {
			const result = createErrorResult(
				"INVALID_ARGUMENT",
				"Missing required field",
				{ field: "id" },
				false,
			);

			expect(result.isError).toBe(true);
			expect(isValidErrorEnvelope(result)).toBe(true);

			const sc = result.structuredContent as Record<string, unknown>;
			expect(sc.code).toBe("INVALID_ARGUMENT");
			expect(sc.message).toBe("Missing required field");
			expect(sc.retriable).toBe(false);
			expect(sc.correlation_id).toBeDefined();
			expect(sc.timestamp).toBeDefined();
		});

		it("should set retriable based on error code", () => {
			const notRetriable = createErrorResult("NOT_FOUND", "Not found", undefined, false);
			const retriable = createErrorResult("TIMEOUT", "Timeout", undefined, true);

			expect(
				(notRetriable.structuredContent as Record<string, unknown>).retriable,
			).toBe(false);
			expect((retriable.structuredContent as Record<string, unknown>).retriable).toBe(true);
		});

		it("should validate error envelope structure", () => {
			const validResult = createErrorResult("TEST_ERROR", "Test");
			expect(isValidErrorEnvelope(validResult)).toBe(true);

			const invalidResult = {
				isError: true,
				content: [{ type: "text" as const, text: "error" }],
				// Missing structuredContent
			};
			expect(isValidErrorEnvelope(invalidResult)).toBe(false);
		});

		it("should determine standard retriability for codes", () => {
			expect(isRetriable("INVALID_ARGUMENT")).toBe(false);
			expect(isRetriable("NOT_FOUND")).toBe(false);
			expect(isRetriable("DATABASE_ERROR")).toBe(true);
			expect(isRetriable("TIMEOUT")).toBe(true);
			expect(isRetriable("UNKNOWN_CODE")).toBe(false);
		});
	});

	// Contract registry
	describe("Contract Registry", () => {
		it("should register and retrieve contracts", () => {
			const registry = new ContractRegistry();
			const contract = defineContract({
				name: "test_contract",
				description: "test",
				argsSchema: {},
				persistence: "stateless",
				handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
			});

			registry.register(contract);
			expect(registry.get("test_contract")).toBe(contract);
			expect(registry.has("test_contract")).toBe(true);
		});

		it("should reject duplicate registrations", () => {
			const registry = new ContractRegistry();
			const contract = defineContract({
				name: "duplicate",
				description: "test",
				argsSchema: {},
				persistence: "stateless",
				handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
			});

			registry.register(contract);
			expect(() => registry.register(contract)).toThrow();
		});

		it("should list all contracts", () => {
			const registry = new ContractRegistry();
			const c1 = defineContract({
				name: "c1",
				description: "test",
				argsSchema: {},
				persistence: "stateless",
				handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
			});
			const c2 = defineContract({
				name: "c2",
				description: "test",
				argsSchema: {},
				persistence: "stateless",
				handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
			});

			registry.register(c1);
			registry.register(c2);
			expect(registry.getAll()).toHaveLength(2);
		});
	});

	// Alias resolution
	describe("Alias Resolution", () => {
		const contractWithAliases = defineContract({
			name: "test",
			description: "test",
			argsSchema: {
				type: "object",
				properties: {
					canonical_name: { type: "string" },
				},
				required: ["canonical_name"],
			},
			aliases: [
				{
					deprecated: "old_name",
					canonical: "canonical_name",
				},
			],
			persistence: "stateless",
			handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
		});

		it("should resolve deprecated alias to canonical name", async () => {
			const result = await enforceContract(
				{ old_name: "value" },
				contractWithAliases,
			);
			expect(result.ok).toBe(true);
			expect(result.validated?.canonical_name).toBe("value");
			expect(result.validated?.old_name).toBeUndefined();
		});

		it("should prefer canonical name if both are present", async () => {
			const result = await enforceContract(
				{ canonical_name: "canonical_value", old_name: "alias_value" },
				contractWithAliases,
			);
			expect(result.ok).toBe(true);
			expect(result.validated?.canonical_name).toBe("canonical_value");
		});
	});
});
