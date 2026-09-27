import type { WalletAdapter } from "./types.js";

/** Options for constructing a WalletConnectAdapter. */
export interface WalletConnectAdapterOptions {
  /** WalletConnect Sign Client instance (from @walletconnect/sign-client). */
  // Typed as unknown to avoid a hard dependency on @walletconnect/sign-client.
  client: {
    request(args: {
      topic: string;
      chainId: string;
      request: { method: string; params: unknown };
    }): Promise<string>;
  };
  /** Active WalletConnect session topic. */
  topic: string;
  /** Stellar chain ID (e.g. "stellar:testnet"). */
  chainId: string;
  /** The connected wallet's Stellar public key. */
  address: string;
}

/** Lifecycle events emitted by the signing delegation. */
export type SigningDelegationEvent =
  | { type: "delegation:created"; delegate: string; expiresAt: number }
  | { type: "delegation:used"; delegate: string; xdr: string }
  | { type: "delegation:revoked"; delegate: string };

export type SigningDelegationListener = (event: SigningDelegationEvent) => void;

/** A custody delegate authorized to sign on behalf of the connected wallet. */
export interface SigningDelegation {
  /** Public key of the custody solution authorized to sign. */
  delegate: string;
  /** Unix timestamp (ms) after which the delegation is no longer valid. */
  expiresAt: number;
}

/**
 * WalletConnect adapter — routes signing through a WalletConnect session
 * instead of the Freighter browser extension.
 *
 * Supports transaction signing delegation for custody solutions: a delegate
 * (e.g. a custody provider) can be authorized to sign transactions on behalf
 * of the connected wallet until the delegation expires or is revoked.
 */
export class WalletConnectAdapter implements WalletAdapter {
  private readonly opts: WalletConnectAdapterOptions;
  private readonly delegations = new Map<string, SigningDelegation>();
  private readonly listeners = new Set<SigningDelegationListener>();

  constructor(opts: WalletConnectAdapterOptions) {
    this.opts = opts;
  }

  async getAddress(): Promise<string> {
    return this.opts.address;
  }

  /**
   * Authorize a custody solution to sign transactions on behalf of the
   * connected wallet until `expiresAt` (Unix ms).
   */
  delegateSigning(delegate: string, expiresAt: number): SigningDelegation {
    const delegation: SigningDelegation = { delegate, expiresAt };
    this.delegations.set(delegate, delegation);
    this.emit({ type: "delegation:created", delegate, expiresAt });
    return delegation;
  }

  /** Revoke a previously granted signing delegation. */
  revokeDelegation(delegate: string): boolean {
    const removed = this.delegations.delete(delegate);
    if (removed) {
      this.emit({ type: "delegation:revoked", delegate });
    }
    return removed;
  }

  /** List currently active (non-expired) signing delegations. */
  listDelegations(): SigningDelegation[] {
    const now = Date.now();
    return [...this.delegations.values()].filter((d) => d.expiresAt > now);
  }

  /** Subscribe to delegation lifecycle events. Returns an unsubscribe fn. */
  onDelegation(listener: SigningDelegationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async signTransaction(xdr: string, network: string): Promise<string> {
    return this.opts.client.request({
      topic: this.opts.topic,
      chainId: this.opts.chainId,
      request: {
        method: "stellar_signXDR",
        params: { xdr, network },
      },
    });
  }

  /**
   * Sign a transaction on behalf of a delegated custody solution. The
   * delegate must hold an active, non-expired delegation.
   */
  async signTransactionAs(
    delegate: string,
    xdr: string,
    network: string,
  ): Promise<string> {
    const delegation = this.delegations.get(delegate);
    if (!delegation || delegation.expiresAt <= Date.now()) {
      throw new Error(`No active signing delegation for ${delegate}`);
    }
    const signed = await this.signTransaction(xdr, network);
    this.emit({ type: "delegation:used", delegate, xdr });
    return signed;
  }

  private emit(event: SigningDelegationEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
