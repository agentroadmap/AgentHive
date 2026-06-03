/**
 * P304: TransportRegistry with DB-backed hot-reload.
 *
 * Listens for pg_notify('transport_registry_changed') and reloads the
 * in-memory adapter map within 2 seconds — no process restart required.
 *
 * The adapters map is swapped atomically. Node.js single-threaded event loop
 * guarantees no torn read during the swap.
 */

import type { Pool, PoolClient } from 'pg';

import { resolveTransport } from '../../notifications/transport-registry.ts';
import type {
  DispatchArgs,
  NotificationEnvelope,
  NotificationRoute,
} from '../../notifications/types.ts';
import type { NotificationChannel, OutboundMessage, SendResult, TransportAdapter } from './adapter.ts';
import { TransportWakeTimeoutError } from './errors.ts';

const WAKE_POLL_MS = 500;
const DEFAULT_WAKE_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Maps a channel name to the static transport registry name. */
function channelToTransportName(channel: string): string {
  return channel === 'discord' ? 'discord_webhook' : channel;
}

function msgToEnvelope(msg: OutboundMessage): NotificationEnvelope {
  return {
    queueId: Number(msg.notificationId),
    severity: 'INFO',
    kind: '',
    payload: msg.metadata ?? {},
    proposalId: null,
    title: msg.title,
    body: msg.body,
    createdAt: new Date(),
  };
}

function defaultRouteFor(channel: string): NotificationRoute {
  return {
    id: -1,
    kind: '',
    severityMin: 'INFO',
    transport: channelToTransportName(channel),
    target: null,
    template: null,
    priority: 0,
  };
}

interface RegistryRow {
  transport_id: string;
  channel: string;
  config: unknown;
}

export class TransportRegistry {
  private adapters: Map<string, TransportAdapter> = new Map();
  private listenClient!: PoolClient;
  private pool!: Pool;

  async initialize(db: Pool): Promise<void> {
    this.pool = db;
    this.listenClient = await db.connect();
    await this.listenClient.query('LISTEN transport_registry_changed');
    this.listenClient.on('notification', (note) => {
      if (note.channel === 'transport_registry_changed') {
        void this.reloadAdapterMap();
      }
    });
    await this.reloadAdapterMap();
  }

  async destroy(): Promise<void> {
    try {
      await this.listenClient.query('UNLISTEN transport_registry_changed');
    } catch { /* ignore */ }
    try {
      this.listenClient.release();
    } catch { /* ignore */ }
  }

  private async reloadAdapterMap(): Promise<void> {
    const { rows } = await this.pool.query<RegistryRow>(
      `SELECT transport_id, channel, config
         FROM roadmap.transport_registry
        WHERE status != 'offline'`,
    );
    const newMap = new Map<string, TransportAdapter>(
      rows.map((r) => [r.transport_id, this.buildAdapter(r)]),
    );
    // Atomic swap — safe due to Node.js single-threaded event loop.
    this.adapters = newMap;
  }

  buildAdapter(row: RegistryRow): TransportAdapter {
    const transportName = channelToTransportName(row.channel);
    const staticAdapter = resolveTransport(transportName);
    if (!staticAdapter) {
      throw new Error(`No static adapter for channel: ${row.channel} (tried ${transportName})`);
    }

    // Capture pool ref for availability checks inside the returned adapter.
    const pool = this.pool;
    const transportId = row.transport_id;
    const channel = row.channel as NotificationChannel;

    return {
      transportId,
      channel,

      isAvailable: async (): Promise<boolean> => {
        const { rows: r } = await pool.query<{ status: string }>(
          `SELECT status FROM roadmap.transport_registry WHERE transport_id = $1`,
          [transportId],
        );
        return r[0]?.status === 'online';
      },

      wakeUp: async (wakeTimeoutMs = DEFAULT_WAKE_TIMEOUT_MS): Promise<void> => {
        await pool.query(
          `SELECT pg_notify('transport_wake', $1)`,
          [JSON.stringify({ transport: transportId })],
        );
        const deadline = Date.now() + wakeTimeoutMs;
        while (Date.now() < deadline) {
          await sleep(WAKE_POLL_MS);
          const { rows: r } = await pool.query<{ status: string }>(
            `SELECT status FROM roadmap.transport_registry WHERE transport_id = $1`,
            [transportId],
          );
          if (r[0]?.status === 'online') return;
        }
        throw new TransportWakeTimeoutError(transportId, wakeTimeoutMs);
      },

      send: async (msg: OutboundMessage): Promise<SendResult> => {
        const dispatchArgs: DispatchArgs = {
          envelope: msgToEnvelope(msg),
          route: defaultRouteFor(row.channel),
        };
        try {
          await staticAdapter.send(dispatchArgs);
          return { success: true };
        } catch (err) {
          return { success: false, errorCode: (err as Error).message };
        }
      },

      onFailure: async (_msg: OutboundMessage, _err: Error): Promise<'retry'> => 'retry',
    };
  }

  /** Look up adapter by channel name (e.g. 'discord'). */
  getAdapter(channel: string): TransportAdapter {
    const adapter = [...this.adapters.values()].find((a) => a.channel === channel);
    if (!adapter) throw new Error(`No adapter registered for channel: ${channel}`);
    return adapter;
  }

  /** Look up adapter by transport_id. Returns null if not found. */
  tryGetAdapterById(transportId: string): TransportAdapter | null {
    return this.adapters.get(transportId) ?? null;
  }

  /** Non-throwing getAdapter: returns null if channel is not registered. */
  tryGetAdapterByChannel(channel: string): TransportAdapter | null {
    return [...this.adapters.values()].find((a) => a.channel === channel) ?? null;
  }

  /** Size of the current adapter map (for tests). */
  get size(): number {
    return this.adapters.size;
  }
}
