/**
 * Payment channel reconciler.
 *
 * Compares a payer's local channel_pay history against on-chain channel state
 * (balance / deposited) to catch drift before closing a channel.
 *
 * This is a read-only helper — it never submits any on-chain transaction.
 */
import { ChannelReconciliationError } from "./errors.js";

/** On-chain state for a single payment channel. */
export interface ChannelState {
  /** Total amount deposited into the channel (stroops). */
  deposited: bigint;
  /** Current remaining balance in the channel (stroops). */
  balance: bigint;
}

/** Result of a channel reconciliation check. */
export interface ChannelReconciliationResult {
  /** True when on-chain balance matches what local history predicts. */
  inSync: boolean;
  /** The balance currently held on-chain (stroops). */
  onChainBalance: bigint;
  /** The balance the local payment history predicts (deposited − Σ localPayments). */
  expectedBalance: bigint;
  /** Signed difference: onChainBalance − expectedBalance (0 when in sync). */
  delta: bigint;
}

/**
 * Fetcher type: called by reconcileChannel to retrieve live channel state.
 * Implement this to read the on-chain open_channel / channel_pay / close_channel
 * state for a given (invoiceId, payer) pair via your RPC/contract layer.
 */
export type ChannelStateFetcher = (
  invoiceId: string,
  payer: string
) => Promise<ChannelState>;

/** A single local channel_pay entry used as matching input. */
export interface LocalPayment {
  /** Amount paid (stroops). */
  amount: bigint;
  /** Optional payer address the payment was attributed to. */
  payer?: string;
  /** Optional invoice the payment was attributed to. */
  invoiceId?: string;
}

/** A single on-chain channel_pay entry used as matching input. */
export interface OnChainPayment {
  /** Amount paid (stroops). */
  amount: bigint;
  /** Optional payer address the payment was attributed to. */
  payer?: string;
  /** Optional invoice the payment was attributed to. */
  invoiceId?: string;
}

/** A matched pair of local and on-chain payments. */
export interface InvoiceMatch {
  /** The local payment that was matched. */
  local: LocalPayment;
  /** The on-chain payment it was matched against. */
  onChain: OnChainPayment;
}

/** Result of matching local payments against on-chain payments. */
export interface InvoiceMatchingResult {
  /** Pairs of local/on-chain payments that matched. */
  matches: InvoiceMatch[];
  /** Local payments with no on-chain counterpart. */
  unmatchedLocal: LocalPayment[];
  /** On-chain payments with no local counterpart. */
  unmatchedOnChain: OnChainPayment[];
  /** True when every local payment matched and no on-chain payment is left over. */
  balanced: boolean;
}

/** Events emitted by the invoice matching engine. */
export type InvoiceMatchingEvent =
  | { type: "match"; match: InvoiceMatch }
  | { type: "unmatchedLocal"; payment: LocalPayment }
  | { type: "unmatchedOnChain"; payment: OnChainPayment }
  | { type: "complete"; result: InvoiceMatchingResult };

/** Listener invoked for every invoice matching event. */
export type InvoiceMatchingListener = (event: InvoiceMatchingEvent) => void;

let _fetcher: ChannelStateFetcher | null = null;

/** Register (or clear) the function that reads on-chain channel state. */
export function registerChannelStateFetcher(fetcher: ChannelStateFetcher | null): void {
  _fetcher = fetcher;
}

/**
 * Reconcile a payer's local channel_pay history against the on-chain channel
 * state for a given invoice.
 *
 * @param invoiceId     - The invoice the channel is associated with.
 * @param payer         - Stellar G… address of the channel payer.
 * @param localPayments - Amounts (stroops) from every local channel_pay call,
 *                        in any order.
 * @param fetcher       - Optional one-off fetcher; falls back to the registered
 *                        fetcher if omitted.
 *
 * @returns Reconciliation result — no on-chain writes are performed.
 */
export async function reconcileChannel(
  invoiceId: string,
  payer: string,
  localPayments: bigint[],
  fetcher?: ChannelStateFetcher
): Promise<ChannelReconciliationResult> {
  const resolveFetcher = fetcher ?? _fetcher;
  if (!resolveFetcher) {
    throw new ChannelReconciliationError(
      "No channel state fetcher registered. Call registerChannelStateFetcher() first."
    );
  }

  const { deposited, balance: onChainBalance } = await resolveFetcher(invoiceId, payer);

  const totalPaid = localPayments.reduce((sum, amt) => sum + amt, 0n);
  const expectedBalance = deposited - totalPaid;
  const delta = onChainBalance - expectedBalance;

  return {
    inSync: delta === 0n,
    onChainBalance,
    expectedBalance,
    delta,
  };
}

/**
 * Match local channel_pay entries against on-chain channel_pay entries.
 *
 * Matching is greedy and amount-based: each local payment is paired with the
 * first still-unmatched on-chain payment of the same amount. When both sides
 * carry a payer and/or invoiceId, those must agree as well. Leftovers on either
 * side are reported as unmatched.
 *
 * @param localPayments   - Local channel_pay entries to match.
 * @param onChainPayments - On-chain channel_pay entries to match against.
 * @param listener        - Optional listener receiving match/unmatch/complete events.
 *
 * @returns Matching result — no on-chain writes are performed.
 */
export function matchInvoices(
  localPayments: LocalPayment[],
  onChainPayments: OnChainPayment[],
  listener?: InvoiceMatchingListener
): InvoiceMatchingResult {
  const remaining = onChainPayments.slice();
  const matches: InvoiceMatch[] = [];
  const unmatchedLocal: LocalPayment[] = [];

  for (const local of localPayments) {
    const index = remaining.findIndex((onChain) => {
      if (onChain.amount !== local.amount) return false;
      if (local.payer !== undefined && onChain.payer !== undefined && onChain.payer !== local.payer) {
        return false;
      }
      if (
        local.invoiceId !== undefined &&
        onChain.invoiceId !== undefined &&
        onChain.invoiceId !== local.invoiceId
      ) {
        return false;
      }
      return true;
    });

    if (index === -1) {
      unmatchedLocal.push(local);
      listener?.({ type: "unmatchedLocal", payment: local });
      continue;
    }

    const [onChain] = remaining.splice(index, 1);
    const match: InvoiceMatch = { local, onChain };
    matches.push(match);
    listener?.({ type: "match", match });
  }

  for (const onChain of remaining) {
    listener?.({ type: "unmatchedOnChain", payment: onChain });
  }

  const result: InvoiceMatchingResult = {
    matches,
    unmatchedLocal,
    unmatchedOnChain: remaining,
    balanced: unmatchedLocal.length === 0 && remaining.length === 0,
  };

  listener?.({ type: "complete", result });
  return result;
}