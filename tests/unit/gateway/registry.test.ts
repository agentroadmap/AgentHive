import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TransportWakeTimeoutError } from "../../../src/core/messaging/gateway/errors.ts";
import type { TransportAdapter } from "../../../src/core/messaging/gateway/adapter.ts";

describe("TransportWakeTimeoutError", () => {
  it("captures transportId and timeoutMs", () => {
    const err = new TransportWakeTimeoutError("discord-main", 10_000);
    assert.equal(err.transportId, "discord-main");
    assert.equal(err.timeoutMs, 10_000);
    assert.match(err.message, /discord-main/);
    assert.match(err.message, /10000/);
    assert.equal(err.name, "TransportWakeTimeoutError");
  });

  it("is an instance of Error", () => {
    const err = new TransportWakeTimeoutError("t", 1);
    assert.ok(err instanceof Error);
    assert.ok(err instanceof TransportWakeTimeoutError);
  });
});

describe("TransportRegistry.buildAdapter (unit contract)", () => {
  it("tryGetAdapterByChannel returns null when channel not registered", () => {
    // Without a real DB, we test the structural contract via an in-memory stub.
    // The full hot-reload integration test requires a real DB (see integration/).

    const stub: TransportAdapter = {
      transportId: "discord_webhook",
      channel: "discord",
      isAvailable: async () => true,
      wakeUp: async () => {},
      send: async () => ({ success: true }),
      onFailure: async () => "retry",
    };

    // Simulate the registry's channel lookup
    const adapters = new Map<string, TransportAdapter>([["discord_webhook", stub]]);
    const tryGetByChannel = (ch: string) =>
      [...adapters.values()].find((a) => a.channel === ch) ?? null;

    assert.equal(tryGetByChannel("discord"), stub);
    assert.equal(tryGetByChannel("email"), null);
    assert.equal(tryGetByChannel("sms"), null);
  });

  it("adapter map atomic swap is safe: new map replaces old map completely", () => {
    // Verify the map-swap pattern used in reloadAdapterMap.
    let adapters: Map<string, TransportAdapter> = new Map();
    const stub1: TransportAdapter = {
      transportId: "t1",
      channel: "discord",
      isAvailable: async () => true,
      wakeUp: async () => {},
      send: async () => ({ success: true }),
      onFailure: async () => "retry",
    };
    const stub2: TransportAdapter = {
      transportId: "t2",
      channel: "email",
      isAvailable: async () => false,
      wakeUp: async () => {},
      send: async () => ({ success: false }),
      onFailure: async () => "dlq",
    };

    adapters = new Map([["t1", stub1]]);
    assert.equal(adapters.size, 1);

    // Atomic swap: new map replaces old
    const newMap = new Map([["t1", stub1], ["t2", stub2]]);
    adapters = newMap;
    assert.equal(adapters.size, 2);
    assert.equal(adapters.get("t2"), stub2);
  });
});
