/**
 * P1365-AC5: Capacity tracker tests
 * Tests throttle curve, reset detection, EWMA, threshold transitions
 */

import { CapacityTracker } from '../capacity-tracker';
import { CapacitySignal } from '../rate-limit-parser';

describe('CapacityTracker', () => {
  let tracker: CapacityTracker;
  const now = new Date('2026-05-22T10:00:00Z');

  beforeEach(() => {
    tracker = new CapacityTracker();
  });

  describe('happy path', () => {
    it('should record a signal and compute throttle', () => {
      const signal: CapacitySignal = {
        provider: 'anthropic',
        model: 'claude-opus-4',
        requests_remaining: 95,
        requests_limit: 100,
        tokens_remaining: 950000,
        tokens_limit: 1000000,
        reset_at: new Date('2026-05-22T11:00:00Z'),
        sampled_at: now,
      };

      tracker.recordSignal(signal, 'agency-alpha');

      const throttle = tracker.computeThrottle('anthropic', 'claude-opus-4', 'agency-alpha');
      expect(throttle.action).toBe('none');
      expect(throttle.p_skip).toBe(0);
      expect(throttle.headroom_pct).toBe(95); // min(95%, 95%)
    });
  });

  describe('reset detection', () => {
    it('should detect reset when tokens_remaining increases', () => {
      const state = tracker.getState();

      const signal1: CapacitySignal = {
        provider: 'anthropic',
        model: 'claude-opus-4',
        requests_remaining: 90,
        requests_limit: 100,
        tokens_remaining: 900000,
        tokens_limit: 1000000,
        reset_at: null,
        sampled_at: now,
      };

      const signal2: CapacitySignal = {
        provider: 'anthropic',
        model: 'claude-opus-4',
        requests_remaining: 95,
        requests_limit: 100,
        tokens_remaining: 950000, // increased -> reset
        tokens_limit: 1000000,
        reset_at: null,
        sampled_at: new Date(now.getTime() + 1000),
      };

      tracker.recordSignal(signal1, 'agency-alpha');
      tracker.recordSignal(signal2, 'agency-alpha');

      // Should have dropped the first sample
      const entry = state.get('anthropic:claude-opus-4:agency-alpha');
      expect(entry!.samples.length).toBe(1);
      expect(entry!.samples[0].tokens_remaining).toBe(950000);
    });
  });

  describe('EWMA burn rate', () => {
    it('should compute burn rate from token deltas', () => {
      const signal1: CapacitySignal = {
        provider: 'anthropic',
        model: 'claude-opus-4',
        requests_remaining: 100,
        requests_limit: 100,
        tokens_remaining: 1000000,
        tokens_limit: 1000000,
        reset_at: null,
        sampled_at: now,
      };

      const signal2: CapacitySignal = {
        provider: 'anthropic',
        model: 'claude-opus-4',
        requests_remaining: 100,
        requests_limit: 100,
        tokens_remaining: 900000, // burned 100k in 10 seconds = 10k/s
        tokens_limit: 1000000,
        reset_at: null,
        sampled_at: new Date(now.getTime() + 10000),
      };

      tracker.recordSignal(signal1, 'agency-alpha');
      tracker.recordSignal(signal2, 'agency-alpha');

      const entry = tracker.getState().get('anthropic:claude-opus-4:agency-alpha');
      expect(entry!.burn_rate_per_sec).toBe(10000); // First sample; no EWMA yet
    });

    it('should apply EWMA smoothing over 5+ samples', () => {
      const agencyId = 'agency-beta';
      let timestamp = now.getTime();

      // Simulate 5 samples with constant burn rate
      for (let i = 0; i < 5; i++) {
        const signal: CapacitySignal = {
          provider: 'openai',
          model: 'gpt-4',
          requests_remaining: 100,
          requests_limit: 100,
          tokens_remaining: 1000000 - (i + 1) * 100000, // -100k tokens each step
          tokens_limit: 1000000,
          reset_at: null,
          sampled_at: new Date(timestamp),
        };
        tracker.recordSignal(signal, agencyId);
        timestamp += 10000; // 10 seconds between samples
      }

      const entry = tracker.getState().get('openai:gpt-4:agency-beta');
      // By 5 samples, EWMA should have converged toward 10k/s
      expect(entry!.burn_rate_per_sec).toBeCloseTo(10000, -3);
    });
  });

  describe('throttle curve: threshold transitions', () => {
    it('should return action=none when headroom >= 50%', () => {
      const signal: CapacitySignal = {
        provider: 'anthropic',
        model: 'claude-opus-4',
        requests_remaining: 50,
        requests_limit: 100,
        tokens_remaining: 500000,
        tokens_limit: 1000000,
        reset_at: null,
        sampled_at: now,
      };

      tracker.recordSignal(signal, 'agency-alpha');
      const throttle = tracker.computeThrottle('anthropic', 'claude-opus-4', 'agency-alpha');

      expect(throttle.action).toBe('none');
      expect(throttle.p_skip).toBe(0);
      expect(throttle.headroom_pct).toBe(50);
    });

    it('should return action=soft with linear p_skip when 25% <= headroom < 50%', () => {
      const signal: CapacitySignal = {
        provider: 'anthropic',
        model: 'claude-opus-4',
        requests_remaining: 37.5, // 37.5% headroom
        requests_limit: 100,
        tokens_remaining: null,
        tokens_limit: null,
        reset_at: null,
        sampled_at: now,
      };

      tracker.recordSignal(signal, 'agency-alpha');
      const throttle = tracker.computeThrottle('anthropic', 'claude-opus-4', 'agency-alpha');

      expect(throttle.action).toBe('soft');
      expect(throttle.headroom_pct).toBe(37.5);
      // p_skip = (37.5 - 25) / 25 * 0.25 = 0.125
      expect(throttle.p_skip).toBeCloseTo(0.125, 3);
    });

    it('should return action=soft with higher p_skip when 10% <= headroom < 25%', () => {
      const signal: CapacitySignal = {
        provider: 'anthropic',
        model: 'claude-opus-4',
        requests_remaining: 17.5, // 17.5% headroom
        requests_limit: 100,
        tokens_remaining: null,
        tokens_limit: null,
        reset_at: null,
        sampled_at: now,
      };

      tracker.recordSignal(signal, 'agency-alpha');
      const throttle = tracker.computeThrottle('anthropic', 'claude-opus-4', 'agency-alpha');

      expect(throttle.action).toBe('soft');
      expect(throttle.headroom_pct).toBe(17.5);
      // p_skip = 0.25 + (17.5 - 10) / 15 * 0.45 = 0.25 + 0.225 = 0.475
      expect(throttle.p_skip).toBeCloseTo(0.475, 3);
    });

    it('should return action=hard when headroom < 10%', () => {
      const signal: CapacitySignal = {
        provider: 'anthropic',
        model: 'claude-opus-4',
        requests_remaining: 5,
        requests_limit: 100,
        tokens_remaining: null,
        tokens_limit: null,
        reset_at: null,
        sampled_at: now,
      };

      tracker.recordSignal(signal, 'agency-alpha');
      const throttle = tracker.computeThrottle('anthropic', 'claude-opus-4', 'agency-alpha');

      expect(throttle.action).toBe('hard');
      expect(throttle.p_skip).toBe(1);
    });
  });

  describe('headroom computation', () => {
    it('should use min of requests and tokens headroom', () => {
      const signal: CapacitySignal = {
        provider: 'anthropic',
        model: 'claude-opus-4',
        requests_remaining: 80,
        requests_limit: 100, // 80% headroom
        tokens_remaining: 300000,
        tokens_limit: 1000000, // 30% headroom
        reset_at: null,
        sampled_at: now,
      };

      tracker.recordSignal(signal, 'agency-alpha');
      const throttle = tracker.computeThrottle('anthropic', 'claude-opus-4', 'agency-alpha');

      expect(throttle.headroom_pct).toBe(30); // min(80, 30)
    });

    it('should skip null headroom components', () => {
      const signal: CapacitySignal = {
        provider: 'anthropic',
        model: 'claude-opus-4',
        requests_remaining: 25,
        requests_limit: 100, // 25% headroom
        tokens_remaining: null,
        tokens_limit: null,
        reset_at: null,
        sampled_at: now,
      };

      tracker.recordSignal(signal, 'agency-alpha');
      const throttle = tracker.computeThrottle('anthropic', 'claude-opus-4', 'agency-alpha');

      expect(throttle.headroom_pct).toBe(25);
    });

    it('should return null headroom and unknown action when no limits available', () => {
      const signal: CapacitySignal = {
        provider: 'anthropic',
        model: 'claude-opus-4',
        requests_remaining: 50,
        requests_limit: null,
        tokens_remaining: 500000,
        tokens_limit: null,
        reset_at: null,
        sampled_at: now,
      };

      tracker.recordSignal(signal, 'agency-alpha');
      const throttle = tracker.computeThrottle('anthropic', 'claude-opus-4', 'agency-alpha');

      expect(throttle.headroom_pct).toBeNull();
      expect(throttle.action).toBe('unknown');
      expect(throttle.p_skip).toBe(0);
    });
  });

  describe('no signal', () => {
    it('should return action=none with p_skip=0 when no signal recorded', () => {
      const throttle = tracker.computeThrottle('anthropic', 'claude-opus-4', 'agency-unknown');

      expect(throttle.action).toBe('none');
      expect(throttle.p_skip).toBe(0);
      expect(throttle.headroom_pct).toBeNull();
    });
  });

  describe('clear and clearAll', () => {
    it('should clear a specific entry', () => {
      const signal: CapacitySignal = {
        provider: 'anthropic',
        model: 'claude-opus-4',
        requests_remaining: 50,
        requests_limit: 100,
        tokens_remaining: 500000,
        tokens_limit: 1000000,
        reset_at: null,
        sampled_at: now,
      };

      tracker.recordSignal(signal, 'agency-alpha');
      expect(tracker.getState().size).toBe(1);

      tracker.clear('anthropic', 'claude-opus-4', 'agency-alpha');
      expect(tracker.getState().size).toBe(0);
    });

    it('should clear all entries', () => {
      const signal: CapacitySignal = {
        provider: 'anthropic',
        model: 'claude-opus-4',
        requests_remaining: 50,
        requests_limit: 100,
        tokens_remaining: 500000,
        tokens_limit: 1000000,
        reset_at: null,
        sampled_at: now,
      };

      tracker.recordSignal(signal, 'agency-alpha');
      tracker.recordSignal(signal, 'agency-beta');
      expect(tracker.getState().size).toBe(2);

      tracker.clearAll();
      expect(tracker.getState().size).toBe(0);
    });
  });
});
