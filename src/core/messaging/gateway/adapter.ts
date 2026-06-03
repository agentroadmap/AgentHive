/**
 * P304: TransportAdapter interface.
 *
 * Transport adapters normalize inbound/outbound messages and emit wake-up
 * events. They must NOT contain dispatch, routing, gate, or scheduling logic.
 */

export type NotificationChannel = 'discord' | 'email' | 'sms' | 'push' | 'digest';
export type FailureAction = 'retry' | 'dlq' | 'drop';

export interface OutboundMessage {
  notificationId: bigint;
  channel: NotificationChannel;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
}

export interface SendResult {
  success: boolean;
  /** Transport-assigned message ID for dedup. */
  externalId?: string;
  errorCode?: string;
}

export interface TransportAdapter {
  readonly transportId: string;
  readonly channel: NotificationChannel;

  /** True if the transport is ready to accept messages right now. */
  isAvailable(): Promise<boolean>;

  /**
   * Attempt to bring the transport online; resolves when ready or rejects
   * after wakeTimeoutMs. Idempotent.
   */
  wakeUp(wakeTimeoutMs?: number): Promise<void>;

  send(msg: OutboundMessage): Promise<SendResult>;

  /** Called by the gateway on send failure. Returns desired failure action. */
  onFailure(msg: OutboundMessage, err: Error): Promise<FailureAction>;
}
