import { describe, it, expect, afterEach, vi } from "vitest";
import {
  aggregatePayments,
  createInvoiceRemainingFetcher,
  registerInvoiceRemainingFetcher,
  remainingForInvoice,
} from "../src/paymentAllocation.js";
import { ValidationError } from "../src/errors.js";
import type { Invoice } from "../src/types.js";

function makeInvoice(id: string, amounts: bigint[], funded = 0n): Invoice {
  return {
    id,
    creator: "GCREATOR",
    recipients: amounts.map((amount, index) => ({
      address: `GRECIPIENT${index}`,
      amount,
    })),
    token: "USDC",
    deadline: 1_000_000,
    funded,
    status: "Pending",
    payments: [],
  } as unknown as Invoice;
}

const amountsOf = (allocations: Array<{ amount: bigint }>) =>
  allocations.map((allocation) => allocation.amount);

afterEach(() => {
  registerInvoiceRemainingFetcher(null);
  vi.useRealTimers();
});

describe("aggregatePayments — equal strategy", () => {
  it("splits the budget evenly when every invoice has enough room", async () => {
    const allocations = await aggregatePayments(300n, [1n, 2n, 3n], "equal", {
      remaining: { "1": 100n, "2": 100n, "3": 100n },
    });

    expect(amountsOf(allocations)).toEqual([100n, 100n, 100n]);
    expect(allocations[0]!.percentOfBudget).toBe(33.33);
  });

  it("caps at each invoice's remaining amount and redistributes the surplus", async () => {
    const allocations = await aggregatePayments(300n, [1n, 2n, 3n], "equal", {
      remaining: { "1": 50n, "2": 500n, "3": 500n },
    });

    expect(amountsOf(allocations)).toEqual([50n, 125n, 125n]);
  });

  it("never allocates more than the invoices collectively still need", async () => {
    const allocations = await aggregatePayments(1_000n, [1n, 2n], "equal", {
      remaining: { "1": 10n, "2": 20n },
    });

    expect(amountsOf(allocations)).toEqual([10n, 20n]);
    expect(allocations.reduce((total, a) => total + a.percentOfBudget, 0)).toBe(3);
  });

  it("distributes rounding dust deterministically so the budget is fully used", async () => {
    const allocations = await aggregatePayments(100n, [1n, 2n, 3n], "equal", {
      remaining: { "1": 100n, "2": 100n, "3": 100n },
    });

    expect(allocations.reduce((total, a) => total + a.amount, 0n)).toBe(100n);
    expect(amountsOf(allocations)).toEqual([34n, 33n, 33n]);
  });

  it("handles a single invoice", async () => {
    const allocations = await aggregatePayments(1_000n, [42n], "equal", {
      remaining: { "42": 400n },
    });

    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({ invoiceId: 42n, amount: 400n });
    expect(allocations[0]!.percentOfBudget).toBe(40);
  });

  it("handles an empty invoice list gracefully", async () => {
    await expect(aggregatePayments(500n, [], "equal")).resolves.toEqual([]);
  });

  it("skips invoices that are already fully funded", async () => {
    const allocations = await aggregatePayments(100n, [1n, 2n], "equal", {
      remaining: { "1": 0n, "2": 100n },
    });

    expect(amountsOf(allocations)).toEqual([0n, 100n]);
    expect(allocations[0]!.percentOfBudget).toBe(0);
  });
});

describe("aggregatePayments — proportional strategy", () => {
  it("allocates more to invoices further from their target", async () => {
    const allocations = await aggregatePayments(1_000n, [1n, 2n], "proportional", {
      remaining: { "1": 100n, "2": 900n },
    });

    expect(amountsOf(allocations)).toEqual([100n, 900n]);
  });

  it("weights by raw remaining amounts when the budget is smaller than the total", async () => {
    const allocations = await aggregatePayments(200n, [1n, 2n], "proportional", {
      remaining: { "1": 300n, "2": 100n },
    });

    expect(amountsOf(allocations)).toEqual([150n, 50n]);
  });

  it("weights by fraction-of-target-remaining when targets are supplied", async () => {
    const budget = 600n;
    const remaining = { "1": 200n, "2": 800n };
    const withTargets = await aggregatePayments(budget, [1n, 2n], "proportional", {
      remaining,
      targets: { "1": 400n, "2": 20_000n },
    });

    // Invoice 1 is 50% unfunded while invoice 2 is only 4% unfunded, so the
    // fraction-based weighting overrides the raw remaining amounts.
    const rawProportional = await aggregatePayments(budget, [1n, 2n], "proportional", {
      remaining,
    });

    expect(withTargets[0]!.amount).toBe(200n);
    expect(withTargets[0]!.amount + withTargets[1]!.amount).toBe(budget);
    expect(withTargets[0]!.amount).toBeGreaterThan(rawProportional[0]!.amount);
    expect(withTargets[1]!.amount).toBeLessThan(rawProportional[1]!.amount);
  });

  it("treats invoices with a zero target as unfunded-adjacent (zero weight)", async () => {
    const allocations = await aggregatePayments(100n, [1n, 2n], "proportional", {
      remaining: { "1": 100n, "2": 100n },
      targets: { "1": 0n, "2": 100n },
    });

    expect(amountsOf(allocations)).toEqual([0n, 100n]);
  });
});


