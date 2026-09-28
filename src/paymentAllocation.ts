/**
 * Payment aggregator — allocate one budget across many invoices.
 *
 * Given a total budget in stroops and a list of invoice IDs, {@link aggregatePayments}
 * computes how much should be paid to each invoice using one of three
 * strategies:
 *
 * - `equal` — split the budget evenly across the invoices.
 * - `proportional` — weight each invoice by how far it still is from its
 *   target (its remaining amount, or `remaining / target` when targets are
 *   supplied), so invoices furthest from being funded receive the most.
 * - `custom` — use caller-supplied weights that sum to 100.
 *
 * Every allocation is capped at the invoice's remaining amount, so the
 * aggregator can never propose an overpayment. Rounding dust is redistributed
 * deterministically (largest-remainder method) so the allocations always sum to
 * `min(budget, total remaining)`.
 *
 * The remaining amount of each invoice is resolved from (in order) an explicit
 * `remaining` map/record, a per-call `fetchRemaining` function, an
 * `invoiceSource` (any object exposing `getInvoice`), or a fetcher registered
 * through {@link registerInvoiceRemainingFetcher}.
 *
 * @example
 * import { aggregatePayments } from "@stellar-split/sdk";
 *
 * const allocations = await aggregatePayments(1_000_000_000n, [1n, 2n, 3n], "proportional", {
 *   invoiceSource: client, // StellarSplitClient
 * });
 *
 * for (const { invoiceId, amount, percentOfBudget } of allocations) {
 *   console.log(`Invoice ${invoiceId}: ${amount} (${percentOfBudget}% of budget)`);
 * }
 */

import { ValidationError } from "./errors.js";
import type { Invoice } from "./types.js";

/** Budget-allocation strategies supported by {@link aggregatePayments}. */
export type SplitStrategy = "equal" | "proportional" | "custom";

/** A single invoice's share of the budget. */
export interface PaymentAllocation {
  /** Invoice the payment should be sent to. */
  invoiceId: bigint;
  /** Amount to pay, in stroops. Never exceeds the invoice's remaining amount. */
  amount: bigint;
  /** `amount` as a percentage of the total budget, rounded to 2 decimals. */
  percentOfBudget: number;
}

/** Resolves the remaining (still unfunded) amount, in stroops, for an invoice. */
export type InvoiceRemainingFetcher = (invoiceId: bigint) => Promise<bigint>;

/** Minimal invoice source contract — satisfied by `StellarSplitClient`. */
export interface InvoiceSource {
  getInvoice(invoiceId: string): Promise<Invoice>;
}

/** A bigint/number amount keyed by invoice ID (decimal string). */
export type AmountLookup = ReadonlyMap<bigint, bigint> | Record<string, bigint | number>;

/** Options for {@link aggregatePayments}. */
export interface AggregatePaymentsOptions {
  /**
   * Weights for the `custom` strategy, one per invoice ID, in the same order.
   * Must be non-negative and sum to exactly 100.
   */
  weights?: readonly number[];

  /** Explicit remaining amounts, keyed by invoice ID. */
  remaining?: AmountLookup;

  /**
   * Per-invoice target (total) amounts, keyed by invoice ID. When supplied, the
   * `proportional` strategy weights each invoice by the *fraction* of its
   * target still unfunded instead of by the raw remaining amount.
   */
  targets?: AmountLookup;

  /** Async resolver called once per invoice for its remaining amount. */
  fetchRemaining?: InvoiceRemainingFetcher;

  /** Invoice source used to derive remaining amounts from on-chain data. */
  invoiceSource?: InvoiceSource;
}

/** Fixed-point scale used internally to keep proportional weights integral. */
const WEIGHT_SCALE = 1_000_000n;
/** Fixed-point scale used to express percentages with 2 decimals. */
const PERCENT_SCALE = 10_000n;
/** Allowed floating-point tolerance when validating custom weights. */
const WEIGHT_SUM_TOLERANCE = 1e-6;
/** Guard against pathological weight distributions looping forever. */
const MAX_ALLOCATION_PASSES = 1_024;

/** Default remaining-amount fetcher, set via {@link registerInvoiceRemainingFetcher}. */
let defaultRemainingFetcher: InvoiceRemainingFetcher | null = null;

/**
 * Register a process-wide remaining-amount fetcher.
 *
 * Useful when an application always talks to a single contract: register the
 * fetcher once and call {@link aggregatePayments} without per-call options.
 * Pass `null` to clear the registration.
 *
 * @param fetcher - Fetcher to use as the fallback source, or `null` to clear it.
 */
export function registerInvoiceRemainingFetcher(
  fetcher: InvoiceRemainingFetcher | null,
): void {
  defaultRemainingFetcher = fetcher;
}

/**
 * Compute how much an invoice still needs to be fully funded.
 *
 * The target is the sum of all recipient amounts; negative results (an
 * over-funded invoice) are clamped to `0n`.
 *
 * @param invoice - Invoice to inspect.
 * @returns Remaining amount in stroops, never negative.
 */
