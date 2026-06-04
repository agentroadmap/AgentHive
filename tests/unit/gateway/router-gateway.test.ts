/**
 * P304: Router-level integration tests verifying NotificationRouter's use of
 * TransportRegistry. Exercises the wake-up fast-path (AC#10) and DLQ
 * fall-through (WAKE_TIMEOUT) through the actual router code path.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  FailureAction,
  NotificationChannel,
  OutboundMessage,
  SendResult,
  TransportAdapter,
} from "../../../src/core/messaging/gateway/adapter.ts";
import { TransportWakeTimeoutError } from "../../../src/core/messaging/gateway/errors.ts";
import type { TransportRegistry } from "../../../src/core/messaging/gateway/registry.ts";
import { NotificationRouter } from "../../../src/core/notifications/router.ts";

/** Minimal pending-row stub returned by the fake pool. */
function pendingRow(channel: string) {
  return {
    id: "1",
    severity: "INFO" as const,
    kind: "test.event",
    channel,
    proposal_id: null,
    title: "Test notification",
    body: "body",
    payload: null,
    metadata: null,
    created_at: new Date().toISOString(),
    dispatch_attempts: 0,
  };
}

/** Stub adapter factory. Tracks wakeUp and send invocations. */
function makeStubAdapter(opts: {
  channel: NotificationChannel;
  available: boolean;
  wakeUpError?: Error;
}): TransportAdapter & { wakeUpCalls: number; sendCalls: number } {
  let wakeUpCalls = 0;
  let sendCalls = 0;
  return {
    transportId: `stub-${opts.channel}`,
    channel: opts.channel,
    isAvailable: async () => opts.available,
    wakeUp: async () => {
      wakeUpCalls++;
      if (opts.wakeUpError) throw opts.wakeUpError;
    },
    send: async (_msg: OutboundMessage): Promise<SendResult> => {
      sendCalls++;
      return { success: true };
    },
    onFailure: async (_msg: OutboundMessage, _err: Error): Promise<FailureAction> => "retry",
    get wakeUpCalls() { return wakeUpCalls; },
    get sendCalls() { return sendCalls; },
  };
}

/** Build a mock TransportRegistry with one adapter. */
function makeRegistry(adapter: TransportAdapter): TransportRegistry {
  return {
    tryGetAdapterByChannel: (ch: string) =>
      ch === adapter.channel ? adapter : null,
    tryGetAdapterById: (id: string) =>
      id === adapter.transportId ? adapter : null,
    getAdapter: (ch: string) => {
      if (ch === adapter.channel) return adapter;
      throw new Error(`No adapter for channel: ${ch}`);
    },
    size: 1,
    initialize: async () => {},
    destroy: async () => {},
    buildAdapter: () => { throw new Error("not implemented in stub"); },
  } as unknown as TransportRegistry;
}

/** Listener stub: does nothing, satisfies the factory signature. */
function makeListenerStub() {
  let onNotification: ((n: { channel: string }) => void) | null = null;
  let onError: ((e: Error) => void) | null = null;
  const client = {
    query: async (_sql: string) => ({ rows: [] }),
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (event === "notification") onNotification = handler as typeof onNotification;
      if (event === "error") onError = handler as typeof onError;
    },
    end: async () => {},
  };
  return {
    factory: async () => client as any,
    emit: (channel: string) => onNotification?.({ channel }),
    emitError: (e: Error) => onError?.(e),
  };
}

/**
 * Minimal pool mock: returns one pending row from claimBatch, then no rows.
 * Absorbs UPDATE (markSent, recordAttempt) and route queries.
 */
