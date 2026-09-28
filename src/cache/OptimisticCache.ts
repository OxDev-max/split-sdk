/**
 * OptimisticCache — applies a predicted outcome to a cached value
 * immediately upon submission, then commits or rolls back once the
 * settled transaction result is known, so UIs built on the SDK don't have
 * to re-fetch (and flicker) after every mutation.
 *
 * Keyed by invoiceId, with an internal (invoiceId, version) composite so
 * concurrent optimistic mutations to the same invoice queue up instead of
 * clobbering one another: rolling back mutation N leaves mutations N+1..M
 * (and the base cache) untouched.
 *
 * Issue #776 — {@link OptimisticCache.read} additionally implements a
 * stale-while-revalidate strategy: once a value is within
 * `staleWhileRevalidateMs` of its TTL it is returned immediately while a
 * background revalidation refreshes it, eliminating the latency spike that
 * would otherwise hit every caller at the TTL boundary. At most one
 * revalidation runs per key at a time and background failures are emitted as
 * a `revalidateError` event (see {@link OptimisticCache.onRevalidateError})
 * instead of surfacing to the caller.
 */

import { SimpleCache } from "../cache.js";

export type CommitFn = () => void;
export type RollbackFn = () => void;

export interface OptimisticEntry<T> {
  key: string;
  invoiceId: string;
  version: number;
  predictedValue: T;
  rollbackValue: T;
}

export interface RollbackEvent<T> {
  key: string;
  invoiceId: string;
  version: number;
  /** The value now visible for `invoiceId` after this rollback (either an
   * older still-pending prediction, or the committed base value). */
  restoredValue: T;
}

/** Options controlling {@link OptimisticCache} freshness behaviour. */
export interface OptimisticCacheOptions {
  /**
   * Freshness window (ms) applied to values written through
   * `read()`/`set()` when no explicit TTL is passed. Defaults to 60_000.
   */
  defaultTtlMs?: number;
  /**
   * Extra window (ms) after a value's TTL during which the stale value is
   * served immediately while a background revalidation refreshes it.
   * `0` (the default) disables stale-while-revalidate: reads block on a fresh
   * fetch once the TTL elapses.
   */
  staleWhileRevalidateMs?: number;
  /**
   * Clock used for freshness bookkeeping, in milliseconds since the epoch.
   * Defaults to `Date.now`; injectable so tests can advance time
   * deterministically.
   */
  now?: () => number;
}

/** Payload emitted on {@link OptimisticCache.onRevalidateError}. */
export interface RevalidateErrorEvent {
  /** Cache key whose background revalidation failed. */
  key: string;
  /** The error thrown by the caller-supplied fetcher. */
  error: unknown;
}

/** Bookkeeping for a value written through `read()`/`set()`. */
interface FreshnessEntry<T> {
  value: T;
  /** Timestamp after which the value is stale (but may still be servable). */
  freshUntil: number;
  /** Timestamp after which the value may no longer be served at all. */
  staleUntil: number;
}

const DEFAULT_BASE_TTL_MS = 60_000;

export class OptimisticCache<T = unknown> {
  private readonly base: SimpleCache<T>;
  /** Per-invoice FIFO queue of pending (uncommitted, unrolled-back) predictions. */
  private readonly pending = new Map<string, OptimisticEntry<T>[]>();
  private readonly rollbackHandlers = new Set<(event: RollbackEvent<T>) => void>();
  private readonly versionCounters = new Map<string, number>();
  /** Freshness bookkeeping for values written through read()/set(). */
  private readonly freshness = new Map<string, FreshnessEntry<T>>();
  /** In-flight background revalidations, keyed by cache key. */
  private readonly revalidations = new Map<string, Promise<void>>();
  private readonly revalidateErrorHandlers = new Set<(event: RevalidateErrorEvent) => void>();
  private readonly defaultTtlMs: number;
  private readonly staleWhileRevalidateMs: number;
  private readonly now: () => number;

  constructor(base?: SimpleCache<T>, options: OptimisticCacheOptions = {}) {
    this.defaultTtlMs = options.defaultTtlMs ?? DEFAULT_BASE_TTL_MS;
    this.staleWhileRevalidateMs = options.staleWhileRevalidateMs ?? 0;
    this.now = options.now ?? Date.now;
    this.base = base ?? new SimpleCache<T>({ enabled: true, ttlMs: this.defaultTtlMs });
  }

  /**
   * Read the current UI-facing value for an invoice: the most recently
   * applied still-pending optimistic prediction if one exists, otherwise
   * the committed base value.
   */
  get(invoiceId: string): T | undefined {
    const queue = this.pending.get(invoiceId);
    if (queue && queue.length > 0) {
      return queue[queue.length - 1]!.predictedValue;
    }
    return this.base.get(invoiceId);
  }

  /** Number of optimistic mutations across all invoices awaiting commit/rollback. */
  get pendingCount(): number {
    let total = 0;
    for (const queue of this.pending.values()) total += queue.length;
    return total;
  }

  /** Register a listener invoked whenever a rollback() restores a prior value. */
  onRollback(handler: (event: RollbackEvent<T>) => void): () => void {
    this.rollbackHandlers.add(handler);
    return () => this.rollbackHandlers.delete(handler);
  }

  /**
   * Subscribe to the `revalidateError` event, emitted when a
   * stale-while-revalidate refresh fails.
   *
   * Background revalidation failures never reject the `read()` promise that
   * triggered them; they are reported here instead so the caller can log,
   * surface a non-blocking warning, or force a blocking refresh.
   *
   * @returns An unsubscribe function.
   */
  onRevalidateError(handler: (event: RevalidateErrorEvent) => void): () => void {
    this.revalidateErrorHandlers.add(handler);
    return () => this.revalidateErrorHandlers.delete(handler);
  }

