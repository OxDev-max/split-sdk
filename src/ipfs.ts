/**
 * IPFS integration for invoice metadata storage and verification.
 *
 * Supports both HTTP gateway and Kubo RPC backends for pinning and fetching
 * invoice metadata from IPFS.
 */

import type {
  CIDVerificationResult,
  InvoiceMetadata,
  IPFSConfig,
  LineItem,
} from "./types.js";
import {
  IPFSPinError,
  IPFSFetchError,
  CIDMismatchError,
  IPFSConfigError,
} from "./errors.js";

/** Default IPFS configuration using public gateway. */
export const DEFAULT_IPFS_CONFIG: IPFSConfig = {
  backend: "gateway",
  url: "https://ipfs.io",
  timeout: 30000,
};

/** Global IPFS configuration. */
let globalIPFSConfig: IPFSConfig = DEFAULT_IPFS_CONFIG;

/**
 * Configure the IPFS backend globally.
 *
 * @param config - IPFS configuration options.
 */
export function configureIPFS(config: Partial<IPFSConfig>): void {
  globalIPFSConfig = {
    ...DEFAULT_IPFS_CONFIG,
    ...config,
  };
}

/**
 * Get the current IPFS configuration.
 */
export function getIPFSConfig(): IPFSConfig {
  return { ...globalIPFSConfig };
}

/**
 * Reset IPFS configuration to defaults.
 */
export function resetIPFSConfig(): void {
  globalIPFSConfig = DEFAULT_IPFS_CONFIG;
}

/**
 * Serialize InvoiceMetadata to JSON, converting bigints to strings.
 */
function serializeMetadata(metadata: InvoiceMetadata): string {
  const serializable = {
    ...metadata,
    lineItems: metadata.lineItems.map((item) => ({
      ...item,
      unitPrice: item.unitPrice.toString(),
      total: item.total?.toString(),
    })),
  };
  return JSON.stringify(serializable);
}

/**
 * Deserialize JSON back to InvoiceMetadata, converting strings to bigints.
 */
export function deserializeMetadata(json: string): InvoiceMetadata {
  const parsed = JSON.parse(json);
  return {
    title: parsed.title,
    description: parsed.description,
    attachmentCIDs: parsed.attachmentCIDs ?? [],
    lineItems: (parsed.lineItems ?? []).map(
      (item: { description: string; quantity: number; unitPrice: string; total?: string }) => ({
        description: item.description,
        quantity: item.quantity,
        unitPrice: BigInt(item.unitPrice),
        total: item.total ? BigInt(item.total) : undefined,
      })
    ),
  };
}

// ---------------------------------------------------------------------------
// CID computation
//
// A CID is a self-describing content address: it embeds the multihash of the
// content it names. Verification therefore means *recomputing* the CID from
// the bytes and comparing it to the CID that was requested — comparing content
// against content would only prove the fetch round-tripped, not that the bytes
// actually hash to the address being claimed.
//
// Both common versions are supported:
// - CIDv0: `base58btc(0x12 0x20 || sha256(content))` — the classic `Qm...`
// - CIDv1: `base32(0x01 0x70 0x12 0x20 || sha256(content))` — the `bafy...` form
// ---------------------------------------------------------------------------

/** Multicodec prefix for `sha2-256`, the hash IPFS uses for file blocks. */
const SHA256_MULTIHASH_PREFIX = new Uint8Array([0x12, 0x20]);

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** SHA-256 digest of `content`. */
async function sha256(content: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hashBuffer);
}

/**
 * Encode bytes in base58btc — the multibase used by CIDv0.
 *
 * Implemented directly rather than pulled from a dependency so the SDK's
 * dependency surface stays unchanged.
 */
function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";

  // Count leading zero bytes; each encodes as a literal "1".
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Repeatedly divide the big-endian number by 58, collecting remainders.
  const digits: number[] = [];
  const buffer = Array.from(bytes);
  let start = zeros;
  while (start < buffer.length) {
    let remainder = 0;
    for (let i = start; i < buffer.length; i++) {
      // accumulator = remainder * 256 + byte, kept below 2^53 to stay exact.
      const accumulator = remainder * 256 + (buffer[i] as number);
      (buffer[i] as number) = Math.floor(accumulator / 58);
      remainder = accumulator % 58;
    }
    digits.push(remainder);
    while (start < buffer.length && (buffer[start] as number) === 0) start++;
  }

  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) {
    out += BASE58_ALPHABET[digits[i] as number];
  }
  return out;
}

