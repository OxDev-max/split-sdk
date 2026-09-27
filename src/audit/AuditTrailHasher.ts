import { AuditEvent, AuditChainEntry, AuditTrailRoot } from '../types/audit';
import * as crypto from 'crypto';

// Use node crypto webcrypto subtle
const subtle = crypto.webcrypto.subtle;

export interface MerkleProof {
  leaf: string;
  index: number;
  siblings: Array<{ hash: string; position: 'left' | 'right' }>;
  root: AuditTrailRoot;
}

export type AuditValidationEvent =
  | { type: 'validation:start'; expectedRoot: AuditTrailRoot; length: number }
  | { type: 'validation:success'; root: AuditTrailRoot; length: number }
  | { type: 'validation:failure'; reason: string; mismatchAt?: number };

export type AuditValidationListener = (event: AuditValidationEvent) => void;

export class AuditTrailHasher {
  private entries: AuditChainEntry[] = [];
  private listeners: AuditValidationListener[] = [];

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
   * Registers a listener for validation lifecycle events
   */
  onValidation(listener: AuditValidationListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private emit(event: AuditValidationEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
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
   * Generates a Merkle inclusion proof for the entry at the given index
   */
  async proof(index: number): Promise<MerkleProof> {
    if (index < 0 || index >= this.entries.length) {
      throw new Error(`Index ${index} out of bounds for ${this.entries.length} entries`);
    }

    const leaf = this.entries[index].hash;
    const siblings: MerkleProof['siblings'] = [];
    let currentLayer = this.entries.map(e => e.hash);
    let currentIndex = index;

    while (currentLayer.length > 1) {
      const isRightNode = currentIndex % 2 === 1;
      const siblingIndex = isRightNode ? currentIndex - 1 : currentIndex + 1;
      const siblingHash = siblingIndex < currentLayer.length
        ? currentLayer[siblingIndex]
        : currentLayer[currentIndex];

      siblings.push({
        hash: siblingHash,
        position: isRightNode ? 'left' : 'right',
      });

      const nextLayer: string[] = [];
      for (let i = 0; i < currentLayer.length; i += 2) {
        if (i + 1 < currentLayer.length) {
          nextLayer.push(await AuditTrailHasher.sha256Hex(currentLayer[i] + currentLayer[i + 1]));
        } else {
          nextLayer.push(await AuditTrailHasher.sha256Hex(currentLayer[i] + currentLayer[i]));
        }
      }
      currentLayer = nextLayer;
      currentIndex = Math.floor(currentIndex / 2);
    }

    return { leaf, index, siblings, root: currentLayer[0] };
  }

  /**
   * Verifies a Merkle inclusion proof against an expected root
   */
  static async verifyProof(proof: MerkleProof, expectedRoot: AuditTrailRoot): Promise<boolean> {
    let computed = proof.leaf;
    for (const sibling of proof.siblings) {
      if (sibling.position === 'left') {
        computed = await AuditTrailHasher.sha256Hex(sibling.hash + computed);
      } else {
        computed = await AuditTrailHasher.sha256Hex(computed + sibling.hash);
      }
    }
    return computed === expectedRoot && proof.root === expectedRoot;
  }

  /**
   * Recomputes the root from stored entries and checks equality
   */
  async verify(expectedRoot: AuditTrailRoot): Promise<{ valid: boolean; mismatchAt?: number; length?: number }> {
    this.emit({ type: 'validation:start', expectedRoot, length: this.entries.length });

    // Check integrity of the chain
    let prevHash = await AuditTrailHasher.sha256Hex('');
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (entry.index !== i) {
        this.emit({ type: 'validation:failure', reason: 'index-mismatch', mismatchAt: i });
        return { valid: false, mismatchAt: i };
      }
      if (entry.prevHash !== prevHash) {
        this.emit({ type: 'validation:failure', reason: 'prev-hash-mismatch', mismatchAt: i });
        return { valid: false, mismatchAt: i };
      }
      
      const dataString = JSON.stringify({ event: entry.event, prevHash: entry.prevHash, index: entry.index });
      const expectedHash = await AuditTrailHasher.sha256Hex(dataString);
      
      if (entry.hash !== expectedHash) {
        this.emit({ type: 'validation:failure', reason: 'entry-hash-mismatch', mismatchAt: i });
        return { valid: false, mismatchAt: i };
      }
      
      prevHash = entry.hash;
    }

    // Check root
    const computedRoot = await this.root();
    if (computedRoot !== expectedRoot) {
      this.emit({ type: 'validation:failure', reason: 'root-mismatch', mismatchAt: 0 });
      return { valid: false, mismatchAt: 0 };
    }

    this.emit({ type: 'validation:success', root: computedRoot, length: this.entries.length });
    return { valid: true, length: this.entries.length };
  }

  // Allow test access
  getEntries(): AuditChainEntry[] {
    return this.entries;
  }
}
