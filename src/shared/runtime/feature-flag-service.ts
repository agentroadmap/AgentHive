import { Pool } from "pg";

/**
 * P523: Unified Feature Flag System
 * Provides database-backed, hot-reloadable feature flags with per-tenant scoping.
 */

export interface FlagValue {
  enabled: boolean;
  variant?: string;
  reason: string; // "per_tenant_override" | "rollout_canary" | "enabled_default" | "flag_not_found"
}

export interface FlagResolutionContext {
  projectSlug?: string;
  agentIdentity?: string;
  userId?: string;
  experimentId?: string;
}

interface CacheEntry {
  value: FlagValue;
  expiresAt: number;
}

export class FeatureFlagService {
  private static instance: FeatureFlagService;
  private cache = new Map<string, CacheEntry>();
  private cacheMaxAgeSec = 5; // 5-second TTL
  private pool: Pool;
  private listeningChannels = new Set<string>();

  private constructor(pool: Pool) {
    this.pool = pool;
  }

  static initialize(pool: Pool): void {
    FeatureFlagService.instance = new FeatureFlagService(pool);
  }

  static getInstance(): FeatureFlagService {
    if (!FeatureFlagService.instance) {
      throw new Error(
        "FeatureFlagService not initialized. Call initialize(pool) first."
      );
    }
    return FeatureFlagService.instance;
  }

  /**
   * Check if a flag is enabled with optional context (tenant, agent, user)
   */
  async isEnabled(
    flagName: string,
    ctx?: FlagResolutionContext
  ): Promise<boolean> {
    const resolved = await this.resolve(flagName, ctx);
    return resolved.enabled;
  }

  /**
   * Resolve a flag to its FlagValue (enabled, variant, reason)
   * Resolution order:
   * 1. per_tenant_override[projectSlug] if projectSlug provided
   * 2. rollout_percent via deterministic hash
   * 3. enabled_default
   */
  async resolve(
    flagName: string,
    ctx?: FlagResolutionContext
  ): Promise<FlagValue> {
    // Check in-process cache first
    const cached = this.cache.get(flagName);
    if (cached && cached.expiresAt > Date.now()) {
      return this.applyResolution(cached.value, ctx);
    }

    // Fetch from DB
    const flag = await this.fetchFromDb(flagName);
    if (!flag) {
      return { enabled: false, reason: "flag_not_found" };
    }

    // Resolution: per-tenant override takes precedence
    if (
      ctx?.projectSlug &&
      flag.per_tenant_override &&
      flag.per_tenant_override[ctx.projectSlug] !== undefined
    ) {
      const override = flag.per_tenant_override[ctx.projectSlug];
      const result: FlagValue = {
        enabled: override.enabled ?? flag.enabled_default,
        variant: override.variant,
        reason: "per_tenant_override",
      };
      this.setCacheEntry(flagName, result);
      return result;
    }

    // Canary rollout via deterministic hash
    if (flag.rollout_percent < 100) {
      const hash = this.deterministicHash(
        flagName,
        ctx?.agentIdentity ?? ctx?.userId ?? "anonymous"
      );
      const enabled = (hash % 100) < flag.rollout_percent;
      const result: FlagValue = {
        enabled,
        reason: "rollout_canary",
      };
      this.setCacheEntry(flagName, result);
      return result;
    }

    // Default
    const result: FlagValue = {
      enabled: flag.enabled_default,
      reason: "enabled_default",
    };
    this.setCacheEntry(flagName, result);
    return result;
  }

  /**
   * Get all currently cached/resolved flags (for debugging)
   */
  values(): Map<string, FlagValue> {
    const result = new Map<string, FlagValue>();
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt > Date.now()) {
        result.set(key, entry.value);
      }
    }
    return result;
  }

  /**
   * Subscribe to NOTIFY events on feature_flag_changed channel
   * Invalidates cache on any flag change for instant propagation
   */
  async subscribeToChanges(
    callback?: (flagName: string) => void
  ): Promise<void> {
    if (this.listeningChannels.has("feature_flag_changed")) {
      return; // Already listening
    }

    const client = await this.pool.connect();
    this.listeningChannels.add("feature_flag_changed");

    client.on("notification", (msg) => {
      try {
        if (msg.channel === "feature_flag_changed" && msg.payload) {
          const payload = JSON.parse(msg.payload);
          const flagName = payload.flag_name;
          this.cache.delete(flagName); // Instant invalidation
          if (callback) {
            callback(flagName);
          }
        }
      } catch (err) {
        console.error(
          `Error handling feature_flag_changed notification: ${err}`
        );
      }
    });

    client.query("LISTEN feature_flag_changed");
    // Keep client connection alive for the lifetime of the service
  }

  /**
   * Fetch flag definition from DB
   */
  private async fetchFromDb(flagName: string): Promise<any> {
    try {
      const result = await this.pool.query(
        `SELECT
          flag_name,
          enabled_default,
          per_tenant_override,
          rollout_percent,
          variant_values
        FROM roadmap.feature_flag
        WHERE flag_name = $1 AND NOT is_archived`,
        [flagName]
      );
      return result.rows[0] || null;
    } catch (err) {
      console.error(
        `Error fetching flag '${flagName}' from DB: ${err.message}`
      );
      return null;
    }
  }

  /**
   * Apply context-specific resolution (extensible for future agent-level overrides)
   */
  private applyResolution(
    baseValue: FlagValue,
    ctx?: FlagResolutionContext
  ): FlagValue {
    // Currently a pass-through; can be extended for agent-specific logic
    return baseValue;
  }

  /**
   * Deterministic hash: consistent across reboots for same (flagName, userId)
   */
  private deterministicHash(flagName: string, userId: string): number {
    const combined = `${flagName}:${userId}`;
    let hash = 0;
    for (let i = 0; i < combined.length; i++) {
      const char = combined.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32-bit
    }
    return Math.abs(hash);
  }

  /**
   * Cache entry setter with TTL
   */
  private setCacheEntry(flagName: string, value: FlagValue): void {
    this.cache.set(flagName, {
      value,
      expiresAt: Date.now() + this.cacheMaxAgeSec * 1000,
    });
  }

  /**
   * Clear cache (for testing or manual invalidation)
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Reset singleton instance (for testing)
   */
  static reset(): void {
    FeatureFlagService.instance = null as any;
  }
}
