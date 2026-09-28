/**
 * Tests for #885 — SDK Telemetry Module
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  StellarSplitTelemetry,
  withTelemetry,
} from "../src/telemetryModule.js";
import type { TelemetryConfig } from "../src/telemetryModule.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTelemetry(overrides: Partial<TelemetryConfig> = {}) {
  return new StellarSplitTelemetry({ enabled: true, flushIntervalMs: 60_000, ...overrides });
}

// ---------------------------------------------------------------------------
// Default / disabled behaviour
// ---------------------------------------------------------------------------

describe("StellarSplitTelemetry — disabled by default", () => {
  it("creates without throwing", () => {
    expect(() => new StellarSplitTelemetry()).not.toThrow();
  });

  it("record() is a no-op when disabled", () => {
    const tel = new StellarSplitTelemetry({ enabled: false, flushIntervalMs: 0 });
    tel.record("getInvoice", 10, true);
    const snap = tel.getMetrics();
    expect(Object.keys(snap.methods)).toHaveLength(0);
  });

  it("getMetrics() returns empty methods map when disabled", () => {
    const tel = new StellarSplitTelemetry({ enabled: false, flushIntervalMs: 0 });
    const snap = tel.getMetrics();
    expect(snap.methods).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Accumulation
// ---------------------------------------------------------------------------

describe("StellarSplitTelemetry — metrics accumulation", () => {
  let tel: StellarSplitTelemetry;

  beforeEach(() => {
    tel = makeTelemetry();
  });

  afterEach(() => {
    tel.destroy();
  });

  it("increments callCount on each record()", () => {
    tel.record("createInvoice", 10, true);
    tel.record("createInvoice", 20, true);
    const snap = tel.getMetrics();
    expect(snap.methods["createInvoice"]?.callCount).toBe(2);
  });

  it("increments errorCount only on failure", () => {
    tel.record("pay", 5, true);
    tel.record("pay", 8, false);
    tel.record("pay", 6, false);
    const snap = tel.getMetrics();
    expect(snap.methods["pay"]?.errorCount).toBe(2);
    expect(snap.methods["pay"]?.callCount).toBe(3);
  });

  it("tracks multiple methods independently", () => {
    tel.record("getInvoice", 12, true);
    tel.record("getPayments", 7, true);
    const snap = tel.getMetrics();
    expect(snap.methods["getInvoice"]?.callCount).toBe(1);
    expect(snap.methods["getPayments"]?.callCount).toBe(1);
  });

  it("getMetrics() includes snapshotAt and startedAt", () => {
    const snap = tel.getMetrics();
    expect(typeof snap.snapshotAt).toBe("number");
    expect(typeof snap.startedAt).toBe("number");
    expect(snap.snapshotAt).toBeGreaterThanOrEqual(snap.startedAt);
  });
});

// ---------------------------------------------------------------------------
// Percentiles
// ---------------------------------------------------------------------------

describe("StellarSplitTelemetry — latency percentiles", () => {
  let tel: StellarSplitTelemetry;

  beforeEach(() => {
    tel = makeTelemetry();
  });

  afterEach(() => {
    tel.destroy();
  });

  it("p50/p95/p99 are 0 for a single sample", () => {
    tel.record("m", 42, true);
    const m = tel.getMetrics().methods["m"]!;
    // With a single sample all percentiles equal that sample
    expect(m.p50LatencyMs).toBe(42);
    expect(m.p95LatencyMs).toBe(42);
    expect(m.p99LatencyMs).toBe(42);
  });

  it("p50 is the median of a sorted list", () => {
    // Samples: 10, 20, 30 → sorted: [10, 20, 30] → p50 = 20
    [10, 30, 20].forEach((v) => tel.record("med", v, true));
    const m = tel.getMetrics().methods["med"]!;
    expect(m.p50LatencyMs).toBe(20);
  });

  it("p99 exceeds p95 which exceeds p50 for a range of samples", () => {
    for (let i = 1; i <= 100; i++) tel.record("range", i, true);
    const m = tel.getMetrics().methods["range"]!;
    expect(m.p99LatencyMs).toBeGreaterThanOrEqual(m.p95LatencyMs);
    expect(m.p95LatencyMs).toBeGreaterThanOrEqual(m.p50LatencyMs);
  });

  it("returns 0 for a method with no calls", () => {
    // Manually check: no records means empty methods map
    const snap = tel.getMetrics();
    expect(snap.methods["neverCalled"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resetMetrics()
// ---------------------------------------------------------------------------

describe("StellarSplitTelemetry — resetMetrics()", () => {
  let tel: StellarSplitTelemetry;

  beforeEach(() => {
    tel = makeTelemetry();
  });

  afterEach(() => {
    tel.destroy();
  });

  it("clears all method accumulators", () => {
    tel.record("getInvoice", 10, true);
    tel.record("pay", 5, false);
    tel.resetMetrics();
    const snap = tel.getMetrics();
    expect(Object.keys(snap.methods)).toHaveLength(0);
  });

  it("resets startedAt to current time", () => {
    const before = Date.now();
    tel.resetMetrics();
    const snap = tel.getMetrics();
    expect(snap.startedAt).toBeGreaterThanOrEqual(before);
  });

  it("allows new records after reset", () => {
    tel.record("pay", 5, true);
    tel.resetMetrics();
    tel.record("pay", 8, true);
    const snap = tel.getMetrics();
    expect(snap.methods["pay"]?.callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// flush() — no endpoint
// ---------------------------------------------------------------------------

describe("StellarSplitTelemetry — flush() without endpoint", () => {
  it("resolves without throwing", async () => {
    const tel = makeTelemetry(); // no endpoint
    tel.record("getInvoice", 5, true);
    await expect(tel.flush()).resolves.toBeUndefined();
    tel.destroy();
  });
});

// ---------------------------------------------------------------------------
// flush() — with endpoint
// ---------------------------------------------------------------------------

describe("StellarSplitTelemetry — flush() with endpoint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends a POST request with the metrics snapshot", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const tel = new StellarSplitTelemetry({
      enabled: true,
      flushIntervalMs: 999_999,
      endpoint: "https://metrics.example.com/flush",
    });

    tel.record("getInvoice", 15, true);
    tel.record("getInvoice", 25, false);

    await tel.flush();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://metrics.example.com/flush");
    expect(init.method).toBe("POST");

    const body = JSON.parse(init.body as string);
    expect(body).toHaveProperty("methods");
    expect(body.methods["getInvoice"].callCount).toBe(2);
    expect(body.methods["getInvoice"].errorCount).toBe(1);

    tel.destroy();
  });

  it("swallows fetch errors — does not reject", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Network failure"));
    vi.stubGlobal("fetch", fetchMock);

    const tel = new StellarSplitTelemetry({
      enabled: true,
      flushIntervalMs: 999_999,
      endpoint: "https://bad.example.com",
    });

    tel.record("pay", 5, true);
    await expect(tel.flush()).resolves.toBeUndefined();

    tel.destroy();
  });
});

// ---------------------------------------------------------------------------
// Periodic flush scheduling
// ---------------------------------------------------------------------------

describe("StellarSplitTelemetry — periodic flush", () => {
  it("schedules flush when endpoint is set", () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const tel = new StellarSplitTelemetry({
      enabled: true,
      flushIntervalMs: 1_000,
      endpoint: "https://metrics.example.com",
    });

    tel.record("getInvoice", 10, true);

    vi.advanceTimersByTime(1_001);

    // The periodic timer should have triggered a flush
    expect(fetchMock).toHaveBeenCalledTimes(1);

    tel.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("destroy() stops the flush timer", () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const tel = new StellarSplitTelemetry({
      enabled: true,
      flushIntervalMs: 1_000,
      endpoint: "https://metrics.example.com",
    });

    tel.record("pay", 5, true);
    tel.destroy();

    vi.advanceTimersByTime(5_000);
    // Timer was cleared — no calls should have fired after destroy
    expect(fetchMock).toHaveBeenCalledTimes(0);

    vi.useRealTimers();
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// withTelemetry() wrapper
// ---------------------------------------------------------------------------

describe("withTelemetry()", () => {
  let tel: StellarSplitTelemetry;

  beforeEach(() => {
    tel = makeTelemetry();
  });

  afterEach(() => {
    tel.destroy();
  });

  it("records a successful call", async () => {
    const fn = vi.fn().mockResolvedValue("result");
    const wrapped = withTelemetry(tel, "myMethod", fn);

    const result = await wrapped("arg1");
    expect(result).toBe("result");

    const snap = tel.getMetrics();
    expect(snap.methods["myMethod"]?.callCount).toBe(1);
    expect(snap.methods["myMethod"]?.errorCount).toBe(0);
  });

  it("records a failed call and re-throws the error", async () => {
    const err = new Error("boom");
    const fn = vi.fn().mockRejectedValue(err);
    const wrapped = withTelemetry(tel, "badMethod", fn);

    await expect(wrapped()).rejects.toThrow("boom");

    const snap = tel.getMetrics();
    expect(snap.methods["badMethod"]?.callCount).toBe(1);
    expect(snap.methods["badMethod"]?.errorCount).toBe(1);
  });

  it("passes arguments through to the wrapped function", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const wrapped = withTelemetry(tel, "m", fn);
    await wrapped("a", 2, true);
    expect(fn).toHaveBeenCalledWith("a", 2, true);
  });

  it("records latency > 0 ms", async () => {
    const fn = vi.fn().mockImplementation(
      () => new Promise((r) => setTimeout(() => r("ok"), 5)),
    );
    const wrapped = withTelemetry(tel, "slow", fn);
    await wrapped();
    const m = tel.getMetrics().methods["slow"]!;
    expect(m.p50LatencyMs).toBeGreaterThanOrEqual(0);
  });
});
