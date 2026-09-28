/**
 * AccountMergeDetector — Monitors Stellar account merges and automatically reroutes invoice recipients
 * when their accounts are merged into another account.
 *
 * Integrates with HorizonStreamManager to watch for ACCOUNT_MERGE operations.
 */

import { EventEmitter } from "events";
import type { StellarSplitClient } from "../client.js";

export interface AccountMergeEvent {
  /** The account that was merged (source) */
  sourceAccount: string;
  /** The destination account that received the merge */
  destinationAccount: string;
  /** The ledger sequence where the merge occurred */
  ledgerSequence: number;
  /** Timestamp of the merge operation */
  timestamp: Date;
}

export class InvalidDestinationError extends Error {
  constructor(
    public readonly address: string,
    public readonly reason: string,
  ) {
    super(`Invalid destination account ${address}: ${reason}`);
    this.name = "InvalidDestinationError";
  }
}

/** Payload emitted on the "merge" event. */
export interface MergeEventPayload {
  source: string;
  destination: string;
  mergedAt: Date;
}

/**
 * A custody account managed by the detector. Custody accounts are watched
 * accounts whose funds are held on behalf of a recipient and which may be
 * merged into a destination account.
 */
export interface CustodyAccount {
  /** The custody account address */
  address: string;
  /** Optional human-readable label */
  label?: string;
  /** Optional asset the custody account is expected to hold */
  asset?: { code: string; issuer: string };
  /** When the custody account was registered */
  registeredAt: Date;
}

/** Payload emitted on custody account lifecycle events. */
export interface CustodyAccountEventPayload {
  account: CustodyAccount;
  at: Date;
}

export class AccountMergeDetector extends EventEmitter {
  private watchedAccounts = new Set<string>();
  private mergeCache = new Map<string, string>(); // source -> destination mapping
  private custodyAccounts = new Map<string, CustodyAccount>();
  private streamActive = false;
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(
    private client: StellarSplitClient,
    private horizonUrl: string,
  ) {
    super();
  }

  /**
   * Start monitoring for account merge operations.
   */
  start(): void {
    if (this.streamActive) return;
    this.streamActive = true;
    
    // Poll for merge operations every 10 seconds
    this.checkInterval = setInterval(() => {
      this.checkForMerges().catch((err) => {
        console.error("Error checking for account merges:", err);
      });
    }, 10000);
  }

  /**
   * Stop monitoring for account merge operations.
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.streamActive = false;
  }

  /**
   * Add an account to the watch list.
   */
  watchAccount(accountId: string): void {
    this.watchedAccounts.add(accountId);
  }

  /**
   * Remove an account from the watch list.
   */
  unwatchAccount(accountId: string): void {
    this.watchedAccounts.delete(accountId);
  }

  /**
   * Register a custody account and begin watching it for merges.
   * Emits "custody:registered" with the created custody account.
   */
  registerCustodyAccount(
    address: string,
    options: { label?: string; asset?: { code: string; issuer: string } } = {},
  ): CustodyAccount {
    const existing = this.custodyAccounts.get(address);
    if (existing) {
      return existing;
    }

    const account: CustodyAccount = {
      address,
      label: options.label,
      asset: options.asset,
      registeredAt: new Date(),
    };

    this.custodyAccounts.set(address, account);
    this.watchAccount(address);

    this.emit("custody:registered", {
      account,
      at: account.registeredAt,
    } satisfies CustodyAccountEventPayload);

    return account;
  }

  /**
   * Remove a custody account from management and stop watching it.
   * Emits "custody:removed" when an account was actually removed.
   */
  removeCustodyAccount(address: string): boolean {
    const account = this.custodyAccounts.get(address);
    if (!account) {
      return false;
    }

    this.custodyAccounts.delete(address);
    this.unwatchAccount(address);

    this.emit("custody:removed", {
      account,
      at: new Date(),
    } satisfies CustodyAccountEventPayload);

    return true;
  }

  /**
   * Retrieve a managed custody account by address.
   */
  getCustodyAccount(address: string): CustodyAccount | undefined {
    return this.custodyAccounts.get(address);
  }

  /**
   * List all managed custody accounts.
   */
  listCustodyAccounts(): CustodyAccount[] {
    return Array.from(this.custodyAccounts.values());
  }

  /**
   * Check if an account has been merged and resolve the final destination.
   * Supports recursive merge chains up to depth 5.
   */
  async resolveMergeDestination(
    accountId: string,
    depth = 0,
  ): Promise<string> {
    if (depth > 5) {
      throw new Error(`Merge chain too deep for account ${accountId}`);
    }

    const cached = this.mergeCache.get(accountId);
    if (cached) {
      // Recursively resolve in case the destination was also merged
      return this.resolveMergeDestination(cached, depth + 1);
    }

    return accountId; // Not merged
  }

