/**
 * SDK Telemetry Module (#885)
 *
 * Opt-in, local-only usage metrics. No data leaves the developer's
 * infrastructure unless an `endpoint` is explicitly configured.
 *
 * Features:
 * - Per-method call counts, error counts and latency percentiles (p50/p95/p99)
 * - `getMetrics()` returns an in-memory snapshot
 * - `resetMetrics()` clears all counters
 * - When `endpoint` is set, a periodic JSON POST flush is scheduled
 * - Disabled by default (`enabled: false`)
 *
 * @example
 * ```ts
 * import { StellarSplitTelemetry } from '@stellar-split/sdk/telemetry';
 *
 * const tel = new StellarSplitTelemetry({ enabled: true, flushIntervalMs: 30_000 });
 * tel.record('getInvoice', 42, true);
 * const snap = tel.getMetrics();
 * console.log(snap.methods['getInvoice'].p95LatencyMs);
 * ```
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Configuration for the telemetry module. */
export interface TelemetryConfig {
  /**
   * Whether telemetry collection is active. Defaults to `false` (opt-in).
   * When false, `record()` is a no-op and no timers are started.
   */
  enabled: boolean;
  /**
   * How often (in milliseconds) to flush accumulated metrics to `endpoint`.
   * Only meaningful when `endpoint` is also set. Default: 60_000.
   */
  flushIntervalMs: number;
  /**
   * Optional HTTP endpoint to POST metric snapshots to.
   * When omitted, metrics are only kept in-memory and never sent anywhere.
   */
  endpoint?: string;
}

/** Per-method statistics. */
export interface MethodMetrics {
  /** Total number of calls recorded for this method. */
  callCount: number;
  /** Number of calls that resulted in an error. */
  errorCount: number;
  /** 50th-percentile latency in milliseconds, or 0 when no calls recorded. */
  p50LatencyMs: number;
  /** 95th-percentile latency in milliseconds, or 0 when no calls recorded. */
  p95LatencyMs: number;
  /** 99th-percentile latency in milliseconds, or 0 when no calls recorded. */
  p99LatencyMs: number;
}

/** Complete metrics snapshot returned by {@link StellarSplitTelemetry.getMetrics}. */
export interface TelemetrySnapshot {
  /** Per-method statistics, keyed by method name. */
  methods: Record<string, MethodMetrics>;
  /** Unix timestamp (ms) when metrics collection started (or last reset). */
  startedAt: number;
  /** Unix timestamp (ms) of the snapshot. */
  snapshotAt: number;
}

// ---------------------------------------------------------------------------
// Internal accumulator
// ---------------------------------------------------------------------------

interface MethodAccumulator {
  callCount: number;
  errorCount: number;
  /** All recorded latency samples in ms (unsorted). */
  latencySamples: number[];
}

// ---------------------------------------------------------------------------
// Percentile helper
// ---------------------------------------------------------------------------

/**
 * Calculate the p-th percentile of a sorted array.
 * Uses nearest-rank method. Returns 0 for an empty array.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] ?? 0;
  // nearest rank
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1] ?? 0;
}

// ---------------------------------------------------------------------------
// StellarSplitTelemetry
// ---------------------------------------------------------------------------

/**
 * Opt-in telemetry module that tracks per-method SDK usage metrics.
 *
 * Create a single instance and pass it to every component that needs to
 * record metrics. Use {@link getMetrics} to read the current snapshot and
 * {@link resetMetrics} to clear all counters.
 */
export class StellarSplitTelemetry {
  private _config: TelemetryConfig;
  private _accumulators = new Map<string, MethodAccumulator>();
  private _startedAt = Date.now();
  private _flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: Partial<TelemetryConfig> = {}) {
    this._config = {
      enabled: false,
      flushIntervalMs: 60_000,
      ...config,
    };

    if (this._config.enabled && this._config.endpoint) {
      this._scheduleFlush();
    }
  }

  // -------------------------------------------------------------------------
  // Core API
  // -------------------------------------------------------------------------

  /**
   * Record a single method invocation.
   *
   * This is a no-op when `enabled` is `false`, so wrapping every SDK call
   * with `record()` adds zero overhead in the default configuration.
   *
   * @param method     - The SDK method name (e.g. "getInvoice").
   * @param latencyMs  - Call duration in milliseconds.
   * @param success    - Whether the call completed without throwing.
   */
  record(method: string, latencyMs: number, success: boolean): void {
    if (!this._config.enabled) return;

    let acc = this._accumulators.get(method);
    if (!acc) {
      acc = { callCount: 0, errorCount: 0, latencySamples: [] };
      this._accumulators.set(method, acc);
    }

    acc.callCount += 1;
    if (!success) acc.errorCount += 1;
    acc.latencySamples.push(latencyMs);
  }

  /**
   * Return a point-in-time snapshot of all accumulated metrics.
   * The returned object is a deep copy — subsequent `record()` calls do not
   * mutate it.
   */
  getMetrics(): TelemetrySnapshot {
    const methods: Record<string, MethodMetrics> = {};

    for (const [name, acc] of this._accumulators) {
      const sorted = [...acc.latencySamples].sort((a, b) => a - b);
      methods[name] = {
        callCount: acc.callCount,
        errorCount: acc.errorCount,
        p50LatencyMs: percentile(sorted, 50),
        p95LatencyMs: percentile(sorted, 95),
        p99LatencyMs: percentile(sorted, 99),
      };
    }

    return {
      methods,
      startedAt: this._startedAt,
      snapshotAt: Date.now(),
    };
  }

  /**
   * Clear all accumulated counters and latency samples.
   * The `startedAt` timestamp is reset to now.
   */
  resetMetrics(): void {
    this._accumulators.clear();
    this._startedAt = Date.now();
  }

  /**
   * Immediately flush accumulated metrics to the configured `endpoint`.
   * Resolves silently if no endpoint is configured or telemetry is disabled.
   * Never rejects — flush failures are swallowed to avoid disrupting callers.
   */
  async flush(): Promise<void> {
    if (!this._config.enabled || !this._config.endpoint) return;

    const snapshot = this.getMetrics();
    try {
      await fetch(this._config.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot),
      });
    } catch {
      // Telemetry must never break the SDK — silently swallow flush errors.
    }
  }

  /**
   * Stop the periodic flush timer and release resources.
   * Call this when the client is shut down to avoid dangling timers in tests.
   */
  destroy(): void {
    if (this._flushTimer !== null) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private _scheduleFlush(): void {
    if (this._flushTimer !== null) return;
    this._flushTimer = setInterval(() => {
      void this.flush();
    }, this._config.flushIntervalMs);
  }
}

// ---------------------------------------------------------------------------
// Convenience wrapper — wrap any async fn and record its metrics
// ---------------------------------------------------------------------------

/**
 * Wrap an async function so that every invocation is automatically recorded
 * by a {@link StellarSplitTelemetry} instance.
 *
 * @example
 * ```ts
 * const trackedGetInvoice = withTelemetry(tel, 'getInvoice', (id) => client.getInvoice(id));
 * const invoice = await trackedGetInvoice('123');
 * ```
 */
export function withTelemetry<TArgs extends unknown[], TReturn>(
  tel: StellarSplitTelemetry,
  method: string,
  fn: (...args: TArgs) => Promise<TReturn>,
): (...args: TArgs) => Promise<TReturn> {
  return async (...args: TArgs): Promise<TReturn> => {
    const start = Date.now();
    try {
      const result = await fn(...args);
      tel.record(method, Date.now() - start, true);
      return result;
    } catch (err) {
      tel.record(method, Date.now() - start, false);
      throw err;
    }
  };
}
