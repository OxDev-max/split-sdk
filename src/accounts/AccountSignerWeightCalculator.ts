/**
 * AccountSignerWeightCalculator — pre-flight multi-sig weight check.
 *
 * Fetches a Stellar account's signers and thresholds from Horizon and
 * determines whether a proposed set of signing keys meets or exceeds the
 * required threshold before a transaction is submitted.
 *
 * Results are cached per accountId for 30 seconds to avoid redundant calls
 * during batch pre-flights.
 *
 * Issue #477
 */

import { Horizon } from "@stellar/stellar-sdk";
import { InsufficientSignerWeightError } from "../errors.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ThresholdLevel = "low" | "medium" | "high";

export interface SignerWeightResult {
  /** Sum of weights for the provided signing keys that are present on the account. */
  totalWeight: number;
  /** The threshold value required for the requested level. */
  requiredThreshold: number;
  /** Whether totalWeight >= requiredThreshold. */
  sufficient: boolean;
  /** How much more weight is needed (0 when sufficient). */
  missingWeight: number;
}

/**
 * A single signer entry used when building a multi-signature transaction.
 */
export interface MultiSigSigner {
  /** The signer's public key (G… address, pre-auth tx, or hash(x)). */
  key: string;
  /** The weight this signer contributes toward the threshold. */
  weight: number;
}

/**
 * A fully-built multi-signature transaction plan.
 */
export interface MultiSigTransaction {
  /** The account that owns the transaction. */
  accountId: string;
  /** The threshold level the transaction must satisfy. */
  threshold: ThresholdLevel;
  /** The signers that will be required to sign. */
  signers: MultiSigSigner[];
  /** The total weight contributed by the configured signers. */
  totalWeight: number;
  /** The threshold value required for the requested level. */
  requiredThreshold: number;
  /** Whether the configured signers satisfy the required threshold. */
  sufficient: boolean;
}

/**
 * Events emitted by the MultiSigTransactionBuilder during its lifecycle.
 */
export type MultiSigBuilderEvent =
  | { type: "signerAdded"; signer: MultiSigSigner }
  | { type: "signerRemoved"; key: string }
  | { type: "thresholdSet"; threshold: ThresholdLevel }
  | { type: "built"; transaction: MultiSigTransaction };

export type MultiSigBuilderListener = (event: MultiSigBuilderEvent) => void;

// ---------------------------------------------------------------------------
// Cache entry
// ---------------------------------------------------------------------------

