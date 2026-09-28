import TransportWebHID from "@ledgerhq/hw-transport-webhid";
import type Transport from "@ledgerhq/hw-transport";
import Str from "@ledgerhq/hw-app-str";
import type { WalletAdapter } from "../types.js";

/**
 * Minimum Ledger device firmware version supported for signing Stellar
 * transactions. Older firmware lacks support for newer Stellar transaction
 * features (multi-operation submissions and the newer envelope extensions),
 * which makes signing fail silently.
 */
export const MIN_LEDGER_FIRMWARE = "2.0.0";

/**
 * Thrown before any signing attempt when the connected Ledger device runs a
 * firmware version older than {@link MIN_LEDGER_FIRMWARE}.
 */
export class LedgerFirmwareTooOldError extends Error {
  /** Firmware version reported by the device. */
  readonly actualVersion: string;
  /** Minimum firmware version required to sign. */
  readonly requiredVersion: string;

  constructor(actualVersion: string, requiredVersion: string = MIN_LEDGER_FIRMWARE) {
    super(
      `Ledger firmware ${actualVersion} is not supported. ` +
        `Update the device to firmware ${requiredVersion} or newer to sign Stellar transactions.`,
    );
    this.name = "LedgerFirmwareTooOldError";
    this.actualVersion = actualVersion;
    this.requiredVersion = requiredVersion;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Construction options for {@link LedgerAdapter}. */
export interface LedgerAdapterOptions {
  /**
   * When `true`, the pre-signing firmware version check is skipped entirely.
   * Intended for test environments (and for callers that have already verified
   * the device out-of-band). Defaults to `false`.
   */
  skipFirmwareCheck?: boolean;
  /**
   * Overrides how the device firmware version is read. Defaults to the
   * on-device `GET_VERSION` APDU sent over the transport.
   */
  getFirmwareVersion?: (transport: Transport) => Promise<string>;
}

/**
 * Parse a dotted version string into numeric segments.
 * Non-numeric segments (e.g. a `1.2.3-rc1` suffix) count as `0`.
 */
function parseVersionSegments(version: string): number[] {
  return version.split(".").map((segment) => {
    const parsed = Number.parseInt(segment, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  });
}

/**
 * Compare two dotted firmware version strings segment by segment.
 *
 * @returns A negative number when `a < b`, `0` when equal, positive when `a > b`.
 */
export function compareFirmwareVersions(a: string, b: string): number {
  const left = parseVersionSegments(a);
  const right = parseVersionSegments(b);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** Ledger hardware wallet adapter implementing WalletAdapter. */
export class LedgerAdapter implements WalletAdapter {
  private readonly path: string;
  private readonly skipFirmwareCheck: boolean;
  private readonly getFirmwareVersion: (transport: Transport) => Promise<string>;

  constructor(path = "44'/148'/0'", options: LedgerAdapterOptions = {}) {
    this.path = path;
    this.skipFirmwareCheck = options.skipFirmwareCheck ?? false;
    this.getFirmwareVersion =
      options.getFirmwareVersion ?? ((transport) => this.queryFirmwareVersion(transport));
  }

  async getAddress(): Promise<string> {
    const transport = await this.openTransport();
    try {
      const str = new Str(transport);
      const { publicKey } = await str.getPublicKey(this.path);
      return publicKey;
    } finally {
      await transport.close();
    }
  }

  async signTransaction(xdr: string, _network: string): Promise<string> {
    const transport = await this.openTransport();
    try {
      await this.assertFirmwareSupported(transport);
      const str = new Str(transport);
      const txBytes = Uint8Array.from(atob(xdr), (c) => c.charCodeAt(0));
      const { signature } = await str.signTransaction(
        this.path,
        txBytes as unknown as Buffer
      );
      const sigBytes = signature as unknown as Uint8Array;
      return btoa(String.fromCharCode(...sigBytes));
    } finally {
      await transport.close();
    }
  }

  /**
   * Reject with {@link LedgerFirmwareTooOldError} when the device firmware is
   * older than {@link MIN_LEDGER_FIRMWARE}. No-op when the check is skipped.
   */
  private async assertFirmwareSupported(transport: Transport): Promise<void> {
    if (this.skipFirmwareCheck) return;
    const version = await this.getFirmwareVersion(transport);
    if (compareFirmwareVersions(version, MIN_LEDGER_FIRMWARE) < 0) {
      throw new LedgerFirmwareTooOldError(version);
    }
  }

  /**
   * Query the device firmware version using the BOLOS `GET_VERSION` APDU
   * (`CLA 0xE0`, `INS 0x01`). The transport strips the status word, leaving a
   * payload whose trailing three bytes are `major.minor.patch` (some devices
   * prefix a format/target byte, so the last three bytes are used).
   */
  private async queryFirmwareVersion(transport: Transport): Promise<string> {
    const response = await transport.send(0xe0, 0x01, 0x00, 0x00);
    const bytes = Array.from(response as unknown as Uint8Array);
    const versionBytes = bytes.length > 3 ? bytes.slice(-3) : bytes;
    if (versionBytes.length < 3) {
      throw new Error(
        `Unexpected firmware version response from Ledger device (${bytes.length} byte(s)).`,
      );
    }
    return versionBytes.join(".");
  }

  private async openTransport(): Promise<Transport> {
    try {
      return await TransportWebHID.create();
    } catch {
      throw new Error(
        "Ledger device not connected. Please connect your Ledger and open the Stellar app."
      );
    }
  }
}
