/**
 * @stellar-split/sdk/mock
 *
 * In-memory mock client for testing SDK consumers without a live RPC endpoint
 * or deployed contract. State is stored in plain JS Maps; fully synchronous
 * where possible.
 *
 * @example
 * ```ts
 * import { MockStellarSplitClient } from '@stellar-split/sdk/mock';
 *
 * const mock = new MockStellarSplitClient();
 * mock.setInvoice('inv-1', { id: 'inv-1', status: 'Pending', ... });
 * const invoice = await mock.getInvoice('inv-1');
 * ```
 */

import type {
  Invoice,
  Payment,
  InvoiceEvent,
  Subscription,
  SubscriptionOptions,
  CreateInvoiceParams,
  PaginatedResult,
  PaginationOptions,
} from "../types.js";
import type { TxResult } from "../client.js";
import { InvoiceNotFoundError } from "../errors.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single entry in the call history produced by {@link MockStellarSplitClient}. */
export interface CallRecord {
  /** SDK method name that was called. */
  method: string;
  /** Arguments passed to the method (serialised to a plain array). */
  args: unknown[];
  /** Unix timestamp (ms) when the call was made. */
  timestamp: number;
}

// Callback type for invoice subscriptions
type InvoiceEventCallback = (event: InvoiceEvent) => void;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Generate a deterministic-looking fake tx hash. */
function fakeTxHash(seed?: string): string {
  const base = seed ?? String(Date.now());
  let h = 0;
  for (let i = 0; i < base.length; i++) {
    h = (Math.imul(31, h) + base.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(16).padStart(64, "0");
}

/** Build a minimal in-memory Subscription object. */
function makeSubscription(
  invoiceId: string,
  onUnsubscribe: () => void,
): Subscription {
  let active = true;
  let paused = false;
  return {
    unsubscribe() {
      active = false;
      onUnsubscribe();
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    getInvoiceId() {
      return invoiceId;
    },
    isActive() {
      return active;
    },
    isPaused() {
      return paused;
    },
  };
}

// ---------------------------------------------------------------------------
// MockStellarSplitClient
// ---------------------------------------------------------------------------

/**
 * Full in-memory implementation of the {@link StellarSplitClient} contract.
 *
 * Use in unit tests wherever you would normally pass a real client.
 * All writes mutate the internal state map; reads reflect that state.
 */
export class MockStellarSplitClient {
  /** Invoice store. */
  private _invoices = new Map<string, Invoice>();
  /** Sequential invoice ID counter. */
  private _nextId = 1;
  /** All recorded calls. */
  private _calls: CallRecord[] = [];
  /** Registered subscription callbacks, keyed by invoiceId. */
  private _listeners = new Map<string, Set<InvoiceEventCallback>>();

  // -------------------------------------------------------------------------
  // Test-helpers (not on the real client)
  // -------------------------------------------------------------------------

  /**
   * Reset all internal state: clears invoices, call history, and listeners.
   * Call this in `beforeEach` to guarantee test isolation.
   */
  reset(): void {
    this._invoices.clear();
    this._calls = [];
    this._listeners.clear();
    this._nextId = 1;
  }

  /**
   * Pre-populate the mock store with a known invoice.
   * Useful for arrange → act → assert test patterns.
   *
   * @param id      - The invoice ID (string key).
   * @param invoice - Partial invoice merged with defaults.
   */
  setInvoice(id: string, invoice: Invoice): void {
    this._invoices.set(id, { ...invoice, id });
  }

  /**
   * Return all method calls recorded since the last {@link reset}.
   */
  getCallHistory(): CallRecord[] {
    return [...this._calls];
  }

  /**
   * Trigger all active {@link subscribeInvoice} callbacks for a given invoice
   * with a synthetic event. Lets test code drive real-time subscription logic.
   *
   * @param event - The {@link InvoiceEvent} to dispatch.
   */
  simulateEvent(event: InvoiceEvent): void {
    const listeners = this._listeners.get(event.invoiceId);
    if (!listeners) return;
    for (const cb of listeners) {
      cb(event);
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _record(method: string, args: unknown[]): void {
    this._calls.push({ method, args, timestamp: Date.now() });
  }

  private _getOrThrow(invoiceId: string): Invoice {
    const invoice = this._invoices.get(invoiceId);
    if (!invoice) throw new InvoiceNotFoundError(invoiceId);
    return invoice;
  }

  // -------------------------------------------------------------------------
  // StellarSplitClient interface — core methods
  // -------------------------------------------------------------------------

  async createInvoice(
    params: CreateInvoiceParams,
  ): Promise<{ invoiceId: string; txHash: string }> {
    this._record("createInvoice", [params]);
    const invoiceId = String(this._nextId++);
    const invoice: Invoice = {
      id: invoiceId,
      creator: params.creator,
      recipients: params.recipients,
      token: params.token,
      deadline: params.deadline,
      funded: 0n,
      status: "Pending",
      payments: [],
      memo: params.memo,
    };
    this._invoices.set(invoiceId, invoice);
    return { invoiceId, txHash: fakeTxHash(invoiceId) };
  }

  async pay(params: {
    payer: string;
    invoiceId: string;
    amount: bigint;
    donateOnFailure?: boolean;
  }): Promise<TxResult> {
    this._record("pay", [params]);
    const invoice = this._getOrThrow(params.invoiceId);
    const payment: Payment = {
      payer: params.payer,
      amount: params.amount,
      donateOnFailure: params.donateOnFailure,
      timestamp: Math.floor(Date.now() / 1000),
    };
    const updated: Invoice = {
      ...invoice,
      funded: invoice.funded + params.amount,
      payments: [...invoice.payments, payment],
    };
    this._invoices.set(params.invoiceId, updated);
    return { txHash: fakeTxHash(params.invoiceId + params.payer) };
  }

  async getInvoice(invoiceId: string): Promise<Invoice> {
    this._record("getInvoice", [invoiceId]);
    return this._getOrThrow(invoiceId);
  }

  async getPayments(invoiceId: string): Promise<Payment[]> {
    this._record("getPayments", [invoiceId]);
    return this._getOrThrow(invoiceId).payments;
  }

  async getInvoicesByCreator(
    creator: string,
    options?: PaginationOptions,
  ): Promise<PaginatedResult<string>> {
    this._record("getInvoicesByCreator", [creator, options]);
    const limit = options?.limit ?? 20;
    const all = [...this._invoices.values()]
      .filter((inv) => inv.creator === creator)
      .map((inv) => inv.id);
    return {
      items: all.slice(0, limit),
      nextCursor: all.length > limit ? String(limit) : null,
      total: all.length,
    };
  }

  /**
   * Subscribe to invoice events — matches the real client's `subscribeToInvoice`
   * signature (returns an unsubscribe function, not a Subscription object).
   *
   * @param invoiceId - Invoice to watch.
   * @param callback  - Called for each dispatched event.
   * @returns Unsubscribe function.
   */
  subscribeToInvoice(
    invoiceId: string,
    callback: (event: InvoiceEvent) => void,
    _optionsOrInterval?: unknown,
  ): () => void {
    this._record("subscribeToInvoice", [invoiceId]);
    if (!this._listeners.has(invoiceId)) {
      this._listeners.set(invoiceId, new Set());
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this._listeners.get(invoiceId)!.add(callback);

    return () => {
      this._listeners.get(invoiceId)?.delete(callback);
    };
  }

  /**
   * Alternative subscribe API that returns a full {@link Subscription} object.
   * Useful in tests that need pause/resume/isActive.
   */
  subscribeInvoice(
    invoiceId: string,
    callback: (event: InvoiceEvent) => void,
    _options?: SubscriptionOptions,
  ): Subscription {
    this._record("subscribeInvoice", [invoiceId]);
    if (!this._listeners.has(invoiceId)) {
      this._listeners.set(invoiceId, new Set());
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    this._listeners.get(invoiceId)!.add(callback);

    return makeSubscription(invoiceId, () => {
      this._listeners.get(invoiceId)?.delete(callback);
    });
  }

  // -------------------------------------------------------------------------
  // Additional read methods commonly used by consumers
  // -------------------------------------------------------------------------

  async releaseInvoice(
    invoiceId: string,
    _releasedBy: string,
  ): Promise<TxResult> {
    this._record("releaseInvoice", [invoiceId, _releasedBy]);
    const invoice = this._getOrThrow(invoiceId);
    this._invoices.set(invoiceId, { ...invoice, status: "Released" });
    return { txHash: fakeTxHash(invoiceId + "release") };
  }

  async refundInvoice(
    invoiceId: string,
    _refundedBy: string,
  ): Promise<TxResult> {
    this._record("refundInvoice", [invoiceId, _refundedBy]);
    const invoice = this._getOrThrow(invoiceId);
    this._invoices.set(invoiceId, { ...invoice, status: "Refunded" });
    return { txHash: fakeTxHash(invoiceId + "refund") };
  }

  async cancelInvoice(
    invoiceId: string,
    _cancelledBy: string,
  ): Promise<TxResult> {
    this._record("cancelInvoice", [invoiceId, _cancelledBy]);
    const invoice = this._getOrThrow(invoiceId);
    this._invoices.set(invoiceId, { ...invoice, status: "Cancelled" });
    return { txHash: fakeTxHash(invoiceId + "cancel") };
  }
}

export default MockStellarSplitClient;
