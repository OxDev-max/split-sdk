import { describe, it, expect } from "vitest";
import { parseHistoryEvent } from "../src/invoiceHistory";
import type { HistoryEntry } from "../src/types/invoiceHistory";

describe("Invoice History", () => {
  describe("parseHistoryEvent", () => {
    it("parses payment events", () => {
      const raw = {
        eventType: "payment",
        timestamp: 1000,
        actor: "payer1",
        amount: "100",
        payer: "payer1",
      };

      const event = parseHistoryEvent(raw) as any;
      expect(event.eventType).toBe("payment");
      expect(event.amount).toBe(BigInt(100));
      expect(event.payer).toBe("payer1");
    });

    it("parses release events", () => {
      const raw = {
        eventType: "release",
        timestamp: 2000,
        actor: "recipient1",
        amount: "50",
        recipient: "recipient1",
      };

      const event = parseHistoryEvent(raw) as any;
      expect(event.eventType).toBe("release");
      expect(event.amount).toBe(BigInt(50));
      expect(event.recipient).toBe("recipient1");
    });

    it("parses refund events", () => {
      const raw = {
        eventType: "refund",
        timestamp: 3000,
        actor: "refunder",
        amount: "25",
        refundee: "refundee",
      };

      const event = parseHistoryEvent(raw) as any;
      expect(event.eventType).toBe("refund");
      expect(event.amount).toBe(BigInt(25));
      expect(event.refundee).toBe("refundee");
    });

    it("parses note events", () => {
      const raw = {
        eventType: "note",
        timestamp: 4000,
        actor: "creator",
        content: "test note",
      };

      const event = parseHistoryEvent(raw) as any;
      expect(event.eventType).toBe("note");
      expect(event.content).toBe("test note");
    });

    it("parses pause events", () => {
      const raw = {
        eventType: "pause",
        timestamp: 5000,
        actor: "admin",
        reason: "under review",
      };

      const event = parseHistoryEvent(raw) as any;
      expect(event.eventType).toBe("pause");
      expect(event.reason).toBe("under review");
    });

    it("parses cancel events", () => {
      const raw = {
        eventType: "cancel",
        timestamp: 6000,
        actor: "creator",
        reason: "no longer needed",
      };

      const event = parseHistoryEvent(raw) as any;
      expect(event.eventType).toBe("cancel");
      expect(event.reason).toBe("no longer needed");
    });

    it("parses freeze events", () => {
      const raw = {
        eventType: "freeze",
        timestamp: 7000,
        actor: "admin",
        reason: "compliance",
      };

      const event = parseHistoryEvent(raw) as any;
      expect(event.eventType).toBe("freeze");
      expect(event.reason).toBe("compliance");
    });

    it("parses unfreeze events", () => {
      const raw = {
        eventType: "unfreeze",
        timestamp: 8000,
        actor: "admin",
      };

      const event = parseHistoryEvent(raw) as any;
      expect(event.eventType).toBe("unfreeze");
    });

    it("returns null for unknown event types", () => {
      const raw = {
        eventType: "unknown",
        timestamp: 1000,
        actor: "someone",
      };

      expect(parseHistoryEvent(raw)).toBeNull();
    });

    it("returns null for missing event type", () => {
      const raw = {
        timestamp: 1000,
        actor: "someone",
      };

      expect(parseHistoryEvent(raw)).toBeNull();
    });

    it("handles missing optional fields", () => {
      const raw = {
        eventType: "note",
        timestamp: 1000,
        actor: "creator",
      };

      const event = parseHistoryEvent(raw) as any;
      expect(event.eventType).toBe("note");
      expect(event.content).toBe("");
    });
  });

  describe("event chronological ordering", () => {
    it("events maintain chronological order", () => {
      const events: HistoryEntry[] = [
        {
          eventType: "payment",
          timestamp: 1000,
          actor: "payer1",
          amount: BigInt(100),
          payer: "payer1",
        },
        {
          eventType: "release",
          timestamp: 2000,
          actor: "recipient1",
          amount: BigInt(50),
          recipient: "recipient1",
        },
        {
          eventType: "cancel",
          timestamp: 3000,
          actor: "creator",
          reason: "done",
        },
      ];

      const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
      expect(sorted[0].timestamp).toBe(1000);
      expect(sorted[1].timestamp).toBe(2000);
      expect(sorted[2].timestamp).toBe(3000);
    });
  });
});
