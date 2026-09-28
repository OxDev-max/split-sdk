/**
 * Partial-failure handling tests for InvoiceBatchProcessor (#691).
 *
 * These tests verify that:
 *  1. A batch where one invoice throws continues processing remaining invoices.
 *  2. The result object includes `succeeded` and `failed` arrays with correct contents.
 *  3. A batch where all invoices fail returns an empty `succeeded` array.
 *
 * Transaction builder helper tests for complex multi-op invoices (#904).
 *
 * These tests verify that:
 *  4. A multi-op invoice composes all operations into a single transaction.
 *  5. Lifecycle events are emitted for build/add/complete.
 *  6. Building an invoice with no operations is rejected.
 */

import { describe, it, expect, vi } from "vitest";
import { InvoiceBatchProcessor } from "../invoiceBatchProcessor.js";
import type { InvoicePaymentSubmitter } from "../invoiceBatchProcessor.js";
import {
  TransactionBuilder,
  type TransactionOperation,
  type TransactionBuilderEvent,
} from "../transactionBuilder.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain an async iterator into an array. */
async function drain<T>(iter: AsyncIterableIterator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of iter) results.push(item);
  return results;
}

/** Build a simple payment operation for the given invoice. */
function paymentOp(invoiceId: string, amount: bigint): TransactionOperation {
  return {
    type: "payment",
    invoiceId,
    amount,
    asset: "native",
  };
}

// ---------------------------------------------------------------------------
// Tests – partial-failure handling
// ---------------------------------------------------------------------------

