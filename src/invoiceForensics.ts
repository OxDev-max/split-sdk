/**
 * Invoice forensics tools.
 *
 * Provides analysis of invoice fields to detect tampering, mismatches and
 * anomalies, plus typed event handling for forensic findings.
 */

export type InvoiceField = 'invoiceNumber' | 'amount' | 'currency' | 'issuedAt' | 'dueAt' | 'vendor' | 'buyer' | 'lineItems';

export type FindingSeverity = 'info' | 'warning' | 'critical';

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface Invoice {
  invoiceNumber: string;
  amount: number;
  currency: string;
  issuedAt: string;
  dueAt: string;
  vendor: string;
  buyer: string;
  lineItems: InvoiceLineItem[];
}

export interface ForensicFinding {
  code: string;
  severity: FindingSeverity;
  field: InvoiceField;
  message: string;
  expected?: unknown;
  actual?: unknown;
}

export interface ForensicReport {
  invoiceNumber: string;
  findings: ForensicFinding[];
  riskScore: number;
  passed: boolean;
}

export type ForensicEventType = 'finding' | 'report' | 'error';

export interface ForensicEventMap {
  finding: ForensicFinding;
  report: ForensicReport;
  error: { message: string; error?: unknown };
}

export type ForensicEventHandler<T extends ForensicEventType> = (payload: ForensicEventMap[T]) => void;

export interface InvoiceForensicsOptions {
  /** Absolute tolerance when comparing monetary amounts. */
  amountTolerance?: number;
  /** Maximum allowed gap (ms) between issue and due dates. */
  maxTermMs?: number;
  /** Risk score at or above which the report is considered failed. */
  riskThreshold?: number;
}

const DEFAULT_AMOUNT_TOLERANCE = 0.01;
const DEFAULT_MAX_TERM_MS = 365 * 24 * 60 * 60 * 1000;
const DEFAULT_RISK_THRESHOLD = 50;

const SEVERITY_WEIGHT: Record<FindingSeverity, number> = {
  info: 1,
  warning: 10,
  critical: 40,
};

/**
 * Analyzes invoices for tampering, mismatches and anomalies and emits typed
 * events for each finding and for the final report.
 */
export class InvoiceForensics {
  private readonly amountTolerance: number;
  private readonly maxTermMs: number;
  private readonly riskThreshold: number;
  private readonly handlers: { [K in ForensicEventType]: Set<ForensicEventHandler<K>> } = {
    finding: new Set(),
    report: new Set(),
    error: new Set(),
  };

  constructor(options: InvoiceForensicsOptions = {}) {
    this.amountTolerance = options.amountTolerance ?? DEFAULT_AMOUNT_TOLERANCE;
    this.maxTermMs = options.maxTermMs ?? DEFAULT_MAX_TERM_MS;
    this.riskThreshold = options.riskThreshold ?? DEFAULT_RISK_THRESHOLD;
  }

  on<T extends ForensicEventType>(event: T, handler: ForensicEventHandler<T>): () => void {
    this.handlers[event].add(handler as ForensicEventHandler<ForensicEventType>);
    return () => this.off(event, handler);
  }

  off<T extends ForensicEventType>(event: T, handler: ForensicEventHandler<T>): void {
    this.handlers[event].delete(handler as ForensicEventHandler<ForensicEventType>);
  }

  private emit<T extends ForensicEventType>(event: T, payload: ForensicEventMap[T]): void {
    for (const handler of this.handlers[event]) {
      try {
        (handler as ForensicEventHandler<T>)(payload);
      } catch (error) {
        if (event !== 'error') {
          this.emit('error', { message: `Handler for "${event}" threw`, error });
        }
      }
    }
  }

  /** Runs all forensic checks against a single invoice. */
  analyze(invoice: Invoice): ForensicReport {
    const findings: ForensicFinding[] = [];

    try {
      findings.push(...this.checkRequiredFields(invoice));
      findings.push(...this.checkDates(invoice));
      findings.push(...this.checkAmounts(invoice));
      findings.push(...this.checkLineItems(invoice));
    } catch (error) {
      this.emit('error', { message: 'Invoice analysis failed', error });
    }

    for (const finding of findings) {
      this.emit('finding', finding);
    }

    const riskScore = findings.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);
    const report: ForensicReport = {
      invoiceNumber: invoice.invoiceNumber,
      findings,
      riskScore,
      passed: riskScore < this.riskThreshold,
    };

