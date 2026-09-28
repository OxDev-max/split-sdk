import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  deadlineFromDays,
  deadlineFromDate,
  isDeadlineValid,
  timeUntilDeadline,
  formatDeadline,
} from "../src/deadline.js";
import { ValidationError } from "../src/errors.js";

/** 2026-01-01T00:00:00Z — deterministic "now" for every test below. */
const NOW_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const NOW_S = BigInt(Math.floor(NOW_MS / 1000));
const HOUR = 3_600n;
const DAY = 86_400n;

describe("deadlineFromDays", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a bigint exactly n days from now", () => {
    const deadline = deadlineFromDays(7);

    expect(typeof deadline).toBe("bigint");
    expect(deadline).toBe(NOW_S + 7n * DAY);
  });

  it("rounds partial days up so any positive duration is in the future", () => {
    expect(deadlineFromDays(0.5)).toBe(NOW_S + 43_200n);
    expect(deadlineFromDays(0.000001)).toBe(NOW_S + 1n);
    expect(deadlineFromDays(0.000001)).toBeGreaterThan(NOW_S);
  });

  it("supports zero and negative day counts", () => {
    expect(deadlineFromDays(0)).toBe(NOW_S);
    expect(deadlineFromDays(-1)).toBe(NOW_S - DAY);
  });

  it("throws for non-finite input", () => {
    expect(() => deadlineFromDays(Number.NaN)).toThrow(ValidationError);
    expect(() => deadlineFromDays(Number.POSITIVE_INFINITY)).toThrow(ValidationError);
  });
});

describe("deadlineFromDate", () => {
  it("converts a Date to a Unix timestamp in seconds", () => {
    expect(deadlineFromDate(new Date(NOW_MS))).toBe(NOW_S);
    expect(deadlineFromDate(new Date(0))).toBe(0n);
  });

  it("truncates sub-second precision", () => {
    expect(deadlineFromDate(new Date(NOW_MS + 999))).toBe(NOW_S);
  });

  it("throws for an invalid Date", () => {
    expect(() => deadlineFromDate(new Date("not-a-date"))).toThrow(ValidationError);
  });
});

describe("isDeadlineValid", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a deadline in the past", () => {
    expect(isDeadlineValid(NOW_S - 1n)).toBe(false);
  });

  it("rejects a same-day deadline less than an hour away", () => {
    expect(isDeadlineValid(NOW_S)).toBe(false);
    expect(isDeadlineValid(NOW_S + HOUR - 1n)).toBe(false);
  });

  it("accepts a deadline exactly one hour away (inclusive minimum)", () => {
    expect(isDeadlineValid(NOW_S + HOUR)).toBe(true);
  });

  it("accepts a far-future deadline", () => {
    expect(isDeadlineValid(deadlineFromDays(30))).toBe(true);
  });
});

describe("timeUntilDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("breaks a far-future deadline into days, hours, minutes and seconds", () => {
    const remaining = timeUntilDeadline(NOW_S + 10n * DAY + 5n * HOUR + 120n + 7n);

    expect(remaining).toEqual({
      days: 10,
      hours: 5,
      minutes: 2,
      seconds: 7,
      expired: false,
    });
  });

  it("handles a same-day deadline", () => {
    expect(timeUntilDeadline(NOW_S + 90n)).toEqual({
      days: 0,
      hours: 0,
      minutes: 1,
      seconds: 30,
      expired: false,
    });
  });

  it("reports expired deadlines as all zeros", () => {
    expect(timeUntilDeadline(NOW_S - 60n)).toEqual({
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
      expired: true,
    });

    expect(timeUntilDeadline(NOW_S)).toEqual({
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
      expired: true,
    });
  });

  it("never returns negative units for deadlines far in the past", () => {
    const remaining = timeUntilDeadline(1n);

    expect(remaining.expired).toBe(true);
    expect(remaining.days).toBe(0);
    expect(remaining.hours).toBe(0);
    expect(remaining.minutes).toBe(0);
    expect(remaining.seconds).toBe(0);
  });
});

describe("formatDeadline", () => {
  const NEW_YEAR = BigInt(Math.floor(Date.UTC(2026, 0, 1, 0, 0, 0) / 1000));

  it("formats a deadline as a human-readable date string", () => {
    expect(formatDeadline(NEW_YEAR, "en-US")).toBe("Jan 1, 2026, 12:00 AM");
  });

  it("respects the requested locale", () => {
    const en = formatDeadline(NEW_YEAR, "en-US");
    const de = formatDeadline(NEW_YEAR, "de-DE");

    expect(de).toContain("01.01.2026");
    expect(de).not.toBe(en);
  });

  it("falls back to the runtime locale when none is given", () => {
    expect(typeof formatDeadline(NEW_YEAR)).toBe("string");
    expect(formatDeadline(NEW_YEAR)).toContain("2026");
  });

  it("formats far-future deadlines correctly", () => {
    const deadline = deadlineFromDate(new Date(Date.UTC(2032, 8, 25, 12, 30, 0)));

    expect(formatDeadline(deadline, "en-US")).toBe("Sep 25, 2032, 12:30 PM");
  });

  it("throws when the deadline is outside the supported Date range", () => {
    expect(() => formatDeadline(10n ** 30n)).toThrow(ValidationError);
  });
});
