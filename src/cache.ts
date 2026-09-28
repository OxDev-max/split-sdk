/**
 * Simple in-memory cache with per-entry TTL.
 *
 * Used by StellarSplitClient to avoid redundant RPC calls for read-heavy
 * operations like getInvoice().
 */

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  keys: string[];
  evictions: number;
}

export interface MethodCacheEntry {
  value: any;
  expiresAt: number;
}

export class SimpleCache<T> {
  private readonly store = new Map<string, MethodCacheEntry>();
  private readonly ttlConfig: Record<string, number>;
  private enabled: boolean;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private maxEntries: number;

  constructor(config?: number | { enabled?: boolean; ttl?: Record<string, number>; ttlMs?: number; maxEntries?: number }) {
    if (typeof config === "number") {
      this.enabled = true;
      this.maxEntries = 1000;
      this.ttlConfig = { default: config };
    } else {
      this.enabled = config?.enabled ?? (config?.ttl !== undefined || config?.ttlMs !== undefined);
      this.maxEntries = config?.maxEntries ?? (this.enabled ? 1000 : 0);
      this.ttlConfig = config?.ttl ?? {};
      if (config?.ttlMs !== undefined) {
        this.ttlConfig["default"] = config.ttlMs;
      }
    }
  }

  get(key: string): T | undefined {
    if (!this.enabled) return undefined;
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }
    
    // Update LRU order
    this.store.delete(key);
    this.store.set(key, entry);

    this.hits++;
    return entry.value;
  }

  set(key: string, value: T): void {
    if (!this.enabled) return;
    const method = key.split(":")[0] || key;
    const ttl = this.ttlConfig[method] ?? this.ttlConfig["default"] ?? 0;
    if (ttl <= 0) return;

    if (this.maxEntries > 0 && this.store.size >= this.maxEntries && !this.store.has(key)) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
        this.evictions++;
      }
    }

    this.store.set(key, { value, expiresAt: Date.now() + ttl });
  }

  invalidate(methodOrKey?: string, args?: any[]): void {
    if (!methodOrKey) {
      this.store.clear();
      return;
    }
    if (args) {
      const key = `${methodOrKey}:${JSON.stringify(args)}`;
      this.store.delete(key);
      return;
    }
    
    // Check if it's an exact key
    if (this.store.has(methodOrKey)) {
      this.store.delete(methodOrKey);
    }
    
    // Invalidate by method prefix
    const prefix = `${methodOrKey}:`;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  clear(): void {
    this.store.clear();
  }

  getStats(): CacheStats {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.store.size,
      keys: Array.from(this.store.keys()),
      evictions: this.evictions,
    };
  }

  entries(): Map<string, T> {
    const now = Date.now();
    const result = new Map<string, T>();
    for (const [key, entry] of this.store) {
      if (now <= entry.expiresAt) result.set(key, entry.value);
    }
    return result;
  }

  replaceAll(next: Map<string, T>): void {
    this.store.clear();
    for (const [key, value] of next) {
      this.set(key, value);
    }
  }
}

/**
 * A lightweight, generic in-memory cache with optional TTL-based entry expiry.
 *
 * When `ttlMs` is omitted entries never expire, preserving backward-compatible
 * behaviour.  When supplied, `get()` and `has()` silently evict stale entries
 * on access, and `purgeExpired()` sweeps the entire store in one pass.
 *
 * Usage:
 *   const cache = new Cache<Invoice>(30_000); // 30-second TTL
 *   cache.set("inv:1", invoice);
 *   cache.get("inv:1"); // undefined after 30 s
 */
interface CacheEntry<V> {
  value: V;
  /** Unix ms timestamp recorded at write time. */
  writtenAt: number;
}

export class Cache<V> {
  private readonly store = new Map<string, CacheEntry<V>>();
  private readonly ttlMs: number | undefined;

  /**
   * @param ttlMs  Time-to-live in milliseconds.  Omit (or pass `undefined`)
   *               for no-expiry behaviour.
   */
  constructor(ttlMs?: number) {
    this.ttlMs = ttlMs;
  }

  /**
   * Store `value` under `key`, recording the current wall-clock time.
   */
  set(key: string, value: V): void {
    this.store.set(key, { value, writtenAt: Date.now() });
  }