    this.emit('report', report);
    return report;
  }

  /** Analyzes a batch of invoices and returns their reports. */
  analyzeAll(invoices: Invoice[]): ForensicReport[] {
    return invoices.map((invoice) => this.analyze(invoice));
  }

  private checkRequiredFields(invoice: Invoice): ForensicFinding[] {
    const findings: ForensicFinding[] = [];
    const required: InvoiceField[] = ['invoiceNumber', 'currency', 'vendor', 'buyer'];

    for (const field of required) {
      const value = invoice[field];
      if (typeof value !== 'string' || value.trim() === '') {
        findings.push({
          code: 'MISSING_FIELD',
          severity: 'critical',
          field,
          message: `Required field "${field}" is missing or empty`,
          actual: value,
        });
      }
    }

    return findings;
  }

  private checkDates(invoice: Invoice): ForensicFinding[] {
    const findings: ForensicFinding[] = [];
    const issued = Date.parse(invoice.issuedAt);
    const due = Date.parse(invoice.dueAt);

    if (Number.isNaN(issued)) {
      findings.push({
        code: 'INVALID_DATE',
        severity: 'critical',
        field: 'issuedAt',
        message: 'issuedAt is not a valid date',
        actual: invoice.issuedAt,
      });
    }

    if (Number.isNaN(due)) {
      findings.push({
        code: 'INVALID_DATE',
        severity: 'critical',
        field: 'dueAt',
        message: 'dueAt is not a valid date',
        actual: invoice.dueAt,
      });
    }

    if (!Number.isNaN(issued) && !Number.isNaN(due)) {
      if (due < issued) {
        findings.push({
          code: 'DUE_BEFORE_ISSUED',
          severity: 'critical',
          field: 'dueAt',
          message: 'Due date precedes issue date',
          expected: invoice.issuedAt,
          actual: invoice.dueAt,
        });
      } else if (due - issued > this.maxTermMs) {
        findings.push({
          code: 'EXCESSIVE_TERM',
          severity: 'warning',
          field: 'dueAt',
          message: 'Payment term exceeds the configured maximum',
          expected: this.maxTermMs,
          actual: due - issued,
        });
      }
    }

    return findings;
  }

  private checkAmounts(invoice: Invoice): ForensicFinding[] {
    const findings: ForensicFinding[] = [];

    if (typeof invoice.amount !== 'number' || !Number.isFinite(invoice.amount)) {
      findings.push({
        code: 'INVALID_AMOUNT',
        severity: 'critical',
        field: 'amount',
        message: 'Invoice amount is not a finite number',
        actual: invoice.amount,
      });
      return findings;
    }

    if (invoice.amount <= 0) {
      findings.push({
        code: 'NON_POSITIVE_AMOUNT',
        severity: 'critical',
        field: 'amount',
        message: 'Invoice amount must be positive',
        actual: invoice.amount,
      });
    }

    const lineTotal = invoice.lineItems.reduce(
      (sum, item) => sum + item.quantity * item.unitPrice,
      0,
    );

    if (Math.abs(lineTotal - invoice.amount) > this.amountTolerance) {
      findings.push({
        code: 'AMOUNT_MISMATCH',
        severity: 'critical',
        field: 'amount',
        message: 'Invoice amount does not match the sum of line items',
        expected: lineTotal,
        actual: invoice.amount,
      });
    }

    return findings;
  }

  private checkLineItems(invoice: Invoice): ForensicFinding[] {
    const findings: ForensicFinding[] = [];

    if (!Array.isArray(invoice.lineItems) || invoice.lineItems.length === 0) {
      findings.push({
        code: 'NO_LINE_ITEMS',
        severity: 'warning',
        field: 'lineItems',
        message: 'Invoice has no line items',
        actual: invoice.lineItems,
      });
      return findings;
    }

    invoice.lineItems.forEach((item, index) => {
      if (typeof item.quantity !== 'number' || item.quantity <= 0) {
        findings.push({
          code: 'INVALID_QUANTITY',
          severity: 'warning',
          field: 'lineItems',
          message: `Line item ${index} has an invalid quantity`,
          actual: item.quantity,
        });
      }

      if (typeof item.unitPrice !== 'number' || item.unitPrice < 0) {
        findings.push({
          code: 'INVALID_UNIT_PRICE',
          severity: 'warning',
          field: 'lineItems',
          message: `Line item ${index} has an invalid unit price`,
          actual: item.unitPrice,
        });
      }
    });

    return findings;
  }
}
