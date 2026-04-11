/**
 * SpacetimeDB WebSocket Subscription Client
 * 
 * Provides real-time push notifications for table changes.
 * Subscribes to SQL queries and fires callbacks when rows are inserted/updated/deleted.
 */

import { exec } from 'child_process';
import { EventEmitter } from 'events';

export interface SubscriptionConfig {
  server: string;
  database: string;
  query: string;
  onInsert?: (row: any) => void;
  onUpdate?: (row: any) => void;
  onDelete?: (row: any) => void;
}

export class SpacetimeSubscription extends EventEmitter {
  private process: any = null;
  private config: SubscriptionConfig;

  constructor(config: SubscriptionConfig) {
    super();
    this.config = config;
  }

  /**
   * Start the subscription
   */
  start(): void {
    const { server, database, query } = this.config;
    
    // Use spacetime subscribe command
    this.process = exec(
      `spacetime subscribe --server ${server} ${database} "${query}"`,
      { encoding: 'utf8' }
    );

    this.process.stdout?.on('data', (data: string) => {
      try {
        const lines = data.split('\n').filter(line => line.trim());
        for (const line of lines) {
          if (line.startsWith('{')) {
            const update = JSON.parse(line);
            this.handleUpdate(update);
          }
        }
      } catch (error) {
        this.emit('error', error);
      }
    });

    this.process.stderr?.on('data', (data: string) => {
      this.emit('error', new Error(data));
    });

    this.process.on('close', (code: number) => {
      this.emit('close', code);
    });
  }

  /**
   * Stop the subscription
   */
  stop(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  /**
   * Handle subscription updates
   */
  private handleUpdate(update: any): void {
    for (const [table, changes] of Object.entries(update)) {
      const { inserts, deletes } = changes as any;

      if (inserts && inserts.length > 0) {
        for (const row of inserts) {
          this.emit('insert', { table, row });
          this.config.onInsert?.(row);
        }
      }

      if (deletes && deletes.length > 0) {
        for (const row of deletes) {
          this.emit('delete', { table, row });
          this.config.onDelete?.(row);
        }
      }
    }
  }
}

/**
 * Create a message subscription for a specific channel
 */
export function subscribeToChannel(
  server: string,
  database: string,
  channel: string,
  callback: (message: any) => void
): SpacetimeSubscription {
  const query = `SELECT * FROM message_ledger WHERE channel_name = '${channel}'`;
  
  const subscription = new SpacetimeSubscription({
    server,
    database,
    query,
    onInsert: callback
  });

  subscription.start();
  return subscription;
}

/**
 * Create a subscription for all messages
 */
export function subscribeToAllMessages(
  server: string,
  database: string,
  callback: (message: any) => void
): SpacetimeSubscription {
  const query = `SELECT * FROM message_ledger`;
  
  const subscription = new SpacetimeSubscription({
    server,
    database,
    query,
    onInsert: callback
  });

  subscription.start();
  return subscription;
}
