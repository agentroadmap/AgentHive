/**
 * P852: Agent name composition tests.
 * Pure-function module; no DB or env required.
 */

import { describe, expect, test } from "bun:test";
import {
	buildBaseName,
	computeAbbr,
	encodeAgency,
	encodeExpertise,
	encodeModel,
	encodeProvider,
	EXPERTISE,
	isLiaisonHint,
} from "../../src/core/identity/agent-registry/agent-name.ts";

describe("encodeAgency", () => {
	test("known agencies", () => {
		expect(encodeAgency("claude")).toBe("cc");
		expect(encodeAgency("claude-code")).toBe("cc");
		expect(encodeAgency("hermes")).toBe("hm");
		expect(encodeAgency("openclaw")).toBe("oc");
		expect(encodeAgency("codex")).toBe("cd");
		expect(encodeAgency("copilot")).toBe("cp");
		expect(encodeAgency("gemini-cli")).toBe("gm");
	});

	test("case insensitive", () => {
		expect(encodeAgency("Claude-Code")).toBe("cc");
		expect(encodeAgency("HERMES")).toBe("hm");
	});

	test("unknown agency falls back to first 2 alphanumerics", () => {
		expect(encodeAgency("zeta-bot")).toBe("ze");
	});
});

describe("encodeProvider", () => {
	test("known providers", () => {
		expect(encodeProvider("anthropic")).toBe("ant");
		expect(encodeProvider("openai")).toBe("oai");
		expect(encodeProvider("azure")).toBe("az");
		expect(encodeProvider("google")).toBe("ggl");
		expect(encodeProvider("aws")).toBe("bdr");
		expect(encodeProvider("bedrock")).toBe("bdr");
		expect(encodeProvider("github")).toBe("gh");
	});
});

describe("encodeModel", () => {
	test("claude families with major+minor", () => {
		expect(encodeModel("claude-sonnet-4-5")).toBe("s45");
		expect(encodeModel("claude-sonnet-4-5-20260101")).toBe("s45");
		expect(encodeModel("claude-sonnet-4-7")).toBe("s47");
		expect(encodeModel("claude-opus-4-7")).toBe("o47");
		expect(encodeModel("claude-haiku-4-5")).toBe("h45");
	});

	test("claude family with major only", () => {
		expect(encodeModel("claude-sonnet-4")).toBe("s4");
	});

	test("gpt models", () => {
		expect(encodeModel("gpt-4o")).toBe("gp4o");
		expect(encodeModel("gpt-4")).toBe("gp4");
		expect(encodeModel("gpt-4o-2026-05-01")).toBe("gp4o");
	});

	test("o-series", () => {
		expect(encodeModel("o1")).toBe("o1");
		expect(encodeModel("o3-mini")).toBe("o3");
	});

	test("gemini", () => {
		expect(encodeModel("gemini-2-flash")).toBe("g2");
		expect(encodeModel("gemini-1-5-pro")).toBe("g1");
	});

	test("unknown model falls back to alphanumerics", () => {
		expect(encodeModel("custom-llm-7b")).toBe("cust");
	});
});

describe("computeAbbr", () => {
	test("claude-code · sonnet-4-5 · anthropic", () => {
		expect(computeAbbr("claude-code", "claude-sonnet-4-5", "anthropic")).toBe(
			"ccs45ant",
		);
	});

	test("hermes · sonnet-4-5 · anthropic", () => {
		expect(computeAbbr("hermes", "claude-sonnet-4-5", "anthropic")).toBe(
			"hms45ant",
		);
	});

	test("openclaw · gpt-4o · openai", () => {
		expect(computeAbbr("openclaw", "gpt-4o", "openai")).toBe("ocgp4ooai");
	});

	test("codex · o1 · openai", () => {
		expect(computeAbbr("codex", "o1", "openai")).toBe("cdo1oai");
	});

	test("gemini-cli · gemini-2 · google", () => {
		expect(computeAbbr("gemini-cli", "gemini-2-flash", "google")).toBe(
			"gmg2ggl",
		);
	});
});

describe("encodeExpertise", () => {
	test("known capabilities", () => {
		expect(encodeExpertise("typescript")).toBe("ts");
		expect(encodeExpertise("postgres")).toBe("pg");
		expect(encodeExpertise("liaison")).toBe("lsn");
	});

	test("known stages", () => {
		expect(encodeExpertise("gate-review")).toBe("gate");
		expect(encodeExpertise("merge")).toBe("mrg");
		expect(encodeExpertise("develop")).toBe("dev");
	});

	test("case insensitive lookup", () => {
		expect(encodeExpertise("TypeScript")).toBe("ts");
		expect(encodeExpertise("GATE-REVIEW")).toBe("gate");
	});

	test("unknown hint truncated to 5 chars", () => {
		expect(encodeExpertise("orchestration")).toBe("orche");
		expect(encodeExpertise("xyz")).toBe("xyz");
	});

	test("expertise map covers documented stages", () => {
		expect(EXPERTISE["gate-review"]).toBe("gate");
		expect(EXPERTISE.develop).toBe("dev");
	});
});

describe("buildBaseName", () => {
	test("typescript expert on mac", () => {
		expect(buildBaseName("ccs45ant", "mac", ["typescript"])).toBe(
			"ccs45ant-mac-ts",
		);
	});

	test("gate-review on bot", () => {
		expect(buildBaseName("hms45ant", "bot", ["gate-review"])).toBe(
			"hms45ant-bot-gate",
		);
	});

	test("liaison singleton base", () => {
		expect(buildBaseName("ccs45ant", "mac", ["liaison"])).toBe(
			"ccs45ant-mac-lsn",
		);
	});

	test("no hints → no exp segment", () => {
		expect(buildBaseName("ccs45ant", "mac", [])).toBe("ccs45ant-mac");
	});

	test("falls through empty/undefined hints", () => {
		expect(buildBaseName("ccs45ant", "mac", [undefined, "", "develop"])).toBe(
			"ccs45ant-mac-dev",
		);
	});

	test("first non-empty hint wins", () => {
		expect(
			buildBaseName("ccs45ant", "mac", ["typescript", "gate-review"]),
		).toBe("ccs45ant-mac-ts");
	});
});

describe("isLiaisonHint", () => {
	test("liaison first → true", () => {
		expect(isLiaisonHint(["liaison"])).toBe(true);
		expect(isLiaisonHint(["LIAISON"])).toBe(true);
	});

	test("typescript first → false", () => {
		expect(isLiaisonHint(["typescript"])).toBe(false);
	});

	test("empty hints → false", () => {
		expect(isLiaisonHint([])).toBe(false);
		expect(isLiaisonHint([undefined, ""])).toBe(false);
	});

	test("liaison after empties is detected", () => {
		expect(isLiaisonHint([undefined, "", "liaison"])).toBe(true);
	});
});