  /**
   * Retrieve the value for `key`.
   *
   * Returns `undefined` and **deletes the entry** when the entry is expired
   * (i.e. `Date.now() - writtenAt > ttlMs`).  Returns `undefined` for
   * missing keys regardless of TTL configuration.
   */
  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Returns `true` only when the key exists **and** is not expired.
   * Expired entries are deleted as a side-effect.
   */
  has(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Remove all entries whose TTL has elapsed in a single sweep.
   * No-op when no TTL is configured.
   */
  purgeExpired(): void {
    if (this.ttlMs === undefined) return;
    for (const [key, entry] of this.store) {
      if (this.isExpired(entry)) {
        this.store.delete(key);
      }
    }
  }

  /** Remove a specific entry by key. */
  delete(key: string): void {
    this.store.delete(key);
  }

  /** Remove all entries. */
  clear(): void {
    this.store.clear();
  }

  /** Number of entries currently in the store (including not-yet-evicted expired ones). */
  get size(): number {
    return this.store.size;
  }

  // ── private helpers ──────────────────────────────────────────────────────

  private isExpired(entry: CacheEntry<V>): boolean {
    if (this.ttlMs === undefined) return false;
    return Date.now() - entry.writtenAt > this.ttlMs;
  }
}

/**
 * Outcome of a nonce deduplication check.
 */
export type NonceDedupOutcome = "accepted" | "duplicate";

/**
 * Event payload emitted for every nonce deduplication decision.
 */
export interface NonceDedupEvent {
  /** The nonce that was evaluated. */
  nonce: string;
  /** Whether the request was accepted (first-seen) or rejected as a duplicate. */
  outcome: NonceDedupOutcome;
  /** Unix ms timestamp of the decision. */
  timestamp: number;
}

/**
 * Listener invoked whenever a nonce deduplication decision is made.
 */
export type NonceDedupListener = (event: NonceDedupEvent) => void;

/**
 * Configuration for {@link NonceDeduplicator}.
 *
 * Deduplication is **opt-in**: when `enabled` is omitted or `false` the
 * deduplicator is a transparent pass-through and every nonce is accepted,
 * preserving existing behaviour.
 */
export interface NonceDeduplicatorConfig {
  /** Enable deduplication. Defaults to `false` (pass-through). */
  enabled?: boolean;
  /** Time-to-live in ms for a seen nonce. Defaults to 300_000 (5 minutes). */
  ttlMs?: number;
  /** Maximum number of tracked nonces before oldest-first eviction. Defaults to 1000. */
  maxEntries?: number;
}

/**
 * Optional request deduplication keyed by nonce.
 *
 * Tracks recently seen nonces so that a repeated request (same nonce) can be
 * detected and rejected.  When disabled (the default) every nonce is accepted
 * and no state is retained, so callers can adopt it without changing behaviour.
 *
 * Usage:
 *   const dedup = new NonceDeduplicator({ enabled: true, ttlMs: 60_000 });
 *   dedup.on("dedup", (e) => console.log(e.outcome));
 *   if (dedup.check(nonce) === "duplicate") { ... }
 */
export class NonceDeduplicator {
  private readonly enabled: boolean;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly seen = new Map<string, number>();
  private readonly listeners = new Set<NonceDedupListener>();

  constructor(config?: NonceDeduplicatorConfig) {
    this.enabled = config?.enabled ?? false;
    this.ttlMs = config?.ttlMs ?? 300_000;
    this.maxEntries = config?.maxEntries ?? 1000;
  }

  /**
   * Evaluate `nonce` and record it when accepted.
   *
   * @returns `"duplicate"` when the nonce was seen within the TTL window,
   *          otherwise `"accepted"`.  Always `"accepted"` when disabled.
   */
  check(nonce: string): NonceDedupOutcome {
    if (!this.enabled) {
      this.emit({ nonce, outcome: "accepted", timestamp: Date.now() });
      return "accepted";
    }

    this.purgeExpired();

    if (this.seen.has(nonce)) {
      this.emit({ nonce, outcome: "duplicate", timestamp: Date.now() });
      return "duplicate";
    }

    if (this.maxEntries > 0 && this.seen.size >= this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }

    this.seen.set(nonce, Date.now() + this.ttlMs);
    this.emit({ nonce, outcome: "accepted", timestamp: Date.now() });
    return "accepted";
  }

  /** Convenience predicate: `true` when `nonce` is a duplicate. */
  isDuplicate(nonce: string): boolean {
    return this.check(nonce) === "duplicate";
  }

  /** Register a listener for deduplication decisions. */
  on(_event: "dedup", listener: NonceDedupListener): void {
    this.listeners.add(listener);
  }

  /** Remove a previously registered listener. */
  off(_event: "dedup", listener: NonceDedupListener): void {
    this.listeners.delete(listener);
  }

  /** Remove all tracked nonces. */
  clear(): void {
    this.seen.clear();
  }

  /** Number of nonces currently tracked (including not-yet-evicted expired ones). */
  get size(): number {
    return this.seen.size;
  }

  // ── private helpers ──────────────────────────────────────────────────────

  private purgeExpired(): void {
    const now = Date.now();
    for (const [nonce, expiresAt] of this.seen) {
      if (now > expiresAt) this.seen.delete(nonce);
    }
  }

  private emit(event: NonceDedupEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