/** Encode bytes in unpadded lowercase base32 — the multibase used by CIDv1. */
function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/** Build the multihash for `content` under sha2-256. */
async function multihash(content: string): Promise<Uint8Array> {
  const digest = await sha256(content);
  const out = new Uint8Array(SHA256_MULTIHASH_PREFIX.length + digest.length);
  out.set(SHA256_MULTIHASH_PREFIX, 0);
  out.set(digest, SHA256_MULTIHASH_PREFIX.length);
  return out;
}

/** Compute the CIDv0 (`Qm...`) for `content`. */
export async function computeCidV0(content: string): Promise<string> {
  return encodeBase58(await multihash(content));
}

/** Compute the CIDv1 (`bafy...`, dag-pb, sha2-256) for `content`. */
export async function computeCidV1(content: string): Promise<string> {
  const body = await multihash(content);
  // varint codec 0x01 (dag-pb) + varint multihash code 0x12 + varint length 0x20
  const out = new Uint8Array(4 + body.length);
  out.set([0x01, 0x70, 0x12, 0x20], 0);
  out.set(body, 4);
  // "b" is the multibase prefix identifying base32lower-encoded CIDs.
  return `b${encodeBase32(out)}`;
}

/**
 * Normalise content to the exact bytes that were (or would be) pinned.
 *
 * Objects are serialised as JSON. This must match {@link serializeMetadata}
 * exactly, since the CID returned by `pinInvoiceMetadata` addresses those
 * bytes.
 */
function normalizeContent(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

/**
 * Strip incidental differences from a CID before comparing.
 *
 * CIDs are often written with an `ipfs://` URI scheme or a `/ipfs/` path
 * segment; both name the same address as the bare form.
 */
function normalizeCid(cid: string): string {
  return cid
    .trim()
    .replace(/^ipfs:\/\//i, "")
    .replace(/^\//, "")
    .replace(/\/ipfs\//i, "/");
}

/**
 * Compute the CID of `content` in the same version as `cid`.
 *
 * Comparing within the requested version matters: a CIDv0 and CIDv1 name the
 * same bytes, so verifying one against the other would always fail.
 */
async function computeCidForVersion(
  content: string,
  cid: string,
): Promise<string> {
  const normalized = cid.trim();
  // CIDv1 base32 always begins "b"; CIDv0 base58btc always begins "Qm".
  return normalized.startsWith("b")
    ? computeCidV1(content)
    : computeCidV0(content);
}

/**
 * Pin invoice metadata to IPFS via the configured backend.
 *
 * @param metadata - The invoice metadata to pin.
 * @param config - Optional IPFS configuration override.
 * @returns The CID of the pinned content.
 * @throws {IPFSPinError} If pinning fails.
 * @throws {IPFSConfigError} If configuration is invalid.
 */
export async function pinInvoiceMetadata(
  metadata: InvoiceMetadata,
  config?: Partial<IPFSConfig>
): Promise<string> {
  const cfg = { ...globalIPFSConfig, ...config };
  const jsonContent = serializeMetadata(metadata);

  if (cfg.backend === "kubo") {
    return pinViaKubo(jsonContent, cfg);
  } else if (cfg.backend === "gateway") {
    return pinViaGateway(jsonContent, cfg);
  } else {
    throw new IPFSConfigError(`Unknown IPFS backend: ${cfg.backend}`);
  }
}

/**
 * Pin content via Kubo RPC API (/api/v0/add).
 */
async function pinViaKubo(content: string, cfg: IPFSConfig): Promise<string> {
  const url = `${cfg.url.replace(/\/$/, "")}/api/v0/add?pin=true`;

  const formData = new FormData();
  const blob = new Blob([content], { type: "application/json" });
  formData.append("file", blob, "metadata.json");

  const headers: Record<string, string> = {};
  if (cfg.authorization) {
    headers["Authorization"] = cfg.authorization;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), cfg.timeout ?? 30000);

  try {
    const response = await fetch(url, {
      method: "POST",
      body: formData,
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new IPFSPinError(
        `Kubo pin failed: ${response.status} ${response.statusText} - ${text}`,
        url
      );
    }

    const result = await response.json();
    if (!result.Hash) {
      throw new IPFSPinError("Kubo response missing Hash field", url);
    }

    return result.Hash;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof IPFSPinError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new IPFSPinError(`Kubo pin request failed: ${message}`, url);
  }
}

/**
 * Pin content via a writable HTTP gateway that supports POST.
 * Falls back to computing a mock CID for testing purposes if the gateway
 * doesn't support pinning.
 */
async function pinViaGateway(content: string, cfg: IPFSConfig): Promise<string> {
  const baseUrl = cfg.url.replace(/\/$/, "");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cfg.authorization) {
    headers["Authorization"] = cfg.authorization;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), cfg.timeout ?? 30000);

  try {
    // Try Pinata-style API first
    const pinataUrl = `${baseUrl}/pinning/pinJSONToIPFS`;
    let response = await fetch(pinataUrl, {
      method: "POST",
      body: content,
      headers,
      signal: controller.signal,
    });

    if (response.ok) {
      clearTimeout(timeoutId);
      const result = await response.json();
      if (result.IpfsHash) {
        return result.IpfsHash;
      }
      if (result.Hash) {
        return result.Hash;
      }
    }

    // Try Web3.Storage style API
    const web3Url = `${baseUrl}/upload`;
    response = await fetch(web3Url, {
      method: "POST",
      body: content,
      headers,
      signal: controller.signal,
    });

    if (response.ok) {
      clearTimeout(timeoutId);
      const result = await response.json();
      if (result.cid) {
        return result.cid;
      }
    }

    // Try direct add endpoint (some gateways support this)
    const addUrl = `${baseUrl}/api/v0/add`;
    const formData = new FormData();
    const blob = new Blob([content], { type: "application/json" });
    formData.append("file", blob, "metadata.json");

    response = await fetch(addUrl, {
      method: "POST",
      body: formData,
      headers: cfg.authorization ? { Authorization: cfg.authorization } : undefined,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const result = await response.json();
      if (result.Hash) {
        return result.Hash;
      }
    }

    throw new IPFSPinError(
      `Gateway does not support pinning or pin request failed`,
      baseUrl
    );
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof IPFSPinError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new IPFSPinError(`Gateway pin request failed: ${message}`, baseUrl);
  }
}

/**
 * Fetch content from IPFS by CID.
 *
 * @param cid - The CID to fetch.
 * @param config - Optional IPFS configuration override.
 * @returns The fetched content as a string.
 * @throws {IPFSFetchError} If fetching fails.
 */
export async function fetchFromIPFS(
  cid: string,
  config?: Partial<IPFSConfig>
): Promise<string> {
  const cfg = { ...globalIPFSConfig, ...config };

  if (cfg.backend === "kubo") {
    return fetchViaKubo(cid, cfg);
  } else {
    return fetchViaGateway(cid, cfg);
  }
}

/**
 * Fetch content via Kubo RPC API (/api/v0/cat).
 */
async function fetchViaKubo(cid: string, cfg: IPFSConfig): Promise<string> {
  const url = `${cfg.url.replace(/\/$/, "")}/api/v0/cat?arg=${encodeURIComponent(cid)}`;

  const headers: Record<string, string> = {};
  if (cfg.authorization) {
    headers["Authorization"] = cfg.authorization;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), cfg.timeout ?? 30000);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new IPFSFetchError(
        `Kubo fetch failed: ${response.status} ${response.statusText}`,
        cid
      );
    }

    return await response.text();
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof IPFSFetchError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new IPFSFetchError(`Kubo fetch request failed: ${message}`, cid);
  }
}

