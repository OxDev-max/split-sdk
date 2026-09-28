/**
 * Tests for the Ledger adapter firmware pre-check — Issue #775
 *
 * Covers the acceptance criteria:
 *  1. Before signing, the adapter queries the device firmware version via the
 *     transport.
 *  2. Firmware below MIN_LEDGER_FIRMWARE rejects with LedgerFirmwareTooOldError
 *     listing the required version.
 *  3. Compatible firmware proceeds with the existing signing flow.
 *  4. The check is skipped via a constructor flag (test environments).
 *
 * Both hardware modules are mocked, so no device or WebHID access is required.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  LedgerAdapter,
  LedgerFirmwareTooOldError,
  MIN_LEDGER_FIRMWARE,
  compareFirmwareVersions,
} from "../src/adapters/ledger.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { fakeTransport, strSignTransaction } = vi.hoisted(() => ({
  fakeTransport: {
    send: vi.fn(),
    close: vi.fn(),
    decorateAppAPIMethods: vi.fn(),
  },
  strSignTransaction: vi.fn(),
}));

vi.mock("@ledgerhq/hw-transport-webhid", () => ({
  default: { create: vi.fn(async () => fakeTransport) },
}));

vi.mock("@ledgerhq/hw-app-str", () => ({
  default: class {
    constructor(public transport: unknown) {}
    async getPublicKey() {
      return { publicKey: "GPUBLICKEY" };
    }
    async signTransaction(path: string, txBytes: Uint8Array) {
      return strSignTransaction(path, txBytes);
    }
  },
}));

/**
 * Build a GET_VERSION response payload. Some devices prefix a format byte, so
 * a leading marker is included to exercise the trailing-byte parsing.
 */
function firmwareResponse(version: [number, number, number]): Uint8Array {
  return Uint8Array.from([0x01, ...version]);
}

const XDR = "AQID"; // base64 for [0x01, 0x02, 0x03]
const NETWORK = "Test SDF Network ; September 2015";

beforeEach(() => {
  fakeTransport.send.mockReset();
  fakeTransport.close.mockReset();
  fakeTransport.close.mockResolvedValue(undefined);
  strSignTransaction.mockReset();
  strSignTransaction.mockResolvedValue({ signature: Uint8Array.from([1, 2, 3]) });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compareFirmwareVersions", () => {
  it("orders dotted versions numerically", () => {
    expect(compareFirmwareVersions("2.0.0", "2.0.0")).toBe(0);
    expect(compareFirmwareVersions("1.9.9", "2.0.0")).toBeLessThan(0);
    expect(compareFirmwareVersions("2.1.0", "2.0.0")).toBeGreaterThan(0);
    expect(compareFirmwareVersions("2.10.0", "2.9.0")).toBeGreaterThan(0);
    expect(compareFirmwareVersions("2.0", "2.0.0")).toBe(0);
  });
});

describe("LedgerAdapter firmware pre-check", () => {
  it("queries the device firmware and signs when the version is compatible", async () => {
    fakeTransport.send.mockResolvedValue(firmwareResponse([2, 1, 0]));
    const adapter = new LedgerAdapter();

    const signature = await adapter.signTransaction(XDR, NETWORK);

    expect(fakeTransport.send).toHaveBeenCalledWith(0xe0, 0x01, 0x00, 0x00);
    expect(strSignTransaction).toHaveBeenCalledTimes(1);
    expect(signature).toBe(btoa(String.fromCharCode(1, 2, 3)));
    expect(fakeTransport.close).toHaveBeenCalled();
  });

  it("proceeds when the firmware matches the minimum exactly", async () => {
    const [major, minor, patch] = MIN_LEDGER_FIRMWARE.split(".").map(Number) as [
      number,
      number,
      number,
    ];
    fakeTransport.send.mockResolvedValue(firmwareResponse([major, minor, patch]));
    const adapter = new LedgerAdapter();

    await expect(adapter.signTransaction(XDR, NETWORK)).resolves.toBeTruthy();
    expect(strSignTransaction).toHaveBeenCalledTimes(1);
  });

  it("rejects with LedgerFirmwareTooOldError listing the required version without signing", async () => {
    fakeTransport.send.mockResolvedValue(firmwareResponse([1, 6, 0]));
    const adapter = new LedgerAdapter();

    const error = await adapter.signTransaction(XDR, NETWORK).catch((err) => err);

    expect(error).toBeInstanceOf(LedgerFirmwareTooOldError);
    expect(error.actualVersion).toBe("1.6.0");
    expect(error.requiredVersion).toBe(MIN_LEDGER_FIRMWARE);
    expect(error.message).toContain(MIN_LEDGER_FIRMWARE);
    expect(strSignTransaction).not.toHaveBeenCalled();
    expect(fakeTransport.close).toHaveBeenCalled();
  });

  it("skips the firmware check when skipFirmwareCheck is set", async () => {
    const adapter = new LedgerAdapter("44'/148'/0'", { skipFirmwareCheck: true });

    const signature = await adapter.signTransaction(XDR, NETWORK);

    expect(fakeTransport.send).not.toHaveBeenCalled();
    expect(strSignTransaction).toHaveBeenCalledTimes(1);
    expect(signature).toBe(btoa(String.fromCharCode(1, 2, 3)));
  });

  it("uses an injected firmware version query when provided", async () => {
    const getFirmwareVersion = vi.fn(async () => "1.0.0");
    const adapter = new LedgerAdapter("44'/148'/0'", { getFirmwareVersion });

    const error = await adapter.signTransaction(XDR, NETWORK).catch((err) => err);

    expect(getFirmwareVersion).toHaveBeenCalledTimes(1);
    expect(fakeTransport.send).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(LedgerFirmwareTooOldError);
    expect(error.actualVersion).toBe("1.0.0");
  });
});