export function remainingForInvoice(invoice: Invoice): bigint {
  const target = invoice.recipients.reduce(
    (total, recipient) => total + recipient.amount,
    0n,
  );
  const remaining = target - invoice.funded;

  return remaining > 0n ? remaining : 0n;
}

/**
 * Build an {@link InvoiceRemainingFetcher} from any {@link InvoiceSource}.
 *
 * @param source - Object exposing `getInvoice(id)` (for example a `StellarSplitClient`).
 * @returns A fetcher that derives the remaining amount from the fetched invoice.
 *
 * @example
 * const fetcher = createInvoiceRemainingFetcher(client);
 * const allocations = await aggregatePayments(budget, ids, "equal", { fetchRemaining: fetcher });
 */
export function createInvoiceRemainingFetcher(
  source: InvoiceSource,
): InvoiceRemainingFetcher {
  return async (invoiceId: bigint) =>
    remainingForInvoice(await source.getInvoice(invoiceId.toString()));
}

function assertValidStrategy(strategy: SplitStrategy): void {
  if (strategy !== "equal" && strategy !== "proportional" && strategy !== "custom") {
    throw new ValidationError(
      `Unknown payment allocation strategy "${String(strategy)}". Expected "equal", "proportional" or "custom".`,
      { strategy },
    );
  }
}

function assertNoDuplicates(invoiceIds: readonly bigint[]): void {
  const seen = new Set<string>();

  for (const invoiceId of invoiceIds) {
    const key = invoiceId.toString();

    if (seen.has(key)) {
      throw new ValidationError(
        `Duplicate invoice ID ${key} in aggregatePayments input.`,
        { invoiceId: key },
      );
    }

    seen.add(key);
  }
}

function lookupAmount(source: AmountLookup | undefined, invoiceId: bigint): bigint | undefined {
  if (!source) {
    return undefined;
  }

  if (source instanceof Map) {
    return source.get(invoiceId);
  }

  const raw = (source as Record<string, bigint | number>)[invoiceId.toString()];

  if (raw === undefined) {
    return undefined;
  }

  return typeof raw === "bigint" ? raw : BigInt(Math.trunc(raw));
}

/** Validate `weights` and return them scaled to integers, ready for allocation. */
function resolveCustomWeights(
  weights: readonly number[] | undefined,
  invoiceCount: number,
): bigint[] {
  if (!weights) {
    throw new ValidationError(
      'The "custom" strategy requires a `weights` array with one entry per invoice.',
    );
  }

  if (weights.length !== invoiceCount) {
    throw new ValidationError(
      `Custom weights must contain one entry per invoice (expected ${invoiceCount}, received ${weights.length}).`,
      { expected: invoiceCount, received: weights.length },
    );
  }

  let sum = 0;

  for (const weight of weights) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new ValidationError(
        `Custom weights must be finite, non-negative numbers (received ${String(weight)}).`,
        { weight },
      );
    }

    sum += weight;
  }

  if (Math.abs(sum - 100) > WEIGHT_SUM_TOLERANCE) {
    throw new ValidationError(`Custom weights must sum to 100 (received ${sum}).`, {
      sum,
    });
  }

  // Scale to integers so the allocation math stays exact. `Math.round` preserves
  // the proportional relationship to 6 decimal places.
  return weights.map((weight) => BigInt(Math.round(weight * Number(WEIGHT_SCALE))));
}

async function resolveRemainingAmounts(
  invoiceIds: readonly bigint[],
  options: AggregatePaymentsOptions,
): Promise<bigint[]> {
  const fetcher =
    options.fetchRemaining ??
    (options.invoiceSource
      ? createInvoiceRemainingFetcher(options.invoiceSource)
      : defaultRemainingFetcher);

  const amounts: bigint[] = [];

  for (const invoiceId of invoiceIds) {
    let remaining = lookupAmount(options.remaining, invoiceId);

    if (remaining === undefined && fetcher) {
      remaining = await fetcher(invoiceId);
    }

    if (remaining === undefined) {
      throw new ValidationError(
        "No source of invoice remaining amounts available. Pass `remaining`, `fetchRemaining` or `invoiceSource`, or call registerInvoiceRemainingFetcher().",
        { invoiceId: invoiceId.toString() },
      );
    }

    amounts.push(remaining > 0n ? remaining : 0n);
  }

  return amounts;
}

/** Derive integer weights for the requested strategy. */
function resolveWeights(
  strategy: SplitStrategy,
  remaining: readonly bigint[],
  options: AggregatePaymentsOptions,
  invoiceIds: readonly bigint[],
): bigint[] {
  if (strategy === "equal") {
    return remaining.map(() => 1n);
  }

  if (strategy === "custom") {
    return resolveCustomWeights(options.weights, invoiceIds.length);
  }

  // proportional: the default weight is the raw remaining amount; with targets
  // the weight becomes the fraction of the target still unfunded, i.e. how far
  // the invoice is from its target.
  return remaining.map((amount, index) => {
    const target = lookupAmount(options.targets, invoiceIds[index]!);

    if (target === undefined) {
      return amount;
    }

    if (target <= 0n) {
      return 0n;
    }

    return (amount * WEIGHT_SCALE) / target;
  });
}