/**
 * Fetch content via HTTP gateway.
 */
async function fetchViaGateway(cid: string, cfg: IPFSConfig): Promise<string> {
  const url = `${cfg.url.replace(/\/$/, "")}/ipfs/${cid}`;

  const headers: Record<string, string> = {};
  if (cfg.authorization) {
    headers["Authorization"] = cfg.authorization;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), cfg.timeout ?? 30000);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new IPFSFetchError(
        `Gateway fetch failed: ${response.status} ${response.statusText}`,
        cid
      );
    }

    return await response.text();
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof IPFSFetchError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new IPFSFetchError(`Gateway fetch request failed: ${message}`, cid);
  }
}

/**
 * Verify that content matches a CID.
 *
 * A CID is a self-describing content address, so verification means
 * recomputing it from the bytes and comparing. When `content` is supplied the
 * check is purely local — no network round-trip — and proves the bytes really
 * do hash to the address being claimed. Omit `content` to fetch the bytes by
 * CID and verify those instead.
 *
 * @param cid - The CID to verify.
 * @param content - The expected content (object or string). Omit to verify
 *   whatever the CID resolves to.
 * @param config - Optional IPFS configuration override.
 * @returns True if the content hashes to the CID, false otherwise.
 * @throws {IPFSFetchError} If `content` is omitted and the fetch fails.
 */
export async function verifyCID(
  cid: string,
  content?: unknown,
  config?: Partial<IPFSConfig>,
): Promise<boolean> {
  const source =
    content === undefined || content === null
      ? await fetchFromIPFS(cid, config)
      : normalizeContent(content);

  const computed = await computeCidForVersion(source, cid);
  return computed === normalizeCid(cid);
}

