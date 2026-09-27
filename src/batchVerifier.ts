import type { Invoice, BatchPayment } from "./types.js";

export interface BatchInvoiceValidation {
  invoiceId: string;
  valid: boolean;
  errors: string[];
  token: string;
  remainingAmount: bigint;
  status: string;
}

export interface BatchVerificationResult {
  valid: boolean;
  invoices: BatchInvoiceValidation[];
  commonToken: string | null;
  errors: string[];
}

/**
 * Verify that all invoices in a batch share the same token and are in a
 * payable state, before submitting the on-chain transaction.
 *
 * @param invoices - The invoices to verify (must already be resolved).
 * @param payments - The proposed batch payments (invoiceId + amount pairs).
 */
export function verifyBatchPayments(
  invoices: Invoice[],
  payments: BatchPayment[]
): BatchVerificationResult {
  const errors: string[] = [];
  const invoiceValidations: BatchInvoiceValidation[] = [];

  if (invoices.length === 0) {
    return { valid: false, invoices: [], commonToken: null, errors: ["No invoices provided"] };
  }

  const invoiceMap = new Map(invoices.map((inv) => [inv.id, inv]));
  const tokens = new Set<string>();

  for (const payment of payments) {
    const invoice = invoiceMap.get(payment.invoiceId);
    if (!invoice) {
      invoiceValidations.push({
        invoiceId: payment.invoiceId,
        valid: false,
        errors: ["Invoice not found"],
        token: "",
        remainingAmount: 0n,
        status: "unknown",
      });
      errors.push(`Invoice ${payment.invoiceId}: not found`);
      continue;
    }

    tokens.add(invoice.token);
    const invoiceErrors: string[] = [];

    if (invoice.status !== "Pending") {
      invoiceErrors.push(`Invoice status is "${invoice.status}", expected "Pending"`);
    }

    const totalOwed = invoice.recipients.reduce((sum, r) => sum + r.amount, 0n);
    const remaining = totalOwed - invoice.funded;
    if (payment.amount <= 0n) {
      invoiceErrors.push("Payment amount must be positive");
    }
    if (payment.amount > remaining) {
      invoiceErrors.push(
        `Payment amount ${payment.amount} exceeds remaining ${remaining}`
      );
    }

    invoiceValidations.push({
      invoiceId: payment.invoiceId,
      valid: invoiceErrors.length === 0,
      errors: invoiceErrors,
      token: invoice.token,
      remainingAmount: remaining,
      status: invoice.status,
    });

    if (invoiceErrors.length > 0) {
      errors.push(`Invoice ${payment.invoiceId}: ${invoiceErrors.join("; ")}`);
    }
  }

  const commonToken = tokens.size === 1 ? [...tokens][0]! : null;
  if (tokens.size > 1) {
    errors.push(`Invoices use different tokens: ${[...tokens].join(", ")}`);
  }

  const allValid = errors.length === 0;

  return { valid: allValid, invoices: invoiceValidations, commonToken, errors };
}

/**
 * Result returned by the client's verifyBatchPay method.
 */
export interface VerifyBatchPayResult {
  valid: boolean;
  invoices: BatchInvoiceValidation[];
  commonToken: string | null;
  errors: string[];
}

/**
 * A single leaf entry in an invoice merkle tree. Each entry commits to an
 * invoice id and the amount being paid for that invoice.
 */
export interface InvoiceMerkleLeaf {
  invoiceId: string;
  amount: bigint;
}

/**
 * A merkle inclusion proof for a single invoice leaf.
 */
export interface InvoiceMerkleProof {
  invoiceId: string;
  amount: bigint;
  leaf: string;
  root: string;
  siblings: string[];
  path: Array<"left" | "right">;
}

/**
 * Result of validating an invoice merkle tree against a set of payments.
 */
export interface InvoiceMerkleValidationResult {
  valid: boolean;
  root: string | null;
  leaves: string[];
  errors: string[];
}

/**
 * Event emitted while validating an invoice merkle tree.
 */
export interface InvoiceMerkleEvent {
  type: "validation:start" | "validation:success" | "validation:failure";
  root: string | null;
  leafCount: number;
  errors: string[];
}

export type InvoiceMerkleEventHandler = (event: InvoiceMerkleEvent) => void;

/**
 * Deterministic string encoding for a merkle leaf. Kept dependency-free so it
 * can run in any JS runtime (browser, node, edge).
 */
function encodeLeaf(leaf: InvoiceMerkleLeaf): string {
  return `${leaf.invoiceId}:${leaf.amount.toString()}`;
}

/**
 * FNV-1a based 64-bit hash rendered as a hex string. This is a deterministic,
 * dependency-free hash suitable for building a merkle tree over invoice data.
 * It is not cryptographically secure and is intended for structural
 * validation of invoice batches, not for on-chain commitments.
 */
