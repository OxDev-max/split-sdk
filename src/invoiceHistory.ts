/**
 * Invoice history retrieval and parsing from on-chain ring buffer.
 */

import type { HistoryEntry, HistoryPage, HistoryPageOptions } from "./types/invoiceHistory.js";

export async function getInvoiceHistory(
  invoiceId: bigint,
  client: any
): Promise<HistoryEntry[]> {
  const page = await getHistoryPage(invoiceId, 1000, undefined, client);
  const entries = [...page.entries];

  let nextCursor = page.nextCursor;
  while (page.hasMore && nextCursor) {
    const nextPage = await getHistoryPage(invoiceId, 1000, nextCursor, client);
    entries.push(...nextPage.entries);
    nextCursor = nextPage.nextCursor;
  }

  return entries.sort((a, b) => a.timestamp - b.timestamp);
}

export async function getHistoryPage(
  invoiceId: bigint,
  limit: number = 100,
  cursor?: string,
  client?: any
): Promise<HistoryPage> {
  // Implementation would integrate with actual contract storage reads
  // For now, return empty page structure
  return {
    entries: [],
    nextCursor: undefined,
    hasMore: false,
  };
}

export function parseHistoryEvent(raw: any): HistoryEntry | null {
  if (!raw || !raw.eventType) return null;

  const baseEntry = {
    timestamp: raw.timestamp || 0,
    actor: raw.actor || "",
  };

  switch (raw.eventType) {
    case "payment":
      return {
        ...baseEntry,
        eventType: "payment",
        amount: BigInt(raw.amount || 0),
        payer: raw.payer || "",
      };

    case "release":
      return {
        ...baseEntry,
        eventType: "release",
        amount: BigInt(raw.amount || 0),
        recipient: raw.recipient || "",
      };

    case "refund":
      return {
        ...baseEntry,
        eventType: "refund",
        amount: BigInt(raw.amount || 0),
        refundee: raw.refundee || "",
      };

    case "note":
      return {
        ...baseEntry,
        eventType: "note",
        content: raw.content || "",
      };

    case "pause":
      return {
        ...baseEntry,
        eventType: "pause",
        reason: raw.reason,
      };

    case "cancel":
      return {
        ...baseEntry,
        eventType: "cancel",
        reason: raw.reason,
      };

    case "freeze":
      return {
        ...baseEntry,
        eventType: "freeze",
        reason: raw.reason,
      };

    case "unfreeze":
      return {
        ...baseEntry,
        eventType: "unfreeze",
      };

    default:
      return null;
  }
}
