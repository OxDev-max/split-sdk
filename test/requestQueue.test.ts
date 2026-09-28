import { describe, it, expect, beforeEach } from "vitest";
import { RequestQueue } from "../src/requestQueue";

describe("RequestQueue", () => {
  let queue: RequestQueue;

  beforeEach(() => {
    queue = new RequestQueue(2);
  });

  it("respects maxConcurrent", async () => {
    let maxConcurrentSeen = 0;
    let currentActive = 0;

    const makeRequest = (delay: number) => async () => {
      currentActive++;
      maxConcurrentSeen = Math.max(maxConcurrentSeen, currentActive);
      await new Promise((resolve) => setTimeout(resolve, delay));
      currentActive--;
    };

    await Promise.all([
      queue.enqueue(makeRequest(10), "normal"),
      queue.enqueue(makeRequest(10), "normal"),
      queue.enqueue(makeRequest(10), "normal"),
      queue.enqueue(makeRequest(10), "normal"),
    ]);

    expect(maxConcurrentSeen).toBe(2);
  });

  it("high priority requests jump the queue", async () => {
    const order: string[] = [];

    await Promise.all([
      queue.enqueue(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          order.push("normal1");
        },
        "normal"
      ),
      queue.enqueue(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          order.push("normal2");
        },
        "normal"
      ),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await queue.enqueue(async () => {
          order.push("high");
        }, "high");
      })(),
    ]);

    expect(order[order.length - 1]).toBe("high");
  });

  it("queue.stats() is accurate", async () => {
    const stats = queue.stats();
    expect(stats.high.pending).toBe(0);
    expect(stats.normal.pending).toBe(0);
    expect(stats.low.pending).toBe(0);

    queue.enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }, "high");

    queue.enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }, "high");

    queue.enqueue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }, "normal");

    const stats2 = queue.stats();
    expect(stats2.high.pending).toBeGreaterThan(0);
    expect(stats2.normal.pending).toBeGreaterThan(0);
  });

  it("drains queue after completion", async () => {
    let completed = 0;

    await Promise.all([
      queue.enqueue(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        completed++;
      }, "normal"),
      queue.enqueue(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        completed++;
      }, "normal"),
    ]);

    await queue.drain();

    expect(completed).toBe(2);
    const stats = queue.stats();
    expect(stats.high.pending).toBe(0);
    expect(stats.normal.pending).toBe(0);
    expect(stats.low.pending).toBe(0);
  });

  it("tracks completed and failed requests", async () => {
    await queue.enqueue(async () => {
      return "success";
    }, "high");

    try {
      await queue.enqueue(async () => {
        throw new Error("fail");
      }, "high");
    } catch {
      // expected
    }

    const stats = queue.stats();
    expect(stats.high.completed).toBe(1);
    expect(stats.high.failed).toBe(1);
  });
});