function hashString(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c + i;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/**
 * Hash a single invoice leaf into its merkle node value.
 */
export function hashInvoiceLeaf(leaf: InvoiceMerkleLeaf): string {
  return hashString(`leaf:${encodeLeaf(leaf)}`);
}

/**
 * Combine two child hashes into their parent hash. Order matters so that the
 * tree is deterministic and proofs are unambiguous.
 */
export function hashInvoicePair(left: string, right: string): string {
  return hashString(`node:${left}:${right}`);
}

/**
 * Build the merkle tree levels for a list of invoice leaves. Returns the
 * levels bottom-up, with the last level containing the single root.
 */
function buildLevels(leaves: InvoiceMerkleLeaf[]): string[][] {
  const leafHashes = leaves.map(hashInvoiceLeaf);
  const levels: string[][] = [leafHashes];

  let current = leafHashes;
  while (current.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i]!;
      const right = i + 1 < current.length ? current[i + 1]! : left;
      next.push(hashInvoicePair(left, right));
    }
    levels.push(next);
    current = next;
  }

  return levels;
}

/**
 * Compute the merkle root for a set of invoice leaves. Returns null for an
 * empty leaf set.
 */
export function computeInvoiceMerkleRoot(leaves: InvoiceMerkleLeaf[]): string | null {
  if (leaves.length === 0) {
    return null;
  }
  const levels = buildLevels(leaves);
  return levels[levels.length - 1]![0]!;
}

/**
 * Generate an inclusion proof for the invoice leaf at the given index.
 */
export function generateInvoiceMerkleProof(
  leaves: InvoiceMerkleLeaf[],
  index: number
): InvoiceMerkleProof | null {
  if (index < 0 || index >= leaves.length) {
    return null;
  }

  const levels = buildLevels(leaves);
  const siblings: string[] = [];
  const path: Array<"left" | "right"> = [];

  let idx = index;
  for (let level = 0; level < levels.length - 1; level++) {
    const nodes = levels[level]!;
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    const sibling = siblingIdx < nodes.length ? nodes[siblingIdx]! : nodes[idx]!;
    siblings.push(sibling);
    path.push(isRight ? "left" : "right");
    idx = Math.floor(idx / 2);
  }

  const leaf = leaves[index]!;
  return {
    invoiceId: leaf.invoiceId,
    amount: leaf.amount,
    leaf: hashInvoiceLeaf(leaf),
    root: levels[levels.length - 1]![0]!,
    siblings,
    path,
  };
}

/**
 * Verify an inclusion proof against an expected merkle root.
 */
export function verifyInvoiceMerkleProof(
  proof: InvoiceMerkleProof,
  expectedRoot: string
): boolean {
  let current = proof.leaf;
  for (let i = 0; i < proof.siblings.length; i++) {
    const sibling = proof.siblings[i]!;
    const direction = proof.path[i];
    current =
      direction === "left"
        ? hashInvoicePair(sibling, current)
        : hashInvoicePair(current, sibling);
  }
  return current === expectedRoot;
}

/**
 * Validate that a set of payments forms a consistent invoice merkle tree and
 * that every payment can be proven to be included in the resulting root.
 *
 * Emits validation lifecycle events through the optional handler so callers
 * can surface progress and failures in the UI.
 */
export function validateInvoiceMerkleTree(
  payments: BatchPayment[],
  onEvent?: InvoiceMerkleEventHandler
): InvoiceMerkleValidationResult {
  const errors: string[] = [];
  const leaves: InvoiceMerkleLeaf[] = payments.map((p) => ({
    invoiceId: p.invoiceId,
    amount: p.amount,
  }));

  onEvent?.({
    type: "validation:start",
    root: null,
    leafCount: leaves.length,
    errors: [],
  });

  if (leaves.length === 0) {
    errors.push("No payments provided for merkle validation");
    onEvent?.({
      type: "validation:failure",
      root: null,
      leafCount: 0,
      errors,
    });
    return { valid: false, root: null, leaves: [], errors };
  }

  const seen = new Set<string>();
  for (const leaf of leaves) {
    if (leaf.amount <= 0n) {
      errors.push(`Invoice ${leaf.invoiceId}: amount must be positive`);
    }
    if (seen.has(leaf.invoiceId)) {
      errors.push(`Invoice ${leaf.invoiceId}: duplicate entry in merkle tree`);
    }
    seen.add(leaf.invoiceId);
  }

  const root = computeInvoiceMerkleRoot(leaves);
  const leafHashes = leaves.map(hashInvoiceLeaf);

  if (root !== null) {
    for (let i = 0; i < leaves.length; i++) {
      const proof = generateInvoiceMerkleProof(leaves, i);
      if (!proof || !verifyInvoiceMerkleProof(proof, root)) {
        errors.push(`Invoice ${leaves[i]!.invoiceId}: inclusion proof failed`);
      }
    }
  }

  const valid = errors.length === 0;
  onEvent?.({
    type: valid ? "validation:success" : "validation:failure",
    root,
    leafCount: leaves.length,
    errors,
  });

  return { valid, root, leaves: leafHashes, errors };
}
