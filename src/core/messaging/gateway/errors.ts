/**
 * P304: gateway-specific error types.
 */

export class TransportWakeTimeoutError extends Error {
  constructor(
    readonly transportId: string,
    readonly timeoutMs: number,
  ) {
    super(
      `Transport "${transportId}" did not come online within ${timeoutMs}ms`,
    );
    this.name = 'TransportWakeTimeoutError';
  }
}
