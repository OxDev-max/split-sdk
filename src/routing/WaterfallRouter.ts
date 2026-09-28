/**
 * WaterfallRouter — sequences a multi-tier invoice payout (e.g. platform
 * fee, then tax withholding, then beneficiary) so lower-priority recipients
 * are only paid once every upstream tier's minimum has been met.
 *
 * Issue #777 — tiers may declare an optional `score`; tiers are sorted by
 * score descending (stable, so declaration order breaks ties) before the
 * waterfall executes, letting callers express latency/fee/reliability
 * preferences without reordering their config.
 */

import type { Invoice } from "../types.js";
import { ValidationError } from "../errors.js";
import type { WaterfallConfig, WaterfallPlan, WaterfallStep, WaterfallTier } from "../types/routing.js";

/**
 * Sort tiers by `score` descending, preserving declaration order for ties.
 *
 * The original index is used as an explicit tiebreaker so the ordering is
 * stable regardless of the engine's `Array.prototype.sort` implementation.
 * Tiers without a `score` are treated as `0`, which means an entirely unscored
 * config keeps its declared order.
 */
function sortTiersByScore(tiers: readonly WaterfallTier[]): WaterfallTier[] {
  return tiers
    .map((tier, index) => ({ tier, index }))
    .sort((a, b) => (b.tier.score ?? 0) - (a.tier.score ?? 0) || a.index - b.index)
    .map(({ tier }) => tier);
}

export class WaterfallRouter {
  /**
   * Build a sequenced payment plan for `invoice` given `availableAmount`
   * (stroops) to distribute across `config.tiers`, ordered by `score`
   * descending and then by declared priority. As soon as a tier's
   * minimumAmount exceeds what's left of availableAmount, that tier and every
   * tier after it come back with `satisfied: false` and a zero amount.
   */
  plan(invoice: Invoice, availableAmount: bigint, config: WaterfallConfig): WaterfallPlan {
    if (availableAmount < 0n) {
      throw new ValidationError("availableAmount must be >= 0", { availableAmount: availableAmount.toString() });
    }
    for (const tier of config.tiers) {
      if (tier.minimumAmount < 0n) {
        throw new ValidationError("WaterfallTier.minimumAmount must be >= 0", {
          recipient: tier.recipient,
          minimumAmount: tier.minimumAmount.toString(),
        });
      }
    }

    // Issue #777 — try the best-scoring routes first; ties stay FIFO.
    const tiers = sortTiersByScore(config.tiers);

    let remaining = availableAmount;
    let blocked = false;
    const steps: WaterfallStep[] = [];

    for (const tier of tiers) {
      const asset = tier.asset ?? invoice.token;

      if (blocked || tier.minimumAmount > remaining) {
        blocked = true;
        steps.push({
          recipient: tier.recipient,
          amount: 0n,
          asset,
          minimumAmount: tier.minimumAmount,
          satisfied: false,
        });
        continue;
      }

      remaining -= tier.minimumAmount;
      steps.push({
        recipient: tier.recipient,
        amount: tier.minimumAmount,
        asset,
        minimumAmount: tier.minimumAmount,
        satisfied: true,
      });
    }

    const totalAllocated = steps.reduce((sum, s) => sum + s.amount, 0n);
    return {
      steps,
      fullySatisfied: steps.every((s) => s.satisfied),
      totalAllocated,
      remaining,
      allowPartial: config.allowPartial,
    };
  }
}
