import { describe, it, expect, vi, afterEach } from "vitest";
import { Keypair, StrKey, rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { OptimisticCache } from "../src/cache/OptimisticCache.js";
import type { RevalidateErrorEvent } from "../src/cache/OptimisticCache.js";
import { StellarSplitClient } from "../src/client.js";
import { MockRpcClient } from "../src/testing/mockRpcClient.js";
import { createMockInvoice } from "../src/testing/factories.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OptimisticCache", () => {
  it("returns the predicted value for reads after applyOptimistic(), until commit/rollback", () => {
    const cache = new OptimisticCache<{ funded: bigint }>();
    expect(cache.get("inv-1")).toBeUndefined();

    const { commit } = cache.applyOptimistic("inv-1", { funded: 100n }, { funded: 0n });
    expect(cache.get("inv-1")).toEqual({ funded: 100n });

    commit();
    expect(cache.get("inv-1")).toEqual({ funded: 100n });
    expect(cache.pendingCount).toBe(0);
  });

  it("rollback() restores the previous value, emits onRollback, and leaves no stale optimistic entries", () => {
    const cache = new OptimisticCache<{ funded: bigint }>();
    const rollbackEvents: unknown[] = [];
    cache.onRollback((e) => rollbackEvents.push(e));

    const { rollback } = cache.applyOptimistic("inv-1", { funded: 100n }, { funded: 0n });
    expect(cache.pendingCount).toBe(1);

    rollback();

    expect(cache.get("inv-1")).toEqual({ funded: 0n });
    expect(cache.pendingCount).toBe(0);
    expect(rollbackEvents).toEqual([
      expect.objectContaining({ invoiceId: "inv-1", restoredValue: { funded: 0n } }),
    ]);
  });

  it("commit() and rollback() are idempotent no-ops after the first call", () => {
    const cache = new OptimisticCache<{ funded: bigint }>();
    const rollbackEvents: unknown[] = [];
    cache.onRollback((e) => rollbackEvents.push(e));

    const { commit, rollback } = cache.applyOptimistic("inv-1", { funded: 100n }, { funded: 0n });
    commit();
    rollback(); // should be a no-op — already committed
    expect(cache.get("inv-1")).toEqual({ funded: 100n });
    expect(rollbackEvents).toEqual([]);
  });

  it("queues concurrent optimistic mutations to the same invoice; rolling back mutation N does not discard N+1..M", () => {
    const cache = new OptimisticCache<{ funded: bigint }>();

    const first = cache.applyOptimistic("inv-1", { funded: 100n }, { funded: 0n });
    const second = cache.applyOptimistic("inv-1", { funded: 150n }, { funded: 100n });
    const third = cache.applyOptimistic("inv-1", { funded: 200n }, { funded: 150n });

    expect(cache.pendingCount).toBe(3);
    expect(cache.get("inv-1")).toEqual({ funded: 200n }); // most recent prediction wins

    // Roll back the middle mutation — the newest (third) prediction must still be visible.
    second.rollback();
    expect(cache.pendingCount).toBe(2);
    expect(cache.get("inv-1")).toEqual({ funded: 200n });

    third.rollback();
    expect(cache.get("inv-1")).toEqual({ funded: 100n }); // falls back to the oldest still-pending prediction

    first.commit();
    expect(cache.pendingCount).toBe(0);
    expect(cache.get("inv-1")).toEqual({ funded: 100n });
  });
});

describe("OptimisticCache integration with SplitClient.pay()", () => {
  function makeClient() {
    const mockServer = new MockRpcClient({
      defaultSimulateResponse: { error: "reverted" } as never,
    });
    return new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
      rpcClient: mockServer as never,
      cache: { enabled: true, ttlMs: 60_000 },
      optimisticCache: true,
    });
  }

  it("reverts the UI-facing cache value within one event loop tick after a failed simulation", async () => {
    const client = makeClient();
    const invoiceId = "123";
    const baseInvoice = createMockInvoice({ id: invoiceId, funded: 10_000_000n });

    // Seed the read cache as if getInvoice() had already been called.
    (client as unknown as { _cache: { set: (k: string, v: unknown) => void } })._cache.set(
      `getInvoice:${JSON.stringify([invoiceId])}`,
      baseInvoice,
    );

    // Force simulateTransaction to look like a failed simulation.
    const origIsSimulationError = SorobanRpc.Api.isSimulationError;
    (SorobanRpc.Api as { isSimulationError: (r: unknown) => boolean }).isSimulationError = () => true;

    try {
      const payPromise = client.pay({ payer: baseInvoice.creator, invoiceId, amount: 5_000_000n });

      // Immediately after issuing the call (before it settles), the optimistic
      // prediction should already be visible.
      const duringPending = await client.getInvoice(invoiceId);
      expect(duringPending.funded).toBe(15_000_000n);

      await expect(payPromise).rejects.toThrow();

      const afterFailure = await client.getInvoice(invoiceId);
      expect(afterFailure.funded).toBe(10_000_000n);
      expect(client.optimisticCache?.pendingCount).toBe(0);
    } finally {
      SorobanRpc.Api.isSimulationError = origIsSimulationError;
    }
  });
});


