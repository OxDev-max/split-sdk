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
  compressions: number;
  decompressions: number;
  bytesSaved: number;
}

export interface MethodCacheEntry {
  value: any;
  expiresAt: number;
}

export type CacheEventType =
  | "hit"
  | "miss"
  | "set"
  | "evict"
  | "invalidate"
  | "clear"
  | "compress"
  | "decompress";

export interface CacheEvent {
  type: CacheEventType;
  key?: string;
  size?: number;
  bytesSaved?: number;
}

export type CacheEventListener = (event: CacheEvent) => void;

export interface CompressionOptions {
  /** Enable compression of cached values. Defaults to false. */
  enabled?: boolean;
  /** Minimum serialized byte length before a value is compressed. Defaults to 1024. */
  threshold?: number;
}

/**
 * Lightweight, dependency-free compression codec.
 *
 * Uses a run-length + dictionary substitution scheme over the JSON
 * serialization of a value.  It is intentionally simple and synchronous so it
 * can run inside the hot path of the cache without pulling in native deps.
 */
export class CacheCompressor {
  private readonly threshold: number;

  constructor(threshold = 1024) {
    this.threshold = threshold;
  }

  /** Returns true when the payload is large enough to be worth compressing. */
  shouldCompress(payload: string): boolean {
    return payload.length >= this.threshold;
  }

  /**
   * Compress a string using dictionary substitution followed by run-length
   * encoding.  The output is prefixed with a marker so `decompress` can detect
   * already-compressed payloads.
   */
  compress(input: string): string {
    const dictionary: Record<string, string> = {
      '"': "\u0001",
      "{": "\u0002",
      "}": "\u0003",
      "[": "\u0004",
      "]": "\u0005",
      ",": "\u0006",
      ":": "\u0007",
      "true": "\u0008",
      "false": "\u0009",
      "null": "\u000a",
    };

    let out = input;
    for (const [token, code] of Object.entries(dictionary)) {
      out = out.split(token).join(code);
    }

    // Run-length encode repeated characters.
    let rle = "";
    let i = 0;
    while (i < out.length) {
      const ch = out[i];
      let run = 1;
      while (i + run < out.length && out[i + run] === ch) run++;
      if (run > 3) {
        rle += `\u000b${run}${ch}`;
      } else {
        rle += ch.repeat(run);
      }
      i += run;
    }

    return `\u0000${rle}`;
  }

  /** Reverse of `compress`.  Non-compressed input is returned unchanged. */
  decompress(input: string): string {
    if (!input.startsWith("\u0000")) return input;
    const body = input.slice(1);

    // Expand run-length markers.
    let expanded = "";
    let i = 0;
    while (i < body.length) {
      if (body[i] === "\u000b") {
        let j = i + 1;
        let countStr = "";
        while (j < body.length && body[j] >= "0" && body[j] <= "9") {
          countStr += body[j];
          j++;
        }
        const count = parseInt(countStr, 10);
        const ch = body[j];
        expanded += ch.repeat(count);
        i = j + 1;
      } else {
        expanded += body[i];
        i++;
      }
    }

    const reverse: Record<string, string> = {
      "\u0001": '"',
      "\u0002": "{",
      "\u0003": "}",
      "\u0004": "[",
      "\u0005": "]",
      "\u0006": ",",
      "\u0007": ":",
      "\u0008": "true",
      "\u0009": "false",
      "\u000a": "null",
    };

    let out = expanded;
    for (const [code, token] of Object.entries(reverse)) {
      out = out.split(code).join(token);
    }
    return out;
  }
}

export class SimpleCache<T> {
  private readonly store = new Map<string, MethodCacheEntry>();
  private readonly ttlConfig: Record<string, number>;
  private enabled: boolean;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private compressions = 0;
  private decompressions = 0;
  private bytesSaved = 0;
  private maxEntries: number;
  private readonly compressor: CacheCompressor | undefined;
  private readonly listeners = new Set<CacheEventListener>();

