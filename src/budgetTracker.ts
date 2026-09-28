export interface BudgetTrackerOptions {
  /** Maximum allowed cumulative spend. */
  limit: number;
  /** Fraction of the limit at which a warning is emitted (0 < threshold < 1). Defaults to 0.8. */
  warnThreshold?: number;
}

export type BudgetTrackerEvent = 'warning' | 'limit-reached';

export type BudgetTrackerListener = (payload: {
  event: BudgetTrackerEvent;
  spent: number;
  limit: number;
  remaining: number;
}) => void;

/**
 * Tracks cumulative spend against a configured budget limit and emits
 * events when spend approaches or exceeds the limit.
 */
export class BudgetTracker {
  private readonly limit: number;
  private readonly warnThreshold: number;
  private spent = 0;
  private warned = false;
  private reached = false;
  private readonly listeners = new Map<BudgetTrackerEvent, Set<BudgetTrackerListener>>();

  constructor(options: BudgetTrackerOptions) {
    if (!Number.isFinite(options.limit) || options.limit <= 0) {
      throw new Error('BudgetTracker: limit must be a positive finite number');
    }
    const warnThreshold = options.warnThreshold ?? 0.8;
    if (!Number.isFinite(warnThreshold) || warnThreshold <= 0 || warnThreshold >= 1) {
      throw new Error('BudgetTracker: warnThreshold must be between 0 and 1 (exclusive)');
    }
    this.limit = options.limit;
    this.warnThreshold = warnThreshold;
  }

  /** Record additional spend and emit threshold events as needed. */
  track(amount: number): void {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error('BudgetTracker: amount must be a non-negative finite number');
    }
    this.spent += amount;

    if (!this.warned && this.spent >= this.limit * this.warnThreshold && this.spent < this.limit) {
      this.warned = true;
      this.emit('warning');
    }

    if (!this.reached && this.spent >= this.limit) {
      this.reached = true;
      this.emit('limit-reached');
    }
  }

  /** Current cumulative spend. */
  getSpent(): number {
    return this.spent;
  }

  /** Remaining budget (never negative). */
  getRemaining(): number {
    return Math.max(0, this.limit - this.spent);
  }

  /** Whether spend has reached or exceeded the limit. */
  isLimitReached(): boolean {
    return this.reached;
  }

  /** Subscribe to a budget event. Returns an unsubscribe function. */
  on(event: BudgetTrackerEvent, listener: BudgetTrackerListener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  private emit(event: BudgetTrackerEvent): void {
    const set = this.listeners.get(event);
    if (!set) {
      return;
    }
    const payload = {
      event,
      spent: this.spent,
      limit: this.limit,
      remaining: this.getRemaining(),
    };
    for (const listener of set) {
      listener(payload);
    }
  }
}
