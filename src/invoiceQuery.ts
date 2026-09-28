/**
 * Client-side filter, sort and pagination engine for invoice queries.
 *
 * The engine operates on an in-memory set of `Invoice` objects that has
 * already been fetched from the chain (via `getInvoicesByCreator()` or a
 * caller-supplied tag index), which keeps the wire contract unchanged while
 * still giving callers a single typed query object.
 *
 * @module invoiceQuery
 */

import type { Invoice, InvoiceStatus } from "./types.js";
import { ValidationError } from "./errors.js";

/** Sort orders supported by {@link InvoiceQueryEngine}. */
export type InvoiceSort = "newest" | "oldest" | "highest" | "lowest";

/** The complete set of valid sort orders. */
export const INVOICE_SORTS: readonly InvoiceSort[] = [
  "newest",
  "oldest",
  "highest",
  "lowest",
];

/** Default number of invoices returned per page. */
export const DEFAULT_QUERY_LIMIT = 20;

/**
 * A composable filter over invoices.
 *
 * Every field is optional and all supplied fields are combined with AND
 * semantics — passing `{ status: ["Pending"], maxAmount: 500n }` returns
 * pending invoices worth at most 500 stroops.
 */
export interface InvoiceFilter {
  /** Only return invoices created by this address. */
  creator?: string;
  /** Only return invoices in any of these lifecycle states. */
  status?: InvoiceStatus[];
  /** Inclusive lower bound on the invoice total, in stroops. */
  minAmount?: bigint;
  /** Inclusive upper bound on the invoice total, in stroops. */
  maxAmount?: bigint;
  /** Inclusive lower bound on the creation time (Unix seconds or ms). */
  fromDate?: number;
  /** Inclusive upper bound on the creation time (Unix seconds or ms). */
  toDate?: number;
  /** Return invoices carrying **all** of these tags. */
  tags?: string[];
  /** Maximum number of invoices to return. Defaults to 20. */
  limit?: number;
  /** Opaque cursor returned by a previous call to resume from. */
  cursor?: string;
  /** Sort order for the result set. Defaults to `"newest"`. */
  sort?: InvoiceSort;
}

/** A single page of query results. */
export interface InvoicePage {
  /** The invoices on this page. */
  items: Invoice[];
  /**
   * Cursor to pass as {@link InvoiceFilter.cursor} to fetch the next page, or
   * `undefined` when this is the last page.
   */
  nextCursor?: string;
  /** Total number of invoices matching the filter, across all pages. */
  total: number;
}

/**
 * Resolve the total amount owed on an invoice.
 *
 * Uses the recipients list (the authoritative on-chain split) and falls back
 * to the funded amount when no recipients are present.
 */
function invoiceTotal(invoice: Invoice): bigint {
  if (invoice.recipients.length > 0) {
    return invoice.recipients.reduce((sum, r) => sum + r.amount, 0n);
  }
  return invoice.funded;
}

/**
 * Resolve an invoice's creation time in **milliseconds**.
 *
 * `createdAt` is documented as accepting either seconds or milliseconds, so
 * values above 1e12 are treated as milliseconds (the same heuristic used by
 * `getInvoiceAge`). Invoices without `createdAt` have an unknown creation time
 * and sort last in date orderings.
 */
function createdAtMs(invoice: Invoice): number | undefined {
  const raw = invoice.createdAt;
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
    return undefined;
  }
  return raw > 1e12 ? raw : raw * 1000;
}

/**
 * Collect an invoice's tags.
 *
 * Prefers the explicit `tags` field, falling back to `#hashtags` parsed out of
 * the memo so existing invoices are taggable without a contract change.
 */
