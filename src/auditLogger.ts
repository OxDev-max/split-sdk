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

/** Lifecycle states for a custody withdrawal approval workflow. */
export type WithdrawalApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "executed";

/** A single approval decision recorded by an approver. */
export interface WithdrawalApprovalDecision {
  approverId: string;
  approved: boolean;
  decidedAt: number;
  reason?: string;
}

/** A custody withdrawal request tracked through its approval lifecycle. */
export interface WithdrawalApprovalRequest {
  requestId: string;
  accountId: string;
  assetCode: string;
  amount: string;
  requiredApprovals: number;
  status: WithdrawalApprovalStatus;
  submittedAt: number;
  decisions: WithdrawalApprovalDecision[];
  executedAt?: number;
}

/** Events emitted as a withdrawal approval workflow progresses. */
export type WithdrawalApprovalEvent =
  | { type: "submitted"; request: WithdrawalApprovalRequest }
  | { type: "approved"; request: WithdrawalApprovalRequest; decision: WithdrawalApprovalDecision }
  | { type: "rejected"; request: WithdrawalApprovalRequest; decision: WithdrawalApprovalDecision }
  | { type: "executed"; request: WithdrawalApprovalRequest };

const STELLAR_ADDRESS_RE = /^G[A-Z0-9]{55}$/;

/** Detect if a string value looks like base64-encoded XDR. */
const XDR_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Heuristic minimum length for XDR base64 strings (at least ~40 chars for a minimal tx). */
const MIN_XDR_LENGTH = 40;

export class AuditLogger {
  private readonly sink: (entry: AuditEntry) => void;
  private readonly splitAuditTrails = new Map<string, SplitAuditEntry[]>();
  private readonly withdrawalRequests = new Map<string, WithdrawalApprovalRequest>();
  private readonly withdrawalListeners = new Set<
    (event: WithdrawalApprovalEvent) => void
  >();

  constructor(sink: (entry: AuditEntry) => void) {
    this.sink = sink;
  }

  log(entry: AuditEntry): void {
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
   * Subscribe to withdrawal approval lifecycle events. Returns an unsubscribe
   * function.
   */
  onWithdrawalApprovalEvent(
    listener: (event: WithdrawalApprovalEvent) => void,
  ): () => void {
    this.withdrawalListeners.add(listener);
    return () => this.withdrawalListeners.delete(listener);
  }

  private emitWithdrawalEvent(event: WithdrawalApprovalEvent): void {
    for (const listener of this.withdrawalListeners) {
      listener(event);
    }
  }

  /**
   * Submit a new custody withdrawal request, entering the `pending` state.
   * Emits a `submitted` event and writes an audit entry.
   */
  submitWithdrawalRequest(params: {
    requestId: string;
    accountId: string;
    assetCode: string;
    amount: string;
    requiredApprovals: number;
  }): WithdrawalApprovalRequest {
    if (this.withdrawalRequests.has(params.requestId)) {
      throw new Error(
        `Withdrawal request ${params.requestId} already exists`,
      );
    }
    if (params.requiredApprovals < 1) {
      throw new Error("requiredApprovals must be at least 1");
    }

    const request: WithdrawalApprovalRequest = {
      requestId: params.requestId,
      accountId: params.accountId,
      assetCode: params.assetCode,
      amount: params.amount,
      requiredApprovals: params.requiredApprovals,
      status: "pending",
      submittedAt: Date.now(),
      decisions: [],
    };

    this.withdrawalRequests.set(request.requestId, request);
    this.log({
      timestamp: request.submittedAt,
      method: "withdrawal_submitted",
      params: this.sanitize({
        requestId: request.requestId,
        accountId: request.accountId,
        assetCode: request.assetCode,
        amount: request.amount,
        requiredApprovals: request.requiredApprovals,
      }),
      success: true,
      durationMs: 0,
    });
    this.emitWithdrawalEvent({ type: "submitted", request });
    return request;
  }

  /**
   * Record an approver's decision. Once the number of approvals reaches
   * `requiredApprovals`, the request transitions to `approved`. A single
   * rejection transitions the request to `rejected`. Decisions on a request
   * that is no longer `pending` are rejected.
   */
  recordWithdrawalDecision(params: {
    requestId: string;
    approverId: string;
    approved: boolean;
    reason?: string;
  }): WithdrawalApprovalRequest {
    const request = this.withdrawalRequests.get(params.requestId);
    if (!request) {
      throw new Error(`Unknown withdrawal request ${params.requestId}`);
    }
    if (request.status !== "pending") {
      throw new Error(
        `Withdrawal request ${params.requestId} is not pending (status: ${request.status})`,
      );
    }
    if (request.decisions.some((d) => d.approverId === params.approverId)) {
      throw new Error(
        `Approver ${params.approverId} already decided on ${params.requestId}`,
      );
    }

    const decision: WithdrawalApprovalDecision = {
      approverId: params.approverId,
      approved: params.approved,
      decidedAt: Date.now(),
      reason: params.reason,
    };
    request.decisions.push(decision);

    if (!decision.approved) {
      request.status = "rejected";
    } else if (
      request.decisions.filter((d) => d.approved).length >=
      request.requiredApprovals
    ) {
      request.status = "approved";
    }

    this.log({
      timestamp: decision.decidedAt,
      method: decision.approved
        ? "withdrawal_approved"
        : "withdrawal_rejected",
      params: this.sanitize({
        requestId: request.requestId,
        approverId: decision.approverId,
        reason: decision.reason ?? "",
        status: request.status,
      }),
      success: true,
      durationMs: 0,
    });
    this.emitWithdrawalEvent({
      type: decision.approved ? "approved" : "rejected",
      request,
      decision,
    });
    return request;
  }

  /**
   * Execute an approved withdrawal request. Only requests in the `approved`
   * state may be executed; this transitions them to `executed`.
   */
  executeWithdrawalRequest(requestId: string): WithdrawalApprovalRequest {
    const request = this.withdrawalRequests.get(requestId);
    if (!request) {
      throw new Error(`Unknown withdrawal request ${requestId}`);
    }
    if (request.status !== "approved") {
      throw new Error(
        `Withdrawal request ${requestId} cannot be executed (status: ${request.status})`,
      );
    }

    request.status = "executed";
    request.executedAt = Date.now();

    this.log({
      timestamp: request.executedAt,
      method: "withdrawal_executed",
      params: this.sanitize({
        requestId: request.requestId,
        accountId: request.accountId,
        assetCode: request.assetCode,
        amount: request.amount,
      }),
      success: true,
      durationMs: 0,
    });
    this.emitWithdrawalEvent({ type: "executed", request });
    return request;
  }

  /** Return the current state of a withdrawal approval request. */
  getWithdrawalRequest(requestId: string): WithdrawalApprovalRequest | undefined {
    return this.withdrawalRequests.get(requestId);
  }
}