  /**
   * Write a value into the cache with a freshness window.
   *
   * The value is served fresh for `ttlMs`, then — when
   * `staleWhileRevalidateMs` is configured — continues to be served stale for
   * the remainder of that extra window while a background refresh runs.
   *
   * @param key    - Cache key.
   * @param value  - Value to cache.
   * @param ttlMs  - Freshness window in ms. Defaults to `defaultTtlMs`.
   */
  set(key: string, value: T, ttlMs: number = this.defaultTtlMs): void {
    const now = this.now();
    this.freshness.set(key, {
      value,
      freshUntil: now + ttlMs,
      staleUntil: now + ttlMs + this.staleWhileRevalidateMs,
    });
    this.base.set(key, value);
  }

  /**
   * Read `key`, falling back to `fetcher` on a miss.
   *
   * Implements stale-while-revalidate (Issue #776):
   *  - A fresh value is returned without calling `fetcher`.
   *  - A value within `staleWhileRevalidateMs` of its TTL is returned
   *    immediately and refreshed in the background; failures are emitted via
   *    {@link onRevalidateError} and never rejected back to the caller.
   *  - A missing or fully expired value blocks on `fetcher`.
   *
   * At most one background revalidation runs per key at a time, so concurrent
   * readers cannot stampede the fetcher.
   *
   * @param key     - Cache key.
   * @param fetcher - Async loader used on a miss or full expiry.
   * @param ttlMs   - Freshness window in ms. Defaults to `defaultTtlMs`.
   *
   * @returns The cached or freshly fetched value (or `undefined` when the
   *   fetcher resolves to `undefined`).
   */
  async read(
    key: string,
    fetcher: (key: string) => Promise<T>,
    ttlMs: number = this.defaultTtlMs,
  ): Promise<T | undefined> {
    const now = this.now();
    const entry = this.freshness.get(key);

    if (entry && now < entry.staleUntil) {
      if (now < entry.freshUntil) {
        return entry.value;
      }
      // Stale but still within the revalidation window: serve immediately and
      // refresh in the background so the caller pays no latency.
      this._revalidateInBackground(key, fetcher, ttlMs);
      return entry.value;
    }

    return this._fetchAndStore(key, fetcher, ttlMs);
  }

  private async _fetchAndStore(
    key: string,
    fetcher: (key: string) => Promise<T>,
    ttlMs: number,
  ): Promise<T | undefined> {
    const value = await fetcher(key);
    if (value !== undefined) {
      this.set(key, value, ttlMs);
    }
    return value;
  }

  /** Start (or join) a single background revalidation for `key`. */
  private _revalidateInBackground(
    key: string,
    fetcher: (key: string) => Promise<T>,
    ttlMs: number,
  ): void {
    // One revalidation at a time per key — later readers attach to nothing and
    // simply keep serving the stale value.
    if (this.revalidations.has(key)) return;

    const run = (async () => {
      try {
        const value = await fetcher(key);
        if (value !== undefined) {
          this.set(key, value, ttlMs);
        }
      } catch (error) {
        for (const handler of this.revalidateErrorHandlers) {
          try {
            handler({ key, error });
          } catch {
            // Isolate listener failures from cache bookkeeping.
          }
        }
      } finally {
        this.revalidations.delete(key);
      }
    })();

    this.revalidations.set(key, run);
  }

  /**
   * Apply a predicted value for `invoiceId` immediately. Returns a
   * `{ commit, rollback }` pair: `commit()` writes the prediction into the
   * base cache, `rollback()` restores whatever was visible before this
   * prediction (an earlier still-pending prediction, or the base value).
   * Both are idempotent no-ops after the first call.
   */
  applyOptimistic(
    invoiceId: string,
    predictedValue: T,
    rollbackValue: T,
  ): { commit: CommitFn; rollback: RollbackFn; key: string } {
    const version = (this.versionCounters.get(invoiceId) ?? 0) + 1;
    this.versionCounters.set(invoiceId, version);
    const key = `${invoiceId}@${version}`;

    const entry: OptimisticEntry<T> = { key, invoiceId, version, predictedValue, rollbackValue };
    const queue = this.pending.get(invoiceId) ?? [];
    queue.push(entry);
    this.pending.set(invoiceId, queue);

    let settled = false;

    const commit: CommitFn = () => {
      if (settled) return;
      settled = true;
      this.base.set(invoiceId, entry.predictedValue);
      this._removeEntry(entry);
    };

    const rollback: RollbackFn = () => {
      if (settled) return;
      settled = true;
      this._removeEntry(entry);

      const remaining = this.pending.get(invoiceId);
      const stillPending = remaining && remaining.length > 0;
      const restoredValue = stillPending ? remaining![remaining!.length - 1]!.predictedValue : entry.rollbackValue;
      if (!stillPending) {
        this.base.set(invoiceId, entry.rollbackValue);
      }

      const event: RollbackEvent<T> = { key, invoiceId, version, restoredValue };
      for (const handler of this.rollbackHandlers) {
        try {
          handler(event);
        } catch {
          // Isolate listener failures from cache bookkeeping.
        }
      }
    };

    return { commit, rollback, key };
  }

  private _removeEntry(entry: OptimisticEntry<T>): void {
    const queue = this.pending.get(entry.invoiceId);
    if (!queue) return;
    const idx = queue.indexOf(entry);
    if (idx >= 0) queue.splice(idx, 1);
    if (queue.length === 0) this.pending.delete(entry.invoiceId);
  }
}
