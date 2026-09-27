/**
 * Opt-in telemetry hook system for SDK error and performance monitoring.
 * 
 * Allows application developers to integrate their own monitoring solutions
 * (Sentry, Datadog, custom telemetry) without the SDK having direct dependencies.
 * 
 * All hooks are fire-and-forget — exceptions within hooks do not propagate to SDK callers.
 */

import type { StellarSplitError } from "./errors.js";

/**
 * Context provided to the onError hook when an SDK error occurs.
 */
export interface TelemetryErrorContext {
  /** The SDK method that threw the error (e.g., "createInvoice", "pay"). */
  method: string;
  /** Method arguments (sanitized, no sensitive data). */
  args?: Record<string, unknown>;
  /** Timestamp when the error occurred (milliseconds since epoch). */
  timestamp: number;
  /** Trace ID for correlating this error with the originating SDK call. */
  traceId?: string;
}

/**
 * Parameters passed to onCallStart before each RPC call.
 */
export interface TelemetryCallStartParams {
  /** The SDK method name being invoked (e.g., "getInvoice", "pay"). */
  method: string;
  /** Method arguments (sanitized, no sensitive data). */
  args?: Record<string, unknown>;
  /** Timestamp when the call started (milliseconds since epoch). */
  timestamp: number;
  /** Unique trace ID for this SDK method invocation. */
  traceId?: string;
}

/**
 * Parameters passed to onCallEnd after each RPC call completes.
 */
export interface TelemetryCallEndParams {
  /** The SDK method name that was invoked. */
  method: string;
  /** Duration of the call in milliseconds. */
  durationMs: number;
  /** Whether the call succeeded without throwing an error. */
  success: boolean;
  /** The error that occurred, if any. */
  error?: StellarSplitError;
  /** Timestamp when the call ended (milliseconds since epoch). */
  timestamp: number;
  /** Unique trace ID for this SDK method invocation. */
  traceId?: string;
}

/**
 * A single memory usage sample captured during profiling.
 */
export interface MemorySample {
  /** Timestamp when the sample was captured (milliseconds since epoch). */
  timestamp: number;
  /** Heap used in bytes at the time of the sample. */
  heapUsedBytes: number;
  /** Total heap size in bytes at the time of the sample. */
  heapTotalBytes: number;
  /** Resident set size in bytes, if available. */
  rssBytes?: number;
  /** Optional label describing what triggered the sample. */
  label?: string;
}

/**
 * A heap snapshot captured during profiling.
 */
export interface MemorySnapshot {
  /** Timestamp when the snapshot was captured (milliseconds since epoch). */
  timestamp: number;
  /** Optional label describing the snapshot. */
  label?: string;
  /** Heap used in bytes at the time of the snapshot. */
  heapUsedBytes: number;
  /** Total heap size in bytes at the time of the snapshot. */
  heapTotalBytes: number;
  /** Resident set size in bytes, if available. */
  rssBytes?: number;
}

/**
 * Aggregated memory profiling report produced by {@link MemoryProfiler.stop}.
 */
export interface MemoryProfileReport {
  /** Timestamp when profiling started (milliseconds since epoch). */
  startedAt: number;
  /** Timestamp when profiling stopped (milliseconds since epoch). */
  stoppedAt: number;
  /** Total profiling duration in milliseconds. */
  durationMs: number;
  /** Number of samples captured during the session. */
  sampleCount: number;
  /** Peak heap used in bytes observed during the session. */
  peakHeapUsedBytes: number;
  /** Heap used in bytes at the start of the session. */
  startHeapUsedBytes: number;
  /** Heap used in bytes at the end of the session. */
  endHeapUsedBytes: number;
  /** Net change in heap used bytes over the session. */
  heapUsedDeltaBytes: number;
  /** All samples captured during the session, in chronological order. */
  samples: MemorySample[];
  /** All snapshots captured during the session, in chronological order. */
  snapshots: MemorySnapshot[];
}

/**
 * Parameters passed to memory profiling lifecycle hooks.
 */
export interface MemoryProfileEventParams {
  /** Timestamp when the event occurred (milliseconds since epoch). */
  timestamp: number;
  /** The profiler instance that emitted the event. */
  profiler: MemoryProfiler;
}

