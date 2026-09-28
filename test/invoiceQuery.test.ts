import { describe, expect, it } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-base";
import { randomBytes } from "crypto";
import { StellarSplitClient } from "../src/client.js";
import {
  InvoiceQueryEngine,
  InvoiceTagIndex,
  queryInvoices,
  getInvoiceTags,
  INVOICE_SORTS,
  DEFAULT_QUERY_LIMIT,
} from "../src/invoiceQuery.js";
import { ValidationError } from "../src/errors.js";
import type { Invoice, InvoiceStatus } from "../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CREATOR = Keypair.random().publicKey();
const OTHER_CREATOR = Keypair.random().publicKey();

/** 2026-01-01T00:00:00Z in Unix seconds — the reference "day one". */
const DAY_ONE = 1_767_225_600;

let nextId = 0;

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  nextId += 1;
  return {
    id: String(nextId),
    creator: CREATOR,
    recipients: [{ address: OTHER_CREATOR, amount: 100n }],
    token: "USDC",
    deadline: DAY_ONE + 86_400,
    createdAt: DAY_ONE,
    funded: 0n,
    status: "Pending",
    payments: [],
    ...overrides,
  };
}

/** `count` invoices, one per index, all owned by CREATOR. */
function makeInvoices(
  count: number,
  overrides: (i: number) => Partial<Invoice> = () => ({}),
): Invoice[] {
  return Array.from({ length: count }, (_, i) => makeInvoice(overrides(i)));
}

// ---------------------------------------------------------------------------
// Each filter type in isolation
// ---------------------------------------------------------------------------

describe("InvoiceQueryEngine — individual filters", () => {
  it("returns every invoice when no filter is supplied", () => {
    const page = queryInvoices(makeInvoices(3));
    expect(page.items).toHaveLength(3);
    expect(page.total).toBe(3);
  });

  it("filters by creator", () => {
    const mine = makeInvoice({ creator: CREATOR });
    const theirs = makeInvoice({ creator: OTHER_CREATOR });
    const page = queryInvoices([mine, theirs], { creator: CREATOR });
    expect(page.items.map((i) => i.creator)).toEqual([CREATOR]);
  });

  it("filters by a single status", () => {
    const pending = makeInvoice({ status: "Pending" });
    const released = makeInvoice({ status: "Released" });
    const page = queryInvoices([pending, released], { status: ["Pending"] });
    expect(page.items).toEqual([pending]);
  });

  it("treats status as an OR across the array", () => {
    const pending = makeInvoice({ status: "Pending" });
    const released = makeInvoice({ status: "Released" });
    const cancelled = makeInvoice({ status: "Cancelled" });
    const page = queryInvoices([pending, released, cancelled], {
      status: ["Pending", "Released"],
    });
    expect(page.items).toEqual([pending, released]);
  });

  it("filters by minimum amount using the recipients total", () => {
    const small = makeInvoice({ recipients: [{ address: OTHER_CREATOR, amount: 50n }] });
    const large = makeInvoice({ recipients: [{ address: OTHER_CREATOR, amount: 500n }] });
    const page = queryInvoices([small, large], { minAmount: 100n });
    expect(page.items).toEqual([large]);
  });

  it("filters by maximum amount", () => {
    const small = makeInvoice({ recipients: [{ address: OTHER_CREATOR, amount: 50n }] });
    const large = makeInvoice({ recipients: [{ address: OTHER_CREATOR, amount: 500n }] });
    const page = queryInvoices([small, large], { maxAmount: 100n });
    expect(page.items).toEqual([small]);
  });

  it("sums multiple recipients when computing the invoice total", () => {
    const split = makeInvoice({
      recipients: [
        { address: OTHER_CREATOR, amount: 60n },
        { address: "GOTHERRECIPIENT", amount: 45n },
      ],
    });
    expect(queryInvoices([split], { minAmount: 100n }).items).toEqual([split]);
  });

  it("applies amount bounds inclusively", () => {
    const invoice = makeInvoice({ recipients: [{ address: OTHER_CREATOR, amount: 100n }] });
    const page = queryInvoices([invoice], { minAmount: 100n, maxAmount: 100n });
    expect(page.items).toEqual([invoice]);
  });

  it("handles amounts beyond Number.MAX_SAFE_INTEGER", () => {
    const huge = 9_007_199_254_740_993n; // 2^53 + 1
    const invoice = makeInvoice({ recipients: [{ address: OTHER_CREATOR, amount: huge }] });
    expect(queryInvoices([invoice], { minAmount: huge }).items).toEqual([invoice]);
    expect(queryInvoices([invoice], { maxAmount: huge - 1n }).items).toEqual([]);
  });
});