function makePoolMock(channel: string) {
  const sentIds: string[] = [];
  const dlqIds: string[] = [];
  let claimCallCount = 0;

  const pool = {
    query: async (sql: string, _params?: unknown[]) => {
      if (/notification_queue.*WHERE status = 'pending'/s.test(sql)) {
        claimCallCount++;
        // Return one row on first call, empty on subsequent calls to stop the loop.
        if (claimCallCount === 1) return { rows: [pendingRow(channel)] };
        return { rows: [] };
      }
      if (/notification_route/.test(sql)) {
        // No routes — row will be marked suppressed.
        return { rows: [] };
      }
      if (/UPDATE roadmap.notification_queue.*SET status = 'sent'/s.test(sql)) {
        sentIds.push(String((_params as unknown[])[0]));
        return { rows: [] };
      }
      if (/UPDATE roadmap.notification_queue.*SET status = 'suppressed'/s.test(sql)) {
        return { rows: [] };
      }
      if (/UPDATE roadmap.notification_queue.*SET status = 'failed'/s.test(sql)) {
        return { rows: [] };
      }
      if (/notification_dlq/.test(sql)) {
        dlqIds.push(String((_params as unknown[])[0]));
        return { rows: [] };
      }
      if (/COUNT\(\*\).*notification_dlq/si.test(sql)) {
        return { rows: [{ depth: "0" }] };
      }
      return { rows: [] };
    },
    connect: async () => ({
      query: async (_sql: string, _p?: unknown[]) => ({ rows: [] }),
      release: () => {},
    }),
    _sentIds: sentIds,
    _dlqIds: dlqIds,
  };
  return pool;
}

describe("NotificationRouter + TransportRegistry (AC#10)", () => {
  it("does NOT call wakeUp when isAvailable()=true for a pending notification", async () => {
    const adapter = makeStubAdapter({ channel: "discord", available: true });
    const registry = makeRegistry(adapter);
    const pool = makePoolMock("discord");
    const listener = makeListenerStub();

    const router = new NotificationRouter({
      pool: pool as any,
      listenerFactory: listener.factory,
      log: () => {},
      warn: () => {},
      error: () => {},
      transportRegistry: registry,
    });

    await router.run();
    await router.stop();

    assert.equal(adapter.wakeUpCalls, 0, "wakeUp must not be called when transport is available");
  });

  it("calls wakeUp exactly once when isAvailable()=false", async () => {
    const adapter = makeStubAdapter({ channel: "discord", available: false });
    const registry = makeRegistry(adapter);
    const pool = makePoolMock("discord");
    const listener = makeListenerStub();

    const router = new NotificationRouter({
      pool: pool as any,
      listenerFactory: listener.factory,
      log: () => {},
      warn: () => {},
      error: () => {},
      transportRegistry: registry,
    });

    await router.run();
    await router.stop();

    assert.equal(adapter.wakeUpCalls, 1, "wakeUp must be called once when transport is offline");
  });

  it("moves row to DLQ on WAKE_TIMEOUT when dispatch_attempts >= MAX_ATTEMPTS", async () => {
    const timeout = new TransportWakeTimeoutError("discord-main", 10_000);
    const adapter = makeStubAdapter({
      channel: "discord",
      available: false,
      wakeUpError: timeout,
    });
    const registry = makeRegistry(adapter);

    // Return a row that is already at MAX_ATTEMPTS-1 so the next failure triggers DLQ.
    const row = { ...pendingRow("discord"), dispatch_attempts: 4 };
    const dlqIds: string[] = [];
    let claimCount = 0;

    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        if (/notification_queue.*WHERE status = 'pending'/s.test(sql)) {
          claimCount++;
          if (claimCount === 1) return { rows: [row] };
          return { rows: [] };
        }
        if (/UPDATE roadmap.notification_queue.*SET status = 'failed'/s.test(sql)) {
          return { rows: [] };
        }
        if (/INSERT INTO roadmap.notification_dlq/s.test(sql)) {
          dlqIds.push(String((params as unknown[])[0]));
          return { rows: [] };
        }
        if (/COUNT\(\*\).*notification_dlq/si.test(sql)) {
          return { rows: [{ depth: "0" }] };
        }
        return { rows: [] };
      },
      connect: async () => ({
        query: async (sql: string, p?: unknown[]) => {
          if (/UPDATE roadmap.notification_queue.*SET status = 'failed'/s.test(sql)) {
            return { rows: [] };
          }
          if (/INSERT INTO roadmap.notification_dlq/s.test(sql)) {
            dlqIds.push(String((p as unknown[])[0]));
            return { rows: [] };
          }
          return { rows: [] };
        },
        release: () => {},
      }),
    };

    const listener = makeListenerStub();
    const router = new NotificationRouter({
      pool: pool as any,
      listenerFactory: listener.factory,
      log: () => {},
      warn: () => {},
      error: () => {},
      transportRegistry: registry,
    });

    await router.run();
    await router.stop();

    assert.ok(dlqIds.length > 0, "DLQ insert must be triggered on WAKE_TIMEOUT with max attempts");
    assert.equal(adapter.wakeUpCalls, 1, "wakeUp must be called once before failing");
  });
});
