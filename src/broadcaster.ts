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
 * A candidate payment pathway with its associated cost and reliability.
 */
export interface PaymentPathway {
  /** Identifier of the pathway (e.g. channel or route id). */
  id: string;
  /** Estimated fee rate for routing through this pathway, in sat/vB. */
  feeRate: number;
  /** Estimated probability (0..1) that the payment succeeds via this pathway. */
  successProbability: number;
  /** Optional available liquidity along the pathway, in the smallest unit. */
  liquidity?: number;
}

/**
 * A scored payment pathway produced by the optimizer.
 */
export interface ScoredPaymentPathway extends PaymentPathway {
  /** Composite score; higher is better. */
  score: number;
}

/**
 * Result of a payment pathway optimization run.
 */
export interface PaymentPathwayOptimization {
  /** Pathways ordered from best to worst by score. */
  pathways: ScoredPaymentPathway[];
  /** The recommended pathway, or null when no candidates were provided. */
  recommended: ScoredPaymentPathway | null;
  /** Number of candidate pathways that were evaluated. */
  evaluatedCount: number;
}

/**
 * Event names emitted during the payment pathway optimization lifecycle.
 */
export type PaymentPathwayEvent = "optimized" | "error";

/**
 * Handler invoked when a payment pathway optimization event is emitted.
 */
type PaymentPathwayHandler = (
  event: PaymentPathwayEvent,
  payload: PaymentPathwayOptimization | Error,
) => void;

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

/**
 * Optimizes payment pathways by scoring candidates on cost and reliability.
 *
 * Each candidate is scored so that cheaper fees and higher success
 * probabilities rank higher. The optimizer emits lifecycle events so callers
 * can react to optimization results and errors.
 */
export class PaymentPathwayOptimizer {
  private handlers: Set<PaymentPathwayHandler> = new Set();

  /**
   * Subscribe to payment pathway optimization lifecycle events.
   *
   * @param handler - Handler invoked on "optimized" and "error" events
   * @returns Unsubscribe function that removes only this handler
   */
  on(handler: PaymentPathwayHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Score a single payment pathway.
   *
   * The score rewards higher success probability and penalizes higher fees.
   * A zero or negative fee rate is treated as the cheapest possible pathway.
   *
   * @param pathway - The candidate pathway to score
   * @returns The pathway annotated with its composite score
   */
  scorePathway(pathway: PaymentPathway): ScoredPaymentPathway {
    const probability = Math.min(Math.max(pathway.successProbability, 0), 1);
    const feeRate = pathway.feeRate > 0 ? pathway.feeRate : 1;
    const score = probability / feeRate;
    return { ...pathway, score };
  }

  /**
   * Optimize a set of candidate payment pathways.
   *
   * @param pathways - The candidate pathways to evaluate
   * @returns The optimization result, ordered from best to worst
   */
  optimize(pathways: PaymentPathway[]): PaymentPathwayOptimization {
    try {
      const scored = pathways
        .map((pathway) => this.scorePathway(pathway))
        .sort((a, b) => b.score - a.score);

      const result: PaymentPathwayOptimization = {
        pathways: scored,
        recommended: scored.length > 0 ? scored[0] : null,
        evaluatedCount: scored.length,
      };

      this.emit("optimized", result);
      return result;
    } catch (error) {
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
      return { pathways: [], recommended: null, evaluatedCount: 0 };
    }
  }

  private emit(event: PaymentPathwayEvent, payload: PaymentPathwayOptimization | Error): void {
    this.handlers.forEach((handler) => {
      try {
        handler(event, payload);
      } catch (error) {
        console.error(`Error in payment pathway handler for ${event}:`, error);
      }
    });
  }
}

/**
 * Creates a new PaymentPathwayOptimizer instance.
 *
 * @returns A new PaymentPathwayOptimizer instance
 */
export function createPaymentPathwayOptimizer(): PaymentPathwayOptimizer {
  return new PaymentPathwayOptimizer();
}
