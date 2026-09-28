/**
 * Invoice history entry types for on-chain ring buffer event log parsing.
 */

export type HistoryEventType = "payment" | "release" | "refund" | "note" | "pause" | "cancel" | "freeze" | "unfreeze";

export interface BaseHistoryEntry {
  eventType: HistoryEventType;
  timestamp: number;
  actor: string;
}

export interface PaymentHistoryEntry extends BaseHistoryEntry {
  eventType: "payment";
  amount: bigint;
  payer: string;
}

export interface ReleaseHistoryEntry extends BaseHistoryEntry {
  eventType: "release";
  amount: bigint;
  recipient: string;
}

export interface RefundHistoryEntry extends BaseHistoryEntry {
  eventType: "refund";
  amount: bigint;
  refundee: string;
}

export interface NoteHistoryEntry extends BaseHistoryEntry {
  eventType: "note";
  content: string;
}

export interface PauseHistoryEntry extends BaseHistoryEntry {
  eventType: "pause";
  reason?: string;
}

export interface ResumeHistoryEntry extends BaseHistoryEntry {
  eventType: "pause";
}

export interface CancelHistoryEntry extends BaseHistoryEntry {
  eventType: "cancel";
  reason?: string;
}

export interface FreezeHistoryEntry extends BaseHistoryEntry {
  eventType: "freeze";
  reason?: string;
}

export interface UnfreezeHistoryEntry extends BaseHistoryEntry {
  eventType: "unfreeze";
}

export type HistoryEntry =
  | PaymentHistoryEntry
  | ReleaseHistoryEntry
  | RefundHistoryEntry
  | NoteHistoryEntry
  | PauseHistoryEntry
  | ResumeHistoryEntry
  | CancelHistoryEntry
  | FreezeHistoryEntry
  | UnfreezeHistoryEntry;

export interface HistoryPageOptions {
  limit?: number;
  cursor?: string;
}

export interface HistoryPage {
  entries: HistoryEntry[];
  nextCursor?: string;
  hasMore: boolean;
}
