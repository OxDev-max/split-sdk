/**
 * Typed contract events for the StellarSplit SDK event bus.
 *
 * These events represent state changes on invoices and split rules,
 * emitted by the contract and subscribed to by SDK consumers.
 */

/** Contract event emitted when an invoice is paid. */
export interface PaymentEvent {
  invoiceId: bigint;
  amount: bigint;
  payer: string;
  timestamp: number;
}

/** Contract event emitted when funds are released from an invoice. */
export interface ReleaseEvent {
  invoiceId: bigint;
  amount: bigint;
  recipient: string;
  timestamp: number;
}

/** Contract event emitted when an invoice is refunded. */
export interface RefundEvent {
  invoiceId: bigint;
  amount: bigint;
  payer: string;
  timestamp: number;
}

/** Contract event emitted when a dispute is opened. */
export interface DisputeEvent {
  invoiceId: bigint;
  reason: string;
  opener: string;
  timestamp: number;
}

/** Contract event emitted when a tier is unlocked. */
export interface TierUnlockedEvent {
  invoiceId: bigint;
  tierId: number;
  unlockedAt: number;
  timestamp: number;
}

/** Filters for subscription to contract events. */
export interface EventFilterOptions {
  invoiceId?: bigint;
}

/** All contract event types. */
export type ContractEvent =
  | PaymentEvent
  | ReleaseEvent
  | RefundEvent
  | DisputeEvent
  | TierUnlockedEvent;
