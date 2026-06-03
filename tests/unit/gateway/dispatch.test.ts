import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  FailureAction,
  NotificationChannel,
  OutboundMessage,
  SendResult,
  TransportAdapter,
} from "../../../src/core/messaging/gateway/adapter.ts";

/**
 * Stub adapter factory for testing the isAvailable / wakeUp fast-path logic.
 */
function makeStubAdapter(opts: {
  channel?: NotificationChannel;
  available: boolean;
}): TransportAdapter & { wakeUpCallCount: number; sendCallCount: number } {
  let wakeUpCallCount = 0;
  let sendCallCount = 0;
  return {
    transportId: "stub-transport",
    channel: opts.channel ?? "discord",
    isAvailable: async () => opts.available,
    wakeUp: async () => {
      wakeUpCallCount++;
    },
    send: async (_msg: OutboundMessage): Promise<SendResult> => {
      sendCallCount++;
      return { success: true };
    },
    onFailure: async (_msg: OutboundMessage, _err: Error): Promise<FailureAction> => "retry",
    get wakeUpCallCount() { return wakeUpCallCount; },
    get sendCallCount() { return sendCallCount; },
  };
}

/** Simulates the gateway dispatch fast-path: isAvailable true → skip wakeUp. */
async function dispatchWithWakeCheck(
  adapter: TransportAdapter,
  msg: OutboundMessage,
): Promise<SendResult> {
  const available = await adapter.isAvailable();
  if (!available) {
    await adapter.wakeUp();
  }
  return adapter.send(msg);
}

const sampleMsg: OutboundMessage = {
  notificationId: 1n,
  channel: "discord",
  title: "Test",
  body: "Test body",
};

describe("dispatch wake-up fast-path", () => {
  it("does NOT call wakeUp when isAvailable returns true (AC#10)", async () => {
    const adapter = makeStubAdapter({ available: true });
    await dispatchWithWakeCheck(adapter, sampleMsg);
    assert.equal(adapter.wakeUpCallCount, 0, "wakeUp must not be called when transport is available");
    assert.equal(adapter.sendCallCount, 1);
  });

  it("calls wakeUp exactly once when isAvailable returns false", async () => {
    const adapter = makeStubAdapter({ available: false });
    await dispatchWithWakeCheck(adapter, sampleMsg);
    assert.equal(adapter.wakeUpCallCount, 1, "wakeUp must be called once when transport is offline");
    assert.equal(adapter.sendCallCount, 1);
  });

  it("does NOT call wakeUp across 10 messages when always available (AC#10 at scale)", async () => {
    const adapter = makeStubAdapter({ available: true });
    for (let i = 0; i < 10; i++) {
      await dispatchWithWakeCheck(adapter, { ...sampleMsg, notificationId: BigInt(i) });
    }
    assert.equal(adapter.wakeUpCallCount, 0, "wakeUp must never be called when transport is always available");
    assert.equal(adapter.sendCallCount, 10);
  });
});
