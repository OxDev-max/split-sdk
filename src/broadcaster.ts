import { Invoice } from "./types.js";

/**
 * Handler function for invoice state updates.
 */
type InvoiceHandler = (invoiceId: string, invoice: Invoice) => void;

/**
 * Event emitted when a broadcast is accepted or rejected by deduplication.
 */
export type DeduplicationEvent =
  | { type: "accepted"; invoiceId: string; nonce: string }
  | { type: "duplicate"; invoiceId: string; nonce: string };

/**
 * Handler function for deduplication events.
 */
export type DeduplicationEventHandler = (event: DeduplicationEvent) => void;

/**
 * Options for optional request deduplication by nonce.
 */
export interface DeduplicationOptions {
  /**
   * Whether deduplication is enabled. Defaults to false so existing behavior
   * is unchanged unless explicitly opted in.
   */
  enabled?: boolean;
  /**
   * Time-to-live in milliseconds for a seen nonce. Defaults to 60000.
   */
  ttlMs?: number;
  /**
   * Maximum number of nonces to retain. Oldest entries are evicted first.
   * Defaults to 1000.
   */
  maxEntries?: number;
}

/**
 * Invoice state broadcaster that publishes state changes to multiple subscribers.
 */
export class InvoiceStateBroadcaster {
  private subscribers: Map<string, Set<InvoiceHandler>> = new Map();
  private dedupEnabled: boolean;
  private dedupTtlMs: number;
  private dedupMaxEntries: number;
  private seenNonces: Map<string, number> = new Map();
  private dedupHandlers: Set<DeduplicationEventHandler> = new Set();

  constructor(options: DeduplicationOptions = {}) {
    this.dedupEnabled = options.enabled ?? false;
    this.dedupTtlMs = options.ttlMs ?? 60000;
    this.dedupMaxEntries = options.maxEntries ?? 1000;
  }

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
   * Subscribe to deduplication events (accepted / duplicate).
   *
   * @param handler - The handler function to call for each dedup event
   * @returns Unsubscribe function that removes only this handler
   */
  onDeduplication(handler: DeduplicationEventHandler): () => void {
    this.dedupHandlers.add(handler);
    return () => {
      this.dedupHandlers.delete(handler);
    };
  }

  /**
   * Broadcast an invoice state update to all subscribers of the given invoice ID.
   * 
   * When deduplication is enabled and a nonce is provided, duplicate nonces are
   * rejected and no subscribers are notified.
   * 
   * @param invoiceId - The invoice ID to broadcast to
   * @param invoice - The updated invoice state
   * @param nonce - Optional nonce used for request deduplication
   * @returns True if the broadcast was delivered, false if rejected as duplicate
   */
  broadcast(invoiceId: string, invoice: Invoice, nonce?: string): boolean {
    if (this.dedupEnabled && nonce !== undefined) {
      if (this.isDuplicate(nonce)) {
        this.emitDeduplication({ type: "duplicate", invoiceId, nonce });
        return false;
      }
      this.recordNonce(nonce);
      this.emitDeduplication({ type: "accepted", invoiceId, nonce });
    }

    const handlers = this.subscribers.get(invoiceId);
    if (!handlers || handlers.size === 0) {
      return true; // No subscribers for this invoice ID
    }
    
    // Call all handlers with the updated invoice
    handlers.forEach((handler) => {
      try {
        handler(invoiceId, invoice);
      } catch (error) {
        console.error(`Error in invoice handler for ${invoiceId}:`, error);
      }
    });

    return true;
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

  /**
   * Check whether a nonce has already been seen and is still within its TTL.
   */
  private isDuplicate(nonce: string): boolean {
    const seenAt = this.seenNonces.get(nonce);
    if (seenAt === undefined) {
      return false;
    }
    if (Date.now() - seenAt >= this.dedupTtlMs) {
      this.seenNonces.delete(nonce);
      return false;
    }
    return true;
  }

  /**
   * Record a nonce as seen, evicting expired and oldest entries as needed.
   */
  private recordNonce(nonce: string): void {
    const now = Date.now();
    for (const [key, seenAt] of this.seenNonces) {
      if (now - seenAt >= this.dedupTtlMs) {
        this.seenNonces.delete(key);
      }
    }
    this.seenNonces.set(nonce, now);
    while (this.seenNonces.size > this.dedupMaxEntries) {
      const oldest = this.seenNonces.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.seenNonces.delete(oldest);
    }
  }

  /**
   * Emit a deduplication event to all registered handlers.
   */
  private emitDeduplication(event: DeduplicationEvent): void {
    this.dedupHandlers.forEach((handler) => {
      try {
        handler(event);
      } catch (error) {
        console.error("Error in deduplication handler:", error);
      }
    });
  }
}

/**
 * Creates a new InvoiceStateBroadcaster instance.
 * 
 * @param options - Optional deduplication configuration
 * @returns A new InvoiceStateBroadcaster instance
 */
export function createInvoiceStateBroadcaster(
  options: DeduplicationOptions = {},
): InvoiceStateBroadcaster {
  return new InvoiceStateBroadcaster(options);
}