  /**
   * Check for merge operations on watched accounts.
   */
  private async checkForMerges(): Promise<void> {
    for (const accountId of this.watchedAccounts) {
      try {
        const response = await fetch(
          `${this.horizonUrl}/accounts/${accountId}/operations?order=desc&limit=10`,
        );
        
        if (!response.ok) {
          if (response.status === 404) {
            // Account not found - might be merged
            await this.detectMergeFromHistory(accountId);
          }
          continue;
        }

        const data = await response.json();
        const operations = data._embedded?.records || [];

        for (const op of operations) {
          if (op.type === "account_merge" && op.account === accountId) {
            const destination = op.into;
            await this.handleMergeDetected(accountId, destination, op);
            break;
          }
        }
      } catch (err) {
        console.error(`Error checking account ${accountId}:`, err);
      }
    }
  }

  /**
   * Attempt to detect merge from transaction history when account is not found.
   */
  private async detectMergeFromHistory(accountId: string): Promise<void> {
    try {
      const response = await fetch(
        `${this.horizonUrl}/operations?limit=200&order=desc`,
      );
      
      if (!response.ok) return;

      const data = await response.json();
      const operations = data._embedded?.records || [];

      for (const op of operations) {
        if (op.type === "account_merge" && op.account === accountId) {
          const destination = op.into;
          await this.handleMergeDetected(accountId, destination, op);
          break;
        }
      }
    } catch (err) {
      console.error(`Error detecting merge history for ${accountId}:`, err);
    }
  }

  /**
   * Handle a detected account merge operation.
   */
  private async handleMergeDetected(
    sourceAccount: string,
    destinationAccount: string,
    operation: any,
  ): Promise<void> {
    // Check if we've already processed this merge
    if (this.mergeCache.has(sourceAccount)) {
      return;
    }

    this.mergeCache.set(sourceAccount, destinationAccount);

    const event: AccountMergeEvent = {
      sourceAccount,
      destinationAccount,
      ledgerSequence: operation.source_account_sequence || 0,
      timestamp: new Date(operation.created_at || Date.now()),
    };

    this.emit("recipient:mergeDetected", event);

    this.emit("merge", {
      source: sourceAccount,
      destination: destinationAccount,
      mergedAt: event.timestamp,
    } satisfies MergeEventPayload);

    // If the merged source was a managed custody account, emit a lifecycle event
    const custodyAccount = this.custodyAccounts.get(sourceAccount);
    if (custodyAccount) {
      this.emit("custody:merged", {
        account: custodyAccount,
        at: event.timestamp,
      } satisfies CustodyAccountEventPayload);
    }

    // Notify the client to reroute recipients
    try {
      // The client will handle rerouting via rerouteRecipient method
      this.emit("recipient:reroute", {
        oldAddress: sourceAccount,
        newAddress: destinationAccount,
      });
    } catch (err) {
      console.error("Error notifying merge detection:", err);
    }
  }

  /**
   * Validate that a destination account is suitable for rerouting.
   */
  async validateDestination(
    destinationAccount: string,
    requiredAsset?: { code: string; issuer: string },
  ): Promise<void> {
    try {
      const response = await fetch(
        `${this.horizonUrl}/accounts/${destinationAccount}`,
      );

      if (!response.ok) {
        throw new InvalidDestinationError(
          destinationAccount,
          "Account does not exist on-chain",
        );
      }

      const accountData = await response.json();

      // Check if the destination has also been merged
      const mergedDestination = this.mergeCache.get(destinationAccount);
      if (mergedDestination) {
        throw new InvalidDestinationError(
          destinationAccount,
          "Destination account has itself been merged",
        );
      }

      // Check for required trustlines if asset is specified
      if (requiredAsset) {
        const balances = accountData.balances || [];
        const hasTrustline = balances.some(
          (balance: any) =>
            balance.asset_code === requiredAsset.code &&
            balance.asset_issuer === requiredAsset.issuer,
        );

        if (!hasTrustline) {
          throw new InvalidDestinationError(
            destinationAccount,
            `Missing required trustline for ${requiredAsset.code}:${requiredAsset.issuer}`,
          );
        }
      }
    } catch (err) {
      if (err instanceof InvalidDestinationError) {
        throw err;
      }
      throw new InvalidDestinationError(
        destinationAccount,
        `Validation failed: ${err}`,
      );
    }
  }
}
