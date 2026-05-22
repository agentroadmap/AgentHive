/**
 * P1365-AC2: In-memory capacity tracker with throttle curve
 * Maintains EWMA burn-rate estimates and computes skip probability per throttle band
 */

import { CapacitySignal } from './rate-limit-parser';

export interface ThrottleDecision {
  action: 'none' | 'soft' | 'hard';
  p_skip: number; // 0..1; probability to skip spawning this candidate
  headroom_pct: number | null;
  reset_at: Date | null;
}

interface SampleRow {
  requests_remaining: number | null;
  tokens_remaining: number | null;
  requests_limit: number | null;
  tokens_limit: number | null;
  reset_at: Date | null;
  sampled_at: Date;
  burn_rate_per_sec: number | null;
}

interface TrackedEntry {
  key: string; // "${provider}:${model}:${agencyId}"
  provider: string;
  model: string;
  agencyId: string;
  samples: SampleRow[];
  burn_rate_per_sec: number | null; // Latest EWMA estimate
  throttle_action: 'none' | 'soft' | 'hard' | 'unknown';
  updated_at: Date;
}

export class CapacityTracker {
  private entries = new Map<string, TrackedEntry>();
  private readonly burnRateAlpha: number;

  constructor(burnRateAlpha: number = 0.3) {
    this.burnRateAlpha = burnRateAlpha;
  }

  /**
   * Record a single capacity signal (e.g., from API response headers)
   * Detects resets, computes burn rate, updates EWMA
   */
  recordSignal(signal: CapacitySignal, agencyId: string): void {
    const key = `${signal.provider}:${signal.model}:${agencyId}`;
    let entry = this.entries.get(key);

    if (!entry) {
      entry = {
        key,
        provider: signal.provider,
        model: signal.model,
        agencyId,
        samples: [],
        burn_rate_per_sec: null,
        throttle_action: 'unknown',
        updated_at: new Date(),
      };
      this.entries.set(key, entry);
    }

    // Detect reset: if remaining went UP, drop older sample
    const lastSample = entry.samples[entry.samples.length - 1];
    if (
      lastSample &&
      signal.tokens_remaining !== null &&
      lastSample.tokens_remaining !== null &&
      signal.tokens_remaining > lastSample.tokens_remaining
    ) {
      // Likely a window reset; discard last sample
      entry.samples.pop();
    }

    // Compute burn rate from previous sample
    let burnRate: number | null = null;
    if (lastSample && lastSample.tokens_remaining !== null && signal.tokens_remaining !== null) {
      const tokensBurned = lastSample.tokens_remaining - signal.tokens_remaining;
      const timeDeltaSec = (signal.sampled_at.getTime() - lastSample.sampled_at.getTime()) / 1000;
      if (timeDeltaSec > 1) {
        burnRate = Math.max(0, tokensBurned / timeDeltaSec);
      }
    }

    // Update EWMA burn rate
    if (burnRate !== null && entry.burn_rate_per_sec !== null) {
      entry.burn_rate_per_sec =
        this.burnRateAlpha * burnRate + (1 - this.burnRateAlpha) * entry.burn_rate_per_sec;
    } else if (burnRate !== null) {
      entry.burn_rate_per_sec = burnRate;
    }

    // Store sample (keep last 10 for recomputation)
    entry.samples.push({
      requests_remaining: signal.requests_remaining,
      tokens_remaining: signal.tokens_remaining,
      requests_limit: signal.requests_limit,
      tokens_limit: signal.tokens_limit,
      reset_at: signal.reset_at,
      sampled_at: signal.sampled_at,
      burn_rate_per_sec: burnRate,
    });
    if (entry.samples.length > 10) {
      entry.samples.shift();
    }

    entry.updated_at = new Date();
  }

