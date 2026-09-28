/**
 * Tests for FreighterAdapter — focuses on the #772 acceptance criteria:
 * - FreighterNotInstalledError is thrown with the install URL when the
 *   extension is absent.
 * - Normal connection flow is unchanged when the extension is present.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  FreighterAdapter,
  FreighterNotInstalledError,
} from "../src/wallets/adapters/FreighterAdapter.js";

const MOCK_ADDRESS = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const INSTALL_URL = "https://www.freighter.app";

function makeFreighterMock() {
  return {
    isConnected: vi.fn().mockResolvedValue(true),
    getPublicKey: vi.fn().mockResolvedValue(MOCK_ADDRESS),
    signTransaction: vi.fn().mockResolvedValue("signed-xdr"),
  };
}

describe("FreighterAdapter (#772)", () => {
  let adapter: FreighterAdapter;

  afterEach(() => {
    vi.unstubAllGlobals();
    adapter?.disconnect();
  });

  // -------------------------------------------------------------------------
  // Extension not installed
  // -------------------------------------------------------------------------
  describe("when Freighter is not installed", () => {
    beforeEach(() => {
      // Simulate missing extension
      vi.stubGlobal("window", { freighter: undefined });
      adapter = new FreighterAdapter();
    });

    it("throws FreighterNotInstalledError from connect()", async () => {
      await expect(adapter.connect()).rejects.toThrow(FreighterNotInstalledError);
    });

    it("throws FreighterNotInstalledError from getAddress()", async () => {
      await expect(adapter.getAddress()).rejects.toThrow(FreighterNotInstalledError);
    });

    it("throws FreighterNotInstalledError from sign()", async () => {
      await expect(adapter.sign("xdr", "testnet")).rejects.toThrow(
        FreighterNotInstalledError
      );
    });

    it("throws FreighterNotInstalledError from signTransaction()", async () => {
      await expect(adapter.signTransaction("xdr", "testnet")).rejects.toThrow(
        FreighterNotInstalledError
      );
    });

    it("error message includes the Freighter install URL", async () => {
      try {
        await adapter.connect();
        expect.fail("should have thrown");
      } catch (err) {
        expect((err as Error).message).toContain(INSTALL_URL);
      }
    });

    it("error is an instance of FreighterNotInstalledError", async () => {
      try {
        await adapter.connect();
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(FreighterNotInstalledError);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Extension present — existing flow unchanged
  // -------------------------------------------------------------------------
  describe("when Freighter is installed", () => {
    let freighterMock: ReturnType<typeof makeFreighterMock>;

    beforeEach(() => {
      freighterMock = makeFreighterMock();
      vi.stubGlobal("window", { freighter: freighterMock });
      adapter = new FreighterAdapter();
    });

    it("connect() returns the public key", async () => {
      const address = await adapter.connect();
      expect(address).toBe(MOCK_ADDRESS);
    });

    it("getAddress() returns the public key", async () => {
      const address = await adapter.getAddress();
      expect(address).toBe(MOCK_ADDRESS);
      expect(freighterMock.getPublicKey).toHaveBeenCalled();
    });

    it("signTransaction() delegates to freighter.signTransaction", async () => {
      const result = await adapter.signTransaction("test-xdr", "Test SDF Network");
      expect(result).toBe("signed-xdr");
      expect(freighterMock.signTransaction).toHaveBeenCalledWith(
        "test-xdr",
        "Test SDF Network"
      );
    });

    it("does not throw FreighterNotInstalledError when extension is present", async () => {
      await expect(adapter.connect()).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // FreighterNotInstalledError shape
  // -------------------------------------------------------------------------
  describe("FreighterNotInstalledError", () => {
    it("has the correct name property", () => {
      const err = new FreighterNotInstalledError();
      expect(err.name).toBe("FreighterNotInstalledError");
    });

    it("is an instance of Error", () => {
      const err = new FreighterNotInstalledError();
      expect(err).toBeInstanceOf(Error);
    });

    it("message contains the install URL", () => {
      const err = new FreighterNotInstalledError();
      expect(err.message).toContain(INSTALL_URL);
    });
  });
});
