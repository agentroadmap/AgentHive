/**
 * P304: Gateway module public surface.
 */

export type {
  FailureAction,
  NotificationChannel,
  OutboundMessage,
  SendResult,
  TransportAdapter,
} from './adapter.ts';

export type { BackoffStep } from './backoff.ts';
export { BACKOFF_POLICY, retryWithBackoff } from './backoff.ts';

export { checkDlqDepthAndAlert, moveToDlq } from './dlq.ts';

export { TransportWakeTimeoutError } from './errors.ts';

export { TransportRegistry } from './registry.ts';
