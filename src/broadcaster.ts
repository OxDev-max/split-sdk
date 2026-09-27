import { Invoice } from "./types.js";

/**
 * Handler function for invoice state updates.
 */
type InvoiceHandler = (invoiceId: string, invoice: Invoice) => void;

/**
 * Event types emitted by the invoice notification subscription manager.
 */
export type InvoiceNotificationEvent =
  | { type: "subscribed"; invoiceId: string }
  | { type: "unsubscribed"; invoiceId: string }
  | { type: "notified"; invoiceId: string; invoice: Invoice };

/**
 * Handler function for invoice notification events.
 */
type NotificationEventHandler = (event: InvoiceNotificationEvent) => void;

/**
 * Invoice state broadcaster that publishes state changes to multiple subscribers.
 */
export class InvoiceStateBroadcaster {
  private subscribers: Map<string, Set<InvoiceHandler>> = new Map();

  /**
   * Subscribe to invoice state updates for a specific invoice ID.
   * 
   * @param invoiceId - The invoice ID to subscribe to
   * @param handler - The handler function to call when updates are received
   * @returns Unsubscribe function that removes only this subscriber
   */
  subscribe(invoiceId: string, handler: InvoiceHandler): () => void {
    if (!this.subscribers.has(invoiceId)) {
      this.subscribers.set(invoiceId, new Set());
    }
    
    const handlers = this.subscribers.get(invoiceId)!;
    handlers.add(handler);
    
    return () => {
      handlers.delete(handler);
      // Clean up empty sets
      if (handlers.size === 0) {
        this.subscribers.delete(invoiceId);
      }
    };
  }

  /**
   * Broadcast an invoice state update to all subscribers of the given invoice ID.
   * 
   * @param invoiceId - The invoice ID to broadcast to
   * @param invoice - The updated invoice state
   */
  broadcast(invoiceId: string, invoice: Invoice): void {
    const handlers = this.subscribers.get(invoiceId);
    if (!handlers || handlers.size === 0) {
      return; // No subscribers for this invoice ID
    }
    
    // Call all handlers with the updated invoice
    handlers.forEach((handler) => {
      try {
        handler(invoiceId, invoice);
      } catch (error) {
        console.error(`Error in invoice handler for ${invoiceId}:`, error);
      }
    });
  }

  /**
   * Get the number of subscribers for a given invoice ID.
   * 
   * @param invoiceId - The invoice ID to check
   * @returns Number of subscribers
   */
  getSubscriberCount(invoiceId: string): number {
    return this.subscribers.get(invoiceId)?.size ?? 0;
  }
}

/**
 * Creates a new InvoiceStateBroadcaster instance.
 * 
 * @returns A new InvoiceStateBroadcaster instance
 */
export function createInvoiceStateBroadcaster(): InvoiceStateBroadcaster {
  return new InvoiceStateBroadcaster();
}

/**
 * Manages invoice notification subscriptions on top of an
 * {@link InvoiceStateBroadcaster}, emitting lifecycle events for
 * subscribe, unsubscribe, and notify operations.
 */
export class InvoiceNotificationSubscriptionManager {
  private readonly broadcaster: InvoiceStateBroadcaster;
  private readonly eventHandlers: Set<NotificationEventHandler> = new Set();
  private readonly unsubscribers: Map<string, Map<InvoiceHandler, () => void>> =
    new Map();

  constructor(broadcaster: InvoiceStateBroadcaster = createInvoiceStateBroadcaster()) {
    this.broadcaster = broadcaster;
  }

  /**
   * Register a handler for notification lifecycle events.
   *
   * @param handler - The event handler to register
   * @returns Unsubscribe function that removes only this handler
   */
  onEvent(handler: NotificationEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to invoice notifications for a specific invoice ID.
   *
   * @param invoiceId - The invoice ID to subscribe to
   * @param handler - The handler function to call when notifications are received
   * @returns Unsubscribe function that removes only this subscriber
   */
  subscribe(invoiceId: string, handler: InvoiceHandler): () => void {
    const unsubscribe = this.broadcaster.subscribe(invoiceId, handler);

    if (!this.unsubscribers.has(invoiceId)) {
      this.unsubscribers.set(invoiceId, new Map());
    }
    this.unsubscribers.get(invoiceId)!.set(handler, unsubscribe);

    this.emit({ type: "subscribed", invoiceId });

    return () => {
      const handlers = this.unsubscribers.get(invoiceId);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.unsubscribers.delete(invoiceId);
        }
      }
      unsubscribe();
      this.emit({ type: "unsubscribed", invoiceId });
    };
  }

  /**
   * Notify all subscribers of an invoice state update.
   *
   * @param invoiceId - The invoice ID to notify
   * @param invoice - The updated invoice state
   */
  notify(invoiceId: string, invoice: Invoice): void {
    this.broadcaster.broadcast(invoiceId, invoice);
    this.emit({ type: "notified", invoiceId, invoice });
  }

  /**
   * Get the number of subscribers for a given invoice ID.
   *
   * @param invoiceId - The invoice ID to check
   * @returns Number of subscribers
   */
  getSubscriberCount(invoiceId: string): number {
    return this.broadcaster.getSubscriberCount(invoiceId);
  }

  /**
   * Remove all subscriptions and event handlers.
   */
  clear(): void {
    this.unsubscribers.forEach((handlers) => {
      handlers.forEach((unsubscribe) => unsubscribe());
    });
    this.unsubscribers.clear();
    this.eventHandlers.clear();
  }

  private emit(event: InvoiceNotificationEvent): void {
    this.eventHandlers.forEach((handler) => {
      try {
        handler(event);
      } catch (error) {
        console.error("Error in invoice notification event handler:", error);
      }
    });
  }
}

/**
 * Creates a new InvoiceNotificationSubscriptionManager instance.
 *
 * @param broadcaster - Optional broadcaster to use for state updates
 * @returns A new InvoiceNotificationSubscriptionManager instance
 */
export function createInvoiceNotificationSubscriptionManager(
  broadcaster?: InvoiceStateBroadcaster
): InvoiceNotificationSubscriptionManager {
  return new InvoiceNotificationSubscriptionManager(broadcaster);
}
