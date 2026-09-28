import { ApprovalTimeoutError } from "./errors.js";
import { emitSdkEvent } from "./events.js";
import type { ApprovalSessionResult, MultiSigPolicy } from "./types.js";

export type NotificationAdapter = (signerPublicKey: string, txXdr: string) => void | Promise<void>;
export type SignatureApplier = (
  txXdr: string,
  signatures: ReadonlyMap<string, string>,
) => string;

export interface ApprovalWorkflowOptions {
  notifySigner?: NotificationAdapter;
  applySignatures?: SignatureApplier;
}

export interface PaymentForwardingRule {
  id: string;
  /** Optional source account filter; matches any source when omitted. */
  source?: string;
  /** Optional destination account filter; matches any destination when omitted. */
  destination?: string;
  /** Optional asset code filter; matches any asset when omitted. */
  assetCode?: string;
  /** Optional inclusive minimum amount filter. */
  minAmount?: number;
  /** Optional inclusive maximum amount filter. */
  maxAmount?: number;
  /** Account that receives the forwarded payment. */
  forwardTo: string;
}

export interface PaymentForwardingRequest {
  source: string;
  destination: string;
  assetCode: string;
  amount: number;
}

export interface PaymentForwardingDecision {
  forwarded: boolean;
  ruleId?: string;
  forwardTo?: string;
}

export class PaymentForwardingRulesEngine {
  private readonly rules: PaymentForwardingRule[] = [];

  constructor(rules: readonly PaymentForwardingRule[] = []) {
    for (const rule of rules) {
      this.addRule(rule);
    }
  }

  addRule(rule: PaymentForwardingRule): void {
    if (!rule.id) {
      throw new Error("Payment forwarding rule requires an id");
    }
    if (!rule.forwardTo) {
      throw new Error(`Payment forwarding rule requires a forwardTo account: ${rule.id}`);
    }
    this.rules.push(rule);
    emitSdkEvent("paymentForwardingRuleAdded", { ruleId: rule.id });
  }

  getRules(): readonly PaymentForwardingRule[] {
    return this.rules;
  }

  evaluate(request: PaymentForwardingRequest): PaymentForwardingDecision {
    const rule = this.rules.find((candidate) => this.matches(candidate, request));
    if (!rule) {
      emitSdkEvent("paymentForwardingSkipped", {
        source: request.source,
        destination: request.destination,
      });
      return { forwarded: false };
    }

    emitSdkEvent("paymentForwarded", {
      ruleId: rule.id,
      forwardTo: rule.forwardTo,
      amount: request.amount,
    });
    return { forwarded: true, ruleId: rule.id, forwardTo: rule.forwardTo };
  }

  private matches(rule: PaymentForwardingRule, request: PaymentForwardingRequest): boolean {
    if (rule.source !== undefined && rule.source !== request.source) return false;
    if (rule.destination !== undefined && rule.destination !== request.destination) return false;
    if (rule.assetCode !== undefined && rule.assetCode !== request.assetCode) return false;
    if (rule.minAmount !== undefined && request.amount < rule.minAmount) return false;
    if (rule.maxAmount !== undefined && request.amount > rule.maxAmount) return false;
    return true;
  }
}

export class ApprovalSession {
  private readonly signatures = new Map<string, string>();
  private readonly signerWeights = new Map<string, number>();
  private readonly rejections = new Set<string>();
  private readonly expiresAt: number;
  private completed = false;
  private rejected = false;
  private executed = false;
  private timer: ReturnType<typeof setTimeout>;

  constructor(
    private readonly txXdr: string,
    private readonly policy: MultiSigPolicy,
    private readonly applySignatures: SignatureApplier,
  ) {
    for (const signer of policy.signers) {
      this.signerWeights.set(signer.publicKey, signer.weight);
    }
    this.expiresAt = Date.now() + policy.timeoutMs;
    this.timer = setTimeout(() => undefined, policy.timeoutMs);
  }

  submitSignature(signerPublicKey: string, signatureBase64: string): ApprovalSessionResult {
    this.assertActive();
    if (!this.signerWeights.has(signerPublicKey)) {
      throw new Error(`Signer is not authorized: ${signerPublicKey}`);
    }

    this.signatures.set(signerPublicKey, signatureBase64);
    this.rejections.delete(signerPublicKey);
    emitSdkEvent("approvalReceived", { signerPublicKey });

    if (this.weight >= this.policy.threshold) {
      this.completed = true;
      clearTimeout(this.timer);
      emitSdkEvent("approvalWorkflowComplete", { signerCount: this.signatures.size });
    }

    return { complete: this.completed, weight: this.weight };
  }

  reject(signerPublicKey: string): WithdrawalApprovalResult {
    this.assertActive();
    if (!this.signerWeights.has(signerPublicKey)) {
      throw new Error(`Signer is not authorized: ${signerPublicKey}`);
    }

    this.rejections.add(signerPublicKey);
    this.signatures.delete(signerPublicKey);
    this.rejected = true;
    clearTimeout(this.timer);
    emitSdkEvent("approvalRejected", { signerPublicKey });

    return this.status();
  }

  execute(): string {
    this.assertActive();
    if (!this.completed) {
      throw new Error("Approval threshold has not been reached");
    }
    if (this.executed) {
      throw new Error("Withdrawal has already been executed");
    }

    const signedXdr = this.applySignatures(this.txXdr, this.signatures);
    this.executed = true;
    emitSdkEvent("approvalExecuted", { signerCount: this.signatures.size });
    return signedXdr;
  }

  getSignedXdr(): string {
    this.assertActive();
    if (!this.completed) {
      throw new Error("Approval threshold has not been reached");
    }
    return this.applySignatures(this.txXdr, this.signatures);
  }

  status(): WithdrawalApprovalResult {
    return {
      state: this.state,
      weight: this.weight,
      threshold: this.policy.threshold,
      approvals: this.signatures.size,
      rejections: this.rejections.size,
    };
  }

  private get state(): WithdrawalApprovalState {
    if (this.executed) return "executed";
    if (this.rejected) return "rejected";
    if (this.completed) return "approved";
    if (Date.now() > this.expiresAt) return "expired";
    return "pending";
  }

  private get weight(): number {
    let total = 0;
    for (const publicKey of this.signatures.keys()) {
      total += this.signerWeights.get(publicKey) ?? 0;
    }
    return total;
  }

  private assertActive(): void {
    if (this.completed || this.rejected) return;
    if (Date.now() > this.expiresAt) {
      clearTimeout(this.timer);
      throw new ApprovalTimeoutError(this.policy.timeoutMs);
    }
  }
}

export class ApprovalWorkflowSequencer {
  constructor(private readonly options: ApprovalWorkflowOptions = {}) {}

  initiate(txXdr: string, policy: MultiSigPolicy): ApprovalSession {
    const session = new ApprovalSession(
      txXdr,
      policy,
      this.options.applySignatures ?? ((xdr) => xdr),
    );

    for (const signer of policy.signers) {
      emitSdkEvent("approvalRequested", { signerPublicKey: signer.publicKey });
      void this.options.notifySigner?.(signer.publicKey, txXdr);
    }

    return session;
  }
}
