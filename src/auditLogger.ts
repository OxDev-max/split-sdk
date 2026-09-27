import { truncateAddress } from "./utils.js";
import { decodeXDR } from "./xdrDecoder.js";
import type { XDRType, DecodedXDR, SplitAuditEntry } from "./types.js";

export interface AuditEntry {
  timestamp: number;
  method: string;
  params: Record<string, unknown>;
  success: boolean;
  durationMs: number;
  /** Optional decoded XDR payload attached to this audit entry. */
  decodedXdr?: DecodedXDR;
}

/**
 * Optional analytics dashboard export payload.
 *
 * Aggregates the audit entries observed by an {@link AuditLogger} into a
 * serializable shape suitable for an analytics dashboard. Export is opt-in:
 * it is only produced when {@link AuditLogger.exportAnalyticsDashboard} is
 * called, so default logging behavior is unchanged.
 */
export interface AnalyticsDashboardExport {
  /** ISO timestamp of when the export was generated. */
  generatedAt: string;
  /** Total number of audit entries included in the export. */
  totalEntries: number;
  /** Number of successful entries. */
  successCount: number;
  /** Number of failed entries. */
  failureCount: number;
  /** Aggregate duration across all entries, in milliseconds. */
  totalDurationMs: number;
  /** Per-method breakdown of entry counts and durations. */
  methods: Record<string, { count: number; totalDurationMs: number }>;
  /** The raw audit entries included in the export. */
  entries: AuditEntry[];
}

/** Lifecycle events emitted while producing an analytics dashboard export. */
export type AnalyticsExportEvent =
  | { type: "export_start"; entryCount: number }
  | { type: "export_complete"; export: AnalyticsDashboardExport }
  | { type: "export_error"; error: Error };

/** Options controlling an analytics dashboard export. */
export interface AnalyticsExportOptions {
  /** Optional inclusive lower bound (epoch ms) on entry timestamps. */
  since?: number;
  /** Optional inclusive upper bound (epoch ms) on entry timestamps. */
  until?: number;
  /** Optional listener for export lifecycle events. */
  onEvent?: (event: AnalyticsExportEvent) => void;
}

const STELLAR_ADDRESS_RE = /^G[A-Z0-9]{55}$/;

/** Detect if a string value looks like base64-encoded XDR. */
const XDR_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Heuristic minimum length for XDR base64 strings (at least ~40 chars for a minimal tx). */
const MIN_XDR_LENGTH = 40;

export class AuditLogger {
  private readonly sink: (entry: AuditEntry) => void;
  private readonly splitAuditTrails = new Map<string, SplitAuditEntry[]>();
  private readonly entries: AuditEntry[] = [];

  constructor(sink: (entry: AuditEntry) => void) {
    this.sink = sink;
  }

  log(entry: AuditEntry): void {
    this.entries.push(entry);
    this.sink(entry);
  }

