/** Generic wallet adapter interface for signing Stellar transactions. */
export interface WalletAdapter {
  /** Return the wallet's public key (G... address). */
  getAddress(): Promise<string>;
  /**
   * Sign a transaction XDR string.
   *
   * @param xdr     - Base64-encoded transaction XDR.
   * @param network - Network passphrase.
   * @returns Signed transaction XDR.
   */
  signTransaction(xdr: string, network: string): Promise<string>;
}

/**
 * Lifecycle events emitted by a signing delegation.
 *
 * - `created`: a delegation was registered for a custody solution.
 * - `used`:    a delegated signer produced a signature for a transaction.
 * - `revoked`: a delegation was revoked and can no longer sign.
 */
export type SigningDelegationEventType = 'created' | 'used' | 'revoked';

/** Payload delivered to signing delegation event listeners. */
export interface SigningDelegationEvent {
  /** Which lifecycle transition occurred. */
  type: SigningDelegationEventType;
  /** Identifier of the delegation the event refers to. */
  delegationId: string;
  /** Public key of the custody solution that owns the delegation. */
  owner: string;
  /** Public key of the delegate authorized to sign on the owner's behalf. */
  delegate: string;
  /** Base64-encoded transaction XDR, present for `used` events. */
  xdr?: string;
  /** Network passphrase, present for `used` events. */
  network?: string;
  /** Signed transaction XDR, present for `used` events. */
  signedXdr?: string;
  /** Unix epoch milliseconds when the event was emitted. */
  timestamp: number;
}

/** Listener invoked for each signing delegation lifecycle event. */
export type SigningDelegationListener = (event: SigningDelegationEvent) => void;

/**
 * A signing delegation that lets a custody solution authorize a delegate
 * (e.g. an SDK-managed key) to sign transactions on its behalf.
 */
export interface SigningDelegation {
  /** Unique identifier of the delegation. */
  readonly id: string;
  /** Public key of the custody solution that owns the delegation. */
  readonly owner: string;
  /** Public key of the delegate authorized to sign. */
  readonly delegate: string;
  /** Whether the delegation is still active. */
  readonly active: boolean;
  /** Unix epoch milliseconds when the delegation was created. */
  readonly createdAt: number;
  /** Unix epoch milliseconds when the delegation was revoked, if revoked. */
  readonly revokedAt?: number;
}

/**
 * Options accepted when creating a signing delegation.
 */
export interface CreateSigningDelegationOptions {
  /** Public key of the custody solution that owns the delegation. */
  owner: string;
  /** Public key of the delegate authorized to sign on the owner's behalf. */
  delegate: string;
  /** Optional explicit delegation id; generated when omitted. */
  id?: string;
}

/**
 * SDK transaction signing delegation for custody solutions.
 *
 * A custody solution registers a delegate that is allowed to sign
 * transactions on its behalf. The delegate signs through the SDK, and the
 * delegation emits lifecycle events so custody providers can audit usage.
 */
export interface SigningDelegationManager {
  /**
   * Register a new delegation authorizing `delegate` to sign for `owner`.
   * Emits a `created` event.
   */
  createDelegation(options: CreateSigningDelegationOptions): SigningDelegation;
  /** Look up a delegation by id, or `undefined` when unknown. */
  getDelegation(id: string): SigningDelegation | undefined;
  /** List all delegations, optionally filtered by owner public key. */
  listDelegations(owner?: string): SigningDelegation[];
  /**
   * Sign a transaction XDR using an active delegation.
   * Emits a `used` event on success.
   *
   * @param delegationId - Delegation authorizing the signature.
   * @param xdr          - Base64-encoded transaction XDR.
   * @param network      - Network passphrase.
   * @returns Signed transaction XDR.
   */
  signWithDelegation(
    delegationId: string,
    xdr: string,
    network: string,
  ): Promise<string>;
  /**
   * Revoke a delegation so it can no longer sign.
   * Emits a `revoked` event.
   */
  revokeDelegation(id: string): SigningDelegation;
  /** Subscribe to delegation lifecycle events. Returns an unsubscribe fn. */
  onDelegationEvent(listener: SigningDelegationListener): () => void;
}
