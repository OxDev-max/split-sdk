/**
 * Deadline helpers for StellarSplit invoices.
 *
 * Complements {@link DeadlineEngine} (countdowns, business hours and expiry
 * callbacks) with small, pure helpers for *computing*, *validating* and
 * *formatting* invoice deadlines as `bigint` Unix timestamps in seconds — the
 * same `u64` representation the Soroban contract stores.
 *
 * Note: `@stellar-split/sdk/utils` still exposes a legacy
 * `deadlineFromDays(days): number` helper. The helpers in this module are the
 * `bigint`-based API re-exported from the package root.
 *
 * @example
 * import { deadlineFromDays, isDeadlineValid, timeUntilDeadline } from "@stellar-split/sdk";
 *
 * const deadline = deadlineFromDays(7);      // 7 days from now, as bigint
 * isDeadlineValid(deadline);                 // true (more than 1 hour away)
 * timeUntilDeadline(deadline);               // { days: 7, hours: 0, … }
 */

import { ValidationError } from "./errors.js";

/** Number of seconds in one day. */
const SECONDS_PER_DAY = 86_400;
/** Number of seconds in one hour. */
const SECONDS_PER_HOUR = 3_600;
/** Minimum lead time (in seconds) for a deadline to be accepted. */
const MIN_VALID_LEAD_SECONDS = 3_600;

/** Remaining time until a deadline, broken down into calendar units. */
export interface DeadlineRemaining {
  /** Whole days remaining (0 once expired). */
  days: number;
  /** Whole hours remaining after `days` (0-23). */
  hours: number;
  /** Whole minutes remaining after `hours` (0-59). */
  minutes: number;
  /** Whole seconds remaining after `minutes` (0-59). */
  seconds: number;
  /** `true` when the deadline is now or in the past. */
  expired: boolean;
}

/** Current wall-clock time as a whole Unix second. */
function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

/**
 * Compute a Unix timestamp `n` days from now.
 *
 * Any positive `n`, however small, yields a timestamp strictly in the future
 * because the duration is rounded **up** to the next whole second.
 *
 * @param n - Number of days from now. May be fractional or negative.
 * @returns A Unix timestamp in seconds, as a `bigint`.
 * @throws {ValidationError} If `n` is not a finite number.
 *
 * @example
 * deadlineFromDays(7);  // now (seconds) + 604_800n
 * deadlineFromDays(0);  // now, rounded up to the current second
 */
export function deadlineFromDays(n: number): bigint {
  if (!Number.isFinite(n)) {
    throw new ValidationError("deadlineFromDays requires a finite number of days", {
      days: n,
    });
  }

  return nowSeconds() + BigInt(Math.ceil(n * SECONDS_PER_DAY));
}

/**
 * Convert a `Date` to a Unix timestamp in seconds.
 *
 * Sub-second precision is truncated, matching the on-chain second resolution.
 *
 * @param date - The date to convert.
 * @returns A Unix timestamp in seconds, as a `bigint`.
 * @throws {ValidationError} If `date` is invalid (for example `new Date("nope")`).
 *
 * @example
 * deadlineFromDate(new Date(0)); // 0n
 */
export function deadlineFromDate(date: Date): bigint {
  const ms = date.getTime();

  if (!Number.isFinite(ms)) {
    throw new ValidationError("deadlineFromDate requires a valid Date", {
      date: date.toString(),
    });
  }

  return BigInt(Math.floor(ms / 1000));
}

/**
 * Report whether `deadline` is at least one hour in the future.
 *
 * @param deadline - Unix timestamp in seconds.
 * @returns `true` when `deadline - now >= 1 hour`.
 *
 * @example
 * isDeadlineValid(deadlineFromDays(1));                    // true
 * isDeadlineValid(BigInt(Math.floor(Date.now() / 1000)));  // false
 */
export function isDeadlineValid(deadline: bigint): boolean {
  return deadline - nowSeconds() >= BigInt(MIN_VALID_LEAD_SECONDS);
}

/**
 * Break the remaining time until `deadline` into calendar units.
 *
 * Expired deadlines return all-zero units with `expired: true` rather than
 * negative values, so the result can be rendered directly.
 *
 * @param deadline - Unix timestamp in seconds.
 * @returns A {@link DeadlineRemaining} breakdown.
 *
 * @example
 * timeUntilDeadline(deadlineFromDays(1)); // { days: 1, hours: 0, minutes: 0, seconds: 0, expired: false }
 * timeUntilDeadline(0n);                  // { days: 0, …, expired: true }
 */
export function timeUntilDeadline(deadline: bigint): DeadlineRemaining {
  const diff = deadline - nowSeconds();

  if (diff <= 0n) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0, expired: true };
  }

  return {
    days: Number(diff / BigInt(SECONDS_PER_DAY)),
    hours: Number((diff % BigInt(SECONDS_PER_DAY)) / BigInt(SECONDS_PER_HOUR)),
    minutes: Number((diff % BigInt(SECONDS_PER_HOUR)) / 60n),
    seconds: Number(diff % 60n),
    expired: false,
  };
}

/**
 * Format a deadline as a human-readable, locale-aware date string.
 *
 * Output is always rendered in UTC so the same deadline formats identically on
 * every machine and CI runner; only the language/format of the string changes
 * with `locale`.
 *
 * @param deadline - Unix timestamp in seconds.
 * @param locale - Optional BCP-47 locale tag (for example `"en-US"`, `"de-DE"`).
 *                 Defaults to the runtime locale.
 * @returns A localized date/time string, for example `"Sep 25, 2026, 12:00 PM"`.
 * @throws {ValidationError} If `deadline` cannot be represented as a `Date`.
 *
 * @example
 * formatDeadline(deadlineFromDays(7));            // e.g. "Oct 2, 2026, 11:00 AM"
 * formatDeadline(deadlineFromDays(7), "de-DE");   // e.g. "02.10.2026, 11:00"
 */
export function formatDeadline(deadline: bigint, locale?: string): string {
  const ms = Number(deadline) * 1000;

  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) {
    throw new ValidationError("formatDeadline received a deadline outside the supported Date range", {
      deadline: deadline.toString(),
    });
  }

  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(ms));
}
