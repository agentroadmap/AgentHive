import { describe, it, expect, vi, beforeEach } from "vitest";
import { workerRegisterHandler, agencyRegisterHandler } from "../handlers";

// Mock the imported modules
vi.mock("../../../../infra/postgres/pool.ts", () => ({
	query: vi.fn(),
}));

vi.mock("../../../../core/identity/agent-registry/permanent-agent-map.ts", () => ({
	resolvePermanentAgentMapping: vi.fn(),
}));

vi.mock("../../../../core/identity/agent-registry/agent-name.ts", () => ({
	assignDisplayAlias: vi.fn(),
	pascalCaseHost: vi.fn((host: string) => host.charAt(0).toUpperCase() + host.slice(1).toLowerCase()),
}));

vi.mock("../../../../core/identity/agent-registry/alias-manager.ts", () => ({
	claimDisplayAlias: vi.fn(),
}));

vi.mock("node:os", () => ({
	hostname: vi.fn(() => "testhost"),
}));

import { query } from "../../../../infra/postgres/pool.ts";
import { assignDisplayAlias, pascalCaseHost } from "../../../../core/identity/agent-registry/agent-name.ts";
import { claimDisplayAlias } from "../../../../core/identity/agent-registry/alias-manager.ts";

describe("workerRegisterHandler - Alias Wiring", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.AGENTHIVE_HOST = undefined;
	});

	it("AC-9: should call claimDisplayAlias for slot-'a' worker with skills", async () => {
		// Setup
		const mockWorkerId = 123;
		(query as any).mockResolvedValueOnce({
			rows: [{ worker_id: mockWorkerId }],
		});

		(assignDisplayAlias as any).mockReturnValue("Claude-Testhost-Architecture");
		(claimDisplayAlias as any).mockResolvedValue({ claimed: true });

		// Call handler
		const result = await workerRegisterHandler({
			workerIdentity: "ccs45ant-bot-arch-a",
			agencyIdentity: "claude/main",
			skills: ["architecture"],
			model: "claude-sonnet-4-5",
		});

		// Assertions
		expect(query).toHaveBeenCalledWith(
			expect.stringContaining("fn_register_worker"),
			expect.arrayContaining(["ccs45ant-bot-arch-a", "claude/main"]),
		);

		expect(assignDisplayAlias).toHaveBeenCalledWith("claude", "Testhost", "architecture", "a");

		expect(claimDisplayAlias).toHaveBeenCalledWith(mockWorkerId, "Claude-Testhost-Architecture", {
			tier: 2,
		});

		expect(result.content[0].text).toContain("Worker registered");
	});

	it("AC-10: should NOT call claimDisplayAlias for slot-'b' worker", async () => {
		// Setup
		const mockWorkerId = 456;
		(query as any).mockResolvedValueOnce({
			rows: [{ worker_id: mockWorkerId }],
		});

		(assignDisplayAlias as any).mockReturnValue(null);

		// Call handler
		const result = await workerRegisterHandler({
			workerIdentity: "ccs45ant-bot-arch-b",
			agencyIdentity: "claude/main",
			skills: ["architecture"],
			model: "claude-sonnet-4-5",
		});

		// Assertions: claimDisplayAlias should not be called for slot-b
		expect(claimDisplayAlias).not.toHaveBeenCalled();
		expect(result.content[0].text).toContain("Worker registered");
	});

	it("should log warning when alias is already in use", async () => {
		const mockWorkerId = 789;
		(query as any).mockResolvedValueOnce({
			rows: [{ worker_id: mockWorkerId }],
		});

		(assignDisplayAlias as any).mockReturnValue("Claude-Testhost-Architecture");
		(claimDisplayAlias as any).mockResolvedValue({
			claimed: false,
			reason: "alias_in_use",
		});

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		await workerRegisterHandler({
			workerIdentity: "ccs45ant-bot-arch-a",
			agencyIdentity: "claude/main",
			skills: ["architecture"],
		});

		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining("alias_in_use"),
		);

		warnSpy.mockRestore();
	});
});

describe("agencyRegisterHandler - Alias Wiring", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.AGENTHIVE_HOST = undefined;
	});

	it("should call claimDisplayAlias for slot-'a' agency with skills", async () => {
		// Setup
		const mockAgencyId = 321;
		(query as any)
			.mockResolvedValueOnce({
				rows: [
					{
						id: mockAgencyId,
						agent_identity: "codex-hermes-arch-a",
						agent_type: "agency",
					},
				],
			});

		(assignDisplayAlias as any).mockReturnValue("Codex-Testhost-Develop");
		(claimDisplayAlias as any).mockResolvedValue({ claimed: true });

		// Call handler
		const result = await agencyRegisterHandler({
			identity: "codex-hermes-arch-a",
			agentType: "agency",
			provider: "codex",
			model: "gpt-4",
			skills: ["develop"],
		});

		// Assertions
		expect(assignDisplayAlias).toHaveBeenCalledWith("codex", "Testhost", "develop", "a");

		expect(claimDisplayAlias).toHaveBeenCalledWith(mockAgencyId, "Codex-Testhost-Develop", {
			tier: 2,
		});

		expect(result.content[0].text).toContain("Agency registered");
	});

	it("should NOT call claimDisplayAlias for slot-'c' agency", async () => {
		// Setup
		(query as any).mockResolvedValueOnce({
			rows: [
				{
					id: 654,
					agent_identity: "codex-hermes-arch-c",
					agent_type: "agency",
				},
			],
		});

		(assignDisplayAlias as any).mockReturnValue(null);

		// Call handler
		await agencyRegisterHandler({
			identity: "codex-hermes-arch-c",
			agentType: "agency",
			provider: "codex",
			skills: ["develop"],
		});

		// Assertions
		expect(claimDisplayAlias).not.toHaveBeenCalled();
	});
});
