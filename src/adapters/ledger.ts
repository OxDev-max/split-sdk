import TransportWebHID from "@ledgerhq/hw-transport-webhid";
import type Transport from "@ledgerhq/hw-transport";
import Str from "@ledgerhq/hw-app-str";
import type { WalletAdapter } from "../types.js";

/** Lifecycle events emitted by the signing delegation flow. */
export type DelegationEventType = "created" | "used" | "revoked";

export interface DelegationEvent {
  type: DelegationEventType;
  delegationId: string;
  publicKey: string;
  timestamp: number;
}

export type DelegationEventListener = (event: DelegationEvent) => void;

/** A scoped signing delegation granted to a custody solution. */
export interface SigningDelegation {
  id: string;
  /** Public key of the delegating account. */
  publicKey: string;
  /** Identifier of the custody solution receiving the delegation. */
  delegatee: string;
  /** Optional expiry (epoch ms). Undefined means no expiry. */
  expiresAt?: number;
  /** Optional maximum number of signatures allowed. */
  maxUses?: number;
  uses: number;
  revoked: boolean;
}

/** Ledger hardware wallet adapter implementing WalletAdapter. */
export class LedgerAdapter implements WalletAdapter {
  private readonly path: string;
  private readonly delegations = new Map<string, SigningDelegation>();
  private readonly listeners = new Set<DelegationEventListener>();

  constructor(path = "44'/148'/0'") {
    this.path = path;
  }

  async getAddress(): Promise<string> {
    const transport = await this.openTransport();
    try {
      const str = new Str(transport);
      const { publicKey } = await str.getPublicKey(this.path);
      return publicKey;
    } finally {
      await transport.close();
    }
  }

  async signTransaction(xdr: string, _network: string): Promise<string> {
    const transport = await this.openTransport();
    try {
      const str = new Str(transport);
      const txBytes = Uint8Array.from(atob(xdr), (c) => c.charCodeAt(0));
      const { signature } = await str.signTransaction(
        this.path,
        txBytes as unknown as Buffer
      );
      const sigBytes = signature as unknown as Uint8Array;
      return btoa(String.fromCharCode(...sigBytes));
    } finally {
      await transport.close();
    }
  }

  /**
   * Register a listener for delegation lifecycle events.
   * Returns an unsubscribe function.
   */
  onDelegationEvent(listener: DelegationEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Create a signing delegation for a custody solution. The delegation is
   * scoped to the adapter's account and may be bounded by expiry and/or a
   * maximum number of uses.
   */
  async createDelegation(options: {
    delegatee: string;
    expiresAt?: number;
    maxUses?: number;
  }): Promise<SigningDelegation> {
    if (!options.delegatee) {
      throw new Error("A delegatee is required to create a signing delegation.");
    }
    const publicKey = await this.getAddress();
    const delegation: SigningDelegation = {
      id: this.generateDelegationId(),
      publicKey,
      delegatee: options.delegatee,
      expiresAt: options.expiresAt,
      maxUses: options.maxUses,
      uses: 0,
      revoked: false,
    };
    this.delegations.set(delegation.id, delegation);
    this.emit({
      type: "created",
      delegationId: delegation.id,
      publicKey,
      timestamp: Date.now(),
    });
    return delegation;
  }

  /** Retrieve a previously created delegation by id. */
  getDelegation(delegationId: string): SigningDelegation | undefined {
    return this.delegations.get(delegationId);
  }

  /**
   * Sign a transaction on behalf of a custody solution using an existing
   * delegation. Enforces revocation, expiry, and usage limits before
   * delegating to the hardware signer.
   */
  async signWithDelegation(
    delegationId: string,
    xdr: string,
    network: string
  ): Promise<string> {
    const delegation = this.delegations.get(delegationId);
    if (!delegation) {
      throw new Error(`Unknown signing delegation: ${delegationId}`);
    }
    if (delegation.revoked) {
      throw new Error(`Signing delegation ${delegationId} has been revoked.`);
    }
    if (delegation.expiresAt !== undefined && Date.now() > delegation.expiresAt) {
      throw new Error(`Signing delegation ${delegationId} has expired.`);
    }
    if (
      delegation.maxUses !== undefined &&
      delegation.uses >= delegation.maxUses
    ) {
      throw new Error(
        `Signing delegation ${delegationId} has reached its maximum number of uses.`
      );
    }

    const signature = await this.signTransaction(xdr, network);
    delegation.uses += 1;
    this.emit({
      type: "used",
      delegationId: delegation.id,
      publicKey: delegation.publicKey,
      timestamp: Date.now(),
    });
    return signature;
  }

  /** Revoke a delegation so it can no longer be used for signing. */
  revokeDelegation(delegationId: string): void {
    const delegation = this.delegations.get(delegationId);
    if (!delegation) {
      throw new Error(`Unknown signing delegation: ${delegationId}`);
    }
    if (delegation.revoked) {
      return;
    }
    delegation.revoked = true;
    this.emit({
      type: "revoked",
      delegationId: delegation.id,
      publicKey: delegation.publicKey,
      timestamp: Date.now(),
    });
  }

  private emit(event: DelegationEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private generateDelegationId(): string {
    const cryptoObj = globalThis.crypto;
    if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
      return cryptoObj.randomUUID();
    }
    return `delegation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  private async openTransport(): Promise<Transport> {
    try {
      return await TransportWebHID.create();
    } catch {
      throw new Error(
        "Ledger device not connected. Please connect your Ledger and open the Stellar app."
      );
    }
  }
}
