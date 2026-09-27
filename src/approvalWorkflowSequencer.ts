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

export type WithdrawalApprovalState =
  | "pending"
  | "approved"
  | "rejected"
  | "executed"
  | "expired";

export interface WithdrawalApprovalResult {
  state: WithdrawalApprovalState;
  weight: number;
  threshold: number;
  approvals: number;
  rejections: number;
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