describe("OptimisticCache stale-while-revalidate (Issue #776)", () => {
  /** Build a cache with an injectable clock so TTL boundaries are deterministic. */
  function makeCache(options: { staleWhileRevalidateMs?: number } = {}) {
    let now = 0;
    const cache = new OptimisticCache<number>(undefined, {
      staleWhileRevalidateMs: options.staleWhileRevalidateMs ?? 50,
      now: () => now,
    });
    return { cache, advanceTo: (value: number) => { now = value; } };
  }

  it("serves a fresh value without invoking the fetcher again", async () => {
    const { cache } = makeCache();
    const fetcher = vi.fn(async (_key: string) => 1);

    await expect(cache.read("k", fetcher, 100)).resolves.toBe(1);
    await expect(cache.read("k", fetcher, 100)).resolves.toBe(1);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns the stale value immediately and revalidates in the background", async () => {
    const { cache, advanceTo } = makeCache();
    const fetcher = vi.fn(async (_key: string) => 1);

    await expect(cache.read("k", fetcher, 100)).resolves.toBe(1); // fresh until t=100
    fetcher.mockResolvedValueOnce(2);

    advanceTo(120); // stale, but inside the 50 ms revalidation window
    await expect(cache.read("k", fetcher, 100)).resolves.toBe(1);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

    // The refreshed value is fresh from t=120 until t=220.
    await expect(cache.read("k", fetcher, 100)).resolves.toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("emits revalidateError instead of propagating background failures to the caller", async () => {
    const { cache, advanceTo } = makeCache();
    const events: RevalidateErrorEvent[] = [];
    cache.onRevalidateError((event) => events.push(event));

    const fetcher = vi.fn(async (_key: string) => 1);
    await cache.read("k", fetcher, 100);
    fetcher.mockRejectedValueOnce(new Error("rpc down"));

    advanceTo(120);
    await expect(cache.read("k", fetcher, 100)).resolves.toBe(1);
    await vi.waitFor(() => expect(events).toHaveLength(1));

    expect(events[0]).toMatchObject({ key: "k", error: expect.any(Error) });
    // The stale value keeps being served after a failed revalidation.
    await expect(cache.read("k", fetcher, 100)).resolves.toBe(1);
  });

  it("runs at most one background revalidation per key at a time", async () => {
    const { cache, advanceTo } = makeCache();
    const fetcher = vi.fn(async (_key: string) => 1);
    await cache.read("k", fetcher, 100);

    let release: (value: number) => void = () => undefined;
    fetcher.mockImplementationOnce(
      () => new Promise<number>((resolve) => { release = resolve; }),
    );

    advanceTo(120);
    await cache.read("k", fetcher, 100);
    await cache.read("k", fetcher, 100);
    await cache.read("k", fetcher, 100);

    // Initial load + exactly one in-flight background revalidation.
    expect(fetcher).toHaveBeenCalledTimes(2);

    release(42);
    await vi.waitFor(async () => {
      await expect(cache.read("k", fetcher, 100)).resolves.toBe(42);
    });
  });

  it("blocks on a fetch once the value is past the revalidation window", async () => {
    const { cache, advanceTo } = makeCache();
    const fetcher = vi.fn(async (_key: string) => 1);

    await cache.read("k", fetcher, 100);
    fetcher.mockResolvedValueOnce(7);

    advanceTo(150); // staleUntil reached — no stale value may be served
    await expect(cache.read("k", fetcher, 100)).resolves.toBe(7);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("disables stale-while-revalidate by default", async () => {
    const { cache, advanceTo } = makeCache({ staleWhileRevalidateMs: 0 });
    const fetcher = vi.fn(async (_key: string) => 1);

    await cache.read("k", fetcher, 100);
    fetcher.mockResolvedValueOnce(5);

    advanceTo(101);
    await expect(cache.read("k", fetcher, 100)).resolves.toBe(5);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("serves values written via set() without fetching while they are fresh", async () => {
    const { cache } = makeCache();
    cache.set("k", 9, 100);
    const fetcher = vi.fn(async (_key: string) => 1);

    await expect(cache.read("k", fetcher, 100)).resolves.toBe(9);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
