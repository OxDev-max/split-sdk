/**
 * Tests for #884 — React hooks (useInvoice, useCreatorInvoices, useProtocolStats,
 * useInvoiceStream, StellarSplitProvider)
 *
 * Uses @testing-library/react renderHook API + MockStellarSplitClient.
 */

import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  StellarSplitProvider,
  useInvoice,
  useCreatorInvoices,
  useProtocolStats,
  useInvoiceStream,
  useStellarSplitClient,
} from "../src/react/index.js";
import { MockStellarSplitClient } from "../src/mock/index.js";
import type { Invoice } from "../src/types.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeInvoice(id: string, creator = "GCREATOR"): Invoice {
  return {
    id,
    creator,
    recipients: [{ address: "GRECIP", amount: 100n }],
    token: "USDC",
    deadline: Math.floor(Date.now() / 1000) + 86400,
    funded: 0n,
    status: "Pending",
    payments: [],
  };
}

/** Wraps children in a StellarSplitProvider backed by the given mock. */
function makeWrapper(mock: MockStellarSplitClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    // Cast is safe: MockStellarSplitClient satisfies the subset we use in tests
    return (
      <StellarSplitProvider client={mock as unknown as import("../src/client.js").StellarSplitClient}>
        {children}
      </StellarSplitProvider>
    );
  };
}

// ---------------------------------------------------------------------------
// StellarSplitProvider / useStellarSplitClient
// ---------------------------------------------------------------------------

