import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { deadlineFromDays, isExpired } from "../src/utils.js";
import {
  deadlineFromDays as deadlineFromDaysBigInt,
  isDeadlineValid,
  timeUntilDeadline,
} from "../src/deadline.js";

describe("deadlineFromDays (property-based)", () => {
  it("returns a timestamp in the future for positive day counts", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 36500 }),
        (days) => {
          const now = Math.floor(Date.now() / 1000);
          const deadline = deadlineFromDays(days);
          expect(deadline).toBeGreaterThan(now);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("returns approximately now + days * 86400", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3650 }),
        (days) => {
          const now = Math.floor(Date.now() / 1000);
          const deadline = deadlineFromDays(days);
          const expected = now + days * 86400;
          expect(Math.abs(deadline - expected)).toBeLessThanOrEqual(2);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("deadline is never less than now for positive days", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        (days) => {
          const deadline = deadlineFromDays(days);
          expect(deadline).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000));
        },
      ),
      { numRuns: 500 },
    );
  });

  it("isExpired returns false for deadlines in the future", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3650 }),
        (days) => {
          const deadline = deadlineFromDays(days);
          expect(isExpired(deadline)).toBe(false);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("isExpired returns true for deadlines in the past", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3650 }),
        (days) => {
          const now = Math.floor(Date.now() / 1000);
          const pastDeadline = now - days * 86400;
          expect(isExpired(pastDeadline)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("larger day counts produce larger deadlines", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 1001, max: 2000 }),
        (small, large) => {
          const deadlineSmall = deadlineFromDays(small);
          const deadlineLarge = deadlineFromDays(large);
          expect(deadlineLarge).toBeGreaterThan(deadlineSmall);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("deadline is an integer (no fractional seconds)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 36500 }),
        (days) => {
          const deadline = deadlineFromDays(days);
          expect(Number.isInteger(deadline)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("deadlineFromDays(0) returns approximately now", () => {
    const now = Math.floor(Date.now() / 1000);
    const deadline = deadlineFromDays(0);
    expect(Math.abs(deadline - now)).toBeLessThanOrEqual(2);
  });
});

describe("bigint deadline helpers (property-based)", () => {
  const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000));

  it("deadlineFromDays(n) is always in the future for n > 0", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1e-9, max: 3_650, noNaN: true, noDefaultInfinity: true }),
        (days) => {
          expect(deadlineFromDaysBigInt(days)).toBeGreaterThan(nowSeconds());
        },
      ),
      { numRuns: 500, verbose: true },
    );
  });

  it("isDeadlineValid matches the one-hour rule for arbitrary timestamps", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 4_102_444_800n }), (deadline) => {
        expect(isDeadlineValid(deadline)).toBe(deadline - nowSeconds() >= 3_600n);
      }),
      { numRuns: 500, verbose: true },
    );
  });

  it("timeUntilDeadline never reports negative units and flags expiry consistently", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 4_102_444_800n }), (deadline) => {
        const remaining = timeUntilDeadline(deadline);
        const diff = deadline - nowSeconds();

        expect(remaining.expired).toBe(diff <= 0n);
        expect(remaining.days).toBeGreaterThanOrEqual(0);
        expect(remaining.hours).toBeGreaterThanOrEqual(0);
        expect(remaining.hours).toBeLessThanOrEqual(23);
        expect(remaining.minutes).toBeGreaterThanOrEqual(0);
        expect(remaining.minutes).toBeLessThanOrEqual(59);
        expect(remaining.seconds).toBeGreaterThanOrEqual(0);
        expect(remaining.seconds).toBeLessThanOrEqual(59);
      }),
      { numRuns: 500, verbose: true },
    );
  });

  it("timeUntilDeadline units reconstruct the remaining duration", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 4_102_444_800n }), (total) => {
        const deadline = nowSeconds() + total;
        const remaining = timeUntilDeadline(deadline);
        const reconstructed =
          BigInt(remaining.days) * 86_400n +
          BigInt(remaining.hours) * 3_600n +
          BigInt(remaining.minutes) * 60n +
          BigInt(remaining.seconds);
        const diff = deadline - nowSeconds();

        expect(remaining.expired).toBe(false);
        expect(reconstructed).toBeLessThanOrEqual(diff);
        // Allow for the wall clock rolling to the next second mid-assertion.
        expect(diff - reconstructed).toBeLessThanOrEqual(1n);
      }),
      { numRuns: 500, verbose: true },
    );
  });
});

