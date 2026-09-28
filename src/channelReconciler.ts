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

/** Lifecycle events emitted during invoice reconciliation. */
export type ReconciliationEvent =
  | { type: "reconciliation:started"; invoiceId: string; payer: string }
  | { type: "reconciliation:matched"; invoiceId: string; payer: string; result: ChannelReconciliationResult }
  | { type: "reconciliation:discrepancy"; invoiceId: string; payer: string; result: ChannelReconciliationResult }
  | { type: "reconciliation:completed"; invoiceId: string; payer: string; result: ChannelReconciliationResult }
  | { type: "reconciliation:error"; invoiceId: string; payer: string; error: unknown };

/** Listener invoked for every reconciliation lifecycle event. */
export type ReconciliationEventListener = (event: ReconciliationEvent) => void;

const _listeners = new Set<ReconciliationEventListener>();

/**
 * Subscribe to reconciliation lifecycle events.
 *
 * @returns An unsubscribe function that removes the listener.
 */
export function onReconciliationEvent(listener: ReconciliationEventListener): () => void {
  _listeners.add(listener);
  return () => {
    _listeners.delete(listener);
  };
}

function emit(event: ReconciliationEvent): void {
  for (const listener of _listeners) {
    listener(event);
  }
}

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
  emit({ type: "reconciliation:started", invoiceId, payer });

  try {
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

    const result: ChannelReconciliationResult = {
      inSync: delta === 0n,
      onChainBalance,
      expectedBalance,
      delta,
    };

    if (result.inSync) {
      emit({ type: "reconciliation:matched", invoiceId, payer, result });
    } else {
      emit({ type: "reconciliation:discrepancy", invoiceId, payer, result });
    }

    emit({ type: "reconciliation:completed", invoiceId, payer, result });
    return result;
  } catch (error) {
    emit({ type: "reconciliation:error", invoiceId, payer, error });
    throw error;
  }
}