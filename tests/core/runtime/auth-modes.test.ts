/**
 * P228: Cubic Runtime Abstraction — Auth Modes Unit Tests
 *
 * Pure unit tests — no DB, no network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildHostInheritEnv,
  buildKeyInjectEnv,
  resolveAuthEnv,
  resolveCubicRuntimeMetadata,
  CUBIC_RUNTIME_DEFAULTS,
} from "../../../src/core/runtime/auth-modes.ts";

describe("buildHostInheritEnv()", () => {
  it("sets HOME to the provided homeDir", () => {
    const env = buildHostInheritEnv({ homeDir: "/home/alice" });
    assert.equal(env.HOME, "/home/alice");
  });

  it("prepends extraPathDirs to PATH", () => {
    const env = buildHostInheritEnv({
      homeDir: "/home/alice",
      extraPathDirs: ["/usr/local/agents/bin"],
    });
    assert.ok(env.PATH !== undefined, "PATH must be defined");
    assert.ok(
      env.PATH!.startsWith("/usr/local/agents/bin:"),
      `PATH must start with injected dir, got: ${env.PATH}`,
    );
  });

  it("does not set PATH when extraPathDirs is empty", () => {
    const env = buildHostInheritEnv({ homeDir: "/home/alice", extraPathDirs: [] });
    assert.equal(env.PATH, undefined);
  });

  it("does not set PATH when extraPathDirs is omitted", () => {
    const env = buildHostInheritEnv({ homeDir: "/home/alice" });
    assert.equal(env.PATH, undefined);
  });
});

describe("buildKeyInjectEnv()", () => {
  it("sets HOME", () => {
    const env = buildKeyInjectEnv({
      homeDir: "/var/lib/agent",
      apiKeyVault: { ANTHROPIC_API_KEY: "sk-test" },
    });
    assert.equal(env.HOME, "/var/lib/agent");
  });

  it("injects all vault entries into env", () => {
    const vault = { ANTHROPIC_API_KEY: "sk-a", OPENAI_API_KEY: "sk-b" };
    const env = buildKeyInjectEnv({ homeDir: "/tmp", apiKeyVault: vault });
    assert.equal(env.ANTHROPIC_API_KEY, "sk-a");
    assert.equal(env.OPENAI_API_KEY, "sk-b");
  });
});

describe("resolveAuthEnv()", () => {
  it("uses keyInject path when mode=key_inject", () => {
    const env = resolveAuthEnv({
      mode: "key_inject",
      keyInject: {
        homeDir: "/home/bot",
        apiKeyVault: { ANTHROPIC_API_KEY: "sk-injected" },
      },
    });
    assert.equal(env.ANTHROPIC_API_KEY, "sk-injected");
    assert.equal(env.HOME, "/home/bot");
  });

  it("uses hostInherit path when mode=host_inherit", () => {
    const env = resolveAuthEnv({
      mode: "host_inherit",
      hostInherit: { homeDir: "/home/gary" },
    });
    assert.equal(env.HOME, "/home/gary");
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
  });

  it("falls back gracefully when sub-options are not provided", () => {
    const env = resolveAuthEnv({ mode: "host_inherit" });
    assert.ok(env.HOME !== undefined, "HOME must be defined in fallback");
  });
});

describe("resolveCubicRuntimeMetadata()", () => {
  it("fills in all defaults for empty partial", () => {
    const meta = resolveCubicRuntimeMetadata({});
    assert.equal(meta.agent_cli, CUBIC_RUNTIME_DEFAULTS.agent_cli);
    assert.equal(meta.auth_mode, CUBIC_RUNTIME_DEFAULTS.auth_mode);
    assert.equal(meta.host, CUBIC_RUNTIME_DEFAULTS.host);
  });

  it("overrides agent_cli and auth_mode, keeps default host", () => {
    const meta = resolveCubicRuntimeMetadata({
      agent_cli: "codex",
      auth_mode: "key_inject",
    });
    assert.equal(meta.agent_cli, "codex");
    assert.equal(meta.auth_mode, "key_inject");
    assert.equal(meta.host, CUBIC_RUNTIME_DEFAULTS.host);
  });

  it("preserves model_override when set", () => {
    const meta = resolveCubicRuntimeMetadata({ model_override: "claude-opus-4-7" });
    assert.equal(meta.model_override, "claude-opus-4-7");
  });

  it("model_override absent in defaults", () => {
    const meta = resolveCubicRuntimeMetadata({});
    assert.equal(meta.model_override, undefined);
  });
});
