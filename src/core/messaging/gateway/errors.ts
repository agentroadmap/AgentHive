/**
 * P304: gateway-specific error types.
 */

export class TransportWakeTimeoutError extends Error {
  readonly transportId: string;
  readonly timeoutMs: number;

  constructor(transportId: string, timeoutMs: number) {
    super(`Transport "${transportId}" did not come online within ${timeoutMs}ms`);
    this.transportId = transportId;
    this.timeoutMs = timeoutMs;
    this.name = 'TransportWakeTimeoutError';
  }
}