describe("InvoiceQueryEngine — date filters", () => {
  it("filters by a fromDate bound", () => {
    const early = makeInvoice({ createdAt: DAY_ONE });
    const late = makeInvoice({ createdAt: DAY_ONE + 86_400 });
    const page = queryInvoices([early, late], { fromDate: DAY_ONE + 3_600 });
    expect(page.items).toEqual([late]);
  });

  it("filters by a toDate bound", () => {
    const early = makeInvoice({ createdAt: DAY_ONE });
    const late = makeInvoice({ createdAt: DAY_ONE + 86_400 });
    const page = queryInvoices([early, late], { toDate: DAY_ONE + 3_600 });
    expect(page.items).toEqual([early]);
  });

  it("applies date bounds inclusively", () => {
    const invoice = makeInvoice({ createdAt: DAY_ONE });
    const page = queryInvoices([invoice], { fromDate: DAY_ONE, toDate: DAY_ONE });
    expect(page.items).toEqual([invoice]);
  });

  it("accepts filter bounds expressed in milliseconds", () => {
    const invoice = makeInvoice({ createdAt: DAY_ONE });
    expect(queryInvoices([invoice], { fromDate: DAY_ONE * 1000 }).items).toEqual([invoice]);
  });

  it("accepts createdAt expressed in milliseconds", () => {
    const invoice = makeInvoice({ createdAt: DAY_ONE * 1000 });
    expect(queryInvoices([invoice], { toDate: DAY_ONE * 1000 }).items).toEqual([invoice]);
  });

  it("excludes invoices with an unknown creation time", () => {
    const undated = makeInvoice({ createdAt: undefined });
    expect(queryInvoices([undated], { fromDate: 0 }).items).toEqual([]);
  });
});

describe("InvoiceQueryEngine — tag filters", () => {
  it("filters by explicit tags", () => {
    const urgent = makeInvoice({ tags: ["urgent", "q1"] });
    const normal = makeInvoice({ tags: ["q1"] });
    expect(queryInvoices([urgent, normal], { tags: ["urgent"] }).items).toEqual([urgent]);
  });

  it("requires all requested tags to be present", () => {
    const both = makeInvoice({ tags: ["urgent", "q1"] });
    const one = makeInvoice({ tags: ["urgent"] });
    expect(queryInvoices([both, one], { tags: ["urgent", "q1"] }).items).toEqual([both]);
  });

  it("matches tags case-insensitively", () => {
    const invoice = makeInvoice({ tags: ["Urgent"] });
    expect(queryInvoices([invoice], { tags: ["URGENT"] }).items).toEqual([invoice]);
  });

  it("falls back to #hashtags in the memo when tags are absent", () => {
    const tagged = makeInvoice({ memo: "Q3 invoice #urgent #acme" });
    const untagged = makeInvoice({ memo: "no tags here" });
    expect(queryInvoices([tagged, untagged], { tags: ["urgent"] }).items).toEqual([tagged]);
  });

  it("prefers explicit tags over memo hashtags", () => {
    const invoice = makeInvoice({ tags: ["real"], memo: "#fake" });
    expect(getInvoiceTags(invoice)).toEqual(["real"]);
    expect(queryInvoices([invoice], { tags: ["fake"] }).items).toEqual([]);
  });
});

describe("InvoiceQueryEngine — combined filters", () => {
  it("ANDs every supplied field together", () => {
    const match = makeInvoice({
      status: "Pending",
      createdAt: DAY_ONE,
      recipients: [{ address: OTHER_CREATOR, amount: 200n }],
      tags: ["urgent"],
    });
    const wrongStatus = makeInvoice({ ...match, id: "900", status: "Cancelled" });
    const wrongAmount = makeInvoice({
      ...match,
      id: "901",
      recipients: [{ address: OTHER_CREATOR, amount: 5n }],
    });
    const wrongTag = makeInvoice({ ...match, id: "902", tags: ["q1"] });
    const wrongDate = makeInvoice({ ...match, id: "903", createdAt: DAY_ONE + 999_999 });

    const page = queryInvoices([match, wrongStatus, wrongAmount, wrongTag, wrongDate], {
      status: ["Pending"],
      minAmount: 100n,
      maxAmount: 300n,
      fromDate: DAY_ONE - 1,
      toDate: DAY_ONE + 1,
      tags: ["urgent"],
    });

    expect(page.items).toEqual([match]);
    expect(page.total).toBe(1);
  });

  it("combines creator with other filters", () => {
    const mine = makeInvoice({ status: "Pending" });
    const theirs = makeInvoice({ creator: OTHER_CREATOR, status: "Pending" });
    const page = queryInvoices([mine, theirs], { creator: CREATOR, status: ["Pending"] });
    expect(page.items).toEqual([mine]);
  });
});