/**
 * Verify `cid` against `content` and return a structured result.
 *
 * Prefer this over {@link verifyCID} when you need to know *which* address the
 * content actually produces — for example to log the real CID when a mismatch
 * is detected.
 *
 * @param cid - The CID to verify.
 * @param content - The expected content. Omit to verify the fetched bytes.
 * @param config - Optional IPFS configuration override.
 * @returns A {@link CIDVerificationResult} describing the outcome. Errors are
 *   reported as `valid: false` rather than thrown.
 */
export async function verifyCIDDetailed(
  cid: string,
  content?: unknown,
  config?: Partial<IPFSConfig>,
): Promise<CIDVerificationResult> {
  try {
    const source =
      content === undefined || content === null
        ? await fetchFromIPFS(cid, config)
        : normalizeContent(content);

    const computed = await computeCidForVersion(source, cid);
    const valid = computed === normalizeCid(cid);

    return {
      valid,
      expectedCID: cid,
      computedCID: computed,
      ...(valid ? {} : { error: `Content does not match CID ${cid}` }),
    };
  } catch (error) {
    return {
      valid: false,
      expectedCID: cid,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
/**
 * Verify CID and throw CIDMismatchError if content doesn't match.
 *
 * @param cid - The CID to verify.
 * @param content - The expected content.
 * @param config - Optional IPFS configuration override.
 * @throws {CIDMismatchError} If content doesn't match.
 * @throws {IPFSFetchError} If fetching fails.
 */
export async function verifyCIDOrThrow(
  cid: string,
  content?: unknown,
  config?: Partial<IPFSConfig>,
): Promise<void> {
  const result = await verifyCIDDetailed(cid, content, config);
  if (!result.valid) {
    // Surface the CID the content actually produces — without it, a mismatch
    // gives the caller no way to tell a wrong CID from wrong bytes.
    throw new CIDMismatchError(cid, result.computedCID);
  }
}

/**
 * Fetch and parse invoice metadata from IPFS.
 *
 * @param cid - The CID of the metadata.
 * @param config - Optional IPFS configuration override.
 * @returns The parsed InvoiceMetadata.
 * @throws {IPFSFetchError} If fetching fails.
 */
export async function fetchInvoiceMetadata(
  cid: string,
  config?: Partial<IPFSConfig>
): Promise<InvoiceMetadata> {
  const content = await fetchFromIPFS(cid, config);
  return deserializeMetadata(content);
}

/**
 * Parse an IPFS CID from a memo string.
 * Supports formats: "ipfs:Qm...", "ipfs:bafy...", "Qm...", "bafy..."
 *
 * @param memo - The memo string to parse.
 * @returns The extracted CID or null if not found.
 */
export function parseIPFSCid(memo?: string): string | null {
  if (!memo) {
    return null;
  }

  // Match ipfs: prefix followed by CID
  const prefixMatch = memo.match(/ipfs:([a-zA-Z0-9]+)/i);
  if (prefixMatch && prefixMatch[1]) {
    return prefixMatch[1];
  }

  // Match bare CIDv0 (Qm...)
  const cidV0Match = memo.match(/\b(Qm[a-zA-Z0-9]{44})\b/);
  if (cidV0Match && cidV0Match[1]) {
    return cidV0Match[1];
  }

  // Match bare CIDv1 (bafy...)
  const cidV1Match = memo.match(/\b(bafy[a-zA-Z0-9]+)\b/);
  if (cidV1Match && cidV1Match[1]) {
    return cidV1Match[1];
  }

  return null;
}

/**
 * Create a line item with automatic total calculation.
 *
 * @param description - Item description.
 * @param quantity - Item quantity.
 * @param unitPrice - Unit price in stroops.
 * @returns A LineItem object.
 */
export function createLineItem(
  description: string,
  quantity: number,
  unitPrice: bigint
): LineItem {
  return {
    description,
    quantity,
    unitPrice,
    total: BigInt(quantity) * unitPrice,
  };
}

/**
 * Create invoice metadata with validation.
 *
 * @param title - Invoice title.
 * @param description - Invoice description.
 * @param lineItems - Array of line items.
 * @param attachmentCIDs - Array of attachment CIDs.
 * @returns Validated InvoiceMetadata.
 */
export function createInvoiceMetadata(
  title: string,
  description: string,
  lineItems: LineItem[],
  attachmentCIDs: string[] = []
): InvoiceMetadata {
  return {
    title,
    description,
    lineItems,
    attachmentCIDs,
  };
}
