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
 * A single cross-tenant invoice audit record.
 *
 * Captures which tenant performed an action against an invoice owned by
 * another tenant, so cross-tenant access can be recorded, queried, and
 * verified after the fact.
 */
export interface CrossTenantInvoiceAuditEntry {
  /** Tenant that owns the invoice being acted upon. */
  ownerTenantId: string;
  /** Tenant that performed the action. */
  actorTenantId: string;
  /** Invoice the action targeted. */
  invoiceId: string;
  /** Action performed (e.g. "read", "settle", "refund"). */
  action: string;
  /** Whether the cross-tenant access was authorized. */
  authorized: boolean;
  /** When the action occurred (epoch ms). */
  timestamp: number;
  /** Optional free-form context for the action. */
  metadata?: Record<string, unknown>;
}

/** Lifecycle events emitted by the cross-tenant invoice auditor. */
export type CrossTenantAuditEvent =
  | { type: "invoice_audited"; entry: CrossTenantInvoiceAuditEntry }
  | { type: "cross_tenant_access_detected"; entry: CrossTenantInvoiceAuditEntry }
  | { type: "cross_tenant_access_denied"; entry: CrossTenantInvoiceAuditEntry };

export type CrossTenantAuditEventListener = (
  event: CrossTenantAuditEvent,
) => void;

/** Lifecycle events emitted when SDK debug mode is toggled. */
export type DebugModeEvent =
  | { type: "debug_mode_enabled" }
  | { type: "debug_mode_disabled" };

export type DebugModeEventListener = (event: DebugModeEvent) => void;

const STELLAR_ADDRESS_RE = /^G[A-Z0-9]{55}$/;

/** Detect if a string value looks like base64-encoded XDR. */
const XDR_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Heuristic minimum length for XDR base64 strings (at least ~40 chars for a minimal tx). */
const MIN_XDR_LENGTH = 40;

export class AuditLogger {
  private readonly sink: (entry: AuditEntry) => void;
  private readonly splitAuditTrails = new Map<string, SplitAuditEntry[]>();
  private readonly crossTenantAudits: CrossTenantInvoiceAuditEntry[] = [];
  private readonly crossTenantListeners = new Set<CrossTenantAuditEventListener>();
  private readonly debugListeners = new Set<DebugModeEventListener>();
  private debugEnabled = false;

  constructor(sink: (entry: AuditEntry) => void) {
    this.sink = sink;
  }

  /**
   * Enable or disable SDK debug mode.
   *
   * When enabled, verbose diagnostic output is written for every audit
   * operation. Toggling emits a `debug_mode_enabled` / `debug_mode_disabled`
   * event to all subscribers registered via {@link onDebugModeChange}.
   */
  setDebugMode(enabled: boolean): void {
    if (this.debugEnabled === enabled) {
      return;
    }
    this.debugEnabled = enabled;
    this.emitDebugMode({
      type: enabled ? "debug_mode_enabled" : "debug_mode_disabled",
    });
  }

  /** Whether SDK debug mode is currently enabled. */
  isDebugModeEnabled(): boolean {
    return this.debugEnabled;
  }

  /**
   * Subscribe to debug mode state changes.
   *
   * @returns an unsubscribe function.
   */
  onDebugModeChange(listener: DebugModeEventListener): () => void {
    this.debugListeners.add(listener);
    return () => {
      this.debugListeners.delete(listener);
    };
  }

  /** Emit a verbose debug log line when debug mode is enabled. */
  private debugLog(message: string, context?: Record<string, unknown>): void {
    if (!this.debugEnabled) {
      return;
    }
    const suffix = context ? ` ${JSON.stringify(context)}` : "";
    // eslint-disable-next-line no-console
    console.debug(`[AuditLogger] ${message}${suffix}`);
  }

  private emitDebugMode(event: DebugModeEvent): void {
    for (const listener of this.debugListeners) {
      listener(event);
    }
  }

  log(entry: AuditEntry): void {
    this.debugLog("log", {
      method: entry.method,
      success: entry.success,
      durationMs: entry.durationMs,
    });
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
   * Subscribe to cross-tenant invoice audit lifecycle events.
   *
   * @returns an unsubscribe function.
   */
  onCrossTenantAudit(listener: CrossTenantAuditEventListener): () => void {
    this.crossTenantListeners.add(listener);
    return () => {
      this.crossTenantListeners.delete(listener);
    };
  }

  /**
   * Record a cross-tenant invoice audit entry.
   *
   * Persists the entry to the in-memory cross-tenant trail, writes a
   * sanitized `AuditEntry` to the configured sink, and emits the appropriate
   * lifecycle event:
   * - `cross_tenant_access_detected` when the actor differs from the owner,
   * - `cross_tenant_access_denied` when such access is unauthorized,
   * - `invoice_audited` for every recorded entry.
   */
  recordCrossTenantInvoiceAudit(
    entry: CrossTenantInvoiceAuditEntry,
  ): void {
    this.crossTenantAudits.push(entry);

    this.log({
      timestamp: entry.timestamp,
      method: "cross_tenant_invoice_audit",
      params: this.sanitize({
        ownerTenantId: entry.ownerTenantId,
        actorTenantId: entry.actorTenantId,
        invoiceId: entry.invoiceId,
        action: entry.action,
        authorized: entry.authorized,
        ...(entry.metadata ?? {}),
      }),
      success: entry.authorized,
      durationMs: 0,
    });

    const isCrossTenant = entry.actorTenantId !== entry.ownerTenantId;
    if (isCrossTenant) {
      this.emitCrossTenantAudit({
        type: "cross_tenant_access_detected",
        entry,
      });
      if (!entry.authorized) {
        this.emitCrossTenantAudit({
          type: "cross_tenant_access_denied",
          entry,
        });
      }
    }
    this.emitCrossTenantAudit({ type: "invoice_audited", entry });
  }

  /**
   * Query recorded cross-tenant invoice audit entries.
   *
   * All filters are optional and combined with AND semantics. Results are
   * returned in the order they were recorded.
   */
  queryCrossTenantInvoiceAudits(filter?: {
    ownerTenantId?: string;
    actorTenantId?: string;
    invoiceId?: string;
    action?: string;
    authorized?: boolean;
  }): CrossTenantInvoiceAuditEntry[] {
    return this.crossTenantAudits.filter((entry) => {
      if (filter?.ownerTenantId && entry.ownerTenantId !== filter.ownerTenantId) {
        return false;
      }
      if (filter?.actorTenantId && entry.actorTenantId !== filter.actorTenantId) {
        return false;
      }
      if (filter?.invoiceId && entry.invoiceId !== filter.invoiceId) {
        return false;
      }
      if (filter?.action && entry.action !== filter.action) {
        return false;
      }
      if (
        filter?.authorized !== undefined &&
        entry.authorized !== filter.authorized
      ) {
        return false;
      }
      return true;
    });
  }

  private emitCrossTenantAudit(event: CrossTenantAuditEvent): void {
    for (const listener of this.crossTenantListeners) {
      listener(event);
    }
  }
}