describe("InvoiceBatchProcessor – partial-failure handling", () => {
  // ── Criterion 1: one invoice throws, rest continue ───────────────────────

  it("continues processing remaining invoices when one invoice throws", async () => {
    const submitPayment = vi
      .fn()
      .mockImplementation(async ({ invoiceId }: { invoiceId: string }) => {
        if (invoiceId === "inv2") {
          throw new Error("contract call failed");
        }
        return { txHash: `tx-${invoiceId}` };
      });

    const processor = new InvoiceBatchProcessor(
      { submitPayment } as InvoicePaymentSubmitter,
    );

    // Process three invoices: inv1 and inv3 succeed, inv2 fails
    const results = await drain(
      processor.process(["inv1", "inv2", "inv3"], {
        payer: "GPAYER",
        amounts: { inv1: 1n, inv2: 1n, inv3: 1n },
        maxConcurrent: 1, // serial so order is predictable
      }),
    );

    // All three invoices must have been attempted
    expect(results).toHaveLength(3);
    expect(new Set(results.map((r) => r.invoiceId))).toEqual(
      new Set(["inv1", "inv2", "inv3"]),
    );

    // inv1 and inv3 must succeed
    expect(results.find((r) => r.invoiceId === "inv1")!.status).toBe("success");
    expect(results.find((r) => r.invoiceId === "inv3")!.status).toBe("success");

    // inv2 must fail with the error message preserved
    const failed = results.find((r) => r.invoiceId === "inv2")!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("contract call failed");
  });

  // ── Criterion 2: succeeded and failed arrays have correct contents ────────

  it("processAll() returns succeeded and failed arrays with correct contents", async () => {
    const submitPayment = vi
      .fn()
      .mockImplementation(async ({ invoiceId }: { invoiceId: string }) => {
        if (invoiceId === "bad1" || invoiceId === "bad2") {
          throw new Error(`payment rejected: ${invoiceId}`);
        }
        return { txHash: `tx-${invoiceId}` };
      });

    const processor = new InvoiceBatchProcessor(
      { submitPayment } as InvoicePaymentSubmitter,
    );

    const { succeeded, failed } = await processor.processAll(
      ["good1", "bad1", "good2", "bad2", "good3"],
      {
        payer: "GPAYER",
        amounts: {
          good1: 10n,
          bad1: 10n,
          good2: 10n,
          bad2: 10n,
          good3: 10n,
        },
        maxConcurrent: 1,
      },
    );

    // Three invoices succeed
    expect(succeeded).toHaveLength(3);
    expect(new Set(succeeded.map((r) => r.invoiceId))).toEqual(
      new Set(["good1", "good2", "good3"]),
    );
    expect(succeeded.every((r) => r.status === "success")).toBe(true);
    expect(succeeded.every((r) => typeof r.txHash === "string")).toBe(true);

    // Two invoices fail
    expect(failed).toHaveLength(2);
    expect(new Set(failed.map((r) => r.invoiceId))).toEqual(
      new Set(["bad1", "bad2"]),
    );
    expect(failed.every((r) => r.status === "failed")).toBe(true);
    expect(failed.every((r) => typeof r.error === "string")).toBe(true);
  });

  // ── Criterion 3: all invoices fail → empty succeeded array ───────────────

  it("returns an empty succeeded array when all invoices in the batch fail", async () => {
    const submitPayment = vi
      .fn()
      .mockRejectedValue(new Error("network error"));

    const processor = new InvoiceBatchProcessor(
      { submitPayment } as InvoicePaymentSubmitter,
    );

    const { succeeded, failed } = await processor.processAll(
      ["inv1", "inv2", "inv3"],
      {
        payer: "GPAYER",
        amounts: { inv1: 1n, inv2: 1n, inv3: 1n },
        maxConcurrent: 1,
      },
    );

    expect(succeeded).toHaveLength(0);
    expect(failed).toHaveLength(3);
    expect(failed.every((r) => r.status === "failed")).toBe(true);
    expect(failed.every((r) => r.error === "network error")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests – transaction builder helper (#904)
// ---------------------------------------------------------------------------

describe("TransactionBuilder – complex multi-op invoices", () => {
  // ── Criterion 4: multi-op composition ────────────────────────────────────

  it("composes multiple operations into a single transaction", () => {
    const builder = new TransactionBuilder({ payer: "GPAYER" });

    builder
      .addOperation(paymentOp("inv1", 10n))
      .addOperation(paymentOp("inv2", 20n))
      .addOperation({
        type: "memo",
        invoiceId: "inv1",
        text: "batch settlement",
      });

    const tx = builder.build();

    expect(tx.payer).toBe("GPAYER");
    expect(tx.operations).toHaveLength(3);
    expect(tx.operations.map((op) => op.type)).toEqual([
      "payment",
      "payment",
      "memo",
    ]);
    expect(tx.operations[0]).toMatchObject({ invoiceId: "inv1", amount: 10n });
    expect(tx.operations[1]).toMatchObject({ invoiceId: "inv2", amount: 20n });
  });

  it("supports adding a batch of operations at once", () => {
    const builder = new TransactionBuilder({ payer: "GPAYER" });

    builder.addOperations([
      paymentOp("inv1", 1n),
      paymentOp("inv2", 2n),
      paymentOp("inv3", 3n),
    ]);

    const tx = builder.build();
    expect(tx.operations).toHaveLength(3);
    expect(tx.operations.map((op) => op.invoiceId)).toEqual([
      "inv1",
      "inv2",
      "inv3",
    ]);
  });

  // ── Criterion 5: lifecycle event emission ────────────────────────────────

  it("emits build/add/complete lifecycle events", () => {
    const builder = new TransactionBuilder({ payer: "GPAYER" });
    const events: TransactionBuilderEvent[] = [];
    builder.on((event) => events.push(event));

    builder.addOperation(paymentOp("inv1", 5n));
    builder.addOperation(paymentOp("inv2", 5n));
    const tx = builder.build();
    builder.complete(tx);

    expect(events.map((e) => e.type)).toEqual([
      "add",
      "add",
      "build",
      "complete",
    ]);
    expect(events[0]).toMatchObject({ type: "add", operationCount: 1 });
    expect(events[1]).toMatchObject({ type: "add", operationCount: 2 });
    expect(events[2]).toMatchObject({ type: "build", operationCount: 2 });
    expect(events[3]).toMatchObject({ type: "complete", operationCount: 2 });
  });

  it("allows unsubscribing from lifecycle events", () => {
    const builder = new TransactionBuilder({ payer: "GPAYER" });
    const listener = vi.fn();
    const off = builder.on(listener);

    builder.addOperation(paymentOp("inv1", 1n));
    off();
    builder.addOperation(paymentOp("inv2", 1n));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  // ── Criterion 6: empty transaction rejected ──────────────────────────────

  it("throws when building a transaction with no operations", () => {
    const builder = new TransactionBuilder({ payer: "GPAYER" });
    expect(() => builder.build()).toThrow(/no operations/i);
  });
});
