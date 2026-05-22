/**
 * P1365-AC1: Rate-limit header parser tests
 */

import { parseRateLimitHeaders, CapacitySignal } from '../rate-limit-parser';

describe('parseRateLimitHeaders', () => {
  const now = new Date('2026-05-22T10:00:00Z');

  describe('Anthropic headers', () => {
    it('should parse valid Anthropic rate-limit headers', () => {
      const headers = {
        'anthropic-ratelimit-requests-limit': '100',
        'anthropic-ratelimit-requests-remaining': '95',
        'anthropic-ratelimit-tokens-limit': '1000000',
        'anthropic-ratelimit-tokens-remaining': '950000',
        'anthropic-ratelimit-tokens-reset': '1747996800', // Unix timestamp
      };

      const signal = parseRateLimitHeaders('anthropic', headers, 'claude-opus-4', now);

      expect(signal).not.toBeNull();
      expect(signal!.provider).toBe('anthropic');
      expect(signal!.model).toBe('claude-opus-4');
      expect(signal!.requests_limit).toBe(100);
      expect(signal!.requests_remaining).toBe(95);
      expect(signal!.tokens_limit).toBe(1000000);
      expect(signal!.tokens_remaining).toBe(950000);
      expect(signal!.reset_at).toEqual(new Date(1747996800 * 1000));
      expect(signal!.sampled_at).toEqual(now);
    });

    it('should handle case-insensitive headers', () => {
      const headers = {
        'ANTHROPIC-RATELIMIT-REQUESTS-LIMIT': '100',
        'Anthropic-RateLimit-Requests-Remaining': '95',
      };

      const signal = parseRateLimitHeaders('anthropic', headers, 'claude-opus-4', now);
      expect(signal).not.toBeNull();
      expect(signal!.requests_limit).toBe(100);
      expect(signal!.requests_remaining).toBe(95);
    });

    it('should return null when no rate-limit headers present', () => {
      const headers = { 'content-type': 'application/json' };
      const signal = parseRateLimitHeaders('anthropic', headers, 'claude-opus-4', now);
      expect(signal).toBeNull();
    });

    it('should skip missing optional headers', () => {
      const headers = {
        'anthropic-ratelimit-requests-limit': '100',
        'anthropic-ratelimit-requests-remaining': '50',
      };

      const signal = parseRateLimitHeaders('anthropic', headers, 'claude-opus-4', now);
      expect(signal).not.toBeNull();
      expect(signal!.requests_limit).toBe(100);
      expect(signal!.requests_remaining).toBe(50);
      expect(signal!.tokens_limit).toBeNull();
      expect(signal!.tokens_remaining).toBeNull();
      expect(signal!.reset_at).toBeNull();
    });

    it('should handle malformed timestamp', () => {
      const headers = {
        'anthropic-ratelimit-requests-remaining': '50',
        'anthropic-ratelimit-tokens-reset': 'invalid-timestamp',
      };

      const signal = parseRateLimitHeaders('anthropic', headers, 'claude-opus-4', now);
      expect(signal).not.toBeNull();
      expect(signal!.reset_at).toBeNull();
    });
  });

  describe('OpenAI headers', () => {
    it('should parse valid OpenAI rate-limit headers', () => {
      const headers = {
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '99',
        'x-ratelimit-limit-tokens': '2000000',
        'x-ratelimit-remaining-tokens': '1999000',
        'x-ratelimit-reset-requests': '2026-05-22T10:01:00Z',
      };

      const signal = parseRateLimitHeaders('openai', headers, 'gpt-4', now);

      expect(signal).not.toBeNull();
      expect(signal!.provider).toBe('openai');
      expect(signal!.requests_limit).toBe(100);
      expect(signal!.requests_remaining).toBe(99);
      expect(signal!.tokens_limit).toBe(2000000);
      expect(signal!.tokens_remaining).toBe(1999000);
      expect(signal!.reset_at).toEqual(new Date('2026-05-22T10:01:00Z'));
    });

    it('should return null when no OpenAI headers present', () => {
      const headers = { 'content-type': 'application/json' };
      const signal = parseRateLimitHeaders('openai', headers, 'gpt-4', now);
      expect(signal).toBeNull();
    });
  });

  describe('Google/Gemini', () => {
    it('should return null for Google (no success-path headers)', () => {
      const headers = { 'content-type': 'application/json' };
      const signal = parseRateLimitHeaders('google', headers, 'gemini-pro', now);
      expect(signal).toBeNull();
    });
  });

  describe('GitHub/Copilot', () => {
    it('should return null for GitHub (Phase 2)', () => {
      const headers = { 'x-ratelimit-remaining': '100' };
      const signal = parseRateLimitHeaders('github', headers, 'gpt-4-turbo', now);
      expect(signal).toBeNull();
    });
  });

  describe('Unknown provider', () => {
    it('should return null for unknown provider', () => {
      const signal = parseRateLimitHeaders(
        'unknown-provider' as any,
        { 'some-header': 'value' },
        'model-x',
        now
      );
      expect(signal).toBeNull();
    });
  });

  describe('Malformed values', () => {
    it('should skip non-numeric values for integer fields', () => {
      const headers = {
        'anthropic-ratelimit-requests-limit': 'not-a-number',
        'anthropic-ratelimit-requests-remaining': '50',
      };

      const signal = parseRateLimitHeaders('anthropic', headers, 'claude-opus-4', now);
      expect(signal).not.toBeNull();
      expect(signal!.requests_limit).toBeNull();
      expect(signal!.requests_remaining).toBe(50);
    });
  });

  describe('Array header values', () => {
    it('should handle array-valued headers by taking first element', () => {
      const headers = {
        'anthropic-ratelimit-requests-remaining': ['50', '60'],
      };

      const signal = parseRateLimitHeaders('anthropic', headers, 'claude-opus-4', now);
      expect(signal).not.toBeNull();
      expect(signal!.requests_remaining).toBe(50);
    });
  });
});
