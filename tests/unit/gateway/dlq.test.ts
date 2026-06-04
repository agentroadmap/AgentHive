import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { OutboundMessage } from "../../../src/core/messaging/gateway/adapter.ts";
import {
  checkDlqDepthAndAlert,
  moveToDlq,
} from "../../../src/core/messaging/gateway/dlq.ts";

/** Minimal in-memory pool mock for unit-testing moveToDlq without a real DB. */
function makeMockPool(opts: {
  dlqDepth?: number;
  failOnInsert?: boolean;
}) {
  const notificationQueue: Array<{ id: bigint; status: string }> = [
    { id: 1n, status: "pending" },
  ];
  const dlqRows: Array<{ notification_id: bigint; channel: string; last_error: string; attempt_count: number }> = [];
  const alertRows: Array<{ channel: string; title: string; severity: string }> = [];
  let inTransaction = false;

  const client = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql === "BEGIN") { inTransaction = true; return { rows: [] }; }
      if (sql === "ROLLBACK") { inTransaction = false; return { rows: [] }; }
      if (sql === "COMMIT") { inTransaction = false; return { rows: [] }; }

      if (sql.includes("UPDATE roadmap.notification_queue") && sql.includes("status = 'failed'")) {
        const id = params![0] as bigint;
        const row = notificationQueue.find((r) => r.id === id);
        if (row) row.status = "failed";
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO roadmap.notification_dlq")) {
        if (opts.failOnInsert) throw new Error("DB write failure");
        dlqRows.push({
          notification_id: params![0] as bigint,
          channel: params![1] as string,
          last_error: params![2] as string,
          attempt_count: params![3] as number,
        });
        return { rows: [] };
      }
      return { rows: [] };
    },
    release: () => {},
  };

  const pool = {
    connect: async () => client,
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("COUNT(*)") && sql.includes("notification_dlq")) {
        return { rows: [{ depth: String(opts.dlqDepth ?? 0) }] };
      }
      if (sql.includes("INSERT INTO roadmap.notification_queue") && sql.includes("DLQ Depth Alert")) {
        alertRows.push({ channel: "discord", title: "DLQ Depth Alert", severity: "URGENT" });
        return { rows: [] };
      }
      return { rows: [] };
    },
    _notificationQueue: notificationQueue,
    _dlqRows: dlqRows,
    _alertRows: alertRows,
  };

  return pool;
}

const sampleMsg: OutboundMessage = {
  notificationId: 1n,
  channel: "discord",
  title: "Alert",
  body: "Something failed",
};

describe("moveToDlq", () => {
  it("sets notification_queue.status=failed and inserts dlq row (AC#8)", async () => {
    const pool = makeMockPool({});
    await moveToDlq(pool as never, sampleMsg, 4, "SEND_FAILED");

    const qRow = pool._notificationQueue.find((r) => r.id === 1n);
    assert.equal(qRow?.status, "failed", "notification_queue.status must be failed");

    assert.equal(pool._dlqRows.length, 1, "dlq row must be inserted");
    assert.equal(pool._dlqRows[0].attempt_count, 4);
    assert.equal(pool._dlqRows[0].channel, "discord");
  });

  it("uses 'unknown' as default error code when errorCode is omitted", async () => {
    const pool = makeMockPool({});
    await moveToDlq(pool as never, sampleMsg, 4);
    assert.equal(pool._dlqRows[0].last_error, "unknown");
  });
});

describe("checkDlqDepthAndAlert", () => {
  it("inserts URGENT discord alert when depth > 10 (AC#11)", async () => {
    const pool = makeMockPool({ dlqDepth: 11 });
    await checkDlqDepthAndAlert(pool as never);
    assert.equal(pool._alertRows.length, 1);
    assert.equal(pool._alertRows[0].severity, "URGENT");
    assert.equal(pool._alertRows[0].channel, "discord");
  });

  it("does NOT insert alert when depth <= 10", async () => {
    const pool = makeMockPool({ dlqDepth: 10 });
    await checkDlqDepthAndAlert(pool as never);
    assert.equal(pool._alertRows.length, 0);
  });

  it("does NOT insert alert when depth is zero", async () => {
    const pool = makeMockPool({ dlqDepth: 0 });
    await checkDlqDepthAndAlert(pool as never);
    assert.equal(pool._alertRows.length, 0);
  });
});
