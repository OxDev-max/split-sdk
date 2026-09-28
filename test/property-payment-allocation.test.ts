import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { aggregatePayments } from "../src/paymentAllocation.js";
import type { SplitStrategy } from "../src/paymentAllocation.js";

const STRATEGIES: SplitStrategy[] = ["equal", "proportional", "custom"];

/** Arbitrary: 1-8 invoices, each with a remaining amount between 1 and 10^6. */
const scenario = fc
  .array(fc.bigInt({ min: 1n, max: 1_000_000n }), { minLength: 1, maxLength: 8 })
  .chain((remaining) =>
    fc
      .record({
        budget: fc.bigInt({ min: 0n, max: 5_000_000n }),
        strategy: fc.constantFrom(...STRATEGIES),
      })
      .map((record) => ({
        ...record,
        remaining,
        invoiceIds: remaining.map((_, index) => BigInt(index + 1)),
        remainingLookup: Object.fromEntries(
          remaining.map((amount, index) => [String(index + 1), amount]),
        ),
      })),
  );

const amountsOf = (allocations: Array<{ amount: bigint }>) =>
  allocations.map((allocation) => allocation.amount);

const weightsFor = (input: { invoiceIds: bigint[]; strategy: SplitStrategy }) =>
  input.strategy === "custom"
    ? input.invoiceIds.map(() => 100 / input.invoiceIds.length)
    : undefined;

async function allocate(
  input: { budget: bigint; invoiceIds: bigint[]; strategy: SplitStrategy; remainingLookup: Record<string, bigint> },
  extra: { weights?: number[] } = {},
) {
  return aggregatePayments(input.budget, input.invoiceIds, input.strategy, {
    remaining: input.remainingLookup,
    ...(weightsFor(input) ? { weights: weightsFor(input) } : {}),
    ...extra,
  });
}

const totalOf = (allocations: Array<{ amount: bigint }>) =>
  allocations.reduce((sum, allocation) => sum + allocation.amount, 0n);

describe("aggregatePayments (property-based)", () => {
  it("never allocates more than the budget", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (input) => {
        const allocations = await allocate(input);

        expect(totalOf(allocations)).toBeLessThanOrEqual(input.budget);
      }),
      { numRuns: 500 },
    );
  });

  it("never allocates more than an invoice still needs (no overpayment)", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (input) => {
        const allocations = await allocate(input);

        allocations.forEach((allocation, index) => {
          expect(allocation.amount).toBeLessThanOrEqual(input.remaining[index]!);
          expect(allocation.amount).toBeGreaterThanOrEqual(0n);
        });
      }),
      { numRuns: 500 },
    );
  });

  it("fully distributes min(budget, total remaining)", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (input) => {
        const totalRemaining = input.remaining.reduce((sum, amount) => sum + amount, 0n);
        const expected = input.budget < totalRemaining ? input.budget : totalRemaining;

        expect(totalOf(await allocate(input))).toBe(expected);
      }),
      { numRuns: 500 },
    );
  });

  it("returns one allocation per invoice, in input order", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (input) => {
        const allocations = await allocate(input);

        expect(allocations.map((allocation) => allocation.invoiceId)).toEqual(input.invoiceIds);
      }),
      { numRuns: 500 },
    );
  });

  it("keeps percentOfBudget within [0, 100] for a positive budget", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (input) => {
        const budget = input.budget === 0n ? 1n : input.budget;
        const allocations = await aggregatePayments(budget, input.invoiceIds, input.strategy, {
          remaining: input.remainingLookup,
          ...(weightsFor(input) ? { weights: weightsFor(input) } : {}),
        });

        for (const allocation of allocations) {
          expect(allocation.percentOfBudget).toBeGreaterThanOrEqual(0);
          expect(allocation.percentOfBudget).toBeLessThanOrEqual(100);
          expect(Number.isFinite(allocation.percentOfBudget)).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("accepts custom weights that sum to 100 for any invoice count", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.bigInt({ min: 1n, max: 1_000_000n }), { minLength: 1, maxLength: 8 }),
        fc.bigInt({ min: 0n, max: 5_000_000n }),
        async (remaining, budget) => {
          const invoiceIds = remaining.map((_, index) => BigInt(index + 1));
          const weights = remaining.map(() => 100 / remaining.length);
          const totalRemaining = remaining.reduce((sum, amount) => sum + amount, 0n);
          const expected = budget < totalRemaining ? budget : totalRemaining;
          const allocations = await aggregatePayments(budget, invoiceIds, "custom", {
            remaining: Object.fromEntries(
              remaining.map((amount, index) => [String(index + 1), amount]),
            ),
            weights,
          });

          expect(totalOf(allocations)).toBe(expected);
          expect(amountsOf(allocations)).toHaveLength(remaining.length);
        },
      ),
      { numRuns: 500, verbose: true },
    );
  });

  it("rejects custom weights that do not sum to 100", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 60 }), { minLength: 1, maxLength: 5 }),
        fc.integer({ min: 1, max: 99 }),
        async (weights, offset) => {
          const drifting = [
            ...weights.slice(0, -1),
            weights[weights.length - 1]! + offset,
          ];
          const sum = drifting.reduce((total, weight) => total + weight, 0);

          fc.pre(sum !== 100);

          await expect(
            aggregatePayments(
              1_000n,
              drifting.map((_, index) => BigInt(index + 1)),
              "custom",
              {
                remaining: Object.fromEntries(
                  drifting.map((_, index) => [String(index + 1), 1_000n]),
                ),
                weights: drifting,
              },
            ),
          ).rejects.toThrow(/must sum to 100/);
        },
      ),
      { numRuns: 500, verbose: true },
    );
  });
});

