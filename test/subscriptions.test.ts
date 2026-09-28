import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createSubscription,
  triggerSubscription,
  pauseSubscription,
  resumeSubscription,
  getSubscription,
  cancelSubscription,
  SubscriptionNotFoundError,
  TooEarlyToTriggerError,
} from "../src/subscriptions";
import type { CreateInvoiceParams } from "../src/types";

describe("Subscription Management", () => {
  const mockParams: CreateInvoiceParams = {
    creator: "creator1",
    recipients: [{ address: "recipient1", percentage: 100 }],
    amount: BigInt(1000),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("createSubscription", () => {
    it("creates a subscription with active status", async () => {
      const subscriptionId = await createSubscription(
        {
          params: mockParams,
          intervalSeconds: 86400, // 1 day
        },
        "creator1"
      );

      const subscription = await getSubscription(subscriptionId);
      expect(subscription.status).toBe("active");
      expect(subscription.intervalSeconds).toBe(86400);
      expect(subscription.creator).toBe("creator1");
    });

    it("sets nextDueAt correctly", async () => {
      const now = Date.now();
      vi.setSystemTime(now);

      const subscriptionId = await createSubscription(
        {
          params: mockParams,
          intervalSeconds: 3600, // 1 hour
        },
        "creator1"
      );

      const subscription = await getSubscription(subscriptionId);
      expect(subscription.nextDueAt).toBe(now + 3600 * 1000);
    });

    it("increments subscription IDs", async () => {
      const sub1 = await createSubscription(
        { params: mockParams, intervalSeconds: 3600 },
        "creator1"
      );

      const sub2 = await createSubscription(
        { params: mockParams, intervalSeconds: 3600 },
        "creator1"
      );

      expect(sub2 > sub1).toBe(true);
    });
  });

  describe("triggerSubscription", () => {
    it("triggers subscription when time is due", async () => {
      const startTime = Date.now();
      vi.setSystemTime(startTime);

      const subscriptionId = await createSubscription(
        {
          params: mockParams,
          intervalSeconds: 3600,
        },
        "creator1"
      );

      // Advance time past nextDueAt
      vi.setSystemTime(startTime + 3600 * 1000 + 1000);

      const invoiceId = await triggerSubscription(subscriptionId);
      expect(invoiceId).toBeDefined();

      const subscription = await getSubscription(subscriptionId);
      expect(subscription.lastTriggeredAt).toBe(startTime + 3600 * 1000 + 1000);
      expect(subscription.nextDueAt).toBe(startTime + 7200 * 1000 + 1000);
    });

    it("throws TooEarlyToTriggerError if not yet due", async () => {
      const startTime = Date.now();
      vi.setSystemTime(startTime);

      const subscriptionId = await createSubscription(
        {
          params: mockParams,
          intervalSeconds: 3600,
        },
        "creator1"
      );

      // Try to trigger too early
      await expect(triggerSubscription(subscriptionId)).rejects.toThrow(
        TooEarlyToTriggerError
      );
    });

    it("includes nextDueAt in TooEarlyToTriggerError", async () => {
      const startTime = Date.now();
      vi.setSystemTime(startTime);

      const subscriptionId = await createSubscription(
        {
          params: mockParams,
          intervalSeconds: 3600,
        },
        "creator1"
      );

      try {
        await triggerSubscription(subscriptionId);
        expect.fail("Should have thrown");
      } catch (error: any) {
        expect(error.nextDueAt).toBeDefined();
        expect(error.subscriptionId).toBe(subscriptionId);
      }
    });

    it("throws error for paused subscription", async () => {
      const startTime = Date.now();
      vi.setSystemTime(startTime);

      const subscriptionId = await createSubscription(
        {
          params: mockParams,
          intervalSeconds: 3600,
        },
        "creator1"
      );

      await pauseSubscription(subscriptionId);
      vi.setSystemTime(startTime + 3600 * 1000 + 1000);

      await expect(triggerSubscription(subscriptionId)).rejects.toThrow(
        /Cannot trigger paused/
      );
    });

    it("throws error for non-existent subscription", async () => {
      await expect(triggerSubscription(BigInt(999999))).rejects.toThrow(
        SubscriptionNotFoundError
      );
    });
  });

  describe("pauseSubscription", () => {
    it("pauses an active subscription", async () => {
      const subscriptionId = await createSubscription(
        {
          params: mockParams,
          intervalSeconds: 3600,
        },
        "creator1"
      );

      await pauseSubscription(subscriptionId);

      const subscription = await getSubscription(subscriptionId);
      expect(subscription.status).toBe("paused");
    });

    it("prevents triggering paused subscription", async () => {
      const startTime = Date.now();
      vi.setSystemTime(startTime);

      const subscriptionId = await createSubscription(
        {
          params: mockParams,
          intervalSeconds: 3600,
        },
        "creator1"
      );

      await pauseSubscription(subscriptionId);
      vi.setSystemTime(startTime + 3600 * 1000 + 1000);

      await expect(triggerSubscription(subscriptionId)).rejects.toThrow();
    });
  });

  describe("resumeSubscription", () => {
    it("resumes a paused subscription", async () => {
      const startTime = Date.now();
      vi.setSystemTime(startTime);

      const subscriptionId = await createSubscription(
        {
          params: mockParams,
          intervalSeconds: 3600,
        },
        "creator1"
      );

      await pauseSubscription(subscriptionId);
      expect((await getSubscription(subscriptionId)).status).toBe("paused");

      await resumeSubscription(subscriptionId);
      expect((await getSubscription(subscriptionId)).status).toBe("active");
    });

    it("resets nextDueAt on resume", async () => {
      const startTime = Date.now();
      vi.setSystemTime(startTime);

      const subscriptionId = await createSubscription(
        {
          params: mockParams,
          intervalSeconds: 3600,
        },
        "creator1"
      );

      await pauseSubscription(subscriptionId);
      vi.setSystemTime(startTime + 5000);
      await resumeSubscription(subscriptionId);

      const subscription = await getSubscription(subscriptionId);
      expect(subscription.nextDueAt).toBe(startTime + 5000 + 3600 * 1000);
    });
  });

  describe("full subscription lifecycle", () => {
    it("handles complete lifecycle: create, trigger, pause, resume, cancel", async () => {
      const startTime = Date.now();
      vi.setSystemTime(startTime);

      // Create
      const subscriptionId = await createSubscription(
        {
          params: mockParams,
          intervalSeconds: 3600,
        },
        "creator1"
      );
      expect((await getSubscription(subscriptionId)).status).toBe("active");

      // Trigger
      vi.setSystemTime(startTime + 3600 * 1000 + 1000);
      await triggerSubscription(subscriptionId);
      expect((await getSubscription(subscriptionId)).lastTriggeredAt).toBe(
        startTime + 3600 * 1000 + 1000
      );

      // Pause
      await pauseSubscription(subscriptionId);
      expect((await getSubscription(subscriptionId)).status).toBe("paused");

      // Resume
      await resumeSubscription(subscriptionId);
      expect((await getSubscription(subscriptionId)).status).toBe("active");

      // Cancel
      await cancelSubscription(subscriptionId);
      expect((await getSubscription(subscriptionId)).status).toBe("cancelled");
    });
  });

  describe("error handling", () => {
    it("throws SubscriptionNotFoundError for missing subscription", async () => {
      await expect(getSubscription(BigInt(999999))).rejects.toThrow(
        SubscriptionNotFoundError
      );
    });

    it("throws SubscriptionNotFoundError on pause of missing", async () => {
      await expect(pauseSubscription(BigInt(999999))).rejects.toThrow(
        SubscriptionNotFoundError
      );
    });

    it("throws SubscriptionNotFoundError on resume of missing", async () => {
      await expect(resumeSubscription(BigInt(999999))).rejects.toThrow(
        SubscriptionNotFoundError
      );
    });

    it("throws SubscriptionNotFoundError on cancel of missing", async () => {
      await expect(cancelSubscription(BigInt(999999))).rejects.toThrow(
        SubscriptionNotFoundError
      );
    });
  });
});