  constructor(config?: number | { enabled?: boolean; ttl?: Record<string, number>; ttlMs?: number; maxEntries?: number; compression?: boolean | CompressionOptions }) {
    if (typeof config === "number") {
      this.enabled = true;
      this.maxEntries = 1000;
      this.ttlConfig = { default: config };
      this.compressor = undefined;
    } else {
      this.enabled = config?.enabled ?? (config?.ttl !== undefined || config?.ttlMs !== undefined);
      this.maxEntries = config?.maxEntries ?? (this.enabled ? 1000 : 0);
      this.ttlConfig = config?.ttl ?? {};
      if (config?.ttlMs !== undefined) {
        this.ttlConfig["default"] = config.ttlMs;
      }
      const compression = config?.compression;
      if (compression === true) {
        this.compressor = new CacheCompressor();
      } else if (compression && typeof compression === "object" && compression.enabled) {
        this.compressor = new CacheCompressor(compression.threshold);
      } else {
        this.compressor = undefined;
      }
    }
  }

  /** Register a listener for cache lifecycle events. */
  on(listener: CacheEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Remove a previously registered listener. */
  off(listener: CacheEventListener): void {
    this.listeners.delete(listener);
  }

  private emit(event: CacheEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  get(key: string): T | undefined {
    if (!this.enabled) return undefined;
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      this.emit({ type: "miss", key });
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      this.emit({ type: "miss", key });
      return undefined;
    }

    // Update LRU order
    this.store.delete(key);
    this.store.set(key, entry);

    this.hits++;
    this.emit({ type: "hit", key });
    return this.decode(entry.value);
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
        this.emit({ type: "evict", key: oldestKey });
      }
    }

    const stored = this.encode(value);
    this.store.set(key, { value: stored, expiresAt: Date.now() + ttl });
    this.emit({ type: "set", key });
  }

  invalidate(methodOrKey?: string, args?: any[]): void {
    if (!methodOrKey) {
      this.store.clear();
      this.emit({ type: "clear" });
      return;
    }
    if (args) {
      const key = `${methodOrKey}:${JSON.stringify(args)}`;
      this.store.delete(key);
      this.emit({ type: "invalidate", key });
      return;
    }

    // Check if it's an exact key
    if (this.store.has(methodOrKey)) {
      this.store.delete(methodOrKey);
      this.emit({ type: "invalidate", key: methodOrKey });
    }

    // Invalidate by method prefix
    const prefix = `${methodOrKey}:`;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        this.emit({ type: "invalidate", key });
      }
    }
  }

  clear(): void {
    this.store.clear();
    this.emit({ type: "clear" });
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
      compressions: this.compressions,
      decompressions: this.decompressions,
      bytesSaved: this.bytesSaved,
    };
  }

  entries(): Map<string, T> {
    const now = Date.now();
    const result = new Map<string, T>();
    for (const [key, entry] of this.store) {
      if (now <= entry.expiresAt) result.set(key, this.decode(entry.value));
    }
    return result;
  }

  replaceAll(next: Map<string, T>): void {
    this.store.clear();
    for (const [key, value] of next) {
      this.set(key, value);
    }
  }

  // ── compression helpers ──────────────────────────────────────────────────

  private encode(value: T): any {
    if (!this.compressor) return value;
    let payload: string;
    try {
      payload = JSON.stringify(value);
    } catch {
      return value;
    }
    if (payload === undefined || !this.compressor.shouldCompress(payload)) {
      return value;
    }
    const compressed = this.compressor.compress(payload);
    if (compressed.length >= payload.length) return value;
    this.compressions++;
    this.bytesSaved += payload.length - compressed.length;
    this.emit({ type: "compress", size: compressed.length, bytesSaved: payload.length - compressed.length });
    return { __compressed: true, data: compressed };
  }

  private decode(value: any): T {
    if (!this.compressor || value === null || typeof value !== "object" || !(value as any).__compressed) {
      return value as T;
    }
    this.decompressions++;
    this.emit({ type: "decompress", size: (value as any).data?.length });
    try {
      return JSON.parse(this.compressor.decompress((value as any).data)) as T;
    } catch {
      return value as T;
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
