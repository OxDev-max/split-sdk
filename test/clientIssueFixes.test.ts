/**
 * Tests for GitHub issues #850 (cloneInvoice overrides + getLineage),
 * #844 (generic simulate + `{ simulate: true }`), and #842 (subscribeInvoice).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { StellarSplitClient } from "../src/client.js";
import { MockRpcClient } from "../src/testing/mockRpcClient.js";
import { InvoiceCloneabilityValidator } from "../src/preflight/InvoiceCloneabilityValidator.js";
import { _resetActiveSubscriptionsForTesting } from "../src/subscription.js";
import { _resetCursorTrackerForTesting } from "../src/cursorTracker.js";
import type { Invoice } from "../src/types.js";

const CREATOR = Keypair.random().publicKey();
const RECIPIENT = Keypair.random().publicKey();
const TOKEN = StrKey.encodeContract(Keypair.random().rawPublicKey());
const FUTURE_DEADLINE = Math.floor(Date.now() / 1000) + 86_400;

function makeClient(): StellarSplitClient {
  return new StellarSplitClient({
    rpcUrl: "https://example.com",
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
  });
}

function pendingInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "123",
    creator: CREATOR,
    recipients: [{ address: RECIPIENT, amount: 1000n }],
    token: TOKEN,
    deadline: 1_700_000_000,
    funded: 0n,
    status: "Pending",
    payments: [],
    ...overrides,
  } as Invoice;
}

function injectServer(client: StellarSplitClient, server: unknown): void {
  (client as unknown as { _injectedRpcClient: unknown })._injectedRpcClient =
    server;
}

afterEach(() => {
  vi.restoreAllMocks();
  _resetActiveSubscriptionsForTesting();
  _resetCursorTrackerForTesting();
});

describe("Issue #850 — getLineage", () => {
  it("returns the full ancestor chain ordered root to leaf as bigints", async () => {
    const client = makeClient();
    vi.spyOn(client, "getInvoice")
      .mockResolvedValueOnce(pendingInvoice({ id: "3" }))
      .mockResolvedValueOnce(pendingInvoice({ id: "2" }))
      .mockResolvedValueOnce(pendingInvoice({ id: "1" }));

    vi.spyOn(
      client as unknown as { _getInvoiceExt: (id: string) => Promise<unknown> },
      "_getInvoiceExt",
    )
      .mockResolvedValueOnce({ parentInvoiceId: "2", cloneDepth: 2 })
      .mockResolvedValueOnce({ parentInvoiceId: "1", cloneDepth: 1 })
      .mockResolvedValueOnce({ parentInvoiceId: null, cloneDepth: 0 });

    await expect(client.getLineage(3n)).resolves.toEqual([1n, 2n, 3n]);
  });
});

describe("Issue #850 — cloneInvoice overrides", () => {
  async function setupClone(): Promise<{
    client: StellarSplitClient;
    submitSpy: ReturnType<typeof vi.spyOn>;
  }> {
    const client = makeClient();
    vi.spyOn(client, "getInvoice").mockResolvedValue(pendingInvoice());

    const { nativeToScVal } = await import("@stellar/stellar-sdk");
    const submitSpy = vi
      .spyOn(
        client as unknown as { _submitTx: (...args: unknown[]) => unknown },
        "_submitTx",
      )
      .mockResolvedValue({
        txHash: "tx-clone",
        returnValue: nativeToScVal(456n, { type: "u64" }),
      });

    (client as unknown as { _cache: unknown })._cache = {
      get: vi.fn(),
      set: vi.fn(),
      invalidate: vi.fn(),
      clear: vi.fn(),
    };
    return { client, submitSpy };
  }

  it("clones with no overrides and returns the new invoice ID", async () => {
    const { client, submitSpy } = await setupClone();
    await expect(client.cloneInvoice(123n, { skipValidation: true })).resolves.toBe(
      "456",
    );
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it("accepts partial field overrides and submits", async () => {
    const { client } = await setupClone();
    await expect(
      client.cloneInvoice(123n, {
        skipValidation: true,
        title: "Rebalanced split",
        deadline: FUTURE_DEADLINE,
        targetAmount: 2_000n,
      }),
    ).resolves.toBe("456");
  });

  it("rejects an invalid title override before submission", async () => {
    const { client, submitSpy } = await setupClone();
    await expect(
      client.cloneInvoice(123n, { skipValidation: true, title: "   " }),
    ).rejects.toThrow("non-empty string");
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("rejects a past deadline override before submission", async () => {
    const { client, submitSpy } = await setupClone();
    await expect(
      client.cloneInvoice(123n, { skipValidation: true, deadline: 1 }),
    ).rejects.toThrow("future unix timestamp");
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("rejects a non-positive target amount override", async () => {
    const { client, submitSpy } = await setupClone();
    await expect(
      client.cloneInvoice(123n, { skipValidation: true, targetAmount: 0n }),
    ).rejects.toThrow("positive bigint");
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("rejects malformed recipient addresses", async () => {
    const { client, submitSpy } = await setupClone();
    await expect(
      client.cloneInvoice(123n, {
        skipValidation: true,
        recipients: ["not-a-stellar-address"],
      }),
    ).rejects.toThrow("valid Stellar addresses");
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("throws when the source invoice is not cloneable (terminal)", async () => {
    const client = makeClient();
    vi.spyOn(client, "getInvoice").mockResolvedValue(
      pendingInvoice({ status: "Released" }),
    );
    vi.spyOn(InvoiceCloneabilityValidator.prototype, "validate").mockResolvedValue({
      invoiceId: "123",
      cloneable: false,
      fieldReports: [
        { field: "status", valid: false, reason: "Invoice is already Released" },
      ],
    } as never);

    await expect(client.cloneInvoice(123n)).rejects.toThrow(/not cloneable/i);
  });
});

const SIM_SUCCESS = {
  result: { retval: undefined },
  events: [],
  id: "mock",
  latestLedger: 100,
  minResourceFee: "1000",
  cost: { cpuInsns: "5000", memBytes: "2048" },
} as never;

describe("Issue #844 — generic simulate", () => {
  it("returns a SimulationResult with fee and resource usage on success", async () => {
    const client = makeClient();
    const rpc = new MockRpcClient({ defaultSimulateResponse: SIM_SUCCESS });
    injectServer(client, rpc);

    const result = await client.simulate("create_invoice", {
      creator: CREATOR,
      recipients: [{ address: RECIPIENT, amount: 1000n }],
      token: TOKEN,
      deadline: FUTURE_DEADLINE,
    });

    expect(result.success).toBe(true);
    expect(result.fee).toBe(1000n);
    expect(result.cpuInsns).toBe(5000n);
    expect(result.memBytes).toBe(2048n);
    expect(result.footprint).toBeDefined();
    expect(rpc.calls.simulate).toHaveLength(1);
  });

  it("maps camelCase method names onto contract entry points", async () => {
    const client = makeClient();
    const rpc = new MockRpcClient({ defaultSimulateResponse: SIM_SUCCESS });
    injectServer(client, rpc);

    const result = await client.simulate("refund", {
      invoiceId: 7n,
      source: CREATOR,
    });
    expect(result.success).toBe(true);
    expect(rpc.calls.simulate).toHaveLength(1);
  });

  it("returns success:false with the error when the contract rejects the call", async () => {
    const client = makeClient();
    const rpc = new MockRpcClient({
      defaultSimulateResponse: { error: "HostError: deadline passed" } as never,
    });
    injectServer(client, rpc);

    const result = await client.simulate("pay", {
      payer: CREATOR,
      invoiceId: "1",
      amount: 10n,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("deadline passed");
    expect(result.fee).toBe(0n);
  });
});

describe("Issue #844 — { simulate: true } on mutating methods", () => {
  it("createInvoice with simulate:true returns a SimulationResult and never submits", async () => {
    const client = makeClient();
    const rpc = new MockRpcClient({ defaultSimulateResponse: SIM_SUCCESS });
    injectServer(client, rpc);

    const result = (await client.createInvoice({
      creator: CREATOR,
      recipients: [{ address: RECIPIENT, amount: 1000n }],
      token: TOKEN,
      deadline: FUTURE_DEADLINE,
      simulate: true,
    })) as { success?: boolean };

    expect(result.success).toBe(true);
    expect(rpc.calls.send).toHaveLength(0);
  });

  it("pay with simulate:true returns a SimulationResult and never submits", async () => {
    const client = makeClient();
    const rpc = new MockRpcClient({ defaultSimulateResponse: SIM_SUCCESS });
    injectServer(client, rpc);

    const result = (await client.pay({
      payer: CREATOR,
      invoiceId: "1",
      amount: 500n,
      simulate: true,
    })) as { success?: boolean };

    expect(result.success).toBe(true);
    expect(rpc.calls.send).toHaveLength(0);
  });
});

const STREAM_EVENTS = [
  {
    topic: ["payment", "inv-123"],
    value: { payer: "GABC", amount: "1000" },
    ledger: 100,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    topic: ["released", "inv-123"],
    value: { releasedBy: "GXYZ" },
    ledger: 101,
    createdAt: "2026-01-01T00:00:01.000Z",
  },
];

describe("Issue #842 — subscribeInvoice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("streams events for an invoice and stops polling on unsubscribe", async () => {
    const client = makeClient();
    const rpc = new MockRpcClient({
      defaultGetEventsResponse: {
        events: STREAM_EVENTS,
        latestLedger: 105,
      } as never,
      defaultGetLatestLedgerResponse: {
        id: "mock",
        sequence: 100,
        protocolVersion: 21,
      } as never,
    });
    injectServer(client, rpc);

    const received: string[] = [];
    const subscription = client.subscribeInvoice(
      "inv-123",
      (event) => received.push(event.type),
      { pollIntervalMs: 100 },
    );

    expect(subscription.getInvoiceId()).toBe("inv-123");
    expect(subscription.isActive()).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    expect(received).toEqual(["payment", "released"]);

    subscription.unsubscribe();
    const pollCount = rpc.calls.getEvents.length;
    await vi.advanceTimersByTimeAsync(500);

    expect(subscription.isActive()).toBe(false);
    expect(rpc.calls.getEvents.length).toBe(pollCount);
  });

  it("accepts a bigint invoice ID", () => {
    const client = makeClient();
    injectServer(
      client,
      new MockRpcClient({
        defaultGetEventsResponse: { events: [], latestLedger: 1 } as never,
        defaultGetLatestLedgerResponse: {
          id: "mock",
          sequence: 1,
          protocolVersion: 21,
        } as never,
      }),
    );

    const subscription = client.subscribeInvoice(42n, vi.fn());
    expect(subscription.getInvoiceId()).toBe("42");
    subscription.unsubscribe();
  });
});

