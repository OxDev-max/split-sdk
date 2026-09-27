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

/**
 * SDK debug mode configuration.
 *
 * When enabled, cache operations emit verbose log lines through the
 * configured logger so integrators can trace cache hits, misses, writes,
 * evictions and invalidations.
 */
export interface DebugModeOptions {
  enabled?: boolean;
  logger?: (message: string, ...args: any[]) => void;
}

/**
 * Shared debug-mode state used by the cache implementations.
 *
 * Emits `debug:change` events whenever the enabled flag flips so consumers
 * can react to debug mode being toggled at runtime.
 */
export class DebugMode {
  private enabled: boolean;
  private readonly logger: (message: string, ...args: any[]) => void;
  private readonly listeners = new Set<(enabled: boolean) => void>();

  constructor(options?: DebugModeOptions) {
    this.enabled = options?.enabled ?? false;
    this.logger = options?.logger ?? ((message: string, ...args: any[]) => console.debug(message, ...args));
  }

  /** Whether verbose logging is currently active. */
  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Enable or disable debug mode, emitting a change event on transitions. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    for (const listener of this.listeners) {
      listener(enabled);
    }
  }

  enable(): void {
    this.setEnabled(true);
  }

  disable(): void {
    this.setEnabled(false);
  }

  /**
   * Register a listener invoked with the new state whenever debug mode
   * changes. Returns an unsubscribe function.
   */
  onChange(listener: (enabled: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Emit a verbose log line when debug mode is enabled. */
  log(message: string, ...args: any[]): void {
    if (!this.enabled) return;
    this.logger(message, ...args);
  }
}

export class SimpleCache<T> {
  private readonly store = new Map<string, MethodCacheEntry>();
  private readonly ttlConfig: Record<string, number>;
  private enabled: boolean;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private maxEntries: number;
  private readonly debug: DebugMode;

  constructor(config?: number | { enabled?: boolean; ttl?: Record<string, number>; ttlMs?: number; maxEntries?: number; debug?: boolean | DebugModeOptions }) {
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
    this.debug = new DebugMode(
      typeof config === "object" && config?.debug !== undefined
        ? typeof config.debug === "boolean"
          ? { enabled: config.debug }
          : config.debug
        : undefined
    );
  }

  /** Access the debug-mode controller for this cache instance. */
  getDebugMode(): DebugMode {
    return this.debug;
  }

  get(key: string): T | undefined {
    if (!this.enabled) return undefined;
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      this.debug.log(`[cache] miss ${key}`);
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      this.debug.log(`[cache] expired ${key}`);
      return undefined;
    }
    
    // Update LRU order
    this.store.delete(key);
    this.store.set(key, entry);

    this.hits++;
    this.debug.log(`[cache] hit ${key}`);
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
        this.debug.log(`[cache] evict ${oldestKey}`);
      }
    }

    this.store.set(key, { value, expiresAt: Date.now() + ttl });
    this.debug.log(`[cache] set ${key} (ttl=${ttl}ms)`);
  }

  invalidate(methodOrKey?: string, args?: any[]): void {
    if (!methodOrKey) {
      this.store.clear();
      this.debug.log("[cache] invalidate all");
      return;
    }
    if (args) {
      const key = `${methodOrKey}:${JSON.stringify(args)}`;
      this.store.delete(key);
      this.debug.log(`[cache] invalidate ${key}`);
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
    this.debug.log(`[cache] invalidate ${methodOrKey}`);
  }

  clear(): void {
    this.store.clear();
    this.debug.log("[cache] clear");
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
  private readonly debug: DebugMode;

  /**
   * @param ttlMs  Time-to-live in milliseconds.  Omit (or pass `undefined`)
   *               for no-expiry behaviour.
   * @param debug  Optional debug-mode configuration for verbose logging.
   */
  constructor(ttlMs?: number, debug?: boolean | DebugModeOptions) {
    this.ttlMs = ttlMs;
    this.debug = new DebugMode(
      typeof debug === "boolean" ? { enabled: debug } : debug
    );
  }

  /** Access the debug-mode controller for this cache instance. */
  getDebugMode(): DebugMode {
    return this.debug;
  }

  /**
   * Store `value` under `key`, recording the current wall-clock time.
   */
  set(key: string, value: V): void {
    this.store.set(key, { value, writtenAt: Date.now() });
    this.debug.log(`[cache] set ${key}`);
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
    if (!entry) {
      this.debug.log(`[cache] miss ${key}`);
      return undefined;
    }
    if (this.isExpired(entry)) {
      this.store.delete(key);
      this.debug.log(`[cache] expired ${key}`);
      return undefined;
    }
    this.debug.log(`[cache] hit ${key}`);
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
    this.debug.log(`[cache] delete ${key}`);
  }

  /** Remove all entries. */
  clear(): void {
    this.store.clear();
    this.debug.log("[cache] clear");
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
