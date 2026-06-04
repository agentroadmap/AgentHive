import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BACKOFF_POLICY,
  retryWithBackoff,
} from "../../../src/core/messaging/gateway/backoff.ts";
import type { SendResult } from "../../../src/core/messaging/gateway/adapter.ts";

describe("BACKOFF_POLICY", () => {
  it("has 5 steps with last step as dlq", () => {
    assert.equal(BACKOFF_POLICY.length, 5);
    assert.equal(BACKOFF_POLICY[4].onFail, "dlq");
  });

  it("first four steps are retry", () => {
    for (let i = 0; i < 4; i++) {
      assert.equal(BACKOFF_POLICY[i].onFail, "retry");
    }
  });
});

describe("retryWithBackoff", () => {
  it("returns success immediately on first success", async () => {
    const calls: number[] = [];
    const result = await retryWithBackoff(
      async () => {
        calls.push(1);
        return { success: true, externalId: "ok" };
      },
      BACKOFF_POLICY,
    );
    assert.equal(result.success, true);
    assert.equal(calls.length, 1);
  });

  it("short-circuits on success at attempt 2", async () => {
    let callCount = 0;
    const zeroDelayPolicy = BACKOFF_POLICY.map((s) => ({ ...s, delay: 0 }));
    const result = await retryWithBackoff(
      async (): Promise<SendResult> => {
        callCount++;
        if (callCount < 2) return { success: false, errorCode: "TRANSIENT" };
        return { success: true };
      },
      zeroDelayPolicy,
    );
    assert.equal(result.success, true);
    assert.equal(callCount, 2);
  });

  it("exhausts 4 retries then triggers dlq step", async () => {
    let callCount = 0;
    const zeroDelayPolicy = BACKOFF_POLICY.map((s) => ({ ...s, delay: 0 }));
    const result = await retryWithBackoff(
      async (): Promise<SendResult> => {
        callCount++;
        return { success: false, errorCode: "PERM_FAIL" };
      },
      zeroDelayPolicy,
    );
    // 5 calls (4 retries + 1 dlq step) then exits loop
    assert.equal(callCount, 5);
    assert.equal(result.success, false);
    assert.equal(result.errorCode, "PERM_FAIL");
  });
});
