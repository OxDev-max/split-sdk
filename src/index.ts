/**
 * SDK entry point.
 *
 * Exposes the public surface of the SDK along with a lightweight caching
 * layer that supports per-entry TTLs and explicit invalidation.
 */

export type CacheEventType =
  | "set"
  | "hit"
  | "miss"
  | "expire"
  | "invalidate";

export interface CacheEvent<K = string> {
  type: CacheEventType;
  key: K;
  /** Present for "set" events. */
  ttl?: number;
  /** Present for "expire" and "invalidate" events. */
  reason?: string;
}

export type CacheEventListener<K = string> = (event: CacheEvent<K>) => void;

export interface CacheOptions {
  /** Default time-to-live in milliseconds. `0` or `Infinity` disables expiry. */
  defaultTtl?: number;
  /** Injectable clock, primarily for testing. Defaults to `Date.now`. */
  now?: () => number;
}

interface CacheEntry<V> {
  value: V;
  /** Absolute expiry timestamp in ms, or `Infinity` when it never expires. */
  expiresAt: number;
}

/**
 * A small in-memory cache with TTL support and lifecycle events.
 */
export class SdkCache<K = string, V = unknown> {
  private readonly store = new Map<K, CacheEntry<V>>();
  private readonly listeners = new Set<CacheEventListener<K>>();
  private readonly defaultTtl: number;
  private readonly now: () => number;

  constructor(options: CacheOptions = {}) {
    this.defaultTtl = options.defaultTtl ?? 0;
    this.now = options.now ?? Date.now;
  }

  /**
   * Subscribe to cache lifecycle events. Returns an unsubscribe function.
   */
  on(listener: CacheEventListener<K>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Store a value under `key`, optionally overriding the default TTL.
   */
  set(key: K, value: V, ttl?: number): void {
    const effectiveTtl = ttl ?? this.defaultTtl;
    const expiresAt =
      effectiveTtl > 0 && Number.isFinite(effectiveTtl)
        ? this.now() + effectiveTtl
        : Infinity;

    this.store.set(key, { value, expiresAt });
    this.emit({ type: "set", key, ttl: effectiveTtl });
  }

  /**
   * Retrieve a value. Expired entries are evicted and reported as a miss.
   */
  get(key: K): V | undefined {
    const entry = this.store.get(key);

    if (!entry) {
      this.emit({ type: "miss", key });
      return undefined;
    }

    if (this.isExpired(entry)) {
      this.store.delete(key);
      this.emit({ type: "expire", key, reason: "ttl" });
      this.emit({ type: "miss", key });
      return undefined;
    }

    this.emit({ type: "hit", key });
    return entry.value;
  }

  /**
   * Whether a non-expired entry exists for `key`.
   */
  has(key: K): boolean {
    const entry = this.store.get(key);
    if (!entry) {
      return false;
    }
    if (this.isExpired(entry)) {
      this.store.delete(key);
      this.emit({ type: "expire", key, reason: "ttl" });
      return false;
    }
    return true;
  }

  /**
   * Remove a single entry. Returns `true` when an entry was removed.
   */
  invalidate(key: K): boolean {
    const existed = this.store.delete(key);
    if (existed) {
      this.emit({ type: "invalidate", key, reason: "explicit" });
    }
    return existed;
  }

  /**
   * Remove every entry, emitting an invalidation event per removed key.
   */
  invalidateAll(): void {
    for (const key of Array.from(this.store.keys())) {
      this.store.delete(key);
      this.emit({ type: "invalidate", key, reason: "explicit" });
    }
  }

  /**
   * Remove all expired entries. Returns the number of evicted entries.
   */
  prune(): number {
    let evicted = 0;
    for (const [key, entry] of Array.from(this.store.entries())) {
      if (this.isExpired(entry)) {
        this.store.delete(key);
        this.emit({ type: "expire", key, reason: "ttl" });
        evicted += 1;
      }
    }
    return evicted;
  }

  /**
   * Current number of stored entries (including not-yet-pruned expired ones).
   */
  get size(): number {
    return this.store.size;
  }

  /**
   * Remove all entries without emitting per-key events.
   */
  clear(): void {
    this.store.clear();
  }

  private isExpired(entry: CacheEntry<V>): boolean {
    return entry.expiresAt !== Infinity && entry.expiresAt <= this.now();
  }

  private emit(event: CacheEvent<K>): void {
    for (const listener of Array.from(this.listeners)) {
      listener(event);
    }
  }
}

export default SdkCache;