describe("InvoiceQueryEngine — sorting", () => {
  const invoices = [
    makeInvoice({
      id: "1",
      createdAt: DAY_ONE,
      recipients: [{ address: OTHER_CREATOR, amount: 300n }],
    }),
    makeInvoice({
      id: "2",
      createdAt: DAY_ONE + 86_400,
      recipients: [{ address: OTHER_CREATOR, amount: 100n }],
    }),
    makeInvoice({
      id: "3",
      createdAt: DAY_ONE + 43_200,
      recipients: [{ address: OTHER_CREATOR, amount: 200n }],
    }),
  ];

  it("sorts newest first by default", () => {
    expect(queryInvoices(invoices).items.map((i) => i.id)).toEqual(["2", "3", "1"]);
  });

  it.each(INVOICE_SORTS)("supports the %s sort", (sort) => {
    expect(queryInvoices(invoices, { sort }).items).toHaveLength(3);
  });

  it("sorts oldest first", () => {
    expect(queryInvoices(invoices, { sort: "oldest" }).items.map((i) => i.id)).toEqual([
      "1",
      "3",
      "2",
    ]);
  });

  it("sorts highest amount first", () => {
    expect(queryInvoices(invoices, { sort: "highest" }).items.map((i) => i.id)).toEqual([
      "1",
      "3",
      "2",
    ]);
  });

  it("sorts lowest amount first", () => {
    expect(queryInvoices(invoices, { sort: "lowest" }).items.map((i) => i.id)).toEqual([
      "2",
      "3",
      "1",
    ]);
  });

  it("breaks ties on invoice ID for deterministic paging", () => {
    const tied = [
      makeInvoice({ id: "b", createdAt: DAY_ONE, recipients: [{ address: OTHER_CREATOR, amount: 1n }] }),
      makeInvoice({ id: "a", createdAt: DAY_ONE, recipients: [{ address: OTHER_CREATOR, amount: 1n }] }),
    ];
    expect(queryInvoices(tied, { sort: "highest" }).items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("sorts invoices with an unknown creation time last under 'newest'", () => {
    const undated = makeInvoice({ id: "0", createdAt: undefined });
    const dated = makeInvoice({ id: "9", createdAt: DAY_ONE });
    expect(queryInvoices([undated, dated], { sort: "newest" }).items.map((i) => i.id)).toEqual([
      "9",
      "0",
    ]);
  });
});

describe("InvoiceQueryEngine — pagination", () => {
  const invoices = makeInvoices(25);

  it("defaults to a page size of 20", () => {
    expect(DEFAULT_QUERY_LIMIT).toBe(20);
    expect(queryInvoices(invoices).items).toHaveLength(20);
  });

  it("honours an explicit limit", () => {
    expect(queryInvoices(invoices, { limit: 5 }).items).toHaveLength(5);
  });

  it("returns a nextCursor while more pages remain", () => {
    expect(queryInvoices(invoices, { limit: 10 }).nextCursor).toBeDefined();
  });

  it("omits nextCursor on the final page", () => {
    expect(queryInvoices(invoices, { limit: 25 }).nextCursor).toBeUndefined();
  });

  it("reports the unpaginated total on every page", () => {
    expect(queryInvoices(invoices, { limit: 10 }).total).toBe(25);
  });

  it("walks every page without gaps or duplicates", () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let guard = 0;

    do {
      const page = queryInvoices(invoices, { limit: 10, cursor });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      guard += 1;
    } while (cursor !== undefined && guard < 10);

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  it("returns an empty page when the cursor is past the end", () => {
    const past = queryInvoices(invoices, { limit: 5, cursor: "off:25" });
    expect(past.items).toEqual([]);
    expect(past.total).toBe(25);
  });

  it("paginates a filtered result set, not the raw set", () => {
    const cancelled = makeInvoices(5, () => ({ status: "Cancelled" as InvoiceStatus }));
    const first = queryInvoices([...invoices, ...cancelled], {
      status: ["Cancelled"],
      limit: 2,
    });
    expect(first.items).toHaveLength(2);
    expect(first.total).toBe(5);
  });
});

describe("InvoiceQueryEngine — empty results", () => {
  it("returns an empty page when nothing matches", () => {
    const page = queryInvoices(makeInvoices(3), { creator: OTHER_CREATOR });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.nextCursor).toBeUndefined();
  });

  it("returns an empty page for an empty invoice set", () => {
    expect(queryInvoices([], { status: ["Pending"] })).toEqual({ items: [], total: 0 });
  });

  it("returns an empty page for an unknown tag", () => {
    expect(queryInvoices(makeInvoices(2), { tags: ["nonexistent"] }).items).toEqual([]);
  });
});

describe("InvoiceQueryEngine — validation", () => {
  it("rejects an inverted amount range", () => {
    expect(() => queryInvoices([], { minAmount: 10n, maxAmount: 1n })).toThrow(ValidationError);
  });

  it("rejects an inverted date range", () => {
    expect(() => queryInvoices([], { fromDate: 200, toDate: 100 })).toThrow(ValidationError);
  });

  it("rejects a non-positive limit", () => {
    expect(() => queryInvoices([], { limit: 0 })).toThrow(ValidationError);
    expect(() => queryInvoices([], { limit: -1 })).toThrow(ValidationError);
  });

  it("rejects an unknown sort", () => {
    expect(() => queryInvoices([], { sort: "sideways" as never })).toThrow(ValidationError);
  });

  it("rejects a malformed cursor", () => {
    expect(() => queryInvoices([], { cursor: "garbage" })).toThrow(ValidationError);
  });
});

describe("InvoiceTagIndex", () => {
  it("groups invoices by tag", () => {
    const a = makeInvoice({ tags: ["alpha", "shared"] });
    const b = makeInvoice({ tags: ["beta", "shared"] });
    const index = new InvoiceTagIndex([a, b]);

    expect(index.getByTag("alpha")).toEqual([a]);
    expect(index.getByTag("shared")).toEqual([a, b]);
    expect(index.getByTag("missing")).toEqual([]);
  });

  it("lists all known tags sorted", () => {
    expect(new InvoiceTagIndex([makeInvoice({ tags: ["zeta", "alpha"] })]).tags()).toEqual([
      "alpha",
      "zeta",
    ]);
  });

  it("is exposed by the engine", () => {
    expect(new InvoiceQueryEngine([makeInvoice({ tags: ["x"] })]).tagIndex().tags()).toEqual(["x"]);
  });

  it("reports the size of the indexed set", () => {
    expect(new InvoiceQueryEngine(makeInvoices(4)).size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// client.queryInvoices() integration
// ---------------------------------------------------------------------------

describe("StellarSplitClient.queryInvoices", () => {
  const creator = Keypair.random().publicKey();

  /** Build a client whose getInvoicesByCreator/getInvoice return `invoices`. */
  function makeClient(invoices: Invoice[]): StellarSplitClient {
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(randomBytes(32)),
    });
    // Stub the two chain reads queryInvoices depends on.
    client.getInvoicesByCreator = async () => ({
      items: invoices.map((i) => i.id),
      nextCursor: null,
      total: invoices.length,
    });
    client.getInvoice = async (id: string) => {
      const found = invoices.find((i) => i.id === id);
      if (!found) throw new Error(`Unknown invoice ${id}`);
      return found;
    };
    return client;
  }

  const dataset: Invoice[] = [
    makeInvoice({ id: "a", creator, status: "Pending", createdAt: DAY_ONE, recipients: [{ address: OTHER_CREATOR, amount: 10n }] }),
    makeInvoice({ id: "b", creator, status: "Released", createdAt: DAY_ONE + 100, recipients: [{ address: OTHER_CREATOR, amount: 900n }] }),
    makeInvoice({ id: "c", creator, status: "Cancelled", createdAt: DAY_ONE + 200, recipients: [{ address: OTHER_CREATOR, amount: 500n }] }),
  ];

  it("filters invoices fetched from the chain", async () => {
    const page = await makeClient(dataset).queryInvoices({ creator, status: ["Pending"] });
    expect(page.items.map((i) => i.id)).toEqual(["a"]);
    expect(page.total).toBe(1);
  });

  it("sorts the fetched invoices", async () => {
    const page = await makeClient(dataset).queryInvoices({ creator, sort: "highest" });
    expect(page.items.map((i) => i.id)).toEqual(["b", "c", "a"]);
  });

  it("paginates the fetched invoices", async () => {
    const page = await makeClient(dataset).queryInvoices({ creator, limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeDefined();

    const next = await makeClient(dataset).queryInvoices({ creator, limit: 2, cursor: page.nextCursor });
    expect(next.items.map((i) => i.id)).toEqual(["a"]);
    expect(next.nextCursor).toBeUndefined();
  });

  it("returns an empty page when nothing matches", async () => {
    const page = await makeClient(dataset).queryInvoices({ creator, status: ["Refunded"] });
    expect(page).toEqual({ items: [], total: 0 });
  });

  it("requires a creator because the contract has no global invoice index", async () => {
    await expect(makeClient(dataset).queryInvoices({ status: ["Pending"] })).rejects.toThrow(
      ValidationError,
    );
  });
});
