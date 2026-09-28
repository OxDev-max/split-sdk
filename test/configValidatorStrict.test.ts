/**
 * Tests for #883 — ConfigurationError and strict config validation.
 */

import { describe, it, expect } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  ConfigurationError,
  validateConfigStrict,
  NETWORK_PASSPHRASE_MAP,
} from "../src/configValidator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validContractId(): string {
  return StrKey.encodeContract(Keypair.random().rawPublicKey());
}

// ---------------------------------------------------------------------------
// ConfigurationError shape
// ---------------------------------------------------------------------------

describe("ConfigurationError", () => {
  it("has a field, value, and hint", () => {
    const err = new ConfigurationError({
      field: "rpcUrl",
      value: "ftp://bad",
      hint: "Must use https://",
    });

    expect(err.field).toBe("rpcUrl");
    expect(err.value).toBe("ftp://bad");
    expect(err.hint).toBe("Must use https://");
  });

  it("is an instance of Error", () => {
    const err = new ConfigurationError({ field: "x", hint: "y" });
    expect(err).toBeInstanceOf(Error);
  });

  it("message includes field name and hint", () => {
    const err = new ConfigurationError({
      field: "contractId",
      hint: "Must start with C",
    });
    expect(err.message).toContain("contractId");
    expect(err.message).toContain("Must start with C");
  });

  it("handles missing value gracefully", () => {
    const err = new ConfigurationError({ field: "rpcUrl", hint: "required" });
    expect(err.value).toBeUndefined();
    expect(err.message).toContain("not provided");
  });

  it("code is CONFIGURATION_ERROR", () => {
    const err = new ConfigurationError({ field: "f", hint: "h" });
    expect(err.code).toBe("CONFIGURATION_ERROR");
  });

  it("instanceof check works across prototype chain", () => {
    const err = new ConfigurationError({ field: "f", hint: "h" });
    expect(err instanceof ConfigurationError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateConfigStrict — valid config
// ---------------------------------------------------------------------------

describe("validateConfigStrict — valid config", () => {
  it("passes with minimum valid config", () => {
    expect(() =>
      validateConfigStrict({
        rpcUrl: "https://soroban-testnet.stellar.org",
        contractId: validContractId(),
      }),
    ).not.toThrow();
  });

  it("passes with testnet shorthand and matching passphrase", () => {
    expect(() =>
      validateConfigStrict({
        rpcUrl: "https://soroban-testnet.stellar.org",
        contractId: validContractId(),
        network: "testnet",
        networkPassphrase: NETWORK_PASSPHRASE_MAP.testnet,
      }),
    ).not.toThrow();
  });

  it("passes with mainnet shorthand and matching passphrase", () => {
    expect(() =>
      validateConfigStrict({
        rpcUrl: "https://horizon.stellar.org",
        contractId: validContractId(),
        network: "mainnet",
        networkPassphrase: NETWORK_PASSPHRASE_MAP.mainnet,
      }),
    ).not.toThrow();
  });

  it("passes when only network is provided (no passphrase)", () => {
    expect(() =>
      validateConfigStrict({
        rpcUrl: "https://soroban-testnet.stellar.org",
        contractId: validContractId(),
        network: "testnet",
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateConfigStrict — rpcUrl
// ---------------------------------------------------------------------------

describe("validateConfigStrict — rpcUrl validation", () => {
  it("throws ConfigurationError for missing rpcUrl", () => {
    expect(() =>
      validateConfigStrict({ rpcUrl: "", contractId: validContractId() }),
    ).toThrow(ConfigurationError);
  });

  it("throws for non-string rpcUrl", () => {
    expect(() =>
      validateConfigStrict({ rpcUrl: 42, contractId: validContractId() }),
    ).toThrow(ConfigurationError);
  });

  it("throws for a malformed URL", () => {
    expect(() =>
      validateConfigStrict({
        rpcUrl: "not-a-url",
        contractId: validContractId(),
      }),
    ).toThrow(ConfigurationError);
  });

  it("throws for http:// (not https)", () => {
    const err = (() => {
      try {
        validateConfigStrict({
          rpcUrl: "http://insecure.example.com",
          contractId: validContractId(),
        });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ConfigurationError);
    expect((err as ConfigurationError).field).toBe("rpcUrl");
  });

  it("throws for ftp:// scheme", () => {
    expect(() =>
      validateConfigStrict({
        rpcUrl: "ftp://example.com",
        contractId: validContractId(),
      }),
    ).toThrow(ConfigurationError);
  });

  it("ConfigurationError.field is 'rpcUrl'", () => {
    let caught: ConfigurationError | null = null;
    try {
      validateConfigStrict({ rpcUrl: "http://bad", contractId: validContractId() });
    } catch (e) {
      caught = e as ConfigurationError;
    }
    expect(caught?.field).toBe("rpcUrl");
  });
});

// ---------------------------------------------------------------------------
// validateConfigStrict — contractId
// ---------------------------------------------------------------------------

describe("validateConfigStrict — contractId validation", () => {
  it("throws for missing contractId", () => {
    expect(() =>
      validateConfigStrict({
        rpcUrl: "https://example.com",
        contractId: "",
      }),
    ).toThrow(ConfigurationError);
  });

  it("throws for a non-C-prefixed string", () => {
    expect(() =>
      validateConfigStrict({
        rpcUrl: "https://example.com",
        contractId: "GABC123",
      }),
    ).toThrow(ConfigurationError);
  });

  it("throws for a string that is 55 characters (too short)", () => {
    expect(() =>
      validateConfigStrict({
        rpcUrl: "https://example.com",
        contractId: "C" + "A".repeat(54),
      }),
    ).toThrow(ConfigurationError);
  });

  it("throws for a string that is 57 characters (too long)", () => {
    expect(() =>
      validateConfigStrict({
        rpcUrl: "https://example.com",
        contractId: "C" + "A".repeat(56),
      }),
    ).toThrow(ConfigurationError);
  });

  it("throws for a 56-char C-prefixed string with invalid StrKey checksum", () => {
    // Construct an invalid C-address that starts with C and is 56 chars
    expect(() =>
      validateConfigStrict({
        rpcUrl: "https://example.com",
        contractId: "C" + "Z".repeat(55),
      }),
    ).toThrow(ConfigurationError);
  });

  it("ConfigurationError.field is 'contractId' on invalid address", () => {
    let caught: ConfigurationError | null = null;
    try {
      validateConfigStrict({
        rpcUrl: "https://example.com",
        contractId: "GABC",
      });
    } catch (e) {
      caught = e as ConfigurationError;
    }
    expect(caught?.field).toBe("contractId");
  });
});

// ---------------------------------------------------------------------------
// validateConfigStrict — network
// ---------------------------------------------------------------------------

describe("validateConfigStrict — network validation", () => {
  it("throws for an unrecognised network shorthand", () => {
    expect(() =>
      validateConfigStrict({
        rpcUrl: "https://example.com",
        contractId: validContractId(),
        network: "staging",
      }),
    ).toThrow(ConfigurationError);
  });

  it("ConfigurationError.field is 'network' for bad shorthand", () => {
    let caught: ConfigurationError | null = null;
    try {
      validateConfigStrict({
        rpcUrl: "https://example.com",
        contractId: validContractId(),
        network: "devnet",
      });
    } catch (e) {
      caught = e as ConfigurationError;
    }
    expect(caught?.field).toBe("network");
  });
});

// ---------------------------------------------------------------------------
// validateConfigStrict — passphrase mismatch
// ---------------------------------------------------------------------------

describe("validateConfigStrict — networkPassphrase mismatch", () => {
  it("throws when passphrase doesn't match testnet", () => {
    expect(() =>
      validateConfigStrict({
        rpcUrl: "https://example.com",
        contractId: validContractId(),
        network: "testnet",
        networkPassphrase: NETWORK_PASSPHRASE_MAP.mainnet,
      }),
    ).toThrow(ConfigurationError);
  });

  it("throws when passphrase doesn't match mainnet", () => {
    expect(() =>
      validateConfigStrict({
        rpcUrl: "https://example.com",
        contractId: validContractId(),
        network: "mainnet",
        networkPassphrase: NETWORK_PASSPHRASE_MAP.testnet,
      }),
    ).toThrow(ConfigurationError);
  });

  it("ConfigurationError.field is 'networkPassphrase' on mismatch", () => {
    let caught: ConfigurationError | null = null;
    try {
      validateConfigStrict({
        rpcUrl: "https://example.com",
        contractId: validContractId(),
        network: "testnet",
        networkPassphrase: "Wrong passphrase",
      });
    } catch (e) {
      caught = e as ConfigurationError;
    }
    expect(caught?.field).toBe("networkPassphrase");
  });

  it("hint contains expected passphrase text", () => {
    let caught: ConfigurationError | null = null;
    try {
      validateConfigStrict({
        rpcUrl: "https://example.com",
        contractId: validContractId(),
        network: "testnet",
        networkPassphrase: "bad passphrase",
      });
    } catch (e) {
      caught = e as ConfigurationError;
    }
    expect(caught?.hint).toContain(NETWORK_PASSPHRASE_MAP.testnet);
  });
});
