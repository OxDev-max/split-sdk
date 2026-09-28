/**
 * Recurring invoice subscription management.
 */

import type { Subscription, CreateSubscriptionParams, SubscriptionStatus } from "./types/subscriptions.js";
import { StellarSplitError } from "./errors.js";

export class SubscriptionNotFoundError extends StellarSplitError {
  readonly subscriptionId: bigint;

  constructor(subscriptionId: bigint) {
    super(
      `Subscription not found: ${subscriptionId}`,
      "SUBSCRIPTION_NOT_FOUND",
      { subscriptionId }
    );
    this.name = "SubscriptionNotFoundError";
    this.subscriptionId = subscriptionId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class TooEarlyToTriggerError extends StellarSplitError {
  readonly subscriptionId: bigint;
  readonly nextDueAt: number;

  constructor(subscriptionId: bigint, nextDueAt: number) {
    super(
      `Too early to trigger subscription: ${subscriptionId}. Next due at ${new Date(nextDueAt).toISOString()}`,
      "TOO_EARLY_TO_TRIGGER",
      { subscriptionId, nextDueAt }
    );
    this.name = "TooEarlyToTriggerError";
    this.subscriptionId = subscriptionId;
    this.nextDueAt = nextDueAt;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const subscriptions = new Map<bigint, Subscription>();
let nextSubscriptionId = BigInt(1);

export async function createSubscription(
  params: CreateSubscriptionParams,
  creator: string
): Promise<bigint> {
  const subscriptionId = nextSubscriptionId++;
  const now = Date.now();

  const subscription: Subscription = {
    id: subscriptionId,
    params: params.params,
    intervalSeconds: params.intervalSeconds,
    nextDueAt: now + params.intervalSeconds * 1000,
    status: "active",
    creator,
    createdAt: now,
  };

  subscriptions.set(subscriptionId, subscription);
  return subscriptionId;
}

export async function triggerSubscription(subscriptionId: bigint): Promise<bigint> {
  const subscription = subscriptions.get(subscriptionId);
  if (!subscription) {
    throw new SubscriptionNotFoundError(subscriptionId);
  }

  const now = Date.now();
  if (now < subscription.nextDueAt) {
    throw new TooEarlyToTriggerError(subscriptionId, subscription.nextDueAt);
  }

  if (subscription.status === "paused") {
    throw new Error(`Cannot trigger paused subscription: ${subscriptionId}`);
  }

  // Update last triggered and next due
  subscription.lastTriggeredAt = now;
  subscription.nextDueAt = now + subscription.intervalSeconds * 1000;

  // In a real implementation, this would invoke the contract to create a new invoice
  // and return the invoice ID
  const invoiceId = BigInt(Date.now());
  return invoiceId;
}

export async function pauseSubscription(subscriptionId: bigint): Promise<void> {
  const subscription = subscriptions.get(subscriptionId);
  if (!subscription) {
    throw new SubscriptionNotFoundError(subscriptionId);
  }

  subscription.status = "paused";
}

export async function resumeSubscription(subscriptionId: bigint): Promise<void> {
  const subscription = subscriptions.get(subscriptionId);
  if (!subscription) {
    throw new SubscriptionNotFoundError(subscriptionId);
  }

  subscription.status = "active";
  // Reset next due to now + interval to give users time after resuming
  subscription.nextDueAt = Date.now() + subscription.intervalSeconds * 1000;
}

export async function getSubscription(subscriptionId: bigint): Promise<Subscription> {
  const subscription = subscriptions.get(subscriptionId);
  if (!subscription) {
    throw new SubscriptionNotFoundError(subscriptionId);
  }
  return subscription;
}

export async function cancelSubscription(subscriptionId: bigint): Promise<void> {
  const subscription = subscriptions.get(subscriptionId);
  if (!subscription) {
    throw new SubscriptionNotFoundError(subscriptionId);
  }

  subscription.status = "cancelled";
}
