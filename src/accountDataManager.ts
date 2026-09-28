/**
 * Typed CRUD manager for Stellar account data entries.
 *
 * Wraps `Operation.manageData()` with validation for the protocol's 64-byte
 * key/value limits and 64-entry-per-account cap, so callers can store custom
 * metadata alongside SDK state without hand-rolling raw manageData calls.
 *
 * Also provides SDK data migration utilities for moving data entries between
 * accounts, with lifecycle event handling for observability.
 */

import {
  Account,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import type { AccountDataMap } from "./types.js";
import { DataEntryValidationError } from "./errors.js";

/** Stellar protocol limit for both data entry keys and values, in bytes. */
const MAX_DATA_ENTRY_BYTES = 64;

/** Stellar protocol limit on the number of data entries per account. */
const MAX_DATA_ENTRIES = 64;

/** Result of submitting a manageData transaction. */
export interface TransactionResult {
  txHash: string;
}

/** Configuration for {@link AccountDataManager}. */
export interface AccountDataManagerConfig {
  /** Horizon server URL. */
  horizonUrl: string;
  /** Stellar network passphrase. */
  networkPassphrase: string;
}

/** Options controlling an SDK data migration. */
export interface DataMigrationOptions {
  /** Source account whose data entries are migrated. */
  sourceAccountId: string;
  /** Destination account that receives the migrated entries. */
  destinationAccountId: string;
  /** Secret key used to sign transactions on the source account. */
  sourceSignerSecret: string;
  /** Secret key used to sign transactions on the destination account. */
  destinationSignerSecret: string;
  /** Restrict the migration to these keys; defaults to all source entries. */
  keys?: string[];
  /** Delete migrated entries from the source account after copying. */
  deleteSource?: boolean;
}

/** Per-key outcome of a migration run. */
export interface DataMigrationEntryResult {
  key: string;
  status: "migrated" | "skipped" | "failed";
  error?: string;
}

/** Aggregate result of a migration run. */
export interface DataMigrationResult {
  sourceAccountId: string;
  destinationAccountId: string;
  entries: DataMigrationEntryResult[];
  migrated: number;
  skipped: number;
  failed: number;
}

/** Lifecycle events emitted during a migration. */
export type DataMigrationEvent =
  | { type: "start"; sourceAccountId: string; destinationAccountId: string; total: number }
  | { type: "progress"; key: string; index: number; total: number; status: DataMigrationEntryResult["status"] }
  | { type: "complete"; result: DataMigrationResult }
  | { type: "error"; key?: string; error: Error };

/** Listener invoked for each {@link DataMigrationEvent}. */
export type DataMigrationEventListener = (event: DataMigrationEvent) => void;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Typed CRUD manager for account data entries, built on top of
 * `Operation.manageData()` and `Server.loadAccount().data_attr`.
 */
export class AccountDataManager {
  private readonly server: Horizon.Server;
  private readonly networkPassphrase: string;
  private readonly migrationListeners = new Set<DataMigrationEventListener>();

  constructor(config: AccountDataManagerConfig) {
    this.server = new Horizon.Server(config.horizonUrl);
    this.networkPassphrase = config.networkPassphrase;
  }

  /**
   * Set (create or update) a data entry on `accountId`.
   *
   * @throws DataEntryValidationError if the key/value exceed 64 bytes, or if
   *         the account already has 64 entries and `key` is new.
   */
  async set(
    accountId: string,
    key: string,
    value: string,
    signerSecret: string,
  ): Promise<TransactionResult> {
    await this.validateEntry(accountId, key, value);
    return this.submitManageData(accountId, key, value, signerSecret);
  }

  /**
   * Fetch the current value of `key` on `accountId`, or `null` if absent.
   */
  async get(accountId: string, key: string): Promise<string | null> {
    const entries = await this.list(accountId);
    return Object.prototype.hasOwnProperty.call(entries, key) ? entries[key]! : null;
  }

  /**
   * Delete a data entry by submitting `manageData` with a `null` value.
   */
  async delete(
    accountId: string,
    key: string,
    signerSecret: string,
  ): Promise<TransactionResult> {
    return this.submitManageData(accountId, key, null, signerSecret);
  }

  /**
   * Return all data entries currently stored on `accountId`, decoded from
   * base64 to UTF-8 strings.
   */
  async list(accountId: string): Promise<AccountDataMap> {
    const account = await this.server.loadAccount(accountId);
    const raw = account.data_attr as Record<string, string> | undefined;
    const result: AccountDataMap = {};
    for (const [key, base64Value] of Object.entries(raw ?? {})) {
      result[key] = Buffer.from(base64Value, "base64").toString("utf8");
    }
    return result;
  }

  /**
   * Subscribe to migration lifecycle events.
   *
   * @returns an unsubscribe function that removes the listener.
   */
  onMigrationEvent(listener: DataMigrationEventListener): () => void {
    this.migrationListeners.add(listener);
    return () => {
      this.migrationListeners.delete(listener);
    };
  }

  /**
   * Migrate data entries from a source account to a destination account.
   *
   * Copies each selected entry to the destination, optionally deleting it
   * from the source, and emits `start`, `progress`, `complete`, and `error`
   * lifecycle events. Per-key failures are captured in the result rather than
   * aborting the whole run; a fatal error (e.g. source load failure) emits an
   * `error` event and rejects.
   */
  async migrateData(options: DataMigrationOptions): Promise<DataMigrationResult> {
    const {
      sourceAccountId,
      destinationAccountId,
      sourceSignerSecret,
      destinationSignerSecret,
      deleteSource = false,
    } = options;

    let sourceEntries: AccountDataMap;
    try {
      sourceEntries = await this.list(sourceAccountId);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emitMigrationEvent({ type: "error", error });
      throw error;
    }

    const keys = options.keys ?? Object.keys(sourceEntries);
    const total = keys.length;
    this.emitMigrationEvent({
      type: "start",
      sourceAccountId,
      destinationAccountId,
      total,
    });

    const entries: DataMigrationEntryResult[] = [];
    let migrated = 0;
    let skipped = 0;
    let failed = 0;

    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!;
      let status: DataMigrationEntryResult["status"];
      let errorMessage: string | undefined;

      if (!Object.prototype.hasOwnProperty.call(sourceEntries, key)) {
        status = "skipped";
        skipped++;
      } else {
        try {
          await this.set(
            destinationAccountId,
            key,
            sourceEntries[key]!,
            destinationSignerSecret,
          );
          if (deleteSource) {
            await this.delete(sourceAccountId, key, sourceSignerSecret);
          }
          status = "migrated";
          migrated++;
        } catch (err) {
          status = "failed";
          failed++;
          errorMessage = err instanceof Error ? err.message : String(err);
          this.emitMigrationEvent({
            type: "error",
            key,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }

      const entry: DataMigrationEntryResult = { key, status };
      if (errorMessage !== undefined) {
        entry.error = errorMessage;
      }
      entries.push(entry);
      this.emitMigrationEvent({ type: "progress", key, index, total, status });
    }

    const result: DataMigrationResult = {
      sourceAccountId,
      destinationAccountId,
      entries,
      migrated,
      skipped,
      failed,
    };
    this.emitMigrationEvent({ type: "complete", result });
    return result;
  }

  private emitMigrationEvent(event: DataMigrationEvent): void {
    for (const listener of this.migrationListeners) {
      listener(event);
    }
  }

  private async validateEntry(accountId: string, key: string, value: string): Promise<void> {
    if (byteLength(key) > MAX_DATA_ENTRY_BYTES) {
      throw new DataEntryValidationError(
        `key "${key}" exceeds ${MAX_DATA_ENTRY_BYTES} bytes`,
        { key },
      );
    }
    if (byteLength(value) > MAX_DATA_ENTRY_BYTES) {
      throw new DataEntryValidationError(
        `value for key "${key}" exceeds ${MAX_DATA_ENTRY_BYTES} bytes`,
        { key },
      );
    }

    const existing = await this.list(accountId);
    const isNewKey = !Object.prototype.hasOwnProperty.call(existing, key);
    if (isNewKey && Object.keys(existing).length >= MAX_DATA_ENTRIES) {
      throw new DataEntryValidationError(
        `account ${accountId} already has ${MAX_DATA_ENTRIES} data entries`,
        { accountId },
      );
    }
  }

  private async submitManageData(
    accountId: string,
    key: string,
    value: string | null,
    signerSecret: string,
  ): Promise<TransactionResult> {
    const keypair = Keypair.fromSecret(signerSecret);
    const loaded = await this.server.loadAccount(accountId);
    const sourceAccount = new Account(loaded.accountId(), loaded.sequenceNumber());

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(Operation.manageData({ name: key, value: value ?? null }))
      .setTimeout(30)
      .build();

    tx.sign(keypair);
    const result = await this.server.submitTransaction(tx);
    return { txHash: result.hash };
  }
}
