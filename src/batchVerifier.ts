import type { Invoice, BatchPayment } from "./types.js";

export interface BatchInvoiceValidation {
  invoiceId: string;
  valid: boolean;
  errors: string[];
  token: string;
  remainingAmount: bigint;
  status: string;
}

export interface BatchVerificationResult {
  valid: boolean;
  invoices: BatchInvoiceValidation[];
  commonToken: string | null;
  errors: string[];
}

/**
 * Verify that all invoices in a batch share the same token and are in a
 * payable state, before submitting the on-chain transaction.
 *
 * @param invoices - The invoices to verify (must already be resolved).
 * @param payments - The proposed batch payments (invoiceId + amount pairs).
 */
export function verifyBatchPayments(
  invoices: Invoice[],
  payments: BatchPayment[]
): BatchVerificationResult {
  const errors: string[] = [];
  const invoiceValidations: BatchInvoiceValidation[] = [];

  if (invoices.length === 0) {
    return { valid: false, invoices: [], commonToken: null, errors: ["No invoices provided"] };
  }

  const invoiceMap = new Map(invoices.map((inv) => [inv.id, inv]));
  const tokens = new Set<string>();

  for (const payment of payments) {
    const invoice = invoiceMap.get(payment.invoiceId);
    if (!invoice) {
      invoiceValidations.push({
        invoiceId: payment.invoiceId,
        valid: false,
        errors: ["Invoice not found"],
        token: "",
        remainingAmount: 0n,
        status: "unknown",
      });
      errors.push(`Invoice ${payment.invoiceId}: not found`);
      continue;
    }

    tokens.add(invoice.token);
    const invoiceErrors: string[] = [];

    if (invoice.status !== "Pending") {
      invoiceErrors.push(`Invoice status is "${invoice.status}", expected "Pending"`);
    }

    const totalOwed = invoice.recipients.reduce((sum, r) => sum + r.amount, 0n);
    const remaining = totalOwed - invoice.funded;
    if (payment.amount <= 0n) {
      invoiceErrors.push("Payment amount must be positive");
    }
    if (payment.amount > remaining) {
      invoiceErrors.push(
        `Payment amount ${payment.amount} exceeds remaining ${remaining}`
      );
    }

    invoiceValidations.push({
      invoiceId: payment.invoiceId,
      valid: invoiceErrors.length === 0,
      errors: invoiceErrors,
      token: invoice.token,
      remainingAmount: remaining,
      status: invoice.status,
    });

    if (invoiceErrors.length > 0) {
      errors.push(`Invoice ${payment.invoiceId}: ${invoiceErrors.join("; ")}`);
    }
  }

  const commonToken = tokens.size === 1 ? [...tokens][0]! : null;
  if (tokens.size > 1) {
    errors.push(`Invoices use different tokens: ${[...tokens].join(", ")}`);
  }

  const allValid = errors.length === 0;

  return { valid: allValid, invoices: invoiceValidations, commonToken, errors };
}

/**
 * Result returned by the client's verifyBatchPay method.
 */
export interface VerifyBatchPayResult {
  valid: boolean;
  invoices: BatchInvoiceValidation[];
  commonToken: string | null;
  errors: string[];
}

/**
 * A single optimized payment operation produced by the batch optimizer.
 */
export interface OptimizedPayment {
  invoiceId: string;
  amount: bigint;
  token: string;
}

/**
 * Result of optimizing a set of proposed batch payments.
 */
export interface BatchOptimizationResult {
  valid: boolean;
  payments: OptimizedPayment[];
  commonToken: string | null;
  totalAmount: bigint;
  errors: string[];
}

/**
 * Event emitted during the batch optimization lifecycle.
 */
export interface BatchOptimizerEvent {
  type: "optimization:start" | "optimization:complete" | "optimization:error";
  result?: BatchOptimizationResult;
  error?: string;
}

export type BatchOptimizerEventHandler = (event: BatchOptimizerEvent) => void;

/**
 * Batch payment optimizer.
 *
 * Groups and merges proposed batch payments into a minimal set of
 * optimized payment operations, while emitting lifecycle events so
 * callers can observe the optimization process.
 */
export class BatchPaymentOptimizer {
  private readonly handlers: Set<BatchOptimizerEventHandler> = new Set();

  /**
   * Register an event handler for optimization lifecycle events.
   *
   * @returns An unsubscribe function that removes the handler.
   */
  on(handler: BatchOptimizerEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private emit(event: BatchOptimizerEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  /**
   * Optimize a set of proposed batch payments.
   *
   * Payments targeting the same invoice are merged into a single
   * operation, and the resulting operations are validated against the
   * provided invoices. Lifecycle events are emitted on start, completion
   * and error.
   *
   * @param invoices - The invoices referenced by the payments.
   * @param payments - The proposed batch payments (invoiceId + amount pairs).
   */
  optimize(invoices: Invoice[], payments: BatchPayment[]): BatchOptimizationResult {
    this.emit({ type: "optimization:start" });

    try {
      const verification = verifyBatchPayments(invoices, payments);
      if (!verification.valid) {
        const result: BatchOptimizationResult = {
          valid: false,
          payments: [],
          commonToken: verification.commonToken,
          totalAmount: 0n,
          errors: verification.errors,
        };
        this.emit({ type: "optimization:error", result, error: verification.errors.join("; ") });
        return result;
      }

      const invoiceMap = new Map(invoices.map((inv) => [inv.id, inv]));
      const merged = new Map<string, OptimizedPayment>();

      for (const payment of payments) {
        const invoice = invoiceMap.get(payment.invoiceId);
        if (!invoice) {
          continue;
        }
        const existing = merged.get(payment.invoiceId);
        if (existing) {
          existing.amount += payment.amount;
        } else {
          merged.set(payment.invoiceId, {
            invoiceId: payment.invoiceId,
            amount: payment.amount,
            token: invoice.token,
          });
        }
      }

      const optimized = [...merged.values()];
      const totalAmount = optimized.reduce((sum, p) => sum + p.amount, 0n);

      const result: BatchOptimizationResult = {
        valid: true,
        payments: optimized,
        commonToken: verification.commonToken,
        totalAmount,
        errors: [],
      };
      this.emit({ type: "optimization:complete", result });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const result: BatchOptimizationResult = {
        valid: false,
        payments: [],
        commonToken: null,
        totalAmount: 0n,
        errors: [message],
      };
      this.emit({ type: "optimization:error", result, error: message });
      return result;
    }
  }
}
