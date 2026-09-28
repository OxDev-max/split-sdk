import { describe, it, expect } from "vitest";
import { WaterfallRouter } from "../src/routing/WaterfallRouter.js";
import { createMockInvoice } from "../src/testing/factories.js";
import type { WaterfallConfig } from "../src/types/routing.js";

const PLATFORM = "GPLATFORM00000000000000000000000000000000000000000000000";
const TAX = "GTAX000000000000000000000000000000000000000000000000000";
const BENEFICIARY = "GBENEFICIARY0000000000000000000000000000000000000000000";

describe("WaterfallRouter", () => {
  const router = new WaterfallRouter();
  const invoice = createMockInvoice({ token: "NATIVE_TOKEN" });

  function threeTierConfig(overrides?: Partial<WaterfallConfig>): WaterfallConfig {
    return {
      tiers: [
        { recipient: PLATFORM, minimumAmount: 100n },
        { recipient: TAX, minimumAmount: 200n },
        { recipient: BENEFICIARY, minimumAmount: 700n },
      ],
      ...overrides,
    };
  }

  it("returns steps in declared priority order with correct amounts when fully funded", () => {
    const result = router.plan(invoice, 1000n, threeTierConfig());

    expect(result.steps.map((s) => s.recipient)).toEqual([PLATFORM, TAX, BENEFICIARY]);
    expect(result.steps.map((s) => s.amount)).toEqual([100n, 200n, 700n]);
    expect(result.steps.every((s) => s.satisfied)).toBe(true);
    expect(result.fullySatisfied).toBe(true);
    expect(result.totalAllocated).toBe(1000n);
    expect(result.remaining).toBe(0n);
  });

  it("marks tiers N+1 and beyond unsatisfied with zero amount on partial funding", () => {
    // Covers only the first tier (100) plus part of the second (needs 200, only 50 left).
    const result = router.plan(invoice, 150n, threeTierConfig());

    expect(result.steps[0]).toMatchObject({ recipient: PLATFORM, amount: 100n, satisfied: true });
    expect(result.steps[1]).toMatchObject({ recipient: TAX, amount: 0n, satisfied: false });
    expect(result.steps[2]).toMatchObject({ recipient: BENEFICIARY, amount: 0n, satisfied: false });
    expect(result.fullySatisfied).toBe(false);
    expect(result.totalAllocated).toBe(100n);
    expect(result.remaining).toBe(50n);
  });

  it("handles a single-tier waterfall", () => {
    const result = router.plan(invoice, 500n, { tiers: [{ recipient: PLATFORM, minimumAmount: 300n }] });
    expect(result.steps).toEqual([
      { recipient: PLATFORM, amount: 300n, asset: invoice.token, minimumAmount: 300n, satisfied: true },
    ]);
    expect(result.remaining).toBe(200n);
  });

  it("treats a zero-amount tier as trivially satisfied regardless of remaining funds", () => {
    const result = router.plan(invoice, 0n, {
      tiers: [
        { recipient: PLATFORM, minimumAmount: 0n },
        { recipient: TAX, minimumAmount: 50n },
      ],
    });
    expect(result.steps[0]).toMatchObject({ amount: 0n, satisfied: true });
    expect(result.steps[1]).toMatchObject({ amount: 0n, satisfied: false });
  });

  it("supports mixed-asset tiers, defaulting to the invoice token when a tier omits asset", () => {
    const usdc = "CUSDCCONTRACTADDRESSEXAMPLE00000000000000000000000000000";
    const result = router.plan(invoice, 1000n, {
      tiers: [
        { recipient: PLATFORM, minimumAmount: 100n, asset: usdc },
        { recipient: TAX, minimumAmount: 200n }, // defaults to invoice.token
      ],
    });
    expect(result.steps[0].asset).toBe(usdc);
    expect(result.steps[1].asset).toBe(invoice.token);
  });

  it("halts downstream steps entirely once a tier is unsatisfied, even if a later tier's minimum is smaller", () => {
    const result = router.plan(invoice, 100n, {
      tiers: [
        { recipient: PLATFORM, minimumAmount: 100n },
        { recipient: TAX, minimumAmount: 500n }, // unsatisfied — blocks below
        { recipient: BENEFICIARY, minimumAmount: 1n }, // would fit, but must stay blocked
      ],
    });
    expect(result.steps[1].satisfied).toBe(false);
    expect(result.steps[2]).toMatchObject({ amount: 0n, satisfied: false });
  });

  it("rejects a negative availableAmount", () => {
    expect(() => router.plan(invoice, -1n, threeTierConfig())).toThrow();
  });
});

describe("WaterfallRouter route scoring (Issue #777)", () => {
  const router = new WaterfallRouter();
  const invoice = createMockInvoice({ token: "NATIVE_TOKEN" });

  it("tries routes in score-descending order, not declaration order", () => {
    const result = router.plan(invoice, 150n, {
      tiers: [
        { recipient: BENEFICIARY, minimumAmount: 700n, score: 1 },
        { recipient: PLATFORM, minimumAmount: 100n, score: 9 },
        { recipient: TAX, minimumAmount: 200n, score: 5 },
      ],
    });

    // PLATFORM (score 9) is funded first, TAX (5) blocks on the 50 stroops left,
    // and BENEFICIARY (1) stays blocked behind it.
    expect(result.steps.map((s) => s.recipient)).toEqual([PLATFORM, TAX, BENEFICIARY]);
    expect(result.steps[0]).toMatchObject({ amount: 100n, satisfied: true });
    expect(result.steps[1]).toMatchObject({ amount: 0n, satisfied: false });
    expect(result.totalAllocated).toBe(100n);
    expect(result.remaining).toBe(50n);
  });

  it("defaults a missing score to 0", () => {
    const result = router.plan(invoice, 1000n, {
      tiers: [
        { recipient: PLATFORM, minimumAmount: 100n },
        { recipient: TAX, minimumAmount: 200n, score: 0 },
        { recipient: BENEFICIARY, minimumAmount: 700n, score: 5 },
      ],
    });

    expect(result.steps.map((s) => s.recipient)).toEqual([BENEFICIARY, PLATFORM, TAX]);
  });

  it("keeps declaration order (FIFO) for tied scores", () => {
    const result = router.plan(invoice, 1000n, {
      tiers: [
        { recipient: BENEFICIARY, minimumAmount: 300n, score: 3 },
        { recipient: PLATFORM, minimumAmount: 300n, score: 3 },
        { recipient: TAX, minimumAmount: 400n, score: 3 },
      ],
    });

    expect(result.steps.map((s) => s.recipient)).toEqual([BENEFICIARY, PLATFORM, TAX]);
    expect(result.fullySatisfied).toBe(true);
  });

  it("preserves declared order for an entirely unscored config", () => {
    const result = router.plan(invoice, 1000n, {
      tiers: [
        { recipient: PLATFORM, minimumAmount: 100n },
        { recipient: TAX, minimumAmount: 200n },
        { recipient: BENEFICIARY, minimumAmount: 700n },
      ],
    });

    expect(result.steps.map((s) => s.recipient)).toEqual([PLATFORM, TAX, BENEFICIARY]);
  });

  it("does not mutate the caller's tier array", () => {
    const tiers = [
      { recipient: PLATFORM, minimumAmount: 100n, score: 1 },
      { recipient: BENEFICIARY, minimumAmount: 100n, score: 9 },
    ];

    router.plan(invoice, 1000n, { tiers });

    expect(tiers.map((t) => t.recipient)).toEqual([PLATFORM, BENEFICIARY]);
  });
});