export function getInvoiceTags(invoice: Invoice): string[] {
  if (invoice.tags !== undefined && invoice.tags.length > 0) {
    return invoice.tags.map((tag) => tag.toLowerCase());
  }
  if (invoice.memo) {
    const found = invoice.memo.match(/#([\w-]+)/g);
    if (found) {
      return found.map((tag) => tag.slice(1).toLowerCase());
    }
  }
  return [];
}

/** Internal, resolved form of an {@link InvoiceFilter}. */
interface ResolvedFilter {
  creator?: string;
  status?: Set<InvoiceStatus>;
  minAmount?: bigint;
  maxAmount?: bigint;
  fromDate?: number;
  toDate?: number;
  tags?: Set<string>;
  sort: InvoiceSort;
  limit: number;
}

/**
 * Validate a filter for internal consistency.
 *
 * @throws {ValidationError} If a bound is inverted or sort/limit is invalid.
 */
function validateFilter(filter: InvoiceFilter): void {
  if (filter.limit !== undefined) {
    if (!Number.isInteger(filter.limit) || filter.limit <= 0) {
      throw new ValidationError("InvoiceFilter.limit must be a positive integer", {
        limit: filter.limit,
      });
    }
  }

  if (
    filter.minAmount !== undefined &&
    filter.maxAmount !== undefined &&
    filter.minAmount > filter.maxAmount
  ) {
    throw new ValidationError(
      "InvoiceFilter.minAmount must not exceed maxAmount",
      { minAmount: filter.minAmount, maxAmount: filter.maxAmount },
    );
  }

  if (
    filter.fromDate !== undefined &&
    filter.toDate !== undefined &&
    filter.fromDate > filter.toDate
  ) {
    throw new ValidationError("InvoiceFilter.fromDate must not exceed toDate", {
      fromDate: filter.fromDate,
      toDate: filter.toDate,
    });
  }

  if (filter.sort !== undefined && !INVOICE_SORTS.includes(filter.sort)) {
    throw new ValidationError(
      `InvoiceFilter.sort must be one of: ${INVOICE_SORTS.join(", ")}`,
      { sort: filter.sort },
    );
  }
}

function resolveFilter(filter: InvoiceFilter): ResolvedFilter {
  return {
    creator: filter.creator,
    status: filter.status ? new Set(filter.status) : undefined,
    minAmount: filter.minAmount,
    maxAmount: filter.maxAmount,
    fromDate: filter.fromDate,
    toDate: filter.toDate,
    tags: filter.tags
      ? new Set(filter.tags.map((tag) => tag.toLowerCase()))
      : undefined,
    sort: filter.sort ?? "newest",
    limit: filter.limit ?? DEFAULT_QUERY_LIMIT,
  };
}

/** Normalise a seconds-or-milliseconds bound to milliseconds. */
function toMs(date: number): number {
  return date > 1e12 ? date : date * 1000;
}

function matches(invoice: Invoice, filter: ResolvedFilter): boolean {
  if (filter.creator !== undefined && invoice.creator !== filter.creator) {
    return false;
  }

  if (filter.status !== undefined && !filter.status.has(invoice.status)) {
    return false;
  }

  if (filter.minAmount !== undefined || filter.maxAmount !== undefined) {
    const total = invoiceTotal(invoice);
    if (filter.minAmount !== undefined && total < filter.minAmount) {
      return false;
    }
    if (filter.maxAmount !== undefined && total > filter.maxAmount) {
      return false;
    }
  }

  if (filter.fromDate !== undefined || filter.toDate !== undefined) {
    const created = createdAtMs(invoice);
    // Invoices with an unknown creation time cannot satisfy a date filter.
    if (created === undefined) return false;
    if (filter.fromDate !== undefined && created < toMs(filter.fromDate)) {
      return false;
    }
    if (filter.toDate !== undefined && created > toMs(filter.toDate)) {
      return false;
    }
  }

  if (filter.tags !== undefined) {
    const tags = getInvoiceTags(invoice);
    for (const tag of filter.tags) {
      if (!tags.includes(tag)) return false;
    }
  }

  return true;
}

/**
 * Encode a cursor as a stable, opaque offset string.
 *
 * Cursors are offset-based rather than ID-based because sorting can reorder
 * the underlying result set; an offset keeps paging deterministic for a given
 * (filter, sort) pair.
 */
function encodeCursor(offset: number): string {
  return `off:${offset}`;
}

/**
 * Decode a cursor produced by {@link encodeCursor}.
 *
 * @returns The offset, or null when no cursor was supplied.
 * @throws {ValidationError} If the cursor is malformed.
 */
function decodeCursor(cursor: string | undefined): number | null {
  if (cursor === undefined) return null;

  if (!cursor.startsWith("off:")) {
    throw new ValidationError('Invalid cursor: expected an "off:<n>" cursor', {
      cursor,
    });
  }

  const offset = Number.parseInt(cursor.slice(4), 10);
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ValidationError("Invalid cursor: offset must be a non-negative integer", {
      cursor,
    });
  }

  return offset;
}

/**
 * Compare two bigints without narrowing them to `number`.
 *
 * Amounts routinely exceed `Number.MAX_SAFE_INTEGER`, so they must never be
 * compared via numeric subtraction.
 */
