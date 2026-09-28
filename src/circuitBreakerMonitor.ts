import { EventEmitter } from "events";
import type { CircuitBreakerStatus, CircuitState } from "./types.js";

interface BreakerEntry {
  endpoint: string;
  state: CircuitState;
  failureCount: number;
  lastFailure: number | null;
  threshold: number;
}

export interface HealthCheckDiagnostics {
  healthy: boolean;
  totalBreakers: number;
  openBreakers: string[];
  halfOpenBreakers: string[];
  closedBreakers: string[];
  totalFailures: number;
  breakers: CircuitBreakerStatus[];
  checkedAt: number;
}

export class CircuitBreakerMonitor extends EventEmitter {
  private _breakers = new Map<string, BreakerEntry>();

  constructor() {
    super();
  }

  /** Create or ensure a breaker exists for endpoint */
  ensure(endpoint: string, threshold = 3): void {
    if (this._breakers.has(endpoint)) return;
    this._breakers.set(endpoint, {
      endpoint,
      state: "closed",
      failureCount: 0,
      lastFailure: null,
      threshold,
    });
  }

  recordFailure(endpoint: string): void {
    const b = this._breakers.get(endpoint);
    if (!b) return;
    const old = b.state;
    b.failureCount += 1;
    b.lastFailure = Date.now();
    if (b.state === "closed" && b.failureCount >= b.threshold) {
      b.state = "open";
      this.emit("stateChange", { endpoint, oldState: old, newState: b.state });
    }
  }

  recordSuccess(endpoint: string): void {
    const b = this._breakers.get(endpoint);
    if (!b) return;
    const old = b.state;
    b.failureCount = 0;
    b.lastFailure = null;
    if (b.state !== "closed") {
      b.state = "closed";
      this.emit("stateChange", { endpoint, oldState: old, newState: b.state });
    }
  }

  getStatus(): CircuitBreakerStatus[] {
    const out: CircuitBreakerStatus[] = [];
    for (const b of this._breakers.values()) {
      out.push({
        endpoint: b.endpoint,
        state: b.state,
        failureCount: b.failureCount,
        lastFailure: b.lastFailure,
      });
    }
    return out;
  }

  /**
   * Perform a health check across all registered breakers and return
   * detailed diagnostics. Emits "healthCheck" with the diagnostics and
   * "healthCheckError" if the check itself throws.
   */
  healthCheck(): HealthCheckDiagnostics {
    this.emit("healthCheckStart");
    try {
      const breakers = this.getStatus();
      const openBreakers: string[] = [];
      const halfOpenBreakers: string[] = [];
      const closedBreakers: string[] = [];
      let totalFailures = 0;

      for (const b of breakers) {
        totalFailures += b.failureCount;
        if (b.state === "open") openBreakers.push(b.endpoint);
        else if (b.state === "half-open") halfOpenBreakers.push(b.endpoint);
        else closedBreakers.push(b.endpoint);
      }

      const diagnostics: HealthCheckDiagnostics = {
        healthy: openBreakers.length === 0 && halfOpenBreakers.length === 0,
        totalBreakers: breakers.length,
        openBreakers,
        halfOpenBreakers,
        closedBreakers,
        totalFailures,
        breakers,
        checkedAt: Date.now(),
      };

      this.emit("healthCheck", diagnostics);
      return diagnostics;
    } catch (err) {
      this.emit("healthCheckError", err);
      throw err;
    }
  }

  /** Reset a breaker to closed state */
  reset(endpoint: string): void {
    const b = this._breakers.get(endpoint);
    if (!b) return;
    const old = b.state;
    b.state = "closed";
    b.failureCount = 0;
    b.lastFailure = null;
    this.emit("stateChange", { endpoint, oldState: old, newState: b.state });
  }
}

export const defaultCircuitBreakerMonitor = new CircuitBreakerMonitor();
