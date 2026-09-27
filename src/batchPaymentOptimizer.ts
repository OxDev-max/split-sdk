import { EventEmitter } from 'events';

export interface PaymentOperation {
  id: string;
  source: string;
  destination: string;
  amount: number;
  currency: string;
  metadata?: Record<string, unknown>;
}

export interface OptimizedBatch {
  operations: PaymentOperation[];
  totalAmount: number;
  currency: string;
  savings: number;
}

export interface BatchPaymentOptimizerOptions {
  /** Minimum number of operations required to form a batch. */
  minBatchSize?: number;
  /** Whether to merge operations sharing the same source/destination/currency. */
  mergeDuplicates?: boolean;
}

export type BatchPaymentOptimizerEvent =
  | 'optimization:start'
  | 'optimization:progress'
  | 'optimization:complete'
  | 'optimization:error';

export interface OptimizationStartPayload {
  operationCount: number;
}

export interface OptimizationProgressPayload {
  processed: number;
  total: number;
}

export interface OptimizationCompletePayload {
  batches: OptimizedBatch[];
  originalCount: number;
  optimizedCount: number;
}

export interface OptimizationErrorPayload {
  error: Error;
}

const DEFAULT_OPTIONS: Required<BatchPaymentOptimizerOptions> = {
  minBatchSize: 1,
  mergeDuplicates: true,
};

/**
 * Batch payment optimizer.
 *
 * Groups and merges payment operations into optimized batches, reducing the
 * number of on-chain/network operations while preserving net value.
 */
export class BatchPaymentOptimizer extends EventEmitter {
  private readonly options: Required<BatchPaymentOptimizerOptions>;

  constructor(options: BatchPaymentOptimizerOptions = {}) {
    super();
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Optimize a list of payment operations into batches.
   * Emits lifecycle events throughout the optimization process.
   */
  public optimize(operations: PaymentOperation[]): OptimizedBatch[] {
    this.emit('optimization:start', {
      operationCount: operations.length,
    } satisfies OptimizationStartPayload);

    try {
      const merged = this.options.mergeDuplicates
        ? this.mergeOperations(operations)
        : [...operations];

      const batches = this.groupIntoBatches(merged);

      this.emit('optimization:complete', {
        batches,
        originalCount: operations.length,
        optimizedCount: batches.reduce(
          (sum, batch) => sum + batch.operations.length,
          0,
        ),
      } satisfies OptimizationCompletePayload);

      return batches;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('optimization:error', { error } satisfies OptimizationErrorPayload);
      throw error;
    }
  }

  /**
   * Merge operations that share the same source, destination and currency
   * by summing their amounts.
   */
  public mergeOperations(operations: PaymentOperation[]): PaymentOperation[] {
    const merged = new Map<string, PaymentOperation>();

    operations.forEach((operation, index) => {
      const key = `${operation.source}|${operation.destination}|${operation.currency}`;
      const existing = merged.get(key);

      if (existing) {
        merged.set(key, {
          ...existing,
          amount: existing.amount + operation.amount,
        });
      } else {
        merged.set(key, { ...operation });
      }

      this.emit('optimization:progress', {
        processed: index + 1,
        total: operations.length,
      } satisfies OptimizationProgressPayload);
    });

    return Array.from(merged.values());
  }

  /**
   * Group merged operations into batches keyed by currency.
   */
  public groupIntoBatches(operations: PaymentOperation[]): OptimizedBatch[] {
    const byCurrency = new Map<string, PaymentOperation[]>();

    operations.forEach((operation) => {
      const group = byCurrency.get(operation.currency) ?? [];
      group.push(operation);
      byCurrency.set(operation.currency, group);
    });

    const batches: OptimizedBatch[] = [];

    byCurrency.forEach((group, currency) => {
      if (group.length < this.options.minBatchSize) {
        return;
      }

      const totalAmount = group.reduce((sum, op) => sum + op.amount, 0);
      const savings = group.length > 1 ? group.length - 1 : 0;

      batches.push({
        operations: group,
        totalAmount,
        currency,
        savings,
      });
    });

    return batches;
  }
}

export default BatchPaymentOptimizer;
