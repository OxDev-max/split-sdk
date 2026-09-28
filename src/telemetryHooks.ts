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
 * A single recorded performance measurement produced by the built-in profiler.
 */
export interface ProfileMeasurement {
  /** The SDK method or operation name that was measured. */
  name: string;
  /** Duration of the operation in milliseconds. */
  durationMs: number;
  /** Timestamp when the measurement was recorded (milliseconds since epoch). */
  timestamp: number;
  /** Optional trace ID correlating this measurement with an SDK call. */
  traceId?: string;
  /** Optional arbitrary metadata attached to the measurement. */
  metadata?: Record<string, unknown>;
}

/**
 * Aggregated statistics for a profiled operation name.
 */
export interface ProfileStats {
  /** The operation name these stats describe. */
  name: string;
  /** Number of recorded measurements. */
  count: number;
  /** Total accumulated duration in milliseconds. */
  totalMs: number;
  /** Minimum observed duration in milliseconds. */
  minMs: number;
  /** Maximum observed duration in milliseconds. */
  maxMs: number;
  /** Mean duration in milliseconds. */
  avgMs: number;
}

/**
 * Parameters passed to the onProfile hook when a measurement is recorded.
 */
export interface TelemetryProfileParams {
  /** The recorded measurement. */
  measurement: ProfileMeasurement;
  /** Aggregated stats for the measured operation name. */
  stats: ProfileStats;
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
   * Called whenever the built-in profiler records a measurement.
   * 
   * @param params - The measurement and its aggregated stats.
   */
  onProfile?(params: TelemetryProfileParams): void;
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
   * Invoke the onProfile hook if registered.
   * Exceptions within the hook are caught and logged but do not propagate.
   * 
   * @param params - Profile measurement and stats.
   */
  fireOnProfile(params: TelemetryProfileParams): void {
    if (!this.hooks.onProfile) {
      return;
    }

    try {
      this.hooks.onProfile(params);
    } catch (hookError) {
      // Fire-and-forget: hook errors must not propagate
      console.error("[TelemetryHook] onProfile hook threw an exception:", hookError);
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
      this.hooks.onProfile
    );
  }
}

/**
 * Built-in SDK performance profiler.
 *
 * Records operation timings, aggregates per-operation statistics, and emits
 * lifecycle events (start/stop/mark/measure) through the telemetry hook manager.
 *
 * The profiler is disabled by default and must be explicitly enabled via
 * {@link enable} so it adds zero overhead unless opted into.
 */
export class SdkProfiler {
  private enabled = false;
  private readonly measurements: ProfileMeasurement[] = [];
  private readonly stats = new Map<string, ProfileStats>();
  private readonly activeMarks = new Map<string, number>();

  constructor(private readonly hookManager?: TelemetryHookManager) {}

  /**
   * Enable profiling. Subsequent {@link measure} and {@link mark}/{@link endMark}
   * calls will record measurements.
   */
  enable(): void {
    this.enabled = true;
  }

  /**
   * Disable profiling. Existing recorded measurements are retained until cleared.
   */
  disable(): void {
    this.enabled = false;
  }

  /**
   * Whether profiling is currently enabled.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Record a completed measurement for the given operation name.
   * No-op when profiling is disabled.
   *
   * @param name - The operation name being measured.
   * @param durationMs - Duration of the operation in milliseconds.
   * @param options - Optional trace ID and metadata.
   * @returns The recorded measurement, or undefined when disabled.
   */
  measure(
    name: string,
    durationMs: number,
    options?: { traceId?: string; metadata?: Record<string, unknown> }
  ): ProfileMeasurement | undefined {
    if (!this.enabled) {
      return undefined;
    }

    const measurement: ProfileMeasurement = {
      name,
      durationMs,
      timestamp: Date.now(),
      traceId: options?.traceId,
      metadata: options?.metadata,
    };

    this.measurements.push(measurement);
    const stats = this.updateStats(measurement);
    this.hookManager?.fireOnProfile({ measurement, stats });

    return measurement;
  }

  /**
   * Start timing an operation. Pairs with {@link endMark}.
   * No-op when profiling is disabled.
   *
   * @param name - The operation name to start timing.
   */
  mark(name: string): void {
    if (!this.enabled) {
      return;
    }
    this.activeMarks.set(name, Date.now());
  }

  /**
   * Finish timing an operation started with {@link mark} and record the measurement.
   * No-op when profiling is disabled or no matching mark exists.
   *
   * @param name - The operation name to finish timing.
   * @param options - Optional trace ID and metadata.
   * @returns The recorded measurement, or undefined when disabled/unmatched.
   */
  endMark(
    name: string,
    options?: { traceId?: string; metadata?: Record<string, unknown> }
  ): ProfileMeasurement | undefined {
    if (!this.enabled) {
      return undefined;
    }

    const start = this.activeMarks.get(name);
    if (start === undefined) {
      return undefined;
    }

    this.activeMarks.delete(name);
    return this.measure(name, Date.now() - start, options);
  }

  /**
   * Convenience helper that times an async operation and records a measurement.
   * No-op passthrough when profiling is disabled.
   *
   * @param name - The operation name being measured.
   * @param fn - The async function to execute and time.
   * @param options - Optional trace ID and metadata.
   * @returns The resolved value of the wrapped function.
   */
  async profile<T>(
    name: string,
    fn: () => Promise<T>,
    options?: { traceId?: string; metadata?: Record<string, unknown> }
  ): Promise<T> {
    if (!this.enabled) {
      return fn();
    }

    const start = Date.now();
    try {
      return await fn();
    } finally {
      this.measure(name, Date.now() - start, options);
    }
  }

  /**
   * Get all recorded measurements (a defensive copy).
   */
  getMeasurements(): ProfileMeasurement[] {
    return [...this.measurements];
  }

  /**
   * Get aggregated stats for a single operation name, if any.
   */
  getStats(name: string): ProfileStats | undefined {
    const stats = this.stats.get(name);
    return stats ? { ...stats } : undefined;
  }

  /**
   * Get aggregated stats for all profiled operation names.
   */
  getAllStats(): ProfileStats[] {
    return Array.from(this.stats.values(), (stats) => ({ ...stats }));
  }

  /**
   * Clear all recorded measurements, stats, and active marks.
   */
  clear(): void {
    this.measurements.length = 0;
    this.stats.clear();
    this.activeMarks.clear();
  }

  private updateStats(measurement: ProfileMeasurement): ProfileStats {
    const existing = this.stats.get(measurement.name);

    const next: ProfileStats = existing
      ? {
          name: measurement.name,
          count: existing.count + 1,
          totalMs: existing.totalMs + measurement.durationMs,
          minMs: Math.min(existing.minMs, measurement.durationMs),
          maxMs: Math.max(existing.maxMs, measurement.durationMs),
          avgMs: 0,
        }
      : {
          name: measurement.name,
          count: 1,
          totalMs: measurement.durationMs,
          minMs: measurement.durationMs,
          maxMs: measurement.durationMs,
          avgMs: 0,
        };

    next.avgMs = next.totalMs / next.count;
    this.stats.set(measurement.name, next);
    return next;
  }
}