  /**
   * Compute throttle decision based on current capacity headroom
   * Headroom = min(requests_remaining / requests_limit, tokens_remaining / tokens_limit)
   * Skips null sides of the ratio
   *
   * Throttle curve:
   * - >= 50%:        action='none', p_skip=0
   * - 25-50%:        action='soft', p_skip linear 0..0.25
   * - 10-25%:        action='soft', p_skip 0.25 + linear 0..0.45 (top = 0.70)
   * - < 10%:         action='hard', p_skip=1
   */
  computeThrottle(provider: string, model: string, agencyId: string): ThrottleDecision {
    const key = `${provider}:${model}:${agencyId}`;
    const entry = this.entries.get(key);

    if (!entry || entry.samples.length === 0) {
      return {
        action: 'none',
        p_skip: 0,
        headroom_pct: null,
        reset_at: null,
      };
    }

    const latest = entry.samples[entry.samples.length - 1];

    // Compute headroom percentage
    const headrooms: number[] = [];
    if (
      latest.requests_remaining !== null &&
      latest.requests_limit !== null &&
      latest.requests_limit > 0
    ) {
      headrooms.push((latest.requests_remaining / latest.requests_limit) * 100);
    }
    if (
      latest.tokens_remaining !== null &&
      latest.tokens_limit !== null &&
      latest.tokens_limit > 0
    ) {
      headrooms.push((latest.tokens_remaining / latest.tokens_limit) * 100);
    }

    if (headrooms.length === 0) {
      return {
        action: 'unknown',
        p_skip: 0,
        headroom_pct: null,
        reset_at: latest.reset_at,
      };
    }

    const headroom_pct = Math.min(...headrooms);

    // Apply throttle curve
    let action: 'none' | 'soft' | 'hard';
    let p_skip: number;

    if (headroom_pct >= 50) {
      action = 'none';
      p_skip = 0;
    } else if (headroom_pct >= 25) {
      // soft: 25-50%, p_skip = linear 0..0.25
      const band_pct = headroom_pct - 25; // 0..25
      p_skip = (band_pct / 25) * 0.25;
      action = 'soft';
    } else if (headroom_pct >= 10) {
      // soft: 10-25%, p_skip = 0.25 + linear 0..0.45
      const band_pct = headroom_pct - 10; // 0..15
      p_skip = 0.25 + (band_pct / 15) * 0.45;
      action = 'soft';
    } else {
      // < 10%
      action = 'hard';
      p_skip = 1;
    }

    return {
      action,
      p_skip,
      headroom_pct,
      reset_at: latest.reset_at,
    };
  }

  /**
   * Flush all in-memory samples to DB via UPSERT
   * Sequential awaits to avoid pool concurrency issues
   */
  async flushToDb(
    query: (sql: string, params: any[]) => Promise<{ rows: any[] }>
  ): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.samples.length === 0) continue;

      const latest = entry.samples[entry.samples.length - 1];
      const throttle = this.computeThrottle(entry.provider, entry.model, entry.agencyId);

      const sql = `
        INSERT INTO roadmap_workforce.agency_capacity (
          provider, model, agency_id,
          requests_remaining, tokens_remaining,
          requests_limit, tokens_limit,
          reset_at, last_sampled_at,
          burn_rate_per_sec, throttle_action, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (provider, model, agency_id) DO UPDATE SET
          requests_remaining = EXCLUDED.requests_remaining,
          tokens_remaining = EXCLUDED.tokens_remaining,
          requests_limit = EXCLUDED.requests_limit,
          tokens_limit = EXCLUDED.tokens_limit,
          reset_at = EXCLUDED.reset_at,
          last_sampled_at = EXCLUDED.last_sampled_at,
          burn_rate_per_sec = EXCLUDED.burn_rate_per_sec,
          throttle_action = EXCLUDED.throttle_action,
          updated_at = EXCLUDED.updated_at;
      `;

      // Sequential await to avoid pool issues
      await query(sql, [
        entry.provider,
        entry.model,
        entry.agencyId,
        latest.requests_remaining,
        latest.tokens_remaining,
        latest.requests_limit,
        latest.tokens_limit,
        latest.reset_at,
        latest.sampled_at,
        entry.burn_rate_per_sec,
        throttle.action,
        entry.updated_at,
      ]);
    }
  }

  /**
   * Get current in-memory state (for debugging/testing)
   */
  getState(): Map<string, TrackedEntry> {
    return new Map(this.entries);
  }

  /**
   * Clear a specific entry (used for testing or manual reset)
   */
  clear(provider: string, model: string, agencyId: string): void {
    const key = `${provider}:${model}:${agencyId}`;
    this.entries.delete(key);
  }

  /**
   * Clear all entries
   */
  clearAll(): void {
    this.entries.clear();
  }
}
