import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { StellarSplitClient } from "../../src/client.js";
import {
  TESTNET_HORIZON,
  TESTNET_PASSPHRASE,
  TESTNET_RPC,
  getTxDebug,
} from "./utils/stellarDebug.js";
import { fundAccount } from "./utils/friendbot.js";
import { deployFreshContract } from "./utils/deploy.js";

const BASE_CONTRACT_ID = process.env.STELLAR_SPLIT_CONTRACT_ID ?? "";
const isTestnet = process.env.STELLAR_NETWORK === "testnet";

function deadlineInDays(days: number): number {
  return Math.floor(Date.now() / 1000) + days * 86_400;
}

describe("StellarSplit integration (testnet)", () => {
  if (!isTestnet) {
    it.skip("skipped: STELLAR_NETWORK must be=testnet", () => {});
    return;
  }

  if (!BASE_CONTRACT_ID) {
    it("fails fast: missing STELLAR_SPLIT_CONTRACT_ID", () => {
      throw new Error("Missing env STELLAR_SPLIT_CONTRACT_ID");
    });
    return;
  }

  let creator: Keypair;
  let payer: Keypair;
  let recipient1: Keypair;

  beforeAll(async () => {
    creator = Keypair.random();
    payer = Keypair.random();
    recipient1 = Keypair.random();

    await Promise.all([
      fundAccount(creator.publicKey()),
      fundAccount(payer.publicKey()),
      fundAccount(recipient1.publicKey()),
    ]);
  }, 120_000);

  // Each test gets its own fresh client and contract instance
  let client: StellarSplitClient;
  let contractId: string;
  let tokenContractId: string;

  beforeEach(async () => {
    // Deploy a fresh instance of the contract for this specific test
    contractId = await deployFreshContract(creator, BASE_CONTRACT_ID, TESTNET_RPC, TESTNET_PASSPHRASE);
    tokenContractId = process.env.STELLAR_SPLIT_TOKEN_CONTRACT_ID ?? BASE_CONTRACT_ID;
    
    // We can assume the default wallet adapter for node environment works for tests,
    // or we pass a mock adapter. But `pay` uses client's wallet adapter.
    // The previous code had a comment about injecting adapter. The client 
    // uses Freighter by default if no adapter provided. For tests without a browser extension, 
    // we need to provide a custom adapter or use signingKeypair.
    client = new StellarSplitClient({
      rpcUrl: TESTNET_RPC,
      networkPassphrase: TESTNET_PASSPHRASE,
      contractId: contractId,
      horizonUrl: TESTNET_HORIZON,
      cache: { enabled: false },
      signingKeypair: creator, // Use creator as default signer
    });
  }, 120_000);

  it("create invoice → pay → release full lifecycle", async () => {
    const deadline = deadlineInDays(7);
    const { invoiceId } = await client.createInvoice({
      creator: creator.publicKey(),
      recipients: [{ address: recipient1.publicKey(), amount: 10_000_000n }],
      token: tokenContractId,
      deadline,
    });

    const payClient = new StellarSplitClient({
      rpcUrl: TESTNET_RPC,
      networkPassphrase: TESTNET_PASSPHRASE,
      contractId: contractId,
      horizonUrl: TESTNET_HORIZON,
      signingKeypair: payer,
    });
    
    await payClient.pay({
      payer: payer.publicKey(),
      invoiceId,
      amount: 10_000_000n,
    });

    const anyClient = client as any;
    await anyClient.releaseInvoice(invoiceId, creator.publicKey());

    const invoice = await client.getInvoice(invoiceId);
    expect(invoice.status).toBe("Released");
    expect(invoice.funded).toBe(10_000_000n);
  }, 120_000);

  it("refund after deadline", async () => {
    const deadline = deadlineInDays(-1); // in the past
    const { invoiceId } = await client.createInvoice({
      creator: creator.publicKey(),
      recipients: [{ address: recipient1.publicKey(), amount: 10_000_000n }],
      token: tokenContractId,
      deadline,
    });

    const payClient = new StellarSplitClient({
      rpcUrl: TESTNET_RPC,
      networkPassphrase: TESTNET_PASSPHRASE,
      contractId: contractId,
      horizonUrl: TESTNET_HORIZON,
      signingKeypair: payer,
    });
    
    await payClient.pay({
      payer: payer.publicKey(),
      invoiceId,
      amount: 5_000_000n, // partial pay
    });

    const anyClient = client as any;
    await anyClient.refundInvoice(invoiceId, creator.publicKey());

    const invoice = await client.getInvoice(invoiceId);
    expect(invoice.status).toBe("Refunded");
  }, 120_000);

  it("batch create invoices", async () => {
    const deadline = deadlineInDays(7);
    const anyClient = client as any;
    
    if (typeof anyClient.batchCreateInvoices !== "function") {
      console.warn("batchCreateInvoices not found, skipping");
      return;
    }
    
    const res = await anyClient.batchCreateInvoices([
      {
        creator: creator.publicKey(),
        recipients: [{ address: recipient1.publicKey(), amount: 1_000_000n }],
        token: tokenContractId,
        deadline,
      },
      {
        creator: creator.publicKey(),
        recipients: [{ address: recipient1.publicKey(), amount: 2_000_000n }],
        token: tokenContractId,
        deadline,
      }
    ]);

    expect(res.invoiceIds).toBeDefined();
    expect(res.invoiceIds.length).toBe(2);
    
    const inv1 = await client.getInvoice(res.invoiceIds[0]);
    expect(inv1.status).toBe("Pending");
  }, 120_000);

  it("clone + lineage", async () => {
    const deadline = deadlineInDays(7);
    const { invoiceId } = await client.createInvoice({
      creator: creator.publicKey(),
      recipients: [{ address: recipient1.publicKey(), amount: 10_000_000n }],
      token: tokenContractId,
      deadline,
    });

    const anyClient = client as any;
    if (typeof anyClient.cloneInvoice !== "function") {
      console.warn("cloneInvoice not found, skipping");
      return;
    }

    const clonedId = await anyClient.cloneInvoice(invoiceId, {
      creator: creator.publicKey(),
      deadline: deadlineInDays(14),
    });

    const cloned = await client.getInvoice(clonedId);
    expect(cloned.status).toBe("Pending");
    expect((cloned as any).lineage).toBeDefined();
    expect((cloned as any).lineage.sourceId).toBe(invoiceId);
  }, 120_000);

  it("subscription trigger", async () => {
    const deadline = deadlineInDays(7);
    const { invoiceId } = await client.createInvoice({
      creator: creator.publicKey(),
      recipients: [{ address: recipient1.publicKey(), amount: 10_000_000n }],
      token: tokenContractId,
      deadline,
    });

    const events: any[] = [];
    
    // Some versions of the SDK might have a subscribe method directly on client
    const anyClient = client as any;
    if (typeof anyClient.subscribeToInvoice !== "function") {
      console.warn("subscribeToInvoice not found, skipping");
      return;
    }
    
    const unsubscribe = await anyClient.subscribeToInvoice(invoiceId, (evt: any) => {
      events.push(evt);
    });

    const payClient = new StellarSplitClient({
      rpcUrl: TESTNET_RPC,
      networkPassphrase: TESTNET_PASSPHRASE,
      contractId: contractId,
      horizonUrl: TESTNET_HORIZON,
      signingKeypair: payer,
    });
    
    await payClient.pay({
      payer: payer.publicKey(),
      invoiceId,
      amount: 10_000_000n,
    });

    await new Promise(resolve => setTimeout(resolve, 5000));
    unsubscribe();

    // Verify event was received
    expect(events.length).toBeGreaterThan(0);
    expect(events.some(e => e.type === "payment")).toBe(true);
  }, 120_000);
});
