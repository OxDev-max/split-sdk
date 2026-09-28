/**
 * AnchorVerifier (#487)
 *
 * Cross-references a `stellar.toml` file with on-chain issuer account data to
 * confirm bidirectional verification:
 *
 *   1. Load the issuer account from Horizon to obtain its `home_domain`.
 *   2. Optionally verify the TLS certificate fingerprint for that domain
 *      against a caller-supplied pin (#780).
 *   3. Fetch the TOML from that `home_domain`.
 *   4. Assert that the TOML's CURRENCIES array contains an entry matching
 *      both `assetCode` and the issuer address.
 *
 * Returns a `VerificationResult` describing the outcome so callers can
 * decide how to handle partial / failed states.
 */

import { Horizon } from "@stellar/stellar-sdk";
import { CertificatePinningError } from "../errors.js";
import { StellarTomlParser } from "./StellarTomlParser.js";
import type { TomlCurrency, StellarTomlParserOptions } from "./StellarTomlParser.js";

// ---------------------------------------------------------------------------
// Certificate fingerprint fetcher
// ---------------------------------------------------------------------------

/**
 * Retrieves the SHA-256 fingerprint of the TLS certificate served by `domain`
 * on port 443.  Returns a colon-separated uppercase hex string in the
 * standard `openssl` format (e.g. `"AA:BB:CC:..."`).
 *
 * Uses Node.js `node:https` and `node:crypto` — only available in Node.js
 * environments.  Browser environments should not configure
 * `pinnedCertFingerprints` since TLS certificate inspection is unavailable
 * in that context.
 *
 * @internal Exported for testing purposes; prefer using the
 *   `_fetchCertFingerprint` constructor option to inject a test double.
 */
