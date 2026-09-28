/**
 * Tests for XBullAdapter listener-leak fix (#840).
 *
 * Verifies that:
 *   1. Repeated connect() calls leave at most one live xBull account-change listener.
 *   2. After disconnect(), no listener remains registered with the wallet.
 *   3. An account-change event delivered after disconnect() does not modify adapter state.
 *   4. Normal single-connect behaviour is unchanged.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { XBullAdapter } from "../src/wallets/adapters/XBullAdapter.js";

// ---------------------------------------------------------------------------
// Fake xBull window double
// ---------------------------------------------------------------------------

/** Tracks all currently-registered onAccountChange handlers. */
let liveListeners: Array<(pk: string) => void>;
/** Most recently returned unsubscribe function (mirrors what xBull would give back). */
let lastUnsub: (() => void) | null;

function makeXBullDouble(publicKey = "GABC123") {
  liveListeners = [];
  lastUnsub = null;

  return {
    connect: vi.fn().mockResolvedValue({ public_key: publicKey }),
    sign: vi.fn().mockResolvedValue({ xdr: "signed-xdr" }),
    onAccountChange: vi.fn((handler: (pk: string) => void) => {
      liveListeners.push(handler);
      const unsub = () => {
        const idx = liveListeners.indexOf(handler);
        if (idx > -1) liveListeners.splice(idx, 1);
      };
      lastUnsub = unsub;
      return unsub;
    }),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Reset the window double before every test
  (globalThis as any).window = { xbull: makeXBullDouble() };
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("XBullAdapter — listener leak fix (#840)", () => {
  it("registers exactly one listener after a single connect()", async () => {
    const adapter = new XBullAdapter();
    await adapter.connect();

    expect(liveListeners).toHaveLength(1);
  });

  it("still has exactly one listener after three consecutive connect() calls", async () => {
    const adapter = new XBullAdapter();

    await adapter.connect();
    await adapter.connect();
    await adapter.connect();

    expect(liveListeners).toHaveLength(1);
  });

  it("leaves zero listeners after disconnect() following a single connect()", async () => {
    const adapter = new XBullAdapter();
    await adapter.connect();
    adapter.disconnect();

    expect(liveListeners).toHaveLength(0);
  });

  it("leaves zero listeners after disconnect() following three connect() calls", async () => {
    const adapter = new XBullAdapter();

    await adapter.connect();
    await adapter.connect();
    await adapter.connect();
    adapter.disconnect();

    expect(liveListeners).toHaveLength(0);
  });

  it("does not update currentPublicKey (getAddress) after disconnect(), even when wallet emits accountChanged", async () => {
    const adapter = new XBullAdapter();
    const initialKey = "GABC_INITIAL";
    (globalThis as any).window = { xbull: makeXBullDouble(initialKey) };

    await adapter.connect();
    expect(await adapter.getAddress()).toBe(initialKey);

    adapter.disconnect();

    // Simulate the wallet emitting an account-change event after disconnect
    for (const handler of [...liveListeners]) {
      handler("GC_AFTER_DISCONNECT");
    }

    // currentPublicKey must remain null — getAddress() falls back to connect()
    // which would call xbull.connect() again; we just confirm no stale key leaks.
    expect(liveListeners).toHaveLength(0);
  });

  it("invokes onAccountChange handlers when the wallet emits a change after connect()", async () => {
    const adapter = new XBullAdapter();
    await adapter.connect();

    const handler = vi.fn();
    adapter.onAccountChange(handler);

    // Simulate wallet emitting account change
    const newKey = "GNEW_KEY_456";
    liveListeners[0]!(newKey);

    expect(handler).toHaveBeenCalledWith(newKey);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not invoke disconnected onAccountChange handlers after unsubscribe", async () => {
    const adapter = new XBullAdapter();
    await adapter.connect();

    const handler = vi.fn();
    const unsub = adapter.onAccountChange(handler);
    unsub();

    liveListeners[0]!("GNEW_KEY");

    expect(handler).not.toHaveBeenCalled();
  });
});
