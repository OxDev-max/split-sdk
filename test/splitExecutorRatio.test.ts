/**
 * Tests for splitExecutor recipient ratio validation — Issue #778
 *
 * Covers the acceptance criteria:
 *  1. Before building any transaction the executor checks that recipient
 *     ratios sum to 1.0 within SPLIT_RATIO_TOLERANCE (1e-9).
 *  2. A SplitRatioSumError carrying the actual sum is thrown when the check fails.
 *  3. Valid splits (sum within tolerance) proceed unchanged.
 *
 * Ratio validation runs before the subentry capacity guard, so the failure
 * cases below never touch Horizon. The passing cases skip the capacity guard
 * with `{ skipCapacityCheck: true }` — no network calls are made.
 */

import { describe, it, expect } from "vitest";
import {
  splitExecutor,
  SplitRatioSumError,
  SPLIT_RATIO_TOLERANCE,
  sumRecipientRatios,
  validateSplitRatioSum,
} from "../src/payments/splitExecutor.js";
import { StellarSplitError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALICE = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const BOB = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPGQS7Z5H4M3I5K6XTLCPUDVKL";
const CAROL = "GALICE00000000000000000000000000000000000000000000000000";

describe("SPLIT_RATIO_TOLERANCE", () => {
  it("is exported and pinned at 1e-9", () => {
    expect(SPLIT_RATIO_TOLERANCE).toBe(1e-9);
  });
});

describe("sumRecipientRatios / validateSplitRatioSum", () => {
  it("sums declared ratios and treats omitted ratios as 0", () => {
    expect(
      sumRecipientRatios([
        { address: ALICE, amount: 1n, ratio: 0.25 },
        { address: BOB, amount: 1n, ratio: 0.75 },
        { address: CAROL, amount: 1n },
      ]),
    ).toBe(1);
  });

  it("returns the actual sum when the ratios are valid", () => {
    const sum = validateSplitRatioSum([
      { address: ALICE, amount: 1n, ratio: 0.4 },
      { address: BOB, amount: 1n, ratio: 0.6 },
    ]);
    expect(sum).toBeCloseTo(1, 12);
  });

  it("accepts a floating-point sum that is within tolerance of 1.0", () => {
    // 0.1 + 0.2 + 0.7 === 0.9999999999999999 in IEEE-754 arithmetic.
    expect(() =>
      validateSplitRatioSum([
        { address: ALICE, amount: 1n, ratio: 0.1 },
        { address: BOB, amount: 1n, ratio: 0.2 },
        { address: CAROL, amount: 1n, ratio: 0.7 },
      ]),
    ).not.toThrow();
  });

  it("throws SplitRatioSumError carrying the actual sum when underpaid", () => {
    let caught: unknown;
    try {
      validateSplitRatioSum([
        { address: ALICE, amount: 1n, ratio: 0.5 },
        { address: BOB, amount: 1n, ratio: 0.4 },
      ]);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SplitRatioSumError);
    expect(caught).toBeInstanceOf(StellarSplitError);
    const error = caught as SplitRatioSumError;
    expect(error.actualSum).toBeCloseTo(0.9, 12);
    expect(error.expectedSum).toBe(1);
    expect(error.tolerance).toBe(SPLIT_RATIO_TOLERANCE);
    expect(error.code).toBe("SPLIT_RATIO_SUM_INVALID");
    expect(error.message).toContain("0.9");
  });

  it("throws SplitRatioSumError with the actual sum when overpaid", () => {
    const error = (() => {
      try {
        validateSplitRatioSum([
          { address: ALICE, amount: 1n, ratio: 0.6 },
          { address: BOB, amount: 1n, ratio: 0.5 },
        ]);
      } catch (err) {
        return err as SplitRatioSumError;
      }
      throw new Error("expected validateSplitRatioSum to throw");
    })();

    expect(error).toBeInstanceOf(SplitRatioSumError);
    expect(error.actualSum).toBeCloseTo(1.1, 12);
  });
});

describe("splitExecutor ratio pre-flight (Issue #778)", () => {
  it("rejects a ratio-declaring split that does not sum to 1.0 before any transaction is built", async () => {
    // No `skipCapacityCheck` here — the ratio guard must fail first and never
    // reach the Horizon-backed capacity check.
    const error = await splitExecutor(
      [
        { address: ALICE, amount: 5_000_000n, ratio: 0.4 },
        { address: BOB, amount: 5_000_000n, ratio: 0.4 },
      ],
      { horizonUrl: "https://horizon-testnet.stellar.org" },
    ).catch((err) => err as SplitRatioSumError);

    expect(error).toBeInstanceOf(SplitRatioSumError);
    expect(error.actualSum).toBeCloseTo(0.8, 12);
  });

  it("proceeds unchanged for a valid split whose ratios sum to exactly 1.0", async () => {
    const result = await splitExecutor(
      [
        { address: ALICE, amount: 5_000_000n, ratio: 0.25 },
        { address: BOB, amount: 5_000_000n, ratio: 0.75 },
      ],
      { skipCapacityCheck: true },
    );

    expect(result.success).toBe(true);
    expect(result.skippedCapacityCheck).toBe(true);
    expect(result.capacityChecks).toEqual({});
  });

  it("proceeds for a valid split whose ratio sum is within tolerance", async () => {
    const result = await splitExecutor(
      [
        { address: ALICE, amount: 1n, ratio: 0.1 },
        { address: BOB, amount: 1n, ratio: 0.2 },
        { address: CAROL, amount: 1n, ratio: 0.7 },
      ],
      { skipCapacityCheck: true },
    );

    expect(result.success).toBe(true);
  });

  it("skips ratio validation entirely when no recipient declares a ratio", async () => {
    const result = await splitExecutor(
      [
        { address: ALICE, amount: 5_000_000n },
        { address: BOB, amount: 5_000_000n },
      ],
      { skipCapacityCheck: true },
    );

    expect(result.success).toBe(true);
    expect(result.capacityChecks).toEqual({});
  });
});