/**
 * Parameters passed to the onMemorySample hook.
 */
export interface MemorySampleEventParams extends MemoryProfileEventParams {
  /** The sample that was captured. */
  sample: MemorySample;
}

/**
 * Parameters passed to the onMemorySnapshot hook.
 */
export interface MemorySnapshotEventParams extends MemoryProfileEventParams {
  /** The snapshot that was captured. */
  snapshot: MemorySnapshot;
}

/**
 * Parameters passed to the onMemoryProfileStop hook.
 */
export interface MemoryProfileStopEventParams extends MemoryProfileEventParams {
  /** The aggregated report produced when profiling stopped. */
  report: MemoryProfileReport;
}

/**
 * Telemetry hooks that can be registered with the SDK.
 * All hooks are optional and fire-and-forget.
 */
export interface TelemetryHooks {
  /**
   * Called whenever an SDK error is thrown, before it propagates to the caller.
   * 
   * @param error - The error instance that was thrown.
   * @param context - Additional context about the error (method, args, timestamp).
   */
  onError?(error: StellarSplitError, context: TelemetryErrorContext): void;

  /**
   * Called before each SDK method invocation that makes an RPC call.
   * 
   * @param params - Call parameters including method name, args, and timestamp.
   */
  onCallStart?(params: TelemetryCallStartParams): void;

  /**
   * Called after each SDK method invocation completes (success or failure).
   * 
   * @param params - Call results including method name, duration, success status, and optional error.
   */
  onCallEnd?(params: TelemetryCallEndParams): void;

  /**
   * Called when a memory profiling session starts.
   *
   * @param params - Event parameters including the profiler instance and timestamp.
   */
  onMemoryProfileStart?(params: MemoryProfileEventParams): void;

  /**
   * Called each time a memory sample is captured during profiling.
   *
   * @param params - Event parameters including the captured sample.
   */
  onMemorySample?(params: MemorySampleEventParams): void;

  /**
   * Called each time a heap snapshot is captured during profiling.
   *
   * @param params - Event parameters including the captured snapshot.
   */
  onMemorySnapshot?(params: MemorySnapshotEventParams): void;

  /**
   * Called when a memory profiling session stops, with the aggregated report.
   *
   * @param params - Event parameters including the final report.
   */
  onMemoryProfileStop?(params: MemoryProfileStopEventParams): void;
}

/**
 * Internal telemetry hook manager for the SDK.
 * Handles safe invocation of user-provided hooks with error isolation.
 */
export class TelemetryHookManager {
  private hooks: TelemetryHooks = {};

  /**
   * Register telemetry hooks.
   * Replaces any previously registered hooks.
   * 
   * @param hooks - The telemetry hooks to register.
   */
  setHooks(hooks: TelemetryHooks): void {
    this.hooks = hooks;
  }

  /**
   * Clear all registered telemetry hooks.
   */
  clearHooks(): void {
    this.hooks = {};
  }

  /**
   * Invoke the onError hook if registered.
   * Exceptions within the hook are caught and logged to console but do not propagate.
   * 
   * @param error - The error that occurred.
   * @param context - Context about the error.
   */
  fireOnError(error: StellarSplitError, context: TelemetryErrorContext): void {
    if (!this.hooks.onError) {
      return;
    }

    try {
      this.hooks.onError(error, context);
    } catch (hookError) {
      // Fire-and-forget: hook errors must not propagate
      console.error("[TelemetryHook] onError hook threw an exception:", hookError);
    }
  }

  /**
   * Invoke the onCallStart hook if registered.
   * Exceptions within the hook are caught and logged but do not propagate.
   * 
   * @param params - Call start parameters.
   */
  fireOnCallStart(params: TelemetryCallStartParams): void {
    if (!this.hooks.onCallStart) {
      return;
    }

    try {
      this.hooks.onCallStart(params);
    } catch (hookError) {
      // Fire-and-forget: hook errors must not propagate
      console.error("[TelemetryHook] onCallStart hook threw an exception:", hookError);
    }
  }