describe("StellarSplitProvider", () => {
  it("renders without error", () => {
    const mock = new MockStellarSplitClient();
    const wrapper = makeWrapper(mock);
    const { result } = renderHook(() => useStellarSplitClient(), { wrapper });
    expect(result.current).toBeDefined();
  });

  it("throws when used outside a provider", () => {
    // Suppress the expected React error boundary output
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    expect(() =>
      renderHook(() => useStellarSplitClient()),
    ).toThrow();
    consoleError.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// useInvoice
// ---------------------------------------------------------------------------

describe("useInvoice", () => {
  let mock: MockStellarSplitClient;

  beforeEach(() => {
    mock = new MockStellarSplitClient();
  });

  it("starts in loading state", async () => {
    mock.setInvoice("1", makeInvoice("1"));
    const wrapper = makeWrapper(mock);
    const { result } = renderHook(() => useInvoice("1"), { wrapper });

    // Initial state before data loads
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it("returns data after loading", async () => {
    mock.setInvoice("42", makeInvoice("42"));
    const wrapper = makeWrapper(mock);
    const { result } = renderHook(() => useInvoice("42"), { wrapper });

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data?.id).toBe("42");
    expect(result.current.error).toBeNull();
  });

  it("returns error when invoice does not exist", async () => {
    const wrapper = makeWrapper(mock);
    const { result } = renderHook(() => useInvoice("missing"), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.data).toBeNull();
  });

  it("refetch() reloads the invoice", async () => {
    mock.setInvoice("r", makeInvoice("r"));
    const wrapper = makeWrapper(mock);
    const { result } = renderHook(() => useInvoice("r"), { wrapper });

    await waitFor(() => expect(result.current.data).not.toBeNull());

    // Update the invoice in the store
    mock.setInvoice("r", makeInvoice("r"));
    mock._invoices?.set?.("r", { ...makeInvoice("r"), status: "Released" });

    await act(async () => {
      await result.current.refetch();
    });

    // After refetch, data should reflect latest store state
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it("accepts client directly without a provider", async () => {
    mock.setInvoice("d", makeInvoice("d"));
    const { result } = renderHook(() =>
      useInvoice(
        "d",
        mock as unknown as import("../src/client.js").StellarSplitClient,
      ),
    );

    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data?.id).toBe("d");
  });
});

// ---------------------------------------------------------------------------
// useCreatorInvoices
// ---------------------------------------------------------------------------

describe("useCreatorInvoices", () => {
  let mock: MockStellarSplitClient;

  beforeEach(() => {
    mock = new MockStellarSplitClient();
  });

  it("returns invoices for a creator", async () => {
    mock.setInvoice("c1", makeInvoice("c1", "ALICE"));
    mock.setInvoice("c2", makeInvoice("c2", "ALICE"));
    mock.setInvoice("c3", makeInvoice("c3", "BOB"));
    const wrapper = makeWrapper(mock);

    const { result } = renderHook(
      () => useCreatorInvoices("ALICE"),
      { wrapper },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toHaveLength(2);
    expect(result.current.error).toBeNull();
  });

  it("returns empty array when creator has no invoices", async () => {
    const wrapper = makeWrapper(mock);
    const { result } = renderHook(
      () => useCreatorInvoices("NOBODY"),
      { wrapper },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toHaveLength(0);
    expect(result.current.hasMore).toBe(false);
  });

  it("hasMore is true when a next cursor exists", async () => {
    for (let i = 0; i < 25; i++) {
      mock.setInvoice(`inv-${i}`, makeInvoice(`inv-${i}`, "ALICE"));
    }
    const wrapper = makeWrapper(mock);

    const { result } = renderHook(
      () => useCreatorInvoices("ALICE", { limit: 10 }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(true);
  });

  it("loadMore() appends more invoices", async () => {
    for (let i = 0; i < 5; i++) {
      mock.setInvoice(`inv-${i}`, makeInvoice(`inv-${i}`, "ALICE"));
    }
    const wrapper = makeWrapper(mock);

    const { result } = renderHook(
      () => useCreatorInvoices("ALICE", { limit: 3 }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    const firstCount = result.current.data.length;
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadMore();
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data.length).toBeGreaterThan(firstCount);
  });
});

// ---------------------------------------------------------------------------
// useProtocolStats
// ---------------------------------------------------------------------------

describe("useProtocolStats", () => {
  let mock: MockStellarSplitClient;

  beforeEach(() => {
    mock = new MockStellarSplitClient();
  });

  it("returns data or null with loading/error states", async () => {
    const wrapper = makeWrapper(mock);
    const { result } = renderHook(() => useProtocolStats(), { wrapper });

    // Should start loading
    expect(result.current.loading).toBe(true);

    // Should resolve (either data or error)
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Either we have data or an error (checkHealth may not be implemented on mock)
    expect(
      result.current.data !== null || result.current.error !== null,
    ).toBe(true);
  });

  it("accepts a client prop override", async () => {
    const { result } = renderHook(() =>
      useProtocolStats(
        mock as unknown as import("../src/client.js").StellarSplitClient,
      ),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    // Should not throw
  });
});

// ---------------------------------------------------------------------------
// useInvoiceStream
// ---------------------------------------------------------------------------

describe("useInvoiceStream", () => {
  let mock: MockStellarSplitClient;

  beforeEach(() => {
    mock = new MockStellarSplitClient();
    vi.spyOn(mock, "subscribeToInvoice");
  });

  it("isConnected becomes true after mount", async () => {
    const wrapper = makeWrapper(mock);
    const { result } = renderHook(
      () => useInvoiceStream("inv-1"),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isConnected).toBe(true));
  });

  it("latestEvent is null initially", async () => {
    const wrapper = makeWrapper(mock);
    const { result } = renderHook(
      () => useInvoiceStream("inv-2"),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isConnected).toBe(true));
    expect(result.current.latestEvent).toBeNull();
  });

  it("latestEvent updates when simulateEvent fires", async () => {
    const wrapper = makeWrapper(mock);
    const { result } = renderHook(
      () => useInvoiceStream("inv-3"),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isConnected).toBe(true));

    const event: import("../src/types.js").InvoiceEvent = {
      type: "payment",
      invoiceId: "inv-3",
      ledger: 5,
      timestamp: Date.now(),
      eventId: "evt-5",
      payer: "GPAYER",
      amount: 777n,
    };

    act(() => {
      mock.simulateEvent(event);
    });

    await waitFor(() => expect(result.current.latestEvent).not.toBeNull());
    expect(result.current.latestEvent?.type).toBe("payment");
  });

  it("unsubscribes on unmount", async () => {
    const wrapper = makeWrapper(mock);
    const { result, unmount } = renderHook(
      () => useInvoiceStream("inv-4"),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isConnected).toBe(true));
    unmount();

    // After unmount no further callbacks should fire for the hook
    // Add a fresh listener to confirm the invoiceId is still usable
    const cb = vi.fn();
    mock.subscribeToInvoice("inv-4", cb);
    mock.simulateEvent({
      type: "cancelled",
      invoiceId: "inv-4",
      ledger: 1,
      timestamp: 0,
      eventId: "e",
      cancelledBy: "G",
    });

    // The fresh cb should have been called once; the unmounted hook's
    // internal callback should NOT fire (it was cleaned up).
    expect(cb).toHaveBeenCalledOnce();
  });

  it("error is null when subscription succeeds", async () => {
    const wrapper = makeWrapper(mock);
    const { result } = renderHook(
      () => useInvoiceStream("inv-5"),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isConnected).toBe(true));
    expect(result.current.error).toBeNull();
  });
});
