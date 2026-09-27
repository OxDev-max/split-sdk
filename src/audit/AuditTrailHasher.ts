import { AuditEvent, AuditChainEntry, AuditTrailRoot } from '../types/audit';
import * as crypto from 'crypto';

// Use node crypto webcrypto subtle
const subtle = crypto.webcrypto.subtle;

export interface CrossTenantAuditRecord {
  tenantId: string;
  invoiceId: string;
  event: AuditEvent;
  entry: AuditChainEntry;
  recordedAt: number;
}

export interface CrossTenantAuditQuery {
  tenantId?: string;
  invoiceId?: string;
}

export type CrossTenantAuditEventType =
  | 'invoice.audited'
  | 'invoice.cross-tenant-access';

export interface CrossTenantAuditEvent {
  type: CrossTenantAuditEventType;
  tenantId: string;
  invoiceId: string;
  entry: AuditChainEntry;
  timestamp: number;
}

export type CrossTenantAuditListener = (event: CrossTenantAuditEvent) => void;

export class AuditTrailHasher {
  private entries: AuditChainEntry[] = [];
  private crossTenantRecords: CrossTenantAuditRecord[] = [];
  private listeners: Set<CrossTenantAuditListener> = new Set();

  constructor(entries: AuditChainEntry[] = []) {
    this.entries = [...entries];
  }

  /**
   * Helper to hash an object into a 64-character hex string using SHA-256
   */
  private static async sha256Hex(data: string): Promise<string> {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await subtle.digest('SHA-256', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Appends a new event to the audit trail
   */
  async append(event: AuditEvent): Promise<AuditChainEntry> {
    const index = this.entries.length;
    const prevHash = index > 0 ? this.entries[index - 1].hash : await AuditTrailHasher.sha256Hex('');
    
    // Hash stringified payload
    const dataString = JSON.stringify({ event, prevHash, index });
    const hash = await AuditTrailHasher.sha256Hex(dataString);
    
    const entry: AuditChainEntry = { event, hash, prevHash, index };
    this.entries.push(entry);
    return entry;
  }

  /**
   * Records an invoice audit entry scoped to a tenant, enabling cross-tenant auditing.
   * Emits an 'invoice.audited' lifecycle event.
   */
  async auditInvoice(tenantId: string, invoiceId: string, event: AuditEvent): Promise<CrossTenantAuditRecord> {
    const entry = await this.append(event);
    const record: CrossTenantAuditRecord = {
      tenantId,
      invoiceId,
      event,
      entry,
      recordedAt: Date.now(),
    };
    this.crossTenantRecords.push(record);
    this.emit({
      type: 'invoice.audited',
      tenantId,
      invoiceId,
      entry,
      timestamp: record.recordedAt,
    });
    return record;
  }

  /**
   * Records a cross-tenant access attempt against an invoice and emits a
   * 'invoice.cross-tenant-access' event so consumers can react to it.
   */
  async recordCrossTenantAccess(
    accessingTenantId: string,
    invoiceTenantId: string,
    invoiceId: string,
    event: AuditEvent,
  ): Promise<CrossTenantAuditRecord> {
    const entry = await this.append(event);
    const record: CrossTenantAuditRecord = {
      tenantId: accessingTenantId,
      invoiceId,
      event,
      entry,
      recordedAt: Date.now(),
    };
    this.crossTenantRecords.push(record);
    this.emit({
      type: 'invoice.cross-tenant-access',
      tenantId: accessingTenantId,
      invoiceId,
      entry,
      timestamp: record.recordedAt,
    });
    return record;
  }

  /**
   * Queries recorded cross-tenant audit entries, optionally filtered by tenant
   * and/or invoice. Returns a defensive copy to preserve isolation.
   */
  queryCrossTenantAudits(query: CrossTenantAuditQuery = {}): CrossTenantAuditRecord[] {
    return this.crossTenantRecords
      .filter(r => (query.tenantId === undefined || r.tenantId === query.tenantId))
      .filter(r => (query.invoiceId === undefined || r.invoiceId === query.invoiceId))
      .map(r => ({ ...r }));
  }

  /**
   * Verifies that a tenant's recorded audit entries are intact and match the
   * expected chain root, enforcing cross-tenant isolation.
   */
  async verifyTenantAudit(
    tenantId: string,
    expectedRoot: AuditTrailRoot,
  ): Promise<{ valid: boolean; mismatchAt?: number; length?: number }> {
    const tenantEntries = this.crossTenantRecords
      .filter(r => r.tenantId === tenantId)
      .map(r => r.entry);
    const scoped = new AuditTrailHasher(tenantEntries);
    return scoped.verify(expectedRoot);
  }

  /**
   * Registers a listener for cross-tenant audit lifecycle events.
   */
  on(listener: CrossTenantAuditListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Removes a previously registered listener.
   */
  off(listener: CrossTenantAuditListener): void {
    this.listeners.delete(listener);
  }

  private emit(event: CrossTenantAuditEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /**
   * Computes a Merkle root over all current chain entry hashes using pairwise SHA-256 combining
   */
  async root(): Promise<AuditTrailRoot> {
    if (this.entries.length === 0) {
      return AuditTrailHasher.sha256Hex('');
    }

    let currentLayer = this.entries.map(e => e.hash);

    while (currentLayer.length > 1) {
      const nextLayer: string[] = [];
      for (let i = 0; i < currentLayer.length; i += 2) {
        if (i + 1 < currentLayer.length) {
          nextLayer.push(await AuditTrailHasher.sha256Hex(currentLayer[i] + currentLayer[i + 1]));
        } else {
          // Odd number of nodes, pad with itself (left-pad/duplicate)
          nextLayer.push(await AuditTrailHasher.sha256Hex(currentLayer[i] + currentLayer[i]));
        }
      }
      currentLayer = nextLayer;
    }

    return currentLayer[0];
  }

  /**
   * Recomputes the root from stored entries and checks equality
   */
  async verify(expectedRoot: AuditTrailRoot): Promise<{ valid: boolean; mismatchAt?: number; length?: number }> {
    // Check integrity of the chain
    let prevHash = await AuditTrailHasher.sha256Hex('');
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (entry.index !== i) {
        return { valid: false, mismatchAt: i };
      }
      if (entry.prevHash !== prevHash) {
        return { valid: false, mismatchAt: i };
      }
      
      const dataString = JSON.stringify({ event: entry.event, prevHash: entry.prevHash, index: entry.index });
      const expectedHash = await AuditTrailHasher.sha256Hex(dataString);
      
      if (entry.hash !== expectedHash) {
        return { valid: false, mismatchAt: i };
      }
      
      prevHash = entry.hash;
    }

    // Check root
    const computedRoot = await this.root();
    if (computedRoot !== expectedRoot) {
      return { valid: false, mismatchAt: 0 };
    }

    return { valid: true, length: this.entries.length };
  }

  // Allow test access
  getEntries(): AuditChainEntry[] {
    return this.entries;
  }
}
