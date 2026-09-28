/**
 * Recurring subscription types for invoice subscriptions.
 */

import type { CreateInvoiceParams } from "./index.js";

export type SubscriptionStatus = "active" | "paused" | "cancelled";

export interface Subscription {
  id: bigint;
  params: CreateInvoiceParams;
  intervalSeconds: number;
  lastTriggeredAt?: number;
  nextDueAt: number;
  status: SubscriptionStatus;
  creator: string;
  createdAt: number;
}

export interface CreateSubscriptionParams {
  params: CreateInvoiceParams;
  intervalSeconds: number;
}

export interface TooEarlyToTriggerError {
  name: "TooEarlyToTriggerError";
  message: string;
  subscriptionId: bigint;
  nextDueAt: number;
}
