import { EventEmitter } from 'events';

export interface Payment {
  id: string;
  amount: number;
  currency: string;
  recipient: string;
  metadata?: Record<string, unknown>;
}

export type BatchStatus =
  | 'scheduled'
  | 'executing'
  | 'executed'
  | 'cancelled'
  | 'failed';

export interface PaymentBatch {
  id: string;
  payments: Payment[];
  scheduledAt: number;
  status: BatchStatus;
  createdAt: number;
  executedAt?: number;
  error?: string;
}

export interface BatchSchedulerOptions {
  /** Maximum number of payments allowed in a single batch. */
  maxBatchSize?: number;
  /** Injectable clock for deterministic scheduling and tests. */
  now?: () => number;
  /** Injectable timer functions for deterministic tests. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export type BatchExecutor = (payments: Payment[]) => Promise<void> | void;

export interface BatchSchedulerEvents {
  scheduled: (batch: PaymentBatch) => void;
  executed: (batch: PaymentBatch) => void;
  cancelled: (batch: PaymentBatch) => void;
  failed: (batch: PaymentBatch, error: Error) => void;
}

const DEFAULT_MAX_BATCH_SIZE = 100;

/**
 * Schedules and executes batches of payments.
 *
 * Batches are queued by their scheduled time and executed in order once their
 * scheduled time is reached. Lifecycle transitions emit typed events so callers
 * can observe scheduling, execution, cancellation, and failure.
 */
export class PaymentBatchScheduler extends EventEmitter {
  private readonly batches = new Map<string, PaymentBatch>();
  private readonly timers = new Map<string, unknown>();
  private readonly maxBatchSize: number;
  private readonly now: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private sequence = 0;

  constructor(
    private readonly executor: BatchExecutor,
    options: BatchSchedulerOptions = {},
  ) {
    super();
    this.maxBatchSize = options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.now = options.now ?? (() => Date.now());
    this.setTimeoutFn =
      options.setTimeoutFn ??
      ((fn, ms) => setTimeout(fn, ms) as unknown);
    this.clearTimeoutFn =
      options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as never));
  }

  /**
   * Schedule a batch of payments for execution at the given time.
   * Returns the created batch. Throws if the batch is invalid.
   */
  schedule(
    payments: Payment[],
    scheduledAt: number,
    id?: string,
  ): PaymentBatch {
    if (!Array.isArray(payments) || payments.length === 0) {
      throw new Error('Cannot schedule an empty payment batch');
    }
    if (payments.length > this.maxBatchSize) {
      throw new Error(
        `Batch size ${payments.length} exceeds maximum of ${this.maxBatchSize}`,
      );
    }
    if (!Number.isFinite(scheduledAt)) {
      throw new Error('scheduledAt must be a finite timestamp');
    }

    const batchId = id ?? this.nextId();
    if (this.batches.has(batchId)) {
      throw new Error(`Batch ${batchId} already exists`);
    }

    const batch: PaymentBatch = {
      id: batchId,
      payments: payments.map((p) => ({ ...p })),
      scheduledAt,
      status: 'scheduled',
      createdAt: this.now(),
    };

    this.batches.set(batchId, batch);
    this.armTimer(batch);
    this.emit('scheduled', batch);
    return batch;
  }

  /** Cancel a scheduled batch. Returns true if it was cancelled. */
  cancel(id: string): boolean {
    const batch = this.batches.get(id);
    if (!batch || batch.status !== 'scheduled') {
      return false;
    }
    this.disarmTimer(id);
    batch.status = 'cancelled';
    this.emit('cancelled', batch);
    return true;
  }

  /** Retrieve a batch by id. */
  getBatch(id: string): PaymentBatch | undefined {
    return this.batches.get(id);
  }

  /** List all known batches, ordered by scheduled time then creation order. */
  listBatches(): PaymentBatch[] {
    return Array.from(this.batches.values()).sort((a, b) => {
      if (a.scheduledAt !== b.scheduledAt) {
        return a.scheduledAt - b.scheduledAt;
      }
      return a.createdAt - b.createdAt;
    });
  }

  /** Cancel all pending timers. Useful for teardown. */
  dispose(): void {
    for (const id of Array.from(this.timers.keys())) {
      this.disarmTimer(id);
    }
  }

  private nextId(): string {
    this.sequence += 1;
    return `batch_${this.now()}_${this.sequence}`;
  }

  private armTimer(batch: PaymentBatch): void {
    const delay = Math.max(0, batch.scheduledAt - this.now());
    const handle = this.setTimeoutFn(() => {
      this.timers.delete(batch.id);
      void this.execute(batch.id);
    }, delay);
    this.timers.set(batch.id, handle);
  }

  private disarmTimer(id: string): void {
    const handle = this.timers.get(id);
    if (handle !== undefined) {
      this.clearTimeoutFn(handle);
      this.timers.delete(id);
    }
  }

  /** Execute a batch immediately, regardless of its scheduled time. */
  async execute(id: string): Promise<PaymentBatch | undefined> {
    const batch = this.batches.get(id);
    if (!batch || batch.status !== 'scheduled') {
      return batch;
    }

    this.disarmTimer(id);
    batch.status = 'executing';

    try {
      await this.executor(batch.payments);
      batch.status = 'executed';
      batch.executedAt = this.now();
      this.emit('executed', batch);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      batch.status = 'failed';
      batch.error = error.message;
      this.emit('failed', batch, error);
    }

    return batch;
  }
}