/**
 * Water-filling allocator: hand out `pool` stroops across the `remaining`
 * bounds in proportion to `weights`, capping each entry at its remaining amount
 * and redistributing any excess to entries that still have room.
 */
function allocateWithCaps(
  weights: readonly bigint[],
  remaining: readonly bigint[],
  pool: bigint,
): bigint[] {
  const allocations = remaining.map(() => 0n);
  let active = remaining
    .map((amount, index) => (amount > 0n ? index : -1))
    .filter((index) => index >= 0);

  let passes = 0;

  while (pool > 0n && active.length > 0 && passes < MAX_ALLOCATION_PASSES) {
    passes += 1;

    const weightSum = active.reduce((total, index) => total + weights[index]!, 0n);
    const proRata = weightSum > 0n;
    const evenDivisor = BigInt(active.length);
    const leftovers: Array<{ index: number; remainder: bigint }> = [];

    let distributed = 0n;

    for (const index of active) {
      const numerator = proRata ? pool * weights[index]! : pool;
      const divisor = proRata ? weightSum : evenDivisor;
      let share = numerator / divisor;
      const capacity = remaining[index]! - allocations[index]!;

      if (share > capacity) {
        share = capacity;
      }

      if (share > 0n) {
        allocations[index]! += share;
        distributed += share;
      }

      leftovers.push({ index, remainder: numerator % divisor });
    }

    pool -= distributed;
    active = active.filter((index) => allocations[index]! < remaining[index]!);

    if (distributed > 0n || pool === 0n || active.length === 0) {
      continue;
    }

    // Rounding dust: hand out one stroop at a time to the entries with the
    // largest fractional remainder (zero-weight entries are skipped).
    leftovers.sort((a, b) => {
      if (a.remainder === b.remainder) {
        return a.index - b.index;
      }

      return a.remainder < b.remainder ? 1 : -1;
    });

    for (const { index } of leftovers) {
      if (pool === 0n) {
        break;
      }

      if (allocations[index]! >= remaining[index]!) {
        continue;
      }

      if (proRata && weights[index] === 0n) {
        continue;
      }

      allocations[index]! += 1n;
      pool -= 1n;
    }
  }

  return allocations;
}

/**
 * Allocate `budget` stroops across `invoiceIds` using the requested strategy.
 *
 * Behavior:
 * - An empty `invoiceIds` list returns `[]` (no error).
 * - The total allocated never exceeds `budget`, and no single allocation
 *   exceeds that invoice's remaining amount.
 * - When the invoices collectively need less than `budget`, the surplus is left
 *   unallocated and `percentOfBudget` values sum to less than 100.
 * - Invoice IDs must be unique; duplicates throw to avoid double funding.
 *
 * @param budget - Total amount available to spend, in stroops.
 * @param invoiceIds - Invoice IDs to allocate across.
 * @param strategy - `"equal"`, `"proportional"` or `"custom"`.
 * @param options - Remaining-amount sources and, for `"custom"`, the weights.
 * @returns One {@link PaymentAllocation} per input invoice ID, in input order.
 * @throws {ValidationError} On an unknown strategy, a negative budget, duplicate
 *   invoice IDs, invalid custom weights, or a missing remaining-amount source.
 *
 * @example
 * // Split 300 stroops evenly across three invoices that each still need 100.
 * await aggregatePayments(300n, [1n, 2n, 3n], "equal", {
 *   remaining: { "1": 100n, "2": 100n, "3": 100n },
 * });
 * // → [{ invoiceId: 1n, amount: 100n, percentOfBudget: 33.33 }, …]
 */
export async function aggregatePayments(
  budget: bigint,
  invoiceIds: readonly bigint[],
  strategy: SplitStrategy,
  options: AggregatePaymentsOptions = {},
): Promise<PaymentAllocation[]> {
  assertValidStrategy(strategy);

  if (budget < 0n) {
    throw new ValidationError("aggregatePayments budget must not be negative", {
      budget: budget.toString(),
    });
  }

  if (invoiceIds.length === 0) {
    return [];
  }

  assertNoDuplicates(invoiceIds);

  if (strategy === "custom") {
    // Validate weights even when there is nothing to distribute so callers get
    // immediate feedback on a malformed configuration.
    resolveCustomWeights(options.weights, invoiceIds.length);
  }

  const remaining = await resolveRemainingAmounts(invoiceIds, options);
  const totalRemaining = remaining.reduce((total, amount) => total + amount, 0n);
  const distributable = budget < totalRemaining ? budget : totalRemaining;

  if (distributable === 0n) {
    return invoiceIds.map((invoiceId) => ({ invoiceId, amount: 0n, percentOfBudget: 0 }));
  }

  const weights = resolveWeights(strategy, remaining, options, invoiceIds);
  const allocations = allocateWithCaps(weights, remaining, distributable);

  return invoiceIds.map((invoiceId, index) => {
    const amount = allocations[index]!;

    return {
      invoiceId,
      amount,
      percentOfBudget: Number((amount * PERCENT_SCALE) / budget) / 100,
    };
  });
}


