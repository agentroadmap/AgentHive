/**
 * P228: Cubic Runtime Abstraction — CliBuilder Unit Tests
 *
 * Pure unit tests — no DB, no network. Exercises buildArgv(), buildEnv(),
 * buildCommandSpec(), and registry helpers for all five CLI builders.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	AgyCliBuilder,
	ClaudeCliBuilder,
	CodexCliBuilder,
	CopilotCliBuilder,
	GeminiCliBuilder,
	getCliBuilder,
	HermesCliBuilder,
	isKnownCli,
	listCliNames,
} from "../../../src/core/runtime/cli-builders.ts";

// ─── ClaudeCliBuilder ─────────────────────────────────────────────────────────

describe("ClaudeCliBuilder", () => {
	const builder = new ClaudeCliBuilder();
	const homeDir = "/home/testuser";

	it("name is 'claude'", () => {
		assert.equal(builder.name, "claude");
	});

	it("executableName() returns 'claude'", () => {
		assert.equal(builder.executableName(), "claude");
	});

	it("defaultModel() returns claude-sonnet-4-6", () => {
		assert.equal(builder.defaultModel(), "claude-sonnet-4-6");
	});

	it("buildArgv() — basic task", () => {
		const argv = builder.buildArgv({ task: "summarize this" });
		assert.deepEqual(argv, ["claude", "--print", "summarize this"]);
	});

	it("buildArgv() — with modelOverride inserts --model flag", () => {
		const argv = builder.buildArgv({
			task: "do work",
			modelOverride: "claude-opus-4-7",
		});
		assert.equal(argv[0], "claude");
		assert.ok(argv.includes("--model"), "must include --model");
		assert.ok(argv.includes("claude-opus-4-7"), "must include model name");
	});

	it("buildEnv() — sets HOME", () => {
		const env = builder.buildEnv({ homeDir });
		assert.equal(env.HOME, homeDir);
	});

	it("buildEnv() — injects ANTHROPIC_API_KEY from vault", () => {
		const env = builder.buildEnv({
			homeDir,
			apiKeyVault: { ANTHROPIC_API_KEY: "sk-test-key" },
		});
		assert.equal(env.ANTHROPIC_API_KEY, "sk-test-key");
	});

	it("buildEnv() — no vault key: ANTHROPIC_API_KEY absent", () => {
		const env = builder.buildEnv({ homeDir });
		assert.equal(env.ANTHROPIC_API_KEY, undefined);
	});

	it("buildEnv() — injects CLAUDE_CODE_OAUTH_TOKEN from vault (P1967)", () => {
		const env = builder.buildEnv({
			homeDir,
			apiKeyVault: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-123-long-lived" },
		});
		assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "oauth-token-123-long-lived");
	});

	it("buildEnv() — no oauth token: CLAUDE_CODE_OAUTH_TOKEN absent (P1967 no-regression)", () => {
		const env = builder.buildEnv({ homeDir });
		assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
	});

	it("buildEnv() — injects both ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN when both present (P1967)", () => {
		const env = builder.buildEnv({
			homeDir,
			apiKeyVault: {
				ANTHROPIC_API_KEY: "api-key-123",
				CLAUDE_CODE_OAUTH_TOKEN: "oauth-token-456",
			},
		});
		assert.equal(env.ANTHROPIC_API_KEY, "api-key-123");
		assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "oauth-token-456");
	});

	it("buildCommandSpec() — argv starts with claude --print --model", () => {
		const spec = builder.buildCommandSpec("do work", {
			modelName: "claude-sonnet-4-6",
			baseUrl: "https://api.anthropic.com",
			routeProvider: "anthropic",
		});
		assert.equal(spec.argv[0], "claude");
		assert.ok(spec.argv.includes("--print"), "must include --print");
		assert.ok(spec.argv.includes("--model"), "must include --model");
		assert.ok(
			spec.argv.includes("claude-sonnet-4-6"),
			"must include model name",
		);
		assert.ok(spec.argv.includes("do work"), "must include task");
	});

	it("buildCommandSpec() — non-default baseUrl sets ANTHROPIC_BASE_URL", () => {
		const spec = builder.buildCommandSpec("task", {
			modelName: "claude-sonnet-4-6",
			baseUrl: "https://custom.endpoint.io",
			routeProvider: "xiaomi",
		});
		assert.equal(spec.env.ANTHROPIC_BASE_URL, "https://custom.endpoint.io");
	});

	it("buildCommandSpec() — default baseUrl does not set ANTHROPIC_BASE_URL", () => {
		const spec = builder.buildCommandSpec("task", {
			modelName: "claude-sonnet-4-6",
			baseUrl: "https://api.anthropic.com",
			routeProvider: "anthropic",
		});
		assert.equal(spec.env.ANTHROPIC_BASE_URL, undefined);
	});
});

// ─── CodexCliBuilder ──────────────────────────────────────────────────────────

describe("CodexCliBuilder", () => {
	const builder = new CodexCliBuilder();
	const homeDir = "/home/codexuser";

	it("name is 'codex'", () => {
		assert.equal(builder.name, "codex");
	});

	it("executableName() returns 'codex'", () => {
		assert.equal(builder.executableName(), "codex");
	});

	it("defaultModel() returns gpt-4-turbo", () => {
		assert.equal(builder.defaultModel(), "gpt-4-turbo");
	});

	it("buildArgv() — includes 'exec' subcommand and bypass flag", () => {
		const argv = builder.buildArgv({ task: "write a test" });
		assert.equal(argv[0], "codex");
		assert.ok(argv.includes("exec"), "must include exec subcommand");
		assert.ok(
			argv.includes("--dangerously-bypass-approvals-and-sandbox"),
			"must include bypass flag",
		);
		assert.ok(argv.includes("write a test"), "must include task");
	});

	it("buildArgv() — with modelOverride", () => {
		const argv = builder.buildArgv({ task: "task", modelOverride: "gpt-4o" });
		assert.ok(argv.includes("--model"), "must include --model");
		assert.ok(argv.includes("gpt-4o"), "must include model name");
	});

	it("buildEnv() — sets HOME", () => {
		const env = builder.buildEnv({ homeDir });
		assert.equal(env.HOME, homeDir);
	});

	it("buildEnv() — injects OPENAI_API_KEY from vault", () => {
		const env = builder.buildEnv({
			homeDir,
			apiKeyVault: { OPENAI_API_KEY: "sk-openai-key" },
		});
		assert.equal(env.OPENAI_API_KEY, "sk-openai-key");
	});

	it("buildCommandSpec() — argv structure", () => {
		const spec = builder.buildCommandSpec("code task", {
			modelName: "gpt-4-turbo",
			baseUrl: "https://api.openai.com/v1",
			routeProvider: "openai",
		});
		assert.equal(spec.argv[0], "codex");
		assert.ok(spec.argv.includes("exec"), "must include exec");
		assert.ok(spec.argv.includes("--model"), "must include --model");
		assert.ok(spec.argv.includes("gpt-4-turbo"), "must include model");
	});

	it("buildCommandSpec() — non-default baseUrl sets OPENAI_BASE_URL", () => {
		const spec = builder.buildCommandSpec("task", {
			modelName: "gpt-4o",
			baseUrl: "https://custom-openai.example.com/v1",
			routeProvider: "azure",
		});
		assert.equal(
			spec.env.OPENAI_BASE_URL,
			"https://custom-openai.example.com/v1",
		);
	});
});

// ─── HermesCliBuilder ─────────────────────────────────────────────────────────

describe("HermesCliBuilder", () => {
	const builder = new HermesCliBuilder();
	const homeDir = "/home/hermesuser";

	it("name is 'hermes'", () => {
		assert.equal(builder.name, "hermes");
	});

	it("executableName() returns 'hermes'", () => {
		assert.equal(builder.executableName(), "hermes");
	});

	it("defaultModel() returns xiaomi/mimo-v2-omni", () => {
		assert.equal(builder.defaultModel(), "xiaomi/mimo-v2-omni");
	});

	it("buildArgv() — uses 'chat -q' subcommand and appends --yolo -Q", () => {
		const argv = builder.buildArgv({ task: "ask something" });
		assert.equal(argv[0], "hermes");
		assert.ok(argv.includes("chat"), "must include chat");
		assert.ok(argv.includes("-q"), "must include -q");
		assert.ok(argv.includes("--yolo"), "must include --yolo");
		assert.ok(argv.includes("-Q"), "must include -Q");
		assert.ok(argv.includes("ask something"), "must include task");
	});

	it("buildArgv() — modelOverride uses -m flag", () => {
		const argv = builder.buildArgv({ task: "task", modelOverride: "mimo-v3" });
		assert.ok(argv.includes("-m"), "must include -m");
		assert.ok(argv.includes("mimo-v3"), "must include model name");
	});

	it("buildEnv() — sets HOME", () => {
		const env = builder.buildEnv({ homeDir });
		assert.equal(env.HOME, homeDir);
	});

	it("buildEnv() — injects NOUS_API_KEY and maps to OPENAI_API_KEY", () => {
		const env = builder.buildEnv({
			homeDir,
			apiKeyVault: { NOUS_API_KEY: "nous-key-123" },
		});
		assert.equal(env.NOUS_API_KEY, "nous-key-123");
		assert.equal(env.OPENAI_API_KEY, "nous-key-123");
	});

	it("buildEnv() — XIAOMI_API_KEY maps to OPENAI_API_KEY", () => {
		const env = builder.buildEnv({
			homeDir,
			apiKeyVault: { XIAOMI_API_KEY: "xiaomi-key" },
		});
		assert.equal(env.XIAOMI_API_KEY, "xiaomi-key");
		assert.equal(env.OPENAI_API_KEY, "xiaomi-key");
	});

	it("buildCommandSpec() — includes provider flag from routeProvider", () => {
		const spec = builder.buildCommandSpec("task", {
			modelName: "mimo-v2-omni",
			baseUrl: "https://hermes.xiaomi.ai/v1",
			routeProvider: "xiaomi",
		});
		assert.ok(spec.argv.includes("--provider"), "must include --provider");
		assert.ok(spec.argv.includes("xiaomi"), "must include provider name");
		assert.ok(spec.argv.includes("-m"), "must include -m");
		assert.ok(spec.argv.includes("mimo-v2-omni"), "must include model");
	});
});

// ─── GeminiCliBuilder ─────────────────────────────────────────────────────────

describe("GeminiCliBuilder", () => {
	const builder = new GeminiCliBuilder();

	it("name is 'gemini'", () => {
		assert.equal(builder.name, "gemini");
	});

	it("buildArgv() — uses --prompt flag", () => {
		const argv = builder.buildArgv({ task: "my question" });
		assert.equal(argv[0], "gemini");
		assert.ok(argv.includes("--prompt"), "must include --prompt");
		assert.ok(argv.includes("my question"), "must include task");
	});

	it("buildEnv() — injects GEMINI_API_KEY", () => {
		const env = builder.buildEnv({
			homeDir: "/home/user",
			apiKeyVault: { GEMINI_API_KEY: "gemini-key-xyz" },
		});
		assert.equal(env.GEMINI_API_KEY, "gemini-key-xyz");
	});

	it("buildCommandSpec() — argv structure", () => {
		const spec = builder.buildCommandSpec("task", {
			modelName: "gemini-pro",
			baseUrl: "https://generativelanguage.googleapis.com",
			routeProvider: "google",
		});
		assert.equal(spec.argv[0], "gemini");
		assert.ok(spec.argv.includes("--model"), "must include --model");
		assert.ok(spec.argv.includes("gemini-pro"), "must include model name");
		assert.ok(spec.argv.includes("--prompt"), "must include --prompt");
	});
});

// ─── CopilotCliBuilder ────────────────────────────────────────────────────────

describe("CopilotCliBuilder", () => {
	const builder = new CopilotCliBuilder();

	it("name is 'copilot'", () => {
		assert.equal(builder.name, "copilot");
	});

	it("executableName() returns 'gh'", () => {
		assert.equal(builder.executableName(), "gh");
	});

	it("buildArgv() — uses 'gh copilot suggest' subcommand", () => {
		const argv = builder.buildArgv({ task: "write a function" });
		assert.equal(argv[0], "gh");
		assert.ok(argv.includes("copilot"), "must include copilot");
		assert.ok(argv.includes("suggest"), "must include suggest");
		assert.ok(argv.includes("write a function"), "must include task");
	});

	it("buildEnv() — injects GITHUB_TOKEN", () => {
		const env = builder.buildEnv({
			homeDir: "/home/user",
			apiKeyVault: { GITHUB_TOKEN: "ghp_testtoken" },
		});
		assert.equal(env.GITHUB_TOKEN, "ghp_testtoken");
	});

	it("buildCommandSpec() — argv includes --model and task", () => {
		const spec = builder.buildCommandSpec("refactor this", {
			modelName: "gpt-4",
			baseUrl: "https://api.github.com",
			routeProvider: "github",
		});
		assert.ok(spec.argv.includes("gh"), "must include gh");
		assert.ok(spec.argv.includes("--model"), "must include --model");
		assert.ok(spec.argv.includes("gpt-4"), "must include model name");
		assert.ok(spec.argv.includes("refactor this"), "must include task");
	});
});

// ─── AgyCliBuilder ───────────────────────────────────────────────────────────

describe("AgyCliBuilder", () => {
	const builder = new AgyCliBuilder();

	it("name is 'agy'", () => {
		assert.equal(builder.name, "agy");
	});

	it("executableName() returns 'agy'", () => {
		assert.equal(builder.executableName(), "agy");
	});

	it("defaultModel() returns Gemini 3.5 Flash (Medium)", () => {
		assert.equal(builder.defaultModel(), "Gemini 3.5 Flash (Medium)");
	});

	it("buildArgv() — basic task", () => {
		const argv = builder.buildArgv({ task: "run diagnostics" });
		assert.equal(argv[0], "agy");
		assert.ok(argv.includes("-p"), "must include -p");
		assert.ok(argv.includes("run diagnostics"), "must include task");
		assert.ok(
			argv.includes("--dangerously-skip-permissions"),
			"must skip permissions",
		);
		assert.ok(argv.includes("--add-dir"), "must include add-dir");
	});

	it("buildArgv() — with modelOverride and flags", () => {
		const argv = builder.buildArgv({
			task: "task",
			modelOverride: "Claude Sonnet 4.6 (Thinking)",
			flags: { "add-dir": "/tmp/worktree" },
		});
		assert.ok(argv.includes("--model"), "must include --model");
		assert.ok(
			argv.includes("Claude Sonnet 4.6 (Thinking)"),
			"must include custom model",
		);
		assert.ok(argv.includes("/tmp/worktree"), "must include custom add-dir");
	});

	it("buildEnv() — sets HOME", () => {
		const env = builder.buildEnv({ homeDir: "/home/user" });
		assert.equal(env.HOME, "/home/user");
	});

	it("buildCommandSpec() — argv structure", () => {
		const spec = builder.buildCommandSpec("review code", {
			modelName: "Claude Sonnet 4.6 (Thinking)",
			baseUrl: "http://127.0.0.1:6421/mcp-streamable",
			routeProvider: "anthropic",
		});
		assert.equal(spec.argv[0], "agy");
		assert.ok(spec.argv.includes("-p"), "must include -p");
		assert.ok(spec.argv.includes("--model"), "must include --model");
		assert.ok(
			spec.argv.includes("Claude Sonnet 4.6 (Thinking)"),
			"must include model",
		);
		assert.ok(spec.argv.includes("--add-dir"), "must include --add-dir");
	});
});

// ─── Registry ─────────────────────────────────────────────────────────────────

describe("CLI builder registry", () => {
	it("getCliBuilder('claude') returns ClaudeCliBuilder", () => {
		assert.equal(getCliBuilder("claude").name, "claude");
	});

	it("getCliBuilder('codex') returns CodexCliBuilder", () => {
		assert.equal(getCliBuilder("codex").name, "codex");
	});

	it("getCliBuilder('hermes') returns HermesCliBuilder", () => {
		assert.equal(getCliBuilder("hermes").name, "hermes");
	});

	it("getCliBuilder('gemini') returns GeminiCliBuilder", () => {
		assert.equal(getCliBuilder("gemini").name, "gemini");
	});

	it("getCliBuilder('copilot') returns CopilotCliBuilder", () => {
		assert.equal(getCliBuilder("copilot").name, "copilot");
	});

	it("getCliBuilder('agy') returns AgyCliBuilder", () => {
		assert.equal(getCliBuilder("agy").name, "agy");
	});

	it("getCliBuilder('unknown') falls back to hermes", () => {
		assert.equal(getCliBuilder("unknown-cli").name, "hermes");
	});

	it("isKnownCli() returns true for all six CLIs", () => {
		for (const name of [
			"claude",
			"codex",
			"hermes",
			"gemini",
			"copilot",
			"agy",
		]) {
			assert.ok(isKnownCli(name), `${name} must be a known CLI`);
		}
	});

	it("isKnownCli() returns false for unknown CLI", () => {
		assert.equal(isKnownCli("opencode"), false);
	});

	it("listCliNames() contains all six CLIs", () => {
		const names = listCliNames();
		for (const name of [
			"claude",
			"codex",
			"hermes",
			"gemini",
			"copilot",
			"agy",
		]) {
			assert.ok(
				names.includes(name as never),
				`${name} must be in listCliNames()`,
			);
		}
		assert.equal(names.length, 6);
	});
});
