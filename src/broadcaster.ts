import { Invoice } from "./types.js";

/**
 * Handler function for invoice state updates.
 */
type InvoiceHandler = (invoiceId: string, invoice: Invoice) => void;

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
 * Lifecycle phase of a simulated transaction rollback.
 */
export type RollbackPhase = "start" | "success" | "failure";

/**
 * Event emitted during a transaction rollback simulation.
 */
export interface RollbackEvent {
  /** The transaction identifier being rolled back. */
  transactionId: string;
  /** The lifecycle phase this event represents. */
  phase: RollbackPhase;
  /** Optional error when the rollback fails. */
  error?: Error;
}

/**
 * Handler invoked for each rollback lifecycle event.
 */
export type RollbackEventHandler = (event: RollbackEvent) => void;

/**
 * Simulates SDK transaction rollbacks, emitting lifecycle events for the
 * start, success, and failure phases of each rollback.
 */
export class TransactionRollbackSimulator {
  private handlers: Set<RollbackEventHandler> = new Set();

  /**
   * Register a handler for rollback lifecycle events.
   *
   * @param handler - The handler to invoke on each event
   * @returns Unsubscribe function that removes only this handler
   */
  onRollback(handler: RollbackEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Simulate rolling back a transaction. Emits a "start" event, then either a
   * "success" event or a "failure" event depending on the outcome.
   *
   * @param transactionId - The transaction identifier to roll back
   * @param shouldFail - When true, the rollback fails and emits a failure event
   * @returns True when the rollback succeeded, false otherwise
   */
  simulateRollback(transactionId: string, shouldFail = false): boolean {
    this.emit({ transactionId, phase: "start" });

    if (shouldFail) {
      const error = new Error(`Rollback failed for transaction ${transactionId}`);
      this.emit({ transactionId, phase: "failure", error });
      return false;
    }

    this.emit({ transactionId, phase: "success" });
    return true;
  }

  private emit(event: RollbackEvent): void {
    this.handlers.forEach((handler) => {
      try {
        handler(event);
      } catch (error) {
        console.error(`Error in rollback handler for ${event.transactionId}:`, error);
      }
    });
  }
}

/**
 * Creates a new TransactionRollbackSimulator instance.
 *
 * @returns A new TransactionRollbackSimulator instance
 */
export function createTransactionRollbackSimulator(): TransactionRollbackSimulator {
  return new TransactionRollbackSimulator();
}
