/**
 * Tests for the multi-network environment configuration switcher (issue #587).
 *
 * Covers the built-in presets, the passphrase cross-check performed against
 * the live RPC endpoint, the `NetworkMismatchError` contract and the
 * in-flight/concurrency semantics of `StellarSplitClient.switchNetwork`.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { StellarSplitClient } from "../src/client.js";
import {
  NetworkEnvironment,
  NETWORK_PRESETS,
  detectNetworkEnvironment,
  getNetworkPreset,
  isNetworkPreset,
} from "../src/config.js";
import { NetworkPassphraseValidator } from "../src/network/NetworkPassphraseValidator.js";
import {
  NetworkMismatchError,
  UnknownNetworkError,
  ValidationError,
} from "../src/errors.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Minimal client whose constructor does not perform a real network call. */
function makeClient(): StellarSplitClient {
  return new StellarSplitClient({
    rpcUrl: "https://example.com",
    networkPassphrase: "Test Network",
    contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
  });
}

/**
 * Replaces the live RPC passphrase probe with a deterministic result.
 * `configured` is the preset passphrase and `reported` is what the fake RPC
 * node answers with.
 */
function stubValidation(configured: string, reported: string) {
  return vi.spyOn(NetworkPassphraseValidator, "validate").mockResolvedValue({
    valid: configured === reported,
    configured,
    reported,
    mismatch: configured !== reported,
  });
}

