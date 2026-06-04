/**
 * P304: shared retry/backoff policy for transport dispatch.
 *
 * All transports benefit from this policy implemented once in the gateway.
 */

import type { FailureAction, SendResult } from './adapter.ts';

export interface BackoffStep {
  delay: number;
  onFail: FailureAction;
}

export const BACKOFF_POLICY: BackoffStep[] = [
  { delay:   5_000, onFail: 'retry' }, // attempt 1
  { delay:  15_000, onFail: 'retry' }, // attempt 2
  { delay:  60_000, onFail: 'retry' }, // attempt 3
  { delay: 300_000, onFail: 'retry' }, // attempt 4
  { delay:       0, onFail: 'dlq'  }, // attempt 5 → DLQ
];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function retryWithBackoff(
  fn: () => Promise<SendResult>,
  policy: BackoffStep[],
): Promise<SendResult> {
  let lastResult: SendResult | undefined;
  for (let i = 0; i < policy.length; i++) {
    const result = await fn();
    if (result.success) return result;
    lastResult = result;
    if (policy[i].onFail === 'dlq') break;
    await sleep(policy[i].delay);
  }
  return lastResult!;
}