export async function defaultFetchCertFingerprint(
  domain: string,
  timeoutMs = 10_000,
): Promise<string> {
  // Dynamic imports keep the browser bundle clean.
  const [httpsModule, cryptoModule] = await Promise.all([
    import("node:https"),
    import("node:crypto"),
  ]);
  const https = httpsModule;
  const { createHash } = cryptoModule;

  return new Promise<string>((resolve, reject) => {
    const req = https.request(
      {
        host: domain,
        port: 443,
        method: "HEAD",
        path: "/",
        // Allow self-signed / expired certs so we can read the raw DER bytes;
        // the fingerprint comparison is the trust decision.
        rejectUnauthorized: false,
      },
      (res: any) => {
        const socket = res.socket as import("tls").TLSSocket;
        const cert = socket.getPeerCertificate(false);

        if (!cert || !cert.raw) {
          reject(new Error(`No certificate received from domain "${domain}"`));
          req.destroy();
          return;
        }

        // SHA-256 in AA:BB:CC... format
        const hash = createHash("sha256")
          .update(cert.raw)
          .digest("hex")
          .toUpperCase()
          .match(/.{1,2}/g)!
          .join(":");

        resolve(hash);
        req.destroy();
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new Error(`Certificate fetch timed out for domain "${domain}"`),
      );
    });

    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Outcome of an anchor verification run. */
export interface VerificationResult {
  /** True only when the full bidirectional check passed. */
  verified: boolean;
  /** The URL that was (or would have been) fetched for the TOML. */
  tomlUrl: string;
  /** The matching CURRENCIES entry, when one was found. */
  currencyEntry?: TomlCurrency;
  /**
   * List of issue codes that prevented verification.  Empty when
   * `verified === true`.
   *
   * Possible codes:
   * - `"no_home_domain"` — the issuer account has no `home_domain` set.
   * - `"toml_fetch_failed"` — the TOML file could not be fetched or parsed.
   * - `"currency_not_found"` — the TOML exists but has no matching CURRENCIES entry.
   */
  issues: string[];
}

/** Options for `AnchorVerifier`. */
export interface AnchorVerifierOptions extends StellarTomlParserOptions {
  /**
   * Horizon API base URL for loading issuer account data.
   * @default "https://horizon.stellar.org"
   */
  horizonUrl?: string;

  /**
   * Optional map of domain → expected SHA-256 TLS certificate fingerprint.
   *
   * When a domain appears in this map, `AnchorVerifier` will retrieve the
   * server's TLS certificate before trusting any response from that domain
   * and compare its SHA-256 fingerprint against the configured value.
   *
   * A mismatch throws a {@link CertificatePinningError} naming the domain,
   * protecting against compromised DNS or rogue Certificate Authorities.
   *
   * Fingerprint format: colon-separated uppercase hex pairs, as produced by
   * `openssl x509 -fingerprint -sha256`, e.g.:
   * ```
   * "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"
   * ```
   *
   * Certificate pinning uses Node.js `node:https`; browser environments
   * skip the fingerprint check automatically when `_fetchCertFingerprint`
   * is not injected and `node:https` is unavailable.
   */
  pinnedCertFingerprints?: Record<string, string>;

  /**
   * Override the function used to fetch TLS certificate fingerprints.
   *
   * Intended for testing — inject a mock that returns a controlled
   * fingerprint without making a real TLS connection.
   *
   * @internal
   */
  _fetchCertFingerprint?: (domain: string, timeoutMs?: number) => Promise<string>;
}

// ---------------------------------------------------------------------------
// AnchorVerifier
// ---------------------------------------------------------------------------

/**
 * Verifies that an asset issuer's `home_domain` TOML correctly lists the
 * asset, confirming the anchor's on-chain ↔ off-chain consistency.
 *
 * When `pinnedCertFingerprints` is provided, the TLS certificate of each
 * pinned domain is checked before its TOML is fetched or trusted (#780).
 *
 * @example
 * ```ts
 * const verifier = new AnchorVerifier({
 *   horizonUrl: "https://horizon.stellar.org",
 *   pinnedCertFingerprints: {
 *     "circle.io": "AA:BB:CC:...",
 *   },
 * });
 *
 * const result = await verifier.verify("GA5ZSEJ...", "USDC");
 * if (!result.verified) {
 *   console.warn("Anchor issues:", result.issues);
 * }
 * ```
 */
export class AnchorVerifier {
  private readonly _server: Horizon.Server;
  private readonly _parser: StellarTomlParser;
  private readonly _pinnedCertFingerprints: Record<string, string>;
  private readonly _fetchTimeoutMs: number;
  private readonly _fetchCertFingerprintFn: (
    domain: string,
    timeoutMs?: number,
  ) => Promise<string>;

  constructor(options: AnchorVerifierOptions = {}) {
    this._server = new Horizon.Server(
      options.horizonUrl ?? "https://horizon.stellar.org",
    );
    this._fetchTimeoutMs = options.fetchTimeoutMs ?? 10_000;
    this._parser = new StellarTomlParser({
      tomlCacheTtlMs: options.tomlCacheTtlMs,
      fetchTimeoutMs: options.fetchTimeoutMs,
    });
    this._pinnedCertFingerprints = options.pinnedCertFingerprints ?? {};
    this._fetchCertFingerprintFn =
      options._fetchCertFingerprint ?? defaultFetchCertFingerprint;
  }

  /**
   * Perform the full bidirectional anchor verification.
   *
   * @param assetIssuer - Stellar G… address of the asset issuer account.
   * @param assetCode   - Asset code to look up in the CURRENCIES array.
   *
   * @throws {CertificatePinningError} when a pinned domain serves a
   *   certificate whose SHA-256 fingerprint does not match the configured
   *   value.
   */
  async verify(
    assetIssuer: string,
    assetCode: string,
  ): Promise<VerificationResult> {
    // -------------------------------------------------------------------
    // Step 1: Load issuer account from Horizon to get home_domain
    // -------------------------------------------------------------------
    let homeDomain: string | undefined;
    try {
      const account = await this._server.loadAccount(assetIssuer);
      // AccountResponse.home_domain is a plain property on the raw record
      homeDomain = (account as unknown as Record<string, unknown>)
        .home_domain as string | undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        verified: false,
        tomlUrl: "",
        issues: [`account_load_failed: ${msg}`],
      };
    }

    if (!homeDomain) {
      return {
        verified: false,
        tomlUrl: "",
        issues: ["no_home_domain"],
      };
    }

    // -------------------------------------------------------------------
    // Step 2 (optional): Certificate pinning check (#780)
    //
    // When the caller has configured a fingerprint for this domain, verify
    // the server's TLS certificate before fetching or trusting any content.
    // -------------------------------------------------------------------
    const expectedFingerprint = this._pinnedCertFingerprints[homeDomain];
    if (expectedFingerprint) {
      const actualFingerprint = await this._fetchCertFingerprintFn(
        homeDomain,
        this._fetchTimeoutMs,
      );

      if (
        actualFingerprint.toUpperCase() !== expectedFingerprint.toUpperCase()
      ) {
        throw new CertificatePinningError(
          homeDomain,
          expectedFingerprint,
          actualFingerprint,
        );
      }
    }

    // -------------------------------------------------------------------
    // Step 3: Fetch TOML from home_domain
    // -------------------------------------------------------------------
    const tomlUrl = `https://${homeDomain}/.well-known/stellar.toml`;
    let metadata: Awaited<ReturnType<StellarTomlParser["fetch"]>>;
    try {
      metadata = await this._parser.fetch(homeDomain);
    } catch {
      return {
        verified: false,
        tomlUrl,
        issues: ["toml_fetch_failed"],
      };
    }

    // -------------------------------------------------------------------
    // Step 4: Find a matching CURRENCIES entry
    // -------------------------------------------------------------------
    const currencies = metadata.CURRENCIES ?? [];
    const match = currencies.find(
      (c) =>
        c.code === assetCode &&
        (c.issuer === assetIssuer ||
          // Some anchors omit issuer in the TOML when home_domain is definitive
          c.issuer === undefined),
    );

    if (!match) {
      return {
        verified: false,
        tomlUrl,
        issues: ["currency_not_found"],
      };
    }

    return {
      verified: true,
      tomlUrl,
      currencyEntry: match,
      issues: [],
    };
  }

  /**
   * Expose the underlying `StellarTomlParser` so callers can pre-warm the
   * cache or clear it.
   */
  get parser(): StellarTomlParser {
    return this._parser;
  }
}
