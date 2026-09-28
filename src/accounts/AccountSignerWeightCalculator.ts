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
 * A single custody account signer entry, as returned by the custody account
 * management helpers.
 */
export interface CustodySigner {
  /** The signer's public key (G… address, pre-auth tx, or hash(x)). */
  key: string;
  /** The signing weight assigned to this signer. */
  weight: number;
}

/**
 * A snapshot of a custody account's signer configuration and thresholds.
 */
export interface CustodyAccount {
  /** The Stellar account G… address. */
  accountId: string;
  /** The account's current signers. */
  signers: CustodySigner[];
  /** The account's threshold configuration. */
  thresholds: {
    low: number;
    medium: number;
    high: number;
  };
}

/**
 * Event names emitted by the custody account management helpers during
 * lifecycle operations.
 */
export type CustodyAccountEvent =
  | "signer:added"
  | "signer:removed"
  | "signer:updated"
  | "threshold:updated"
  | "account:loaded";

/**
 * Payload delivered to custody account event listeners.
 */
export interface CustodyAccountEventPayload {
  /** The account the event pertains to. */
  accountId: string;
  /** The lifecycle event that occurred. */
  event: CustodyAccountEvent;
  /** The signer affected by the event, when applicable. */
  signer?: CustodySigner;
  /** The threshold level affected by the event, when applicable. */
  thresholdLevel?: ThresholdLevel;
  /** The previous value before the change, when applicable. */
  previousValue?: number;
  /** The new value after the change, when applicable. */
  newValue?: number;
}

export type CustodyAccountEventListener = (payload: CustodyAccountEventPayload) => void;

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
  private readonly listeners = new Set<CustodyAccountEventListener>();

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
  // Custody account management helpers
  // --------------------------------------------------------------------------

  /**
   * Load a custody account snapshot (signers + thresholds) from Horizon.
   * Emits an `account:loaded` event on success.
   */
  async loadCustodyAccount(accountId: string): Promise<CustodyAccount> {
    const record = await this._loadAccount(accountId);
    const account = this._toCustodyAccount(accountId, record);
    this._emit({ accountId, event: "account:loaded" });
    return account;
  }

  /**
   * Add a signer to a custody account snapshot. If the signer already exists
   * its weight is updated instead. Emits `signer:added` or `signer:updated`.
   */
  addSigner(account: CustodyAccount, signer: CustodySigner): CustodyAccount {
    const existing = account.signers.find((s) => s.key === signer.key);
    let next: CustodyAccount;

    if (existing) {
      next = {
        ...account,
        signers: account.signers.map((s) => (s.key === signer.key ? { ...signer } : s)),
      };
      this._emit({
        accountId: account.accountId,
        event: "signer:updated",
        signer: { ...signer },
        previousValue: existing.weight,
        newValue: signer.weight,
      });
    } else {
      next = { ...account, signers: [...account.signers, { ...signer }] };
      this._emit({
        accountId: account.accountId,
        event: "signer:added",
        signer: { ...signer },
        newValue: signer.weight,
      });
    }

    return next;
  }

  /**
   * Remove a signer from a custody account snapshot by public key.
   * Emits `signer:removed` when a signer was actually removed.
   */
  removeSigner(account: CustodyAccount, signerKey: string): CustodyAccount {
    const existing = account.signers.find((s) => s.key === signerKey);
    if (!existing) {
      return account;
    }

    const next: CustodyAccount = {
      ...account,
      signers: account.signers.filter((s) => s.key !== signerKey),
    };

    this._emit({
      accountId: account.accountId,
      event: "signer:removed",
      signer: { ...existing },
      previousValue: existing.weight,
    });

    return next;
  }

  /**
   * Update a threshold level on a custody account snapshot.
   * Emits `threshold:updated` when the value changes.
   */
  updateThreshold(
    account: CustodyAccount,
    level: ThresholdLevel,
    value: number,
  ): CustodyAccount {
    const previousValue = account.thresholds[level];
    if (previousValue === value) {
      return account;
    }

    const next: CustodyAccount = {
      ...account,
      thresholds: { ...account.thresholds, [level]: value },
    };

    this._emit({
      accountId: account.accountId,
      event: "threshold:updated",
      thresholdLevel: level,
      previousValue,
      newValue: value,
    });

    return next;
  }

  /**
   * Register a listener for custody account lifecycle events.
   * Returns an unsubscribe function.
   */
  onCustodyAccountEvent(listener: CustodyAccountEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private _emit(payload: CustodyAccountEventPayload): void {
    for (const listener of this.listeners) {
      listener(payload);
    }
  }

  private _toCustodyAccount(
    accountId: string,
    record: Horizon.AccountResponse,
  ): CustodyAccount {
    return {
      accountId,
      signers: record.signers.map((s) => ({ key: s.key, weight: s.weight })),
      thresholds: {
        low: record.thresholds.low_threshold,
        medium: record.thresholds.med_threshold,
        high: record.thresholds.high_threshold,
      },
    };
  }

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
