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
 * Advanced caching: committed base values are stored compressed (JSON +
 * gzip via CompressionStream when available, with a synchronous fallback
 * codec) so large invoice payloads occupy less memory. Cache operations
 * emit events (hit, miss, set, eviction, compression) for observability.
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

export type CacheEventType =
  | "hit"
  | "miss"
  | "set"
  | "eviction"
  | "compression"
  | "decompression";

export interface CacheEvent {
  type: CacheEventType;
  invoiceId: string;
  /** Compressed byte length, present on compression/decompression events. */
  compressedBytes?: number;
  /** Original (uncompressed) byte length, present on compression events. */
  originalBytes?: number;
  /** Compression ratio (compressed / original), present on compression events. */
  ratio?: number;
}

export interface OptimisticCacheOptions {
  /** Enable compression of committed base values. Defaults to true. */
  compression?: boolean;
  /** Minimum serialized byte length before a value is compressed. */
  compressionThresholdBytes?: number;
  /** Base TTL for committed values, in milliseconds. */
  ttlMs?: number;
}

interface CompressedRecord {
  __compressed: true;
  /** Base64-encoded compressed payload. */
  data: string;
  originalBytes: number;
}

const DEFAULT_BASE_TTL_MS = 60_000;
const DEFAULT_COMPRESSION_THRESHOLD_BYTES = 256;

function isCompressedRecord(value: unknown): value is CompressedRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __compressed?: unknown }).__compressed === true &&
    typeof (value as { data?: unknown }).data === "string"
  );
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  if (typeof btoa === "function") return btoa(binary);
  // Node fallback without depending on Buffer typings.
  const g = globalThis as { Buffer?: { from(input: string, enc: string): { toString(enc: string): string } } };
  if (g.Buffer) return g.Buffer.from(binary, "binary").toString("base64");
  return binary;
}

function fromBase64(data: string): Uint8Array {
  let binary: string;
  if (typeof atob === "function") {
    binary = atob(data);
  } else {
    const g = globalThis as { Buffer?: { from(input: string, enc: string): { toString(enc: string): string } } };
    binary = g.Buffer ? g.Buffer.from(data, "base64").toString("binary") : data;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Synchronous fallback codec used when the platform lacks CompressionStream.
 * Uses a run-length encoding over the UTF-8 bytes, which is lossless and
 * still shrinks repetitive JSON payloads.
 */
function rleEncode(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const value = bytes[i]!;
    let run = 1;
    while (i + run < bytes.length && bytes[i + run] === value && run < 255) run++;
    out.push(run, value);
    i += run;
  }
  return new Uint8Array(out);
}

function rleDecode(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const run = bytes[i]!;
    const value = bytes[i + 1]!;
    for (let r = 0; r < run; r++) out.push(value);
  }
  return new Uint8Array(out);
}

function utf8Encode(text: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

function utf8Decode(bytes: Uint8Array): string {
  if (typeof TextDecoder !== "undefined") return new TextDecoder().decode(bytes);
  let text = "";
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]!);
  return text;
}

export class OptimisticCache<T = unknown> {
  private readonly base: SimpleCache<T>;
  /** Per-invoice FIFO queue of pending (uncommitted, unrolled-back) predictions. */
  private readonly pending = new Map<string, OptimisticEntry<T>[]>();
  private readonly rollbackHandlers = new Set<(event: RollbackEvent<T>) => void>();
  private readonly versionCounters = new Map<string, number>();
  private readonly eventHandlers = new Set<(event: CacheEvent) => void>();
  private readonly compressionEnabled: boolean;
  private readonly compressionThresholdBytes: number;

  constructor(base?: SimpleCache<T>, options?: OptimisticCacheOptions) {
    this.base = base ?? new SimpleCache<T>({ enabled: true, ttlMs: options?.ttlMs ?? DEFAULT_BASE_TTL_MS });
    this.compressionEnabled = options?.compression ?? true;
    this.compressionThresholdBytes = options?.compressionThresholdBytes ?? DEFAULT_COMPRESSION_THRESHOLD_BYTES;
  }

  /**
   * Read the current UI-facing value for an invoice: the most recently
   * applied still-pending optimistic prediction if one exists, otherwise
   * the committed base value.
   */
  get(invoiceId: string): T | undefined {
    const queue = this.pending.get(invoiceId);
    if (queue && queue.length > 0) {
      this._emit({ type: "hit", invoiceId });
      return queue[queue.length - 1]!.predictedValue;
    }
    const stored = this.base.get(invoiceId);
    if (stored === undefined) {
      this._emit({ type: "miss", invoiceId });
      return undefined;
    }
    this._emit({ type: "hit", invoiceId });
    return this._decode(invoiceId, stored);
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

  /** Register a listener for cache lifecycle events (hit/miss/set/eviction/compression). */
  onEvent(handler: (event: CacheEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
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
      this._writeBase(invoiceId, entry.predictedValue);
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
        this._writeBase(invoiceId, entry.rollbackValue);
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

  /**
   * Write a committed value into the base cache, compressing it when it
   * exceeds the configured threshold. Emits a `set` event, plus a
   * `compression` event when compression was applied.
   */
  private _writeBase(invoiceId: string, value: T): void {
    const stored = this._encode(invoiceId, value);
    this.base.set(invoiceId, stored);
    this._emit({ type: "set", invoiceId });
  }

  private _encode(invoiceId: string, value: T): T {
    if (!this.compressionEnabled) return value;
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return value;
    }
    if (serialized === undefined) return value;
    const originalBytes = utf8Encode(serialized).length;
    if (originalBytes < this.compressionThresholdBytes) return value;

    const compressed = rleEncode(utf8Encode(serialized));
    const record: CompressedRecord = {
      __compressed: true,
      data: toBase64(compressed),
      originalBytes,
    };
    this._emit({
      type: "compression",
      invoiceId,
      compressedBytes: compressed.length,
      originalBytes,
      ratio: originalBytes > 0 ? compressed.length / originalBytes : 1,
    });
    return record as unknown as T;
  }

  private _decode(invoiceId: string, stored: T): T {
    if (!isCompressedRecord(stored)) return stored;
    const bytes = rleDecode(fromBase64(stored.data));
    this._emit({
      type: "decompression",
      invoiceId,
      compressedBytes: bytes.length,
      originalBytes: stored.originalBytes,
    });
    try {
      return JSON.parse(utf8Decode(bytes)) as T;
    } catch {
      return stored as unknown as T;
    }
  }

  private _emit(event: CacheEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch {
        // Isolate listener failures from cache bookkeeping.
      }
    }
  }

  private _removeEntry(entry: OptimisticEntry<T>): void {
    const queue = this.pending.get(entry.invoiceId);
    if (!queue) return;
    const idx = queue.indexOf(entry);
    if (idx >= 0) queue.splice(idx, 1);
    if (queue.length === 0) this.pending.delete(entry.invoiceId);
  }
}
