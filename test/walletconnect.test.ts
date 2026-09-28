import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WalletConnectAdapter } from "../src/adapters/walletconnect.js";
import type { WalletAdapter } from "../src/adapters/types.js";

// Mock the WalletConnect client
const mockWalletConnectClient = {
  request: vi.fn(),
};

const mockTopic = "mock-topic-123";
const mockChainId = "stellar:testnet";
const mockAddress = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

// ---------------------------------------------------------------------------
// localStorage stub (jsdom provides one, but we reset between tests)
// ---------------------------------------------------------------------------
function makeLocalStorageStub() {
  const store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { for (const k in store) delete store[k]; }),
    store,
  };
}

describe("WalletConnectAdapter", () => {
  let adapter: WalletAdapter;
  let lsMock: ReturnType<typeof makeLocalStorageStub>;

  beforeEach(() => {
    mockWalletConnectClient.request.mockClear();

    lsMock = makeLocalStorageStub();
    vi.stubGlobal("localStorage", lsMock);

    adapter = new WalletConnectAdapter({
      client: mockWalletConnectClient,
      topic: mockTopic,
      chainId: mockChainId,
      address: mockAddress,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // Existing behaviour
  // -------------------------------------------------------------------------
  describe("getAddress", () => {
    it("returns the configured address", async () => {
      const address = await adapter.getAddress();
      expect(address).toBe(mockAddress);
    });
  });

  describe("signTransaction", () => {
    const mockXdr = "mock-xdr-string";
    const mockNetwork = "Test Network";

    it("calls WalletConnect client with correct parameters", async () => {
      mockWalletConnectClient.request.mockResolvedValue("signed-xdr");
      
      const result = await adapter.signTransaction(mockXdr, mockNetwork);
      
      expect(mockWalletConnectClient.request).toHaveBeenCalledWith({
        topic: mockTopic,
        chainId: mockChainId,
        request: {
          method: "stellar_signXDR",
          params: { xdr: mockXdr, network: mockNetwork },
        },
      });
      expect(result).toBe("signed-xdr");
    });

    it("throws error when WalletConnect request fails", async () => {
      mockWalletConnectClient.request.mockRejectedValue(new Error("WalletConnect error"));
      
      await expect(adapter.signTransaction(mockXdr, mockNetwork)).rejects.toThrow("WalletConnect error");
    });
  });

  // -------------------------------------------------------------------------
  // #774 — Session persistence
  // -------------------------------------------------------------------------
  describe("session persistence (#774)", () => {
    it("writes session data to localStorage on construction", () => {
      expect(lsMock.setItem).toHaveBeenCalledWith(
        "stellarsplit:wc:session",
        expect.stringContaining(mockTopic)
      );
    });

    it("persists topic, chainId, and address", () => {
      const raw = lsMock.store["stellarsplit:wc:session"];
      expect(raw).toBeDefined();
      const parsed = JSON.parse(raw!);
      expect(parsed.topic).toBe(mockTopic);
      expect(parsed.chainId).toBe(mockChainId);
      expect(parsed.address).toBe(mockAddress);
    });

    it("persists an expiry timestamp in the future", () => {
      const raw = lsMock.store["stellarsplit:wc:session"];
      const parsed = JSON.parse(raw!);
      expect(parsed.expiry).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    it("persists a custom expiry when provided", () => {
      lsMock.clear();
      const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
      new WalletConnectAdapter({
        client: mockWalletConnectClient,
        topic: mockTopic,
        chainId: mockChainId,
        address: mockAddress,
        expiry: futureExpiry,
      });
      const raw = lsMock.store["stellarsplit:wc:session"];
      const parsed = JSON.parse(raw!);
      expect(parsed.expiry).toBe(futureExpiry);
    });

    it("persists relayUrl when provided", () => {
      lsMock.clear();
      new WalletConnectAdapter({
        client: mockWalletConnectClient,
        topic: mockTopic,
        chainId: mockChainId,
        address: mockAddress,
        relayUrl: "wss://relay.example.com",
      });
      const raw = lsMock.store["stellarsplit:wc:session"];
      const parsed = JSON.parse(raw!);
      expect(parsed.relayUrl).toBe("wss://relay.example.com");
    });
  });

  // -------------------------------------------------------------------------
  // #774 — Session restore
  // -------------------------------------------------------------------------
  describe("WalletConnectAdapter.restore()", () => {
    it("returns null when localStorage is empty", () => {
      lsMock.clear();
      // getItem returns null for missing keys
      const restored = WalletConnectAdapter.restore(mockWalletConnectClient);
      expect(restored).toBeNull();
    });

    it("restores a valid non-expired session", () => {
      const session = {
        topic: mockTopic,
        chainId: mockChainId,
        address: mockAddress,
        relayUrl: "",
        expiry: Math.floor(Date.now() / 1000) + 3600,
      };
      lsMock.store["stellarsplit:wc:session"] = JSON.stringify(session);

      const restored = WalletConnectAdapter.restore(mockWalletConnectClient);
      expect(restored).not.toBeNull();
    });

    it("returns the correct address after restore", async () => {
      const session = {
        topic: mockTopic,
        chainId: mockChainId,
        address: mockAddress,
        relayUrl: "",
        expiry: Math.floor(Date.now() / 1000) + 3600,
      };
      lsMock.store["stellarsplit:wc:session"] = JSON.stringify(session);

      const restored = WalletConnectAdapter.restore(mockWalletConnectClient)!;
      expect(await restored.getAddress()).toBe(mockAddress);
    });

    it("returns null for an expired session", () => {
      const session = {
        topic: mockTopic,
        chainId: mockChainId,
        address: mockAddress,
        relayUrl: "",
        expiry: Math.floor(Date.now() / 1000) - 10, // already expired
      };
      lsMock.store["stellarsplit:wc:session"] = JSON.stringify(session);

      const restored = WalletConnectAdapter.restore(mockWalletConnectClient);
      expect(restored).toBeNull();
    });

    it("clears localStorage after restoring an expired session", () => {
      const session = {
        topic: mockTopic,
        chainId: mockChainId,
        address: mockAddress,
        relayUrl: "",
        expiry: Math.floor(Date.now() / 1000) - 10,
      };
      lsMock.store["stellarsplit:wc:session"] = JSON.stringify(session);

      WalletConnectAdapter.restore(mockWalletConnectClient);
      expect(lsMock.removeItem).toHaveBeenCalledWith("stellarsplit:wc:session");
    });
  });

  // -------------------------------------------------------------------------
  // #774 — disconnect clears storage
  // -------------------------------------------------------------------------
  describe("disconnect()", () => {
    it("removes persisted session from localStorage", () => {
      (adapter as WalletConnectAdapter).disconnect();
      expect(lsMock.removeItem).toHaveBeenCalledWith("stellarsplit:wc:session");
    });
  });
});
