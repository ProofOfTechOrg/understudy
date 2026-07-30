/**
 * Positive-only TTL cache with a bounded size (insertion-order eviction).
 * Two auth paths need identical caches — directory device credentials
 * (auth.ts) and usk_ MCP tokens (mcp/static-auth.ts) — so the shape lives
 * here once. Positive-only by contract: a miss is never cached, so a
 * credential minted a moment ago works on the very next request; the price
 * is that revocation lags by up to ttlMs beyond the store's row flip.
 */

export interface PositiveCache<T> {
  get(key: string): T | undefined;
  put(key: string, value: T): void;
  /** Test seam — the cache is module state shared across a pool-worker run. */
  clear(): void;
}

export function createPositiveCache<T>(ttlMs: number, maxEntries: number): PositiveCache<T> {
  const entries = new Map<string, { value: T; expiresAt: number }>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (entry === undefined) return undefined;
      if (entry.expiresAt <= Date.now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    put(key, value) {
      if (entries.size >= maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    clear() {
      entries.clear();
    },
  };
}