describe("aggregatePayments — custom strategy", () => {
  it("allocates according to the supplied weights", async () => {
    const allocations = await aggregatePayments(1_000n, [1n, 2n], "custom", {
      remaining: { "1": 10_000n, "2": 10_000n },
      weights: [70, 30],
    });

    expect(amountsOf(allocations)).toEqual([700n, 300n]);
    expect(allocations.map((a) => a.percentOfBudget)).toEqual([70, 30]);
  });

  it("still caps allocations at the remaining amount", async () => {
    const allocations = await aggregatePayments(1_000n, [1n, 2n], "custom", {
      remaining: { "1": 10n, "2": 10_000n },
      weights: [50, 50],
    });

    expect(amountsOf(allocations)).toEqual([10n, 990n]);
  });

  it("accepts weights that sum to 100 within floating-point tolerance", async () => {
    await expect(
      aggregatePayments(100n, [1n, 2n], "custom", {
        remaining: { "1": 1_000n, "2": 1_000n },
        weights: [33.3333333, 66.6666667],
      }),
    ).resolves.toHaveLength(2);
  });

  it("rejects weights that do not sum to 100", async () => {
    await expect(
      aggregatePayments(100n, [1n, 2n], "custom", {
        remaining: { "1": 1_000n, "2": 1_000n },
        weights: [60, 30],
      }),
    ).rejects.toThrow(/must sum to 100/);
  });

  it("rejects a missing weights array", async () => {
    await expect(
      aggregatePayments(100n, [1n, 2n], "custom", { remaining: { "1": 1n, "2": 1n } }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects weights whose length does not match the invoice list", async () => {
    await expect(
      aggregatePayments(100n, [1n, 2n], "custom", {
        remaining: { "1": 1_000n, "2": 1_000n },
        weights: [100],
      }),
    ).rejects.toThrow(/one entry per invoice/);
  });

  it("rejects negative and non-finite weights", async () => {
    await expect(
      aggregatePayments(100n, [1n, 2n], "custom", {
        remaining: { "1": 1_000n, "2": 1_000n },
        weights: [120, -20],
      }),
    ).rejects.toThrow(/non-negative/);

    await expect(
      aggregatePayments(100n, [1n, 2n], "custom", {
        remaining: { "1": 1_000n, "2": 1_000n },
        weights: [Number.NaN, 100],
      }),
    ).rejects.toThrow(/non-negative/);
  });

  it("validates weights before resolving invoice data", async () => {
    await expect(
      aggregatePayments(100n, [1n, 2n], "custom", { weights: [50, 40] }),
    ).rejects.toThrow(/must sum to 100/);
  });
});

describe("aggregatePayments — validation", () => {
  it("rejects an unknown strategy", async () => {
    await expect(
      aggregatePayments(100n, [1n], "weighted" as never, { remaining: { "1": 100n } }),
    ).rejects.toThrow(/Unknown payment allocation strategy/);
  });

  it("rejects a negative budget", async () => {
    await expect(
      aggregatePayments(-1n, [1n], "equal", { remaining: { "1": 100n } }),
    ).rejects.toThrow(/must not be negative/);
  });

  it("rejects duplicate invoice IDs", async () => {
    await expect(
      aggregatePayments(100n, [1n, 1n], "equal", { remaining: { "1": 100n } }),
    ).rejects.toThrow(/Duplicate invoice ID/);
  });

  it("throws when no remaining-amount source is available", async () => {
    await expect(aggregatePayments(100n, [1n], "equal")).rejects.toThrow(
      /No source of invoice remaining amounts/,
    );
  });

  it("returns zeroed allocations for a zero budget", async () => {
    const allocations = await aggregatePayments(0n, [1n, 2n], "equal", {
      remaining: { "1": 100n, "2": 100n },
    });

    expect(allocations).toEqual([
      { invoiceId: 1n, amount: 0n, percentOfBudget: 0 },
      { invoiceId: 2n, amount: 0n, percentOfBudget: 0 },
    ]);
  });

  it("returns allocations in the order the invoice IDs were given", async () => {
    const allocations = await aggregatePayments(30n, [9n, 3n, 6n], "equal", {
      remaining: { "9": 10n, "3": 10n, "6": 10n },
    });

    expect(allocations.map((a) => a.invoiceId)).toEqual([9n, 3n, 6n]);
  });
});


describe("aggregatePayments — remaining amount sources", () => {
  it("uses a per-call fetchRemaining function", async () => {
    const fetchRemaining = vi.fn(async (invoiceId: bigint) => invoiceId * 100n);

    const allocations = await aggregatePayments(300n, [1n, 2n], "equal", { fetchRemaining });

    expect(fetchRemaining).toHaveBeenCalledWith(1n);
    expect(fetchRemaining).toHaveBeenCalledWith(2n);
    // Invoice 1 only needs 100 more, so the surplus goes to invoice 2.
    expect(amountsOf(allocations)).toEqual([100n, 200n]);
  });

  it("derives remaining amounts from an invoiceSource", async () => {
    const invoices = new Map<string, Invoice>([
      ["1", makeInvoice("1", [100n], 40n)],
      ["2", makeInvoice("2", [500n], 0n)],
    ]);
    const invoiceSource = {
      getInvoice: vi.fn(async (id: string) => invoices.get(id)!),
    };

    const allocations = await aggregatePayments(1_000n, [1n, 2n], "equal", { invoiceSource });

    // Remaining amounts are 60 and 500, so both invoices are fully funded.
    expect(amountsOf(allocations)).toEqual([60n, 500n]);
  });

  it("falls back to a registered default fetcher", async () => {
    registerInvoiceRemainingFetcher(async () => 25n);

    const allocations = await aggregatePayments(100n, [1n, 2n], "equal");

    expect(amountsOf(allocations)).toEqual([25n, 25n]);
  });

  it("prefers per-call options over the registered default fetcher", async () => {
    registerInvoiceRemainingFetcher(async () => 1n);

    const allocations = await aggregatePayments(100n, [1n], "equal", {
      remaining: { "1": 80n },
    });

    expect(amountsOf(allocations)).toEqual([80n]);
  });

  it("accepts number values in a remaining record", async () => {
    const allocations = await aggregatePayments(100n, [1n, 2n], "equal", {
      remaining: { "1": 30, "2": 70 },
    });

    expect(amountsOf(allocations)).toEqual([30n, 70n]);
  });

  it("accepts a Map of remaining amounts", async () => {
    const allocations = await aggregatePayments(100n, [1n, 2n], "equal", {
      remaining: new Map([
        [1n, 40n],
        [2n, 60n],
      ]),
    });

    expect(amountsOf(allocations)).toEqual([40n, 60n]);
  });

  it("treats negative remaining amounts as already fully funded", async () => {
    const allocations = await aggregatePayments(100n, [1n, 2n], "equal", {
      remaining: { "1": -5n, "2": 100n },
    });

    expect(amountsOf(allocations)).toEqual([0n, 100n]);
  });
});

describe("remainingForInvoice", () => {
  it("subtracts the funded amount from the sum of recipient amounts", () => {
    expect(remainingForInvoice(makeInvoice("1", [60n, 40n], 25n))).toBe(75n);
  });

  it("clamps over-funded invoices to zero", () => {
    expect(remainingForInvoice(makeInvoice("1", [100n], 150n))).toBe(0n);
  });

  it("returns zero for invoices with no recipients", () => {
    expect(remainingForInvoice(makeInvoice("1", []))).toBe(0n);
  });
});

describe("createInvoiceRemainingFetcher", () => {
  it("builds a fetcher from any getInvoice-compatible source", async () => {
    const getInvoice = vi.fn(async () => makeInvoice("7", [1_000n], 250n));
    const fetcher = createInvoiceRemainingFetcher({ getInvoice });

    await expect(fetcher(7n)).resolves.toBe(750n);
    expect(getInvoice).toHaveBeenCalledWith("7");
  });
});
