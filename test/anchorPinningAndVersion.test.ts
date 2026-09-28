/**
 * Tests for:
 *   - Certificate pinning in AnchorVerifier (#780)
 *   - TOML schema version validation in StellarTomlParser (#779)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Horizon } from "@stellar/stellar-sdk";
import { StellarTomlParser, SUPPORTED_TOML_VERSIONS } from "../src/anchors/StellarTomlParser.js";
import { AnchorVerifier } from "../src/anchors/AnchorVerifier.js";
import { CertificatePinningError, UnsupportedTomlVersionError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ISSUER = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const DOMAIN  = "example.com";
const FINGERPRINT_OK  = "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99";
const FINGERPRINT_BAD = "11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00";

const MINIMAL_TOML = `
[[CURRENCIES]]
code="USDC"
issuer="${ISSUER}"
`;

/** Build a TOML string with an optional header line (e.g. VERSION). */
function makeToml(header = "") {
  return `${header ? header + "\n" : ""}
[[CURRENCIES]]
code="USDC"
issuer="${ISSUER}"
`;
}

function makeAccountWithDomain(domain: string | undefined) {
  return { sequenceNumber: () => "100", home_domain: domain, balances: [] };
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let fetchSpy: ReturnType<typeof vi.fn>;
let loadAccountSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    text: () => Promise.resolve(MINIMAL_TOML),
  });
  vi.stubGlobal("fetch", fetchSpy);

  loadAccountSpy = vi.spyOn(Horizon.Server.prototype, "loadAccount") as any;
  loadAccountSpy.mockResolvedValue(makeAccountWithDomain(DOMAIN) as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// #779 — SUPPORTED_TOML_VERSIONS export
// ---------------------------------------------------------------------------

describe("StellarTomlParser — SUPPORTED_TOML_VERSIONS export (#779)", () => {
  it("exports SUPPORTED_TOML_VERSIONS as a non-empty readonly array", () => {
    expect(Array.isArray(SUPPORTED_TOML_VERSIONS)).toBe(true);
    expect(SUPPORTED_TOML_VERSIONS.length).toBeGreaterThan(0);
  });

  it("includes version 2.0", () => {
    expect(SUPPORTED_TOML_VERSIONS).toContain(2.0);
  });

  it("includes version 2.1", () => {
    expect(SUPPORTED_TOML_VERSIONS).toContain(2.1);
  });
});

// ---------------------------------------------------------------------------
// #779 — VERSION field validation
// ---------------------------------------------------------------------------

describe("StellarTomlParser — VERSION field validation (#779)", () => {
  it("accepts a TOML with a supported VERSION (2.0)", async () => {
    fetchSpy.mockResolvedValue({
      ok: true, status: 200, statusText: "OK",
      text: () => Promise.resolve(makeToml("VERSION=2.0")),
    });
    const parser = new StellarTomlParser();
    await expect(parser.fetch(DOMAIN)).resolves.toBeDefined();
  });

  it("accepts a TOML with a supported VERSION (2.1)", async () => {
    fetchSpy.mockResolvedValue({
      ok: true, status: 200, statusText: "OK",
      text: () => Promise.resolve(makeToml("VERSION=2.1")),
    });
    const parser = new StellarTomlParser();
    await expect(parser.fetch(DOMAIN)).resolves.toBeDefined();
  });

  it("accepts a TOML with no VERSION field (check skipped)", async () => {
    const parser = new StellarTomlParser();
    await expect(parser.fetch(DOMAIN)).resolves.toBeDefined();
  });

  it("throws UnsupportedTomlVersionError for VERSION=3.0", async () => {
    fetchSpy.mockResolvedValue({
      ok: true, status: 200, statusText: "OK",
      text: () => Promise.resolve(makeToml("VERSION=3.0")),
    });
    const parser = new StellarTomlParser();
    await expect(parser.fetch(DOMAIN)).rejects.toBeInstanceOf(UnsupportedTomlVersionError);
  });

  it("UnsupportedTomlVersionError carries the encountered version string", async () => {
    fetchSpy.mockResolvedValue({
      ok: true, status: 200, statusText: "OK",
      text: () => Promise.resolve(makeToml("VERSION=99.9")),
    });
    const parser = new StellarTomlParser();
    await expect(parser.fetch(DOMAIN)).rejects.toMatchObject({
      encounteredVersion: "99.9",
    });
  });

  it("does not cache result when VERSION check throws (isCached stays false)", async () => {
    fetchSpy.mockResolvedValue({
      ok: true, status: 200, statusText: "OK",
      text: () => Promise.resolve(makeToml("VERSION=5.0")),
    });
    const parser = new StellarTomlParser();
    await expect(parser.fetch(DOMAIN)).rejects.toBeInstanceOf(UnsupportedTomlVersionError);
    expect(parser.isCached(DOMAIN)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #780 — Certificate pinning
// ---------------------------------------------------------------------------

describe("AnchorVerifier — pinnedCertFingerprints option (#780)", () => {
  it("verify() succeeds normally when no pinnedCertFingerprints are configured", async () => {
    const verifier = new AnchorVerifier();
    const result = await verifier.verify(ISSUER, "USDC");
    expect(result.verified).toBe(true);
  });

  it("AnchorVerifierOptions.pinnedCertFingerprints is accepted without TypeScript errors", () => {
    const verifier = new AnchorVerifier({
      pinnedCertFingerprints: { "example.com": FINGERPRINT_OK },
    });
    expect(verifier).toBeInstanceOf(AnchorVerifier);
  });

  it("verify() succeeds when actual fingerprint matches the pin", async () => {
    const verifier = new AnchorVerifier({
      pinnedCertFingerprints: { [DOMAIN]: FINGERPRINT_OK },
      // Inject a mock that returns the expected fingerprint
      _fetchCertFingerprint: vi.fn().mockResolvedValue(FINGERPRINT_OK),
    });

    const result = await verifier.verify(ISSUER, "USDC");
    expect(result.verified).toBe(true);
  });

  it("throws CertificatePinningError when actual fingerprint mismatches the pin", async () => {
    const verifier = new AnchorVerifier({
      pinnedCertFingerprints: { [DOMAIN]: FINGERPRINT_OK },
      // Mock returns a different fingerprint → mismatch
      _fetchCertFingerprint: vi.fn().mockResolvedValue(FINGERPRINT_BAD),
    });

    await expect(verifier.verify(ISSUER, "USDC")).rejects.toBeInstanceOf(
      CertificatePinningError,
    );
  });

  it("CertificatePinningError names the domain", async () => {
    const verifier = new AnchorVerifier({
      pinnedCertFingerprints: { [DOMAIN]: FINGERPRINT_OK },
      _fetchCertFingerprint: vi.fn().mockResolvedValue(FINGERPRINT_BAD),
    });

    try {
      await verifier.verify(ISSUER, "USDC");
      expect.fail("Expected CertificatePinningError");
    } catch (err) {
      expect(err).toBeInstanceOf(CertificatePinningError);
      expect((err as CertificatePinningError).domain).toBe(DOMAIN);
    }
  });

  it("_fetchCertFingerprint is called with the home_domain and timeout", async () => {
    const mockFetchFp = vi.fn().mockResolvedValue(FINGERPRINT_OK);
    const verifier = new AnchorVerifier({
      pinnedCertFingerprints: { [DOMAIN]: FINGERPRINT_OK },
      fetchTimeoutMs: 5_000,
      _fetchCertFingerprint: mockFetchFp,
    });

    await verifier.verify(ISSUER, "USDC");

    expect(mockFetchFp).toHaveBeenCalledWith(DOMAIN, 5_000);
  });

  it("fingerprint check is case-insensitive (lowercase pin vs uppercase actual)", async () => {
    const lowerPin = FINGERPRINT_OK.toLowerCase();
    const verifier = new AnchorVerifier({
      pinnedCertFingerprints: { [DOMAIN]: lowerPin },
      _fetchCertFingerprint: vi.fn().mockResolvedValue(FINGERPRINT_OK),
    });

    // Should NOT throw despite case difference
    const result = await verifier.verify(ISSUER, "USDC");
    expect(result.verified).toBe(true);
  });

  it("does not call _fetchCertFingerprint for domains not in the pin map", async () => {
    const mockFetchFp = vi.fn().mockResolvedValue(FINGERPRINT_OK);
    const verifier = new AnchorVerifier({
      pinnedCertFingerprints: { "other.com": FINGERPRINT_OK }, // different domain
      _fetchCertFingerprint: mockFetchFp,
    });

    await verifier.verify(ISSUER, "USDC");

    expect(mockFetchFp).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Error class shape tests
// ---------------------------------------------------------------------------

describe("CertificatePinningError (#780)", () => {
  it("has the correct name, domain, and fingerprint fields", () => {
    const err = new CertificatePinningError(DOMAIN, FINGERPRINT_OK, FINGERPRINT_BAD);
    expect(err.name).toBe("CertificatePinningError");
    expect(err.domain).toBe(DOMAIN);
    expect(err.expectedFingerprint).toBe(FINGERPRINT_OK);
    expect(err.actualFingerprint).toBe(FINGERPRINT_BAD);
  });

  it("is an instance of Error", () => {
    expect(new CertificatePinningError(DOMAIN, FINGERPRINT_OK, FINGERPRINT_BAD)).toBeInstanceOf(Error);
  });

  it("message contains the domain", () => {
    const err = new CertificatePinningError(DOMAIN, FINGERPRINT_OK, FINGERPRINT_BAD);
    expect(err.message).toContain(DOMAIN);
  });
});

describe("UnsupportedTomlVersionError (#779)", () => {
  it("has the correct name and encounteredVersion", () => {
    const err = new UnsupportedTomlVersionError("3.0");
    expect(err.name).toBe("UnsupportedTomlVersionError");
    expect(err.encounteredVersion).toBe("3.0");
  });

  it("is an instance of Error", () => {
    expect(new UnsupportedTomlVersionError("3.0")).toBeInstanceOf(Error);
  });

  it("message contains the encountered version", () => {
    expect(new UnsupportedTomlVersionError("3.0").message).toContain("3.0");
  });
});