  /**
   * Invoke the onCallEnd hook if registered.
   * Exceptions within the hook are caught and logged but do not propagate.
   * 
   * @param params - Call end parameters.
   */
  fireOnCallEnd(params: TelemetryCallEndParams): void {
    if (!this.hooks.onCallEnd) {
      return;
    }

    try {
      this.hooks.onCallEnd(params);
    } catch (hookError) {
      // Fire-and-forget: hook errors must not propagate
      console.error("[TelemetryHook] onCallEnd hook threw an exception:", hookError);
    }
  }

  /**
   * Invoke the onMemoryProfileStart hook if registered.
   * Exceptions within the hook are caught and logged but do not propagate.
   *
   * @param params - Memory profile start event parameters.
   */
  fireOnMemoryProfileStart(params: MemoryProfileEventParams): void {
    if (!this.hooks.onMemoryProfileStart) {
      return;
    }

    try {
      this.hooks.onMemoryProfileStart(params);
    } catch (hookError) {
      // Fire-and-forget: hook errors must not propagate
      console.error("[TelemetryHook] onMemoryProfileStart hook threw an exception:", hookError);
    }
  }

  /**
   * Invoke the onMemorySample hook if registered.
   * Exceptions within the hook are caught and logged but do not propagate.
   *
   * @param params - Memory sample event parameters.
   */
  fireOnMemorySample(params: MemorySampleEventParams): void {
    if (!this.hooks.onMemorySample) {
      return;
    }

    try {
      this.hooks.onMemorySample(params);
    } catch (hookError) {
      // Fire-and-forget: hook errors must not propagate
      console.error("[TelemetryHook] onMemorySample hook threw an exception:", hookError);
    }
  }

  /**
   * Invoke the onMemorySnapshot hook if registered.
   * Exceptions within the hook are caught and logged but do not propagate.
   *
   * @param params - Memory snapshot event parameters.
   */
  fireOnMemorySnapshot(params: MemorySnapshotEventParams): void {
    if (!this.hooks.onMemorySnapshot) {
      return;
    }

    try {
      this.hooks.onMemorySnapshot(params);
    } catch (hookError) {
      // Fire-and-forget: hook errors must not propagate
      console.error("[TelemetryHook] onMemorySnapshot hook threw an exception:", hookError);
    }
  }

  /**
   * Invoke the onMemoryProfileStop hook if registered.
   * Exceptions within the hook are caught and logged but do not propagate.
   *
   * @param params - Memory profile stop event parameters.
   */
  fireOnMemoryProfileStop(params: MemoryProfileStopEventParams): void {
    if (!this.hooks.onMemoryProfileStop) {
      return;
    }

    try {
      this.hooks.onMemoryProfileStop(params);
    } catch (hookError) {
      // Fire-and-forget: hook errors must not propagate
      console.error("[TelemetryHook] onMemoryProfileStop hook threw an exception:", hookError);
    }
  }

  /**
   * Check if any hooks are registered.
   */
  hasHooks(): boolean {
    return !!(
      this.hooks.onError ||
      this.hooks.onCallStart ||
      this.hooks.onCallEnd ||
      this.hooks.onMemoryProfileStart ||
      this.hooks.onMemorySample ||
      this.hooks.onMemorySnapshot ||
      this.hooks.onMemoryProfileStop
    );
  }
}

/**
 * Reads current memory usage from the runtime, when available.
 * Returns undefined in environments without `process.memoryUsage` (e.g. browsers).
 */
function readMemoryUsage(): { heapUsedBytes: number; heapTotalBytes: number; rssBytes?: number } | undefined {
  const proc = (globalThis as { process?: { memoryUsage?: () => { heapUsed: number; heapTotal: number; rss?: number } } }).process;
  if (!proc || typeof proc.memoryUsage !== "function") {
    return undefined;
  }

  try {
    const usage = proc.memoryUsage();
    return {
      heapUsedBytes: usage.heapUsed,
      heapTotalBytes: usage.heapTotal,
      rssBytes: usage.rss,
    };
  } catch {
    return undefined;
  }
}

/**
 * SDK memory profiler.
 *
 * Captures heap usage samples and snapshots over a profiling session and
 * produces an aggregated {@link MemoryProfileReport}. Lifecycle events are
 * emitted through the registered {@link TelemetryHooks} (start, sample,
 * snapshot, stop) with the same fire-and-forget error isolation as other hooks.
 *
 * The profiler is safe to use in environments without `process.memoryUsage`;
 * in that case samples report zeroed byte counts.
 */