describe("NETWORK_PRESETS", () => {
  it("defines horizon, rpc and passphrase for every built-in environment", () => {
    const environments = [
      NetworkEnvironment.MAINNET,
      NetworkEnvironment.TESTNET,
      NetworkEnvironment.FUTURENET,
    ];
    for (const environment of environments) {
      const preset = getNetworkPreset(environment);
      expect(preset.horizonUrl).toMatch(/^https:\/\//);
      expect(preset.rpcUrl).toMatch(/^https:\/\//);
      expect(preset.networkPassphrase.length).toBeGreaterThan(0);
    }
  });

  it("uses the canonical Stellar passphrases", () => {
    expect(NETWORK_PRESETS[NetworkEnvironment.TESTNET].networkPassphrase).toBe(
      "Test SDF Network ; September 2015",
    );
    expect(NETWORK_PRESETS[NetworkEnvironment.MAINNET].networkPassphrase).toBe(
      "Public Global Stellar Network ; September 2015",
    );
  });

  it("detects the environment from a passphrase", () => {
    expect(
      detectNetworkEnvironment(
        NETWORK_PRESETS[NetworkEnvironment.TESTNET].networkPassphrase,
      ),
    ).toBe(NetworkEnvironment.TESTNET);
    expect(detectNetworkEnvironment("Custom Network ; 2026")).toBe(
      NetworkEnvironment.CUSTOM,
    );
  });

  it("isNetworkPreset requires all three fields", () => {
    expect(isNetworkPreset(NETWORK_PRESETS[NetworkEnvironment.TESTNET])).toBe(
      true,
    );
    expect(isNetworkPreset({ rpcUrl: "x", networkPassphrase: "y" })).toBe(false);
    expect(isNetworkPreset(null)).toBe(false);
    expect(isNetworkPreset("testnet")).toBe(false);
  });

  it("rejects environments without a preset", () => {
    expect(() => getNetworkPreset("bogus" as never)).toThrow(UnknownNetworkError);
  });
});

describe("NetworkMismatchError", () => {
  it("exposes the expected and actual passphrases", () => {
    const error = new NetworkMismatchError("expected-pass", "actual-pass");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("NetworkMismatchError");
    expect(error.code).toBe("NETWORK_MISMATCH");
    expect(error.expected).toBe("expected-pass");
    expect(error.actual).toBe("actual-pass");
  });
});

describe("StellarSplitClient.switchNetwork", () => {
  it("validates against the live RPC, then rebinds horizon and rpc URLs", async () => {
    const client = makeClient();
    const preset = NETWORK_PRESETS[NetworkEnvironment.TESTNET];
    const validateSpy = stubValidation(
      preset.networkPassphrase,
      preset.networkPassphrase,
    );

    const switching = client.switchNetwork(NetworkEnvironment.TESTNET);
    // Validation is asynchronous: the old endpoint must still be active.
    expect((client as unknown as { config: { rpcUrl: string } }).config.rpcUrl).toBe(
      "https://example.com",
    );

    await switching;

    expect(validateSpy).toHaveBeenCalledWith(
      preset.networkPassphrase,
      preset.rpcUrl,
    );
    const config = (
      client as unknown as {
        config: { rpcUrl: string; networkPassphrase: string; horizonUrl?: string };
      }
    ).config;
    expect(config.rpcUrl).toBe(preset.rpcUrl);
    expect(config.networkPassphrase).toBe(preset.networkPassphrase);
    expect(config.horizonUrl).toBe(preset.horizonUrl);
    expect(client.activeNetwork).toBe(NetworkEnvironment.TESTNET);
    expect(client.activeNetworkPreset.rpcUrl).toBe(preset.rpcUrl);
  });

  it("rejects the switch and keeps the old configuration on mismatch", async () => {
    const client = makeClient();
    const preset = NETWORK_PRESETS[NetworkEnvironment.TESTNET];
    stubValidation(preset.networkPassphrase, "Some Other Network ; 2026");

    const error = await client
      .switchNetwork(NetworkEnvironment.TESTNET)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(NetworkMismatchError);
    expect((error as NetworkMismatchError).expected).toBe(
      preset.networkPassphrase,
    );
    expect((error as NetworkMismatchError).actual).toBe(
      "Some Other Network ; 2026",
    );
    expect(
      (client as unknown as { config: { rpcUrl: string } }).config.rpcUrl,
    ).toBe("https://example.com");
    expect(client.activeNetwork).not.toBe(NetworkEnvironment.TESTNET);
  });

  it("accepts an explicit NetworkPreset, including via CUSTOM", async () => {
    const client = makeClient();
    const custom = {
      horizonUrl: "https://horizon.example.org",
      rpcUrl: "https://rpc.example.org",
      networkPassphrase: "Example Network ; 2026",
    };
    stubValidation(custom.networkPassphrase, custom.networkPassphrase);

    await client.switchNetwork(NetworkEnvironment.CUSTOM, custom);

    expect(client.activeNetwork).toBe(NetworkEnvironment.CUSTOM);
    expect(client.activeNetworkPreset).toEqual(custom);
    expect(
      (client as unknown as { config: { rpcUrl: string } }).config.rpcUrl,
    ).toBe(custom.rpcUrl);
  });

  it("throws when CUSTOM is used without a preset at runtime", async () => {
    const client = makeClient();
    await expect(
      (client as unknown as {
        switchNetwork(env: NetworkEnvironment): Promise<void>;
      }).switchNetwork(NetworkEnvironment.CUSTOM),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("waits for in-flight requests before applying the new configuration", async () => {
    const client = makeClient();
    const preset = NETWORK_PRESETS[NetworkEnvironment.TESTNET];
    const validateSpy = stubValidation(
      preset.networkPassphrase,
      preset.networkPassphrase,
    );

    let releaseRequest!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const tracked = (
      client as unknown as {
        _trackInFlightRequest<T>(
          method: string,
          operation: () => Promise<T>,
        ): Promise<T>;
      }
    )._trackInFlightRequest("pay", () => inFlight);

    const switching = client.switchNetwork(NetworkEnvironment.TESTNET);

    // Wait until validation has finished but the simulated request is still
    // in flight: the switch must not have been applied yet.
    await vi.waitFor(() => expect(validateSpy).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(client.getInFlightRequests().length).toBeGreaterThan(0),
    );
    expect(
      (client as unknown as { config: { rpcUrl: string } }).config.rpcUrl,
    ).toBe("https://example.com");

    releaseRequest();
    await tracked;
    await switching;

    // Requests issued after the switch resolved observe the new network.
    expect(
      (client as unknown as { config: { rpcUrl: string } }).config.rpcUrl,
    ).toBe(preset.rpcUrl);
    expect(client.getInFlightRequests()).toHaveLength(0);
  });
});
