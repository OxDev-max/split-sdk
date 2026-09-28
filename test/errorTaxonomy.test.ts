/**
 * Tests for issue #881 — Typed error taxonomy
 *
 * Verifies that every new error class is correctly typed, has the right code,
 * and that isRetryable returns the correct boolean for each.
 */
import { describe, it, expect } from "vitest";
import {
  StellarSplitError,
  RoundNotEndedError,
  isRoundNotEndedError,
  WrongMilestoneError,
  isWrongMilestoneError,
  NothingToClaimError,
  isNothingToClaimError,
  InvoiceExpiredError,
  isInvoiceExpiredError,
  PayerNotWhitelistedError,
  isPayerNotWhitelistedError,
  ContributionCapExceededError,
  isContributionCapExceededError,
  PaymentCooldownActiveError,
  isPaymentCooldownActiveError,
  ContractFrozenError,
  isContractFrozenError,
  InvoiceFullyFundedError,
  isInvoiceFullyFundedError,
  isRetryable,
  // Existing errors that isRetryable must also handle
  RpcError,
  TransactionNotConfirmedError,
  CircuitOpenError,
  InvoiceNotFoundError,
  InvoiceFrozenError,
  UnauthorizedError,
} from "../src/errors.js";

// ---------------------------------------------------------------------------
// RoundNotEndedError
// ---------------------------------------------------------------------------