  sanitize(params: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(params).map(([k, v]) => [
        k,
        typeof v === "string" && STELLAR_ADDRESS_RE.test(v)
          ? truncateAddress(v)
          : v,
      ])
    );
  }

  /**
   * Log an entry with automatic XDR decoding.
   *
   * When `xdrPayload` is provided, it is decoded and attached as `decodedXdr`.
   * This produces structured JSON safe for log aggregation, audit trails,
   * and developer UIs — no external XDR converters needed.
   *
   * @param entry     - Base audit entry.
   * @param xdrPayload - Base64-encoded XDR to decode (e.g. a transaction envelope).
   * @param xdrType    - The expected XDR type.
   */
  logWithXdr(
    entry: AuditEntry,
    xdrPayload: string,
    xdrType: XDRType,
  ): void {
    try {
      if (
        xdrPayload.length >= MIN_XDR_LENGTH &&
        XDR_BASE64_RE.test(xdrPayload)
      ) {
        entry.decodedXdr = decodeXDR(xdrPayload, xdrType);
      }
    } catch {
      // Decoding best-effort; never fail an audit log write.
    }
    this.log(entry);
  }

  /**
   * Auto-detect and decode XDR payloads embedded in audit params.
   *
   * Scans `entry.params` for keys matching known XDR field names
   * ("xdr", "txXdr", "envelopeXdr", "resultXdr", "metaXdr")
   * and attempts to decode them, attaching the result to `entry.decodedXdr`.
   */
  logAndDecodeXdr(entry: AuditEntry): void {
    const xdrKeys: Array<{ key: string; type: XDRType }> = [
      { key: "xdr", type: "TransactionEnvelope" },
      { key: "txXdr", type: "TransactionEnvelope" },
      { key: "envelopeXdr", type: "TransactionEnvelope" },
      { key: "resultXdr", type: "TransactionResult" },
      { key: "metaXdr", type: "TransactionMeta" },
    ];

    for (const { key, type } of xdrKeys) {
      const value = entry.params[key];
      if (typeof value === "string" && value.length >= MIN_XDR_LENGTH) {
        try {
          entry.decodedXdr = decodeXDR(value, type);
          break; // Decode the first match only
        } catch {
          // continue to next key
        }
      }
    }

    this.log(entry);
  }

  /**
   * Record a `SplitAuditEntry` for a single settled leg of a multi-recipient
   * split payment. Writes immediately to the configured sink (as an
   * `AuditEntry`) and to the in-memory per-invoice trail returned by
   * {@link exportSplitAuditTrail}.
   */
  recordSplitLeg(entry: SplitAuditEntry): void {
    const trail = this.splitAuditTrails.get(entry.invoiceId) ?? [];
    trail.push(entry);
    this.splitAuditTrails.set(entry.invoiceId, trail);

    this.log({
      timestamp: entry.settledAt,
      method: "split_leg_settled",
      params: this.sanitize({
        invoiceId: entry.invoiceId,
        legIndex: entry.legIndex,
        recipientId: entry.recipientId,
        assetCode: entry.assetCode,
        amount: entry.amount.toString(),
        operationId: entry.operationId,
        ledgerSequence: entry.ledgerSequence,
      }),
      success: true,
      durationMs: 0,
    });
  }

  /**
   * Return all recorded `SplitAuditEntry` records for `invoiceId`, in the
   * order they were settled.
   */
  async exportSplitAuditTrail(invoiceId: string): Promise<SplitAuditEntry[]> {
    return [...(this.splitAuditTrails.get(invoiceId) ?? [])];
  }

  /**
   * Produce an optional analytics dashboard export from the audit entries
   * observed so far.
   *
   * This is opt-in: nothing is exported unless this method is called, so
   * existing default logging behavior is unaffected. Lifecycle events
   * (`export_start`, `export_complete`, `export_error`) are emitted through
   * `options.onEvent` when provided.
   *
   * @param options - Optional time-range filter and event listener.
   * @returns A serializable {@link AnalyticsDashboardExport}.
   */
  exportAnalyticsDashboard(
    options: AnalyticsExportOptions = {},
  ): AnalyticsDashboardExport {
    const { since, until, onEvent } = options;

    const selected = this.entries.filter((entry) => {
      if (since !== undefined && entry.timestamp < since) return false;
      if (until !== undefined && entry.timestamp > until) return false;
      return true;
    });

    onEvent?.({ type: "export_start", entryCount: selected.length });

    try {
      let successCount = 0;
      let failureCount = 0;
      let totalDurationMs = 0;
      const methods: Record<string, { count: number; totalDurationMs: number }> =
        {};

      for (const entry of selected) {
        if (entry.success) {
          successCount += 1;
        } else {
          failureCount += 1;
        }
        totalDurationMs += entry.durationMs;

        const bucket = methods[entry.method] ?? {
          count: 0,
          totalDurationMs: 0,
        };
        bucket.count += 1;
        bucket.totalDurationMs += entry.durationMs;
        methods[entry.method] = bucket;
      }

      const result: AnalyticsDashboardExport = {
        generatedAt: new Date().toISOString(),
        totalEntries: selected.length,
        successCount,
        failureCount,
        totalDurationMs,
        methods,
        entries: selected.map((entry) => ({ ...entry })),
      };

      onEvent?.({ type: "export_complete", export: result });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      onEvent?.({ type: "export_error", error });
      throw error;
    }
  }
}
