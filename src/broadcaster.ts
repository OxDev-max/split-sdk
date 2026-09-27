import { Invoice } from "./types.js";

/**
 * Handler function for invoice state updates.
 */
type InvoiceHandler = (invoiceId: string, invoice: Invoice) => void;

/**
 * A single historical fee observation used to inform fee estimates.
 */
export interface FeeHistoryEntry {
  /** Fee rate observed, in the smallest fee unit (e.g. sat/vB). */
  feeRate: number;
  /** Timestamp (ms since epoch) when the observation was recorded. */
  timestamp: number;
}

/**
 * Result of an SDK fee estimation, including the historical analysis used.
 */
export interface FeeEstimate {
  /** Estimated fee rate, in the smallest fee unit (e.g. sat/vB). */
  feeRate: number;
  /** Minimum fee rate observed in the analyzed history. */
  minFeeRate: number;
  /** Maximum fee rate observed in the analyzed history. */
  maxFeeRate: number;
  /** Average fee rate across the analyzed history. */
  averageFeeRate: number;
  /** Number of historical samples that informed the estimate. */
  sampleCount: number;
}

/**
 * Event names emitted during the fee estimation lifecycle.
 */
export type FeeEstimationEvent = "estimate" | "error";

/**
 * Handler invoked when a fee estimation event is emitted.
 */
type FeeEstimationHandler = (event: FeeEstimationEvent, payload: FeeEstimate | Error) => void;

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
 * Estimates SDK fees using historical fee observations.
 *
 * The estimate is derived from the provided history: the most recent
 * observation is weighted against the historical average so that recent
 * network conditions inform the result without discarding past data.
 * Emits lifecycle events so callers can react to estimates and errors.
 */
export class FeeEstimator {
  private history: FeeHistoryEntry[] = [];
  private handlers: Set<FeeEstimationHandler> = new Set();

  /**
   * Subscribe to fee estimation lifecycle events.
   *
   * @param handler - Handler invoked on "estimate" and "error" events
   * @returns Unsubscribe function that removes only this handler
   */
  on(handler: FeeEstimationHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Record a historical fee observation.
   *
   * @param entry - The fee history entry to record
   */
  record(entry: FeeHistoryEntry): void {
    this.history.push(entry);
  }

  /**
   * Get a copy of the recorded fee history.
   *
   * @returns The recorded fee history entries
   */
  getHistory(): FeeHistoryEntry[] {
    return [...this.history];
  }

  /**
   * Estimate the current fee rate using historical analysis.
   *
   * @param windowSize - Optional number of most recent samples to analyze
   * @returns The fee estimate, or null when no history is available
   */
  estimate(windowSize?: number): FeeEstimate | null {
    try {
      const samples =
        windowSize && windowSize > 0
          ? this.history.slice(-windowSize)
          : this.history;

      if (samples.length === 0) {
        return null;
      }

      const rates = samples.map((entry) => entry.feeRate);
      const minFeeRate = Math.min(...rates);
      const maxFeeRate = Math.max(...rates);
      const averageFeeRate =
        rates.reduce((sum, rate) => sum + rate, 0) / rates.length;

      // Weight the most recent observation against the historical average.
      const latest = samples[samples.length - 1].feeRate;
      const feeRate = Math.round((latest + averageFeeRate) / 2);

      const estimate: FeeEstimate = {
        feeRate,
        minFeeRate,
        maxFeeRate,
        averageFeeRate,
        sampleCount: samples.length,
      };

      this.emit("estimate", estimate);
      return estimate;
    } catch (error) {
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }

  private emit(event: FeeEstimationEvent, payload: FeeEstimate | Error): void {
    this.handlers.forEach((handler) => {
      try {
        handler(event, payload);
      } catch (error) {
        console.error(`Error in fee estimation handler for ${event}:`, error);
      }
    });
  }
}

/**
 * Creates a new FeeEstimator instance.
 *
 * @returns A new FeeEstimator instance
 */
export function createFeeEstimator(): FeeEstimator {
  return new FeeEstimator();
}