function compareBig(a: bigint, b: bigint): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortInvoices(invoices: Invoice[], sort: InvoiceSort): Invoice[] {
  const sorted = [...invoices];

  // Invoices with an unknown creation time get a 0 key so they sort last in
  // "newest" order and first in "oldest" order.
  const dateKey = (inv: Invoice): number => createdAtMs(inv) ?? 0;
  const totalKey = (inv: Invoice): bigint => invoiceTotal(inv);
  // Tie-break on the invoice ID so ordering is stable across pages.
  const tieBreak = (a: Invoice, b: Invoice): number => a.id.localeCompare(b.id);

  switch (sort) {
    case "newest":
      sorted.sort(
        (a, b) => compareBig(BigInt(dateKey(b)), BigInt(dateKey(a))) || tieBreak(a, b),
      );
      break;
    case "oldest":
      sorted.sort(
        (a, b) => compareBig(BigInt(dateKey(a)), BigInt(dateKey(b))) || tieBreak(a, b),
      );
      break;
    case "highest":
      sorted.sort(
        (a, b) => compareBig(totalKey(b), totalKey(a)) || tieBreak(a, b),
      );
      break;
    case "lowest":
      sorted.sort(
        (a, b) => compareBig(totalKey(a), totalKey(b)) || tieBreak(a, b),
      );
      break;
  }

  return sorted;
}

/**
 * An in-memory index over a set of invoices supporting tag lookups.
 *
 * `client.queryInvoices()` builds one of these per call from the invoices it
 * fetches, but it is exported so callers holding their own invoice list can
 * build the index once and reuse it across many queries.
 */
export class InvoiceTagIndex {
  private readonly byTag = new Map<string, Set<Invoice>>();

  /** Build the tag index from a list of invoices. */
  constructor(invoices: Iterable<Invoice> = []) {
    for (const invoice of invoices) {
      for (const tag of getInvoiceTags(invoice)) {
        let bucket = this.byTag.get(tag);
        if (!bucket) {
          bucket = new Set<Invoice>();
          this.byTag.set(tag, bucket);
        }
        bucket.add(invoice);
      }
    }
  }

  /**
   * Return the invoices carrying `tag`.
   *
   * @returns Matching invoices, or an empty array when the tag is unknown.
   */
  getByTag(tag: string): Invoice[] {
    const bucket = this.byTag.get(tag.toLowerCase());
    return bucket ? [...bucket] : [];
  }

  /** All known tags, sorted alphabetically. */
  tags(): string[] {
    return [...this.byTag.keys()].sort();
  }
}

/**
 * Applies an {@link InvoiceFilter} to an in-memory invoice set.
 *
 * @example
 * ```ts
 * const engine = new InvoiceQueryEngine(invoices);
 * const page = engine.query({ status: ["Pending"], sort: "highest", limit: 10 });
 * ```
 */
export class InvoiceQueryEngine {
  private readonly invoices: Invoice[];

  constructor(invoices: Iterable<Invoice> = []) {
    this.invoices = [...invoices];
  }

  /** Number of invoices currently indexed. */
  get size(): number {
    return this.invoices.length;
  }

  /** A tag index built over the current invoice set. */
  tagIndex(): InvoiceTagIndex {
    return new InvoiceTagIndex(this.invoices);
  }

  /**
   * Filter, sort and paginate the indexed invoices.
   *
   * @param filter - The query to run. Omit to return the first page unfiltered.
   * @returns A page of matching invoices, plus a cursor when more remain.
   * @throws {ValidationError} If the filter is internally inconsistent
   *   (e.g. `minAmount > maxAmount`) or the cursor is malformed.
   */
  query(filter: InvoiceFilter = {}): InvoicePage {
    validateFilter(filter);
    const resolved = resolveFilter(filter);
    const offset = decodeCursor(filter.cursor) ?? 0;

    const matched = sortInvoices(
      this.invoices.filter((invoice) => matches(invoice, resolved)),
      resolved.sort,
    );

    const total = matched.length;
    const items = matched.slice(offset, offset + resolved.limit);
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < total ? encodeCursor(nextOffset) : undefined;

    return nextCursor !== undefined
      ? { items, nextCursor, total }
      : { items, total };
  }
}

/**
 * Convenience wrapper around {@link InvoiceQueryEngine} for one-off queries.
 *
 * @param invoices - The invoices to search.
 * @param filter - The query to run.
 */
export function queryInvoices(
  invoices: Iterable<Invoice>,
  filter: InvoiceFilter = {},
): InvoicePage {
  return new InvoiceQueryEngine(invoices).query(filter);
}
