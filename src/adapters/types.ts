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

/** Lifecycle phase of an SDK data migration. */
export type MigrationPhase = 'start' | 'progress' | 'complete' | 'error';

/** Payload emitted for each migration lifecycle event. */
export interface MigrationEvent {
  /** Which phase of the migration this event represents. */
  phase: MigrationPhase;
  /** Identifier of the migration being run. */
  migrationId: string;
  /** Number of records processed so far. */
  processed: number;
  /** Total number of records to process. */
  total: number;
  /** Error details, present only for the 'error' phase. */
  error?: Error;
}

/** Listener invoked for migration lifecycle events. */
export type MigrationEventListener = (event: MigrationEvent) => void;

/** A single versioned data migration step. */
export interface DataMigration<T = unknown> {
  /** Unique identifier, typically the target schema version. */
  id: string;
  /** Transform a single record from the previous shape to the next. */
  migrate(record: T): T | Promise<T>;
}

/** Options controlling how a migration run is executed. */
export interface MigrationOptions {
  /** Abort the run when a record fails instead of collecting errors. */
  failFast?: boolean;
  /** Subscribe to lifecycle events for this run. */
  onEvent?: MigrationEventListener;
}

/** Result summary returned after a migration run completes. */
export interface MigrationResult<T = unknown> {
  /** Identifier of the migration that ran. */
  migrationId: string;
  /** Records successfully migrated. */
  migrated: T[];
  /** Records that failed, paired with the thrown error. */
  failures: Array<{ record: T; error: Error }>;
  /** Whether the run finished without an unhandled error. */
  success: boolean;
}

/**
 * Run a data migration over a set of records, emitting lifecycle events.
 *
 * Emits 'start' before processing, 'progress' after each record, then
 * 'complete' on success or 'error' when the run aborts.
 */
export async function runDataMigration<T>(
  migration: DataMigration<T>,
  records: T[],
  options: MigrationOptions = {},
): Promise<MigrationResult<T>> {
  const { failFast = false, onEvent } = options;
  const total = records.length;
  const migrated: T[] = [];
  const failures: Array<{ record: T; error: Error }> = [];

  onEvent?.({ phase: 'start', migrationId: migration.id, processed: 0, total });

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    try {
      migrated.push(await migration.migrate(record));
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      failures.push({ record, error });
      if (failFast) {
        onEvent?.({
          phase: 'error',
          migrationId: migration.id,
          processed: i + 1,
          total,
          error,
        });
        return { migrationId: migration.id, migrated, failures, success: false };
      }
    }
    onEvent?.({
      phase: 'progress',
      migrationId: migration.id,
      processed: i + 1,
      total,
    });
  }

  onEvent?.({ phase: 'complete', migrationId: migration.id, processed: total, total });
  return { migrationId: migration.id, migrated, failures, success: true };
}