export class MemoryProfiler {
  private readonly hookManager: TelemetryHookManager;
  private startedAt?: number;
  private samples: MemorySample[] = [];
  private snapshots: MemorySnapshot[] = [];
  private startHeapUsedBytes = 0;

  constructor(hookManager?: TelemetryHookManager) {
    this.hookManager = hookManager ?? new TelemetryHookManager();
  }

  /**
   * Whether a profiling session is currently active.
   */
  isRunning(): boolean {
    return this.startedAt !== undefined;
  }

  /**
   * Start a profiling session.
   * Resets any previously collected samples and snapshots.
   *
   * @returns The profiler instance for chaining.
   */
  start(): this {
    this.startedAt = Date.now();
    this.samples = [];
    this.snapshots = [];
    this.startHeapUsedBytes = readMemoryUsage()?.heapUsedBytes ?? 0;

    this.hookManager.fireOnMemoryProfileStart({
      timestamp: this.startedAt,
      profiler: this,
    });

    return this;
  }

  /**
   * Capture a memory usage sample.
   * No-op if profiling has not been started.
   *
   * @param label - Optional label describing what triggered the sample.
   * @returns The captured sample, or undefined if profiling is not active.
   */
  sample(label?: string): MemorySample | undefined {
    if (this.startedAt === undefined) {
      return undefined;
    }

    const usage = readMemoryUsage();
    const sample: MemorySample = {
      timestamp: Date.now(),
      heapUsedBytes: usage?.heapUsedBytes ?? 0,
      heapTotalBytes: usage?.heapTotalBytes ?? 0,
      rssBytes: usage?.rssBytes,
      label,
    };

    this.samples.push(sample);

    this.hookManager.fireOnMemorySample({
      timestamp: sample.timestamp,
      profiler: this,
      sample,
    });

    return sample;
  }

  /**
   * Capture a heap snapshot.
   * No-op if profiling has not been started.
   *
   * @param label - Optional label describing the snapshot.
   * @returns The captured snapshot, or undefined if profiling is not active.
   */
  snapshot(label?: string): MemorySnapshot | undefined {
    if (this.startedAt === undefined) {
      return undefined;
    }

    const usage = readMemoryUsage();
    const snapshot: MemorySnapshot = {
      timestamp: Date.now(),
      label,
      heapUsedBytes: usage?.heapUsedBytes ?? 0,
      heapTotalBytes: usage?.heapTotalBytes ?? 0,
      rssBytes: usage?.rssBytes,
    };

    this.snapshots.push(snapshot);

    this.hookManager.fireOnMemorySnapshot({
      timestamp: snapshot.timestamp,
      profiler: this,
      snapshot,
    });

    return snapshot;
  }

  /**
   * Stop the profiling session and produce an aggregated report.
   * No-op returning undefined if profiling has not been started.
   *
   * @returns The aggregated report, or undefined if profiling is not active.
   */
  stop(): MemoryProfileReport | undefined {
    if (this.startedAt === undefined) {
      return undefined;
    }

    const startedAt = this.startedAt;
    const stoppedAt = Date.now();
    const endHeapUsedBytes = readMemoryUsage()?.heapUsedBytes ?? 0;

    const peakHeapUsedBytes = this.samples.reduce(
      (peak, s) => (s.heapUsedBytes > peak ? s.heapUsedBytes : peak),
      this.startHeapUsedBytes,
    );

    const report: MemoryProfileReport = {
      startedAt,
      stoppedAt,
      durationMs: stoppedAt - startedAt,
      sampleCount: this.samples.length,
      peakHeapUsedBytes,
      startHeapUsedBytes: this.startHeapUsedBytes,
      endHeapUsedBytes,
      heapUsedDeltaBytes: endHeapUsedBytes - this.startHeapUsedBytes,
      samples: [...this.samples],
      snapshots: [...this.snapshots],
    };

    this.startedAt = undefined;

    this.hookManager.fireOnMemoryProfileStop({
      timestamp: stoppedAt,
      profiler: this,
      report,
    });

    return report;
  }
}