describe("RoundNotEndedError (#881)", () => {
  it("is an instance of StellarSplitError", () => {
    const err = new RoundNotEndedError("inv-1", 1_800_000_000);
    expect(err).toBeInstanceOf(StellarSplitError);
    expect(err).toBeInstanceOf(RoundNotEndedError);
    expect(err).toBeInstanceOf(Error);
  });

  it("carries the correct code", () => {
    const err = new RoundNotEndedError("inv-1", 1_800_000_000);
    expect(err.code).toBe("ROUND_NOT_ENDED");
  });

  it("carries invoiceId and roundEnd", () => {
    const err = new RoundNotEndedError("inv-42", 9_999_999_999);
    expect(err.invoiceId).toBe("inv-42");
    expect(err.roundEnd).toBe(9_999_999_999);
  });

  it("isRoundNotEndedError guard works", () => {
    expect(isRoundNotEndedError(new RoundNotEndedError("x", 0))).toBe(true);
    expect(isRoundNotEndedError(new Error("plain"))).toBe(false);
    expect(isRoundNotEndedError(null)).toBe(false);
  });

  it("is NOT retryable", () => {
    expect(isRetryable(new RoundNotEndedError("inv-1", 0))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WrongMilestoneError
// ---------------------------------------------------------------------------

describe("WrongMilestoneError (#881)", () => {
  it("is an instance of StellarSplitError", () => {
    const err = new WrongMilestoneError("inv-1", 2, 1);
    expect(err).toBeInstanceOf(StellarSplitError);
    expect(err).toBeInstanceOf(WrongMilestoneError);
  });

  it("carries the correct code", () => {
    const err = new WrongMilestoneError("inv-1", 2, 1);
    expect(err.code).toBe("WRONG_MILESTONE");
  });

  it("carries invoiceId, requestedIndex and activeIndex", () => {
    const err = new WrongMilestoneError("inv-99", 3, 1);
    expect(err.invoiceId).toBe("inv-99");
    expect(err.requestedIndex).toBe(3);
    expect(err.activeIndex).toBe(1);
  });

  it("isWrongMilestoneError guard works", () => {
    expect(isWrongMilestoneError(new WrongMilestoneError("x", 0, 1))).toBe(true);
    expect(isWrongMilestoneError(new Error("plain"))).toBe(false);
  });

  it("is NOT retryable", () => {
    expect(isRetryable(new WrongMilestoneError("inv-1", 0, 1))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NothingToClaimError
// ---------------------------------------------------------------------------

describe("NothingToClaimError (#881)", () => {
  it("is an instance of StellarSplitError", () => {
    const err = new NothingToClaimError("GABC");
    expect(err).toBeInstanceOf(StellarSplitError);
    expect(err).toBeInstanceOf(NothingToClaimError);
  });

  it("carries the correct code", () => {
    const err = new NothingToClaimError("GABC");
    expect(err.code).toBe("NOTHING_TO_CLAIM");
  });

  it("carries the address", () => {
    const err = new NothingToClaimError("GABC123");
    expect(err.address).toBe("GABC123");
  });

  it("isNothingToClaimError guard works", () => {
    expect(isNothingToClaimError(new NothingToClaimError("addr"))).toBe(true);
    expect(isNothingToClaimError(new Error("plain"))).toBe(false);
  });

  it("is NOT retryable", () => {
    expect(isRetryable(new NothingToClaimError("GABC"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// InvoiceExpiredError
// ---------------------------------------------------------------------------

describe("InvoiceExpiredError (#881)", () => {
  it("is an instance of StellarSplitError", () => {
    const err = new InvoiceExpiredError("inv-exp");
    expect(err).toBeInstanceOf(StellarSplitError);
    expect(err).toBeInstanceOf(InvoiceExpiredError);
  });

  it("carries the correct code", () => {
    const err = new InvoiceExpiredError("inv-exp");
    expect(err.code).toBe("INVOICE_EXPIRED");
  });

  it("carries the invoiceId", () => {
    const err = new InvoiceExpiredError("inv-abc");
    expect(err.invoiceId).toBe("inv-abc");
  });

  it("isInvoiceExpiredError guard works", () => {
    expect(isInvoiceExpiredError(new InvoiceExpiredError("x"))).toBe(true);
    expect(isInvoiceExpiredError(new Error("plain"))).toBe(false);
  });

  it("is NOT retryable", () => {
    expect(isRetryable(new InvoiceExpiredError("inv-1"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PayerNotWhitelistedError
// ---------------------------------------------------------------------------

describe("PayerNotWhitelistedError (#881)", () => {
  it("is an instance of StellarSplitError", () => {
    const err = new PayerNotWhitelistedError("inv-1", "GABC");
    expect(err).toBeInstanceOf(StellarSplitError);
    expect(err).toBeInstanceOf(PayerNotWhitelistedError);
  });

  it("carries the correct code", () => {
    const err = new PayerNotWhitelistedError("inv-1", "GABC");
    expect(err.code).toBe("PAYER_NOT_WHITELISTED");
  });

  it("carries invoiceId and payer", () => {
    const err = new PayerNotWhitelistedError("inv-99", "GDEF");
    expect(err.invoiceId).toBe("inv-99");
    expect(err.payer).toBe("GDEF");
  });

  it("isPayerNotWhitelistedError guard works", () => {
    expect(isPayerNotWhitelistedError(new PayerNotWhitelistedError("x", "y"))).toBe(true);
    expect(isPayerNotWhitelistedError(new Error("plain"))).toBe(false);
  });

  it("is NOT retryable", () => {
    expect(isRetryable(new PayerNotWhitelistedError("inv-1", "GABC"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ContributionCapExceededError
// ---------------------------------------------------------------------------

describe("ContributionCapExceededError (#881)", () => {
  it("is an instance of StellarSplitError", () => {
    const err = new ContributionCapExceededError("inv-1", "GABC", 100n, 200n);
    expect(err).toBeInstanceOf(StellarSplitError);
    expect(err).toBeInstanceOf(ContributionCapExceededError);
  });

  it("carries the correct code", () => {
    const err = new ContributionCapExceededError("inv-1", "GABC", 100n, 200n);
    expect(err.code).toBe("CONTRIBUTION_CAP_EXCEEDED");
  });

  it("carries invoiceId, payer, cap and attempted as bigints", () => {
    const err = new ContributionCapExceededError("inv-99", "GDEF", 500n, 600n);
    expect(err.invoiceId).toBe("inv-99");
    expect(err.payer).toBe("GDEF");
    expect(err.cap).toBe(500n);
    expect(err.attempted).toBe(600n);
  });

  it("isContributionCapExceededError guard works", () => {
    expect(
      isContributionCapExceededError(new ContributionCapExceededError("x", "y", 0n, 1n))
    ).toBe(true);
    expect(isContributionCapExceededError(new Error("plain"))).toBe(false);
  });

  it("is NOT retryable", () => {
    expect(isRetryable(new ContributionCapExceededError("inv-1", "GABC", 100n, 200n))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PaymentCooldownActiveError
// ---------------------------------------------------------------------------

describe("PaymentCooldownActiveError (#881)", () => {
  it("is an instance of StellarSplitError", () => {
    const err = new PaymentCooldownActiveError("inv-1", "GABC", 1_800_000_000);
    expect(err).toBeInstanceOf(StellarSplitError);
    expect(err).toBeInstanceOf(PaymentCooldownActiveError);
  });

  it("carries the correct code", () => {
    const err = new PaymentCooldownActiveError("inv-1", "GABC", 1_800_000_000);
    expect(err.code).toBe("PAYMENT_COOLDOWN_ACTIVE");
  });

  it("carries invoiceId, payer and retryAfter as a Date", () => {
    const ts = 1_800_000_000;
    const err = new PaymentCooldownActiveError("inv-99", "GDEF", ts);
    expect(err.invoiceId).toBe("inv-99");
    expect(err.payer).toBe("GDEF");
    expect(err.retryAfter).toBeInstanceOf(Date);
    expect(err.retryAfter.getTime()).toBe(ts * 1000);
  });

  it("isPaymentCooldownActiveError guard works", () => {
    expect(isPaymentCooldownActiveError(new PaymentCooldownActiveError("x", "y", 0))).toBe(true);
    expect(isPaymentCooldownActiveError(new Error("plain"))).toBe(false);
  });

  it("IS retryable (transient condition)", () => {
    expect(isRetryable(new PaymentCooldownActiveError("inv-1", "GABC", 0))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ContractFrozenError
// ---------------------------------------------------------------------------

describe("ContractFrozenError (#881)", () => {
  it("is an instance of StellarSplitError", () => {
    const err = new ContractFrozenError();
    expect(err).toBeInstanceOf(StellarSplitError);
    expect(err).toBeInstanceOf(ContractFrozenError);
  });

  it("carries the correct code", () => {
    const err = new ContractFrozenError();
    expect(err.code).toBe("CONTRACT_FROZEN");
  });

  it("isContractFrozenError guard works", () => {
    expect(isContractFrozenError(new ContractFrozenError())).toBe(true);
    expect(isContractFrozenError(new Error("plain"))).toBe(false);
  });

  it("is NOT retryable", () => {
    expect(isRetryable(new ContractFrozenError())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// InvoiceFullyFundedError
// ---------------------------------------------------------------------------

describe("InvoiceFullyFundedError (#881)", () => {
  it("is an instance of StellarSplitError", () => {
    const err = new InvoiceFullyFundedError("inv-full");
    expect(err).toBeInstanceOf(StellarSplitError);
    expect(err).toBeInstanceOf(InvoiceFullyFundedError);
  });

  it("carries the correct code", () => {
    const err = new InvoiceFullyFundedError("inv-full");
    expect(err.code).toBe("INVOICE_FULLY_FUNDED");
  });

  it("carries the invoiceId", () => {
    const err = new InvoiceFullyFundedError("inv-abc");
    expect(err.invoiceId).toBe("inv-abc");
  });

  it("isInvoiceFullyFundedError guard works", () => {
    expect(isInvoiceFullyFundedError(new InvoiceFullyFundedError("x"))).toBe(true);
    expect(isInvoiceFullyFundedError(new Error("plain"))).toBe(false);
  });

  it("is NOT retryable", () => {
    expect(isRetryable(new InvoiceFullyFundedError("inv-1"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isRetryable — existing error types
// ---------------------------------------------------------------------------

describe("isRetryable — existing error classes (#881)", () => {
  it("RpcError IS retryable", () => {
    expect(isRetryable(new RpcError("Network error", 503))).toBe(true);
  });

  it("TransactionNotConfirmedError IS retryable", () => {
    expect(isRetryable(new TransactionNotConfirmedError("PENDING"))).toBe(true);
  });

  it("CircuitOpenError IS retryable", () => {
    expect(isRetryable(new CircuitOpenError())).toBe(true);
  });

  it("InvoiceNotFoundError is NOT retryable", () => {
    expect(isRetryable(new InvoiceNotFoundError("inv-1"))).toBe(false);
  });

  it("InvoiceFrozenError is NOT retryable", () => {
    expect(isRetryable(new InvoiceFrozenError("inv-1"))).toBe(false);
  });

  it("UnauthorizedError is NOT retryable", () => {
    expect(isRetryable(new UnauthorizedError())).toBe(false);
  });

  it("plain Error is NOT retryable", () => {
    expect(isRetryable(new Error("oops"))).toBe(false);
  });

  it("non-error values are NOT retryable", () => {
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
    expect(isRetryable("string")).toBe(false);
    expect(isRetryable(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// All new error classes extend StellarSplitError (base requirement #881)
// ---------------------------------------------------------------------------

describe("All new errors extend StellarSplitError (#881)", () => {
  const errors: StellarSplitError[] = [
    new RoundNotEndedError("inv-1", 0),
    new WrongMilestoneError("inv-1", 0, 1),
    new NothingToClaimError("GABC"),
    new InvoiceExpiredError("inv-1"),
    new PayerNotWhitelistedError("inv-1", "GABC"),
    new ContributionCapExceededError("inv-1", "GABC", 100n, 200n),
    new PaymentCooldownActiveError("inv-1", "GABC", 0),
    new ContractFrozenError(),
    new InvoiceFullyFundedError("inv-1"),
  ];

  for (const err of errors) {
    it(`${err.name} is instanceof StellarSplitError`, () => {
      expect(err).toBeInstanceOf(StellarSplitError);
      expect(err).toBeInstanceOf(Error);
      expect(typeof err.code).toBe("string");
      expect(err.code.length).toBeGreaterThan(0);
    });
  }
});