interface CacheEntry {
  record: Horizon.AccountResponse;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// AccountSignerWeightCalculator
// ---------------------------------------------------------------------------

export class AccountSignerWeightCalculator {
  private readonly server: Horizon.Server;
  /** Cache TTL in milliseconds (default 30 seconds). */
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(horizonUrl: string, cacheTtlMs = 30_000) {
    this.server = new Horizon.Server(horizonUrl, { allowHttp: horizonUrl.startsWith("http://") });
    this.cacheTtlMs = cacheTtlMs;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Calculate whether the provided signing keys satisfy the required threshold
   * for the given accountId.
   *
   * @param accountId      - The Stellar account G… address.
   * @param signerPublicKeys - List of public keys that will sign the transaction.
   * @param threshold      - Which threshold level to check: 'low', 'medium', or 'high'.
   * @returns SignerWeightResult
   */
  async calculateWeight(
    accountId: string,
    signerPublicKeys: string[],
    threshold: ThresholdLevel,
  ): Promise<SignerWeightResult> {
    const account = await this._loadAccount(accountId);
    return this._compute(account, signerPublicKeys, threshold);
  }

  /**
   * Asserts that the provided signing keys are sufficient, or throws
   * InsufficientSignerWeightError with a detailed payload.
   *
   * @throws {InsufficientSignerWeightError}
   */
  async assertSufficientWeight(
    accountId: string,
    signerPublicKeys: string[],
    threshold: ThresholdLevel,
  ): Promise<void> {
    const result = await this.calculateWeight(accountId, signerPublicKeys, threshold);
    if (!result.sufficient) {
      throw new InsufficientSignerWeightError(
        signerPublicKeys,
        result.totalWeight,
        result.requiredThreshold,
      );
    }
  }

  /**
   * Manually evict a cached account record (useful in tests or after account updates).
   */
  evict(accountId: string): void {
    this.cache.delete(accountId);
  }

  /**
   * Check whether the provided signing keys meet the required threshold
   * for the given account. Returns `true` if sufficient, `false` otherwise.
   *
   * Missing signers (not on the account) contribute 0 weight.
   *
   * @param accountId      - The Stellar account G… address.
   * @param signers        - List of public keys that will sign the transaction.
   * @param threshold      - Which threshold level to check: 'low', 'medium', or 'high'.
   */
  async meetsThreshold(
    accountId: string,
    signers: string[],
    threshold: ThresholdLevel,
  ): Promise<boolean> {
    const result = await this.calculateWeight(accountId, signers, threshold);
    return result.sufficient;
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private async _loadAccount(accountId: string): Promise<Horizon.AccountResponse> {
    const now = Date.now();
    const entry = this.cache.get(accountId);

    if (entry && entry.expiresAt > now) {
      return entry.record;
    }

    const record = await this.server.loadAccount(accountId);

    this.cache.set(accountId, {
      record,
      expiresAt: now + this.cacheTtlMs,
    });

    return record;
  }

  private _compute(
    account: Horizon.AccountResponse,
    signerPublicKeys: string[],
    threshold: ThresholdLevel,
  ): SignerWeightResult {
    const provided = new Set(signerPublicKeys);

    // Sum weights for all signers whose key is in the provided set.
    // The Horizon AccountResponse.signers array includes the master key
    // as well as pre-auth and hash(x) signers.
    let totalWeight = 0;
    for (const signer of account.signers) {
      if (provided.has(signer.key)) {
        totalWeight += signer.weight;
      }
    }

    const requiredThreshold = this._resolveThreshold(account, threshold);
    const sufficient = totalWeight >= requiredThreshold;
    const missingWeight = sufficient ? 0 : requiredThreshold - totalWeight;

    return { totalWeight, requiredThreshold, sufficient, missingWeight };
  }

  private _resolveThreshold(
    account: Horizon.AccountResponse,
    threshold: ThresholdLevel,
  ): number {
    switch (threshold) {
      case "low":
        return account.thresholds.low_threshold;
      case "medium":
        return account.thresholds.med_threshold;
      case "high":
        return account.thresholds.high_threshold;
    }
  }
}

// ---------------------------------------------------------------------------
// MultiSigTransactionBuilder
// ---------------------------------------------------------------------------

/**
 * Builds multi-signature transaction plans by collecting signers and a target
 * threshold, then validating the collected weight against the account's
 * on-chain thresholds via {@link AccountSignerWeightCalculator}.
 *
 * Emits lifecycle events so callers can react to signer/threshold changes and
 * to the final build result.
 *
 * Issue #914
 */
export class MultiSigTransactionBuilder {
  private readonly calculator: AccountSignerWeightCalculator;
  private readonly accountId: string;
  private readonly signers = new Map<string, MultiSigSigner>();
  private readonly listeners = new Set<MultiSigBuilderListener>();
  private threshold: ThresholdLevel = "medium";

  constructor(accountId: string, calculator: AccountSignerWeightCalculator) {
    this.accountId = accountId;
    this.calculator = calculator;
  }

  /**
   * Register a listener for builder lifecycle events.
   *
   * @returns An unsubscribe function that removes the listener.
   */
  on(listener: MultiSigBuilderListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Add a signer to the transaction. Re-adding an existing key updates its weight.
   */
  addSigner(key: string, weight: number): this {
    const signer: MultiSigSigner = { key, weight };
    this.signers.set(key, signer);
    this._emit({ type: "signerAdded", signer });
    return this;
  }

  /**
   * Remove a signer by key. No-op if the key is not present.
   */
  removeSigner(key: string): this {
    if (this.signers.delete(key)) {
      this._emit({ type: "signerRemoved", key });
    }
    return this;
  }

  /**
   * Set the threshold level the transaction must satisfy.
   */
  setThreshold(threshold: ThresholdLevel): this {
    this.threshold = threshold;
    this._emit({ type: "thresholdSet", threshold });
    return this;
  }

  /**
   * The signers currently configured on the builder.
   */
  getSigners(): MultiSigSigner[] {
    return Array.from(this.signers.values());
  }

  /**
   * Build the multi-signature transaction plan, validating the configured
   * signers against the account's on-chain thresholds.
   *
   * @throws {InsufficientSignerWeightError} when the configured signers do not
   *   meet the required threshold.
   */
  async build(): Promise<MultiSigTransaction> {
    const signers = this.getSigners();
    const keys = signers.map((s) => s.key);

    const result = await this.calculator.calculateWeight(this.accountId, keys, this.threshold);

    if (!result.sufficient) {
      throw new InsufficientSignerWeightError(keys, result.totalWeight, result.requiredThreshold);
    }

    const transaction: MultiSigTransaction = {
      accountId: this.accountId,
      threshold: this.threshold,
      signers,
      totalWeight: result.totalWeight,
      requiredThreshold: result.requiredThreshold,
      sufficient: result.sufficient,
    };

    this._emit({ type: "built", transaction });
    return transaction;
  }

  private _emit(event: MultiSigBuilderEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
