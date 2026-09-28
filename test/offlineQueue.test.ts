import { expect } from "chai";
import { StellarSplitClient } from "../src/client.js";
import * as health from "../src/health.js";
import sinon from "sinon";

describe("OfflineQueue", () => {
  let client: StellarSplitClient;
  let healthStub: sinon.SinonStub;

  beforeEach(() => {
    if (typeof localStorage === "undefined") {
      (global as any).localStorage = {
        store: {} as Record<string, string>,
        getItem(key: string) { return this.store[key] || null; },
        setItem(key: string, value: string) { this.store[key] = value; },
        clear() { this.store = {}; }
      };
    } else {
      localStorage.clear();
    }

    client = new StellarSplitClient({
      rpcUrl: "http://localhost:8000",
      networkPassphrase: "Test",
      contractId: "C123",
      offlineQueue: {
        enabled: true,
        maxQueueSize: 2,
        persistToStorage: true,
      }
    });

    healthStub = sinon.stub(health, "checkRPCHealth").resolves({ status: "down", latencyMs: 0, blockHeight: 0, timestamp: 0 });
  });

  afterEach(() => {
    healthStub.restore();
    sinon.restore();
  });

  it("fills on RPC failure and enforces max size", async () => {
    await client.pay({ invoiceId: "1", amount: 100n, payer: "A" });
    await client.pay({ invoiceId: "2", amount: 200n, payer: "B" });
    await client.pay({ invoiceId: "3", amount: 300n, payer: "C" });

    const q = client.getOfflineQueue();
    expect(q.length).to.equal(2);
    expect(q[0].args[0].invoiceId).to.equal("2");
    expect(q[1].args[0].invoiceId).to.equal("3");
  });

  it("persists to localStorage", async () => {
    await client.pay({ invoiceId: "1", amount: 100n, payer: "A" });
    
    const client2 = new StellarSplitClient({
      rpcUrl: "http://localhost:8000",
      networkPassphrase: "Test",
      contractId: "C123",
      offlineQueue: {
        enabled: true,
        maxQueueSize: 5,
        persistToStorage: true,
      }
    });

    const q = client2.getOfflineQueue();
    expect(q.length).to.equal(1);
    expect(q[0].args[0].invoiceId).to.equal("1");
  });

  it("drains on recovery", async () => {
    await client.pay({ invoiceId: "1", amount: 100n, payer: "A" });

    healthStub.resolves({ status: "ok", latencyMs: 10, blockHeight: 1, timestamp: 1 });
    const payStub = sinon.stub(client, "pay").resolves({ txHash: "success" });

    await client.checkRPCHealth();

    const q = client.getOfflineQueue();
    expect(q.length).to.equal(0);
    expect(payStub.calledOnce).to.be.true;
    expect(payStub.firstCall.args[0].invoiceId).to.equal("1");
  });
});
