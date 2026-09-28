/**
 * Tests for #882 — MockStellarSplitClient
 * Verifies happy-path parity with the real client interface.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { MockStellarSplitClient } from "../src/mock/index.js";
import type { CallRecord } from "../src/mock/index.js";
import { InvoiceNotFoundError } from "../src/errors.js";
import type { Invoice, InvoiceEvent } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "1",
    creator: "GCREATOR000000000000000000000000000000000000000000000000",
    recipients: [
      {
        address: "GRECIPIENT0000000000000000000000000000000000000000000000",
        amount: 100n,
      },
    ],
    token: "USDC_CONTRACT",
    deadline: Math.floor(Date.now() / 1000) + 86400,
    funded: 0n,
    status: "Pending",
    payments: [],
    ...overrides,
  };
}

function makeCreateParams() {
  return {
    creator: "GCREATOR000000000000000000000000000000000000000000000000",
    recipients: [
      {
        address: "GRECIPIENT0000000000000000000000000000000000000000000000",
        amount: 1000n,
      },
    ],
    token: "USDC",
    deadline: Math.floor(Date.now() / 1000) + 86400,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("MockStellarSplitClient", () => {
  let mock: MockStellarSplitClient;

  beforeEach(() => {
    mock = new MockStellarSplitClient();
  });

  // -------------------------------------------------------------------------
  // reset()
  // -------------------------------------------------------------------------
  describe("reset()", () => {
    it("clears invoices, call history and listeners", async () => {
      await mock.createInvoice(makeCreateParams());
      mock.reset();

      expect(mock.getCallHistory()).toHaveLength(0);
      await expect(mock.getInvoice("1")).rejects.toBeInstanceOf(
        InvoiceNotFoundError,
      );
    });

    it("resets the ID counter so IDs start from 1 again", async () => {
      await mock.createInvoice(makeCreateParams());
      mock.reset();
      const { invoiceId } = await mock.createInvoice(makeCreateParams());
      expect(invoiceId).toBe("1");
    });
  });

  // -------------------------------------------------------------------------
  // setInvoice()
  // -------------------------------------------------------------------------
  describe("setInvoice()", () => {
    it("pre-populates a known invoice for test setup", async () => {
      const invoice = makeInvoice({ id: "test-42" });
      mock.setInvoice("test-42", invoice);
      const fetched = await mock.getInvoice("test-42");
      expect(fetched.id).toBe("test-42");
    });

    it("overwrites an existing invoice", async () => {
      mock.setInvoice("1", makeInvoice({ id: "1", status: "Pending" }));
      mock.setInvoice("1", makeInvoice({ id: "1", status: "Released" }));
      const fetched = await mock.getInvoice("1");
      expect(fetched.status).toBe("Released");
    });

    it("always sets the id field to the provided key", async () => {
      const inv = makeInvoice({ id: "ignored" });
      mock.setInvoice("real-id", inv);
      const fetched = await mock.getInvoice("real-id");
      expect(fetched.id).toBe("real-id");
    });
  });

  // -------------------------------------------------------------------------
  // getCallHistory()
  // -------------------------------------------------------------------------
  describe("getCallHistory()", () => {
    it("returns an empty array initially", () => {
      expect(mock.getCallHistory()).toEqual([]);
    });

    it("records each method call with args and timestamp", async () => {
      await mock.createInvoice(makeCreateParams());
      await mock.getInvoice("1").catch(() => {});

      const history = mock.getCallHistory();
      expect(history).toHaveLength(2);

      const [first, second] = history as [CallRecord, CallRecord];
      expect(first.method).toBe("createInvoice");
      expect(second.method).toBe("getInvoice");
      expect(typeof first.timestamp).toBe("number");
    });

    it("returns a copy — mutations do not affect the internal list", () => {
      const h1 = mock.getCallHistory();
      h1.push({ method: "fake", args: [], timestamp: 0 });
      const h2 = mock.getCallHistory();
      expect(h2).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // simulateEvent()
  // -------------------------------------------------------------------------
  describe("simulateEvent()", () => {
    it("calls active subscription callbacks", () => {
      const cb = vi.fn();
      const sub = mock.subscribeInvoice("inv-1", cb);

      const event: InvoiceEvent = {
        type: "payment",
        invoiceId: "inv-1",
        ledger: 100,
        timestamp: Date.now(),
        eventId: "evt-1",
        payer: "GPAYER",
        amount: 500n,
      };

      mock.simulateEvent(event);
      expect(cb).toHaveBeenCalledOnce();
      expect(cb).toHaveBeenCalledWith(event);

      sub.unsubscribe();
    });

    it("does not call callbacks for a different invoiceId", () => {
      const cb = vi.fn();
      mock.subscribeInvoice("inv-A", cb);

      mock.simulateEvent({
        type: "payment",
        invoiceId: "inv-B",
        ledger: 1,
        timestamp: 0,
        eventId: "e",
        payer: "G",
        amount: 0n,
      });

      expect(cb).not.toHaveBeenCalled();
    });

    it("stops calling a callback after unsubscribe", () => {
      const cb = vi.fn();
      const sub = mock.subscribeInvoice("inv-1", cb);
      sub.unsubscribe();

      mock.simulateEvent({
        type: "created",
        invoiceId: "inv-1",
        ledger: 1,
        timestamp: 0,
        eventId: "e",
        creator: "G",
        recipients: [],
        token: "T",
        deadline: 0,
      });

      expect(cb).not.toHaveBeenCalled();
    });

    it("is a no-op for unknown invoiceIds", () => {
      expect(() =>
        mock.simulateEvent({
          type: "released",
          invoiceId: "nope",
          ledger: 1,
          timestamp: 0,
          eventId: "e",
          releasedBy: "G",
          amount: 0n,
        }),
      ).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // createInvoice()
  // -------------------------------------------------------------------------
  describe("createInvoice()", () => {
    it("returns invoiceId and txHash", async () => {
      const { invoiceId, txHash } = await mock.createInvoice(
        makeCreateParams(),
      );
      expect(invoiceId).toBe("1");
      expect(typeof txHash).toBe("string");
      expect(txHash.length).toBeGreaterThan(0);
    });

    it("stores the invoice so getInvoice works immediately", async () => {
      const params = makeCreateParams();
      const { invoiceId } = await mock.createInvoice(params);
      const invoice = await mock.getInvoice(invoiceId);
      expect(invoice.creator).toBe(params.creator);
      expect(invoice.status).toBe("Pending");
      expect(invoice.funded).toBe(0n);
    });

    it("increments IDs for successive calls", async () => {
      const a = await mock.createInvoice(makeCreateParams());
      const b = await mock.createInvoice(makeCreateParams());
      expect(a.invoiceId).toBe("1");
      expect(b.invoiceId).toBe("2");
    });
  });

  // -------------------------------------------------------------------------
  // pay()
  // -------------------------------------------------------------------------
  describe("pay()", () => {
    it("returns a txHash", async () => {
      const { invoiceId } = await mock.createInvoice(makeCreateParams());
      const result = await mock.pay({
        payer: "GPAYER",
        invoiceId,
        amount: 500n,
      });
      expect(typeof result.txHash).toBe("string");
    });

    it("increases funded and records the payment", async () => {
      const { invoiceId } = await mock.createInvoice(makeCreateParams());
      await mock.pay({ payer: "GPAYER", invoiceId, amount: 600n });
      const inv = await mock.getInvoice(invoiceId);
      expect(inv.funded).toBe(600n);
      expect(inv.payments).toHaveLength(1);
      expect(inv.payments[0]?.amount).toBe(600n);
    });

    it("throws InvoiceNotFoundError for unknown invoiceId", async () => {
      await expect(
        mock.pay({ payer: "G", invoiceId: "nope", amount: 1n }),
      ).rejects.toBeInstanceOf(InvoiceNotFoundError);
    });
  });

  // -------------------------------------------------------------------------
  // getInvoice()
  // -------------------------------------------------------------------------
  describe("getInvoice()", () => {
    it("returns the invoice when it exists", async () => {
      mock.setInvoice("x", makeInvoice({ id: "x" }));
      const inv = await mock.getInvoice("x");
      expect(inv.id).toBe("x");
    });

    it("throws InvoiceNotFoundError when missing", async () => {
      await expect(mock.getInvoice("nope")).rejects.toBeInstanceOf(
        InvoiceNotFoundError,
      );
    });
  });

  // -------------------------------------------------------------------------
  // getPayments()
  // -------------------------------------------------------------------------
  describe("getPayments()", () => {
    it("returns empty array initially", async () => {
      mock.setInvoice("p", makeInvoice({ id: "p" }));
      const payments = await mock.getPayments("p");
      expect(payments).toEqual([]);
    });

    it("returns payments after pay()", async () => {
      const { invoiceId } = await mock.createInvoice(makeCreateParams());
      await mock.pay({ payer: "G", invoiceId, amount: 100n });
      const payments = await mock.getPayments(invoiceId);
      expect(payments).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // getInvoicesByCreator()
  // -------------------------------------------------------------------------
  describe("getInvoicesByCreator()", () => {
    it("returns only invoices belonging to the given creator", async () => {
      await mock.createInvoice(makeCreateParams());
      await mock.createInvoice({
        ...makeCreateParams(),
        creator: "GCREATOR2",
      });
      const result = await mock.getInvoicesByCreator(
        "GCREATOR000000000000000000000000000000000000000000000000",
      );
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it("respects limit option", async () => {
      for (let i = 0; i < 5; i++) await mock.createInvoice(makeCreateParams());
      const result = await mock.getInvoicesByCreator(
        "GCREATOR000000000000000000000000000000000000000000000000",
        { limit: 3 },
      );
      expect(result.items).toHaveLength(3);
      expect(result.nextCursor).not.toBeNull();
    });

    it("returns nextCursor: null when all fit on one page", async () => {
      await mock.createInvoice(makeCreateParams());
      const result = await mock.getInvoicesByCreator(
        "GCREATOR000000000000000000000000000000000000000000000000",
        { limit: 20 },
      );
      expect(result.nextCursor).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // subscribeInvoice()
  // -------------------------------------------------------------------------
  describe("subscribeInvoice()", () => {
    it("returns a Subscription with the correct invoiceId", () => {
      const sub = mock.subscribeInvoice("inv-1", () => {});
      expect(sub.getInvoiceId()).toBe("inv-1");
    });

    it("isActive() is true after creation", () => {
      const sub = mock.subscribeInvoice("inv-1", () => {});
      expect(sub.isActive()).toBe(true);
      sub.unsubscribe();
    });

    it("isActive() is false after unsubscribe", () => {
      const sub = mock.subscribeInvoice("inv-1", () => {});
      sub.unsubscribe();
      expect(sub.isActive()).toBe(false);
    });

    it("isPaused() toggles with pause/resume", () => {
      const sub = mock.subscribeInvoice("inv-1", () => {});
      expect(sub.isPaused()).toBe(false);
      sub.pause();
      expect(sub.isPaused()).toBe(true);
      sub.resume();
      expect(sub.isPaused()).toBe(false);
      sub.unsubscribe();
    });

    it("supports multiple callbacks on the same invoiceId", () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      const sub1 = mock.subscribeInvoice("inv-1", cb1);
      const sub2 = mock.subscribeInvoice("inv-1", cb2);

      mock.simulateEvent({
        type: "cancelled",
        invoiceId: "inv-1",
        ledger: 1,
        timestamp: 0,
        eventId: "e",
        cancelledBy: "G",
      });

      expect(cb1).toHaveBeenCalledOnce();
      expect(cb2).toHaveBeenCalledOnce();

      sub1.unsubscribe();
      sub2.unsubscribe();
    });
  });

  // -------------------------------------------------------------------------
  // State-mutating helpers (release / refund / cancel)
  // -------------------------------------------------------------------------
  describe("releaseInvoice / refundInvoice / cancelInvoice", () => {
    it("releaseInvoice sets status to Released", async () => {
      mock.setInvoice("r", makeInvoice({ id: "r" }));
      await mock.releaseInvoice("r", "GCREATOR");
      const inv = await mock.getInvoice("r");
      expect(inv.status).toBe("Released");
    });

    it("refundInvoice sets status to Refunded", async () => {
      mock.setInvoice("rf", makeInvoice({ id: "rf" }));
      await mock.refundInvoice("rf", "GCREATOR");
      const inv = await mock.getInvoice("rf");
      expect(inv.status).toBe("Refunded");
    });

    it("cancelInvoice sets status to Cancelled", async () => {
      mock.setInvoice("c", makeInvoice({ id: "c" }));
      await mock.cancelInvoice("c", "GCREATOR");
      const inv = await mock.getInvoice("c");
      expect(inv.status).toBe("Cancelled");
    });

    it("throws InvoiceNotFoundError for unknown id", async () => {
      await expect(
        mock.releaseInvoice("nope", "G"),
      ).rejects.toBeInstanceOf(InvoiceNotFoundError);
    });
  });
});
