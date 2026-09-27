/**
 * Secure webhook middleware for receiving and parsing StellarSplit invoice webhooks.
 * 
 * This module provides production-ready middleware with:
 * - HMAC-SHA256 signature verification with constant-time comparison
 * - Replay attack protection using timestamp tolerance and nonce tracking
 * - LRU cache for nonce deduplication
 * - Express/Next.js compatibility
 * 
 * @module webhookMiddleware
 */

import type { Request, Response, NextFunction } from "express";
import { ValidationError } from "./errors.js";

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Configuration options for webhook middleware.
 */
export interface WebhookOptions {
  /**
   * Maximum allowed clock drift for timestamp validation in seconds.
   * Requests with timestamps outside this window will be rejected.
   * @default 300 (5 minutes)
   */
  toleranceSeconds?: number;

  /**
   * Maximum size for the in-memory LRU cache that tracks seen nonces.
   * This prevents replay attacks by remembering recently used nonces.
   * @default 1000
   */
  nonceWindowSize?: number;

  /**
   * Header name containing the HMAC signature.
   * @default "x-stellarsplit-signature"
   */
  signatureHeader?: string;

  /**
   * Header name containing the timestamp.
   * @default "x-stellarsplit-timestamp"
   */
  timestampHeader?: string;

  /**
   * Header name containing the unique nonce.
   * @default "x-stellarsplit-nonce"
   */
  nonceHeader?: string;
}

/**
 * Invoice event types emitted by StellarSplit webhooks.
 */
export type InvoiceEventType =
  | "invoice.created"
  | "invoice.paid"
  | "invoice.failed"
  | "invoice.released"
  | "invoice.refunded"
  | "invoice.cancelled"
  | "invoice.expired";

/**
 * Base webhook payload structure.
 */
export interface WebhookPayload<T = unknown> {
  /** Event type identifier */
  event: InvoiceEventType;
  /** Unix timestamp in seconds when the event occurred */
  timestamp: number;
  /** Unique nonce for replay protection */
  nonce: string;
  /** Event-specific data */
  data: T;
}

/**
 * Webhook data for invoice.created event.
 */
export interface InvoiceCreatedData {
  invoiceId: string;
  creator: string;
  recipients: Array<{ address: string; amount: string }>;
  token: string;
  deadline: number;
  totalAmount: string;
}

/**
 * Webhook data for invoice.paid event.
 */
export interface InvoicePaidData {
  invoiceId: string;
  payer: string;
  amount: string;
  funded: string;
  remaining: string;
  txHash: string;
}

/**
 * Webhook data for invoice.released event.
 */
export interface InvoiceReleasedData {
  invoiceId: string;
  totalAmount: string;
  recipients: Array<{ address: string; amount: string; txHash: string }>;
  releasedAt: number;
}

/**
 * Webhook data for invoice.failed event.
 */
export interface InvoiceFailedData {
  invoiceId: string;
  reason: string;
  failedAt: number;
}

/**
 * Webhook data for invoice.refunded event.
 */
export interface InvoiceRefundedData {
  invoiceId: string;
  totalRefunded: string;
  refundedAt: number;
}

/**
 * Webhook data for invoice.cancelled event.
 */
export interface InvoiceCancelledData {
  invoiceId: string;
  cancelledBy: string;
  cancelledAt: number;
}

/**
 * Webhook data for invoice.expired event.
 */
export interface InvoiceExpiredData {
  invoiceId: string;
  deadline: number;
  expiredAt: number;
}

/**
 * Express Request with validated webhook payload attached.
 */
export interface WebhookRequest<T = unknown> extends Request {
  webhookPayload: WebhookPayload<T>;
  rawWebhookBody: string;
}

/**
 * Type guard to check if request has webhook payload.
 */
export function isWebhookRequest<T = unknown>(
  req: Request,
): req is WebhookRequest<T> {
  return "webhookPayload" in req && "rawWebhookBody" in req;
}

/**
 * Express-compatible request handler type.
 */
export type RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => void | Promise<void>;

// ============================================================================
// LRU Cache Implementation
// ============================================================================

/**
 * Least Recently Used (LRU) cache for nonce tracking.
 * Provides O(1) get/set operations and automatic eviction of oldest entries.
 */
class LRUCache<K, V> {
  private readonly capacity: number;
  private readonly cache: Map<K, V>;
  private readonly order: K[];

  constructor(capacity: number) {
    if (capacity <= 0) {
      throw new ValidationError("LRU cache capacity must be positive", {
        capacity,
      });
    }
    this.capacity = capacity;
    this.cache = new Map();
    this.order = [];
  }

  /**
   * Get a value from the cache. Returns undefined if not found.
   * Updates the access order (moves to end).
   */
  get(key: K): V | undefined {
    if (!this.cache.has(key)) {
      return undefined;
    }

    // Move to end (most recently used)
    const index = this.order.indexOf(key);
    if (index !== -1) {
      this.order.splice(index, 1);
      this.order.push(key);
    }

    return this.cache.get(key);
  }

  /**
   * Set a value in the cache. Evicts the least recently used entry if at capacity.
   */
  set(key: K, value: V): void {
    // If key exists, update it and move to end
    if (this.cache.has(key)) {
      this.cache.set(key, value);
      const index = this.order.indexOf(key);
      if (index !== -1) {
        this.order.splice(index, 1);
        this.order.push(key);
      }
      return;
    }

    // Evict oldest if at capacity
    if (this.order.length >= this.capacity) {
      const oldest = this.order.shift();
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }

    // Add new entry
    this.cache.set(key, value);
    this.order.push(key);
  }

  /**
   * Check if a key exists in the cache.
   */
  has(key: K): boolean {
    return this.cache.has(key);
  }

  /**
   * Get the current size of the cache.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Clear all entries from the cache.
   */
  clear(): void {
    this.cache.clear();
    this.order.length = 0;
  }
}

// ============================================================================
// Cryptographic Utilities
// ============================================================================

const textEncoder = new TextEncoder();

/**
 * Compute HMAC-SHA256 signature using Web Crypto API or Node.js crypto.
 * Works in both browser and Node.js environments.
 */
async function computeHmacSha256(
  secret: string,
  message: string,
): Promise<Uint8Array> {
  // Try Web Crypto API first (browser and modern Node.js)
  if (typeof globalThis.crypto !== "undefined" && "subtle" in globalThis.crypto) {
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      textEncoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const signature = await globalThis.crypto.subtle.sign(
      "HMAC",
      key,
      textEncoder.encode(message),
    );

    return new Uint8Array(signature);
  }

  // Fallback to Node.js crypto module
  const crypto = await import("crypto");
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(message);
  const digest = hmac.digest();
  return new Uint8Array(digest);
}

/**
 * Convert hex string to byte array.
 * Handles both uppercase and lowercase hex strings.
 */
function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.toLowerCase().trim();
  
  if (normalized.length % 2 !== 0) {
    throw new ValidationError("Invalid hex string length", {
      hexLength: normalized.length,
    });
  }

  const bytes = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new ValidationError("Invalid hex character in signature", {
        position: i * 2,
      });
    }
    bytes[i] = byte;
  }

  return bytes;
}

/**
 * Convert byte array to hex string.
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time comparison of two byte arrays to prevent timing attacks.
 * Returns true if arrays are equal, false otherwise.
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }

  return result === 0;
}

// ============================================================================
// Signature Validation
// ============================================================================

/**
 * Compute the HMAC-SHA256 signature for a webhook payload.
 * The signed message is `${timestamp}.${rawBody}` to bind the timestamp
 * to the payload and prevent timestamp tampering.
 *
 * @param secret - The shared webhook secret
 * @param timestamp - Unix timestamp in seconds
 * @param rawBody - The raw request body as a string
 * @returns Hex-encoded signature string
 */
export async function computeSignature(
  secret: string,
  timestamp: number | string,
  rawBody: string,
): Promise<string> {
  const message = `${timestamp}.${rawBody}`;
  const digest = await computeHmacSha256(secret, message);
  return bytesToHex(digest);
}

/**
 * Verify a webhook signature against the expected HMAC-SHA256 digest.
 * Uses constant-time comparison to prevent timing attacks.
 *
 * @param secret - The shared webhook secret
 * @param timestamp - Unix timestamp in seconds
 * @param rawBody - The raw request body as a string
 * @param signature - The hex-encoded signature to verify
 * @returns True if the signature is valid, false otherwise
 */
export async function verifySignature(
  secret: string,
  timestamp: number | string,
  rawBody: string,
  signature: string,
): Promise<boolean> {
  if (!secret || !signature) {
    return false;
  }

  let providedBytes: Uint8Array;
  try {
    providedBytes = hexToBytes(signature);
  } catch {
    return false;
  }

  const expectedHex = await computeSignature(secret, timestamp, rawBody);
  const expectedBytes = hexToBytes(expectedHex);

  return constantTimeEqual(expectedBytes, providedBytes);
}

// ============================================================================
// Webhook Event Handling
// ============================================================================

/**
 * Handler function invoked for a validated webhook event.
 */
export type WebhookEventHandler<T = unknown> = (
  payload: WebhookPayload<T>,
) => void | Promise<void>;

/**
 * Simple typed event emitter for dispatching validated webhook events.
 * Supports multiple listeners per event and a wildcard "*" listener.
 */
export class WebhookEventEmitter {
  private readonly listeners: Map<string, Set<WebhookEventHandler>> = new Map();

  /**
   * Register a listener for a specific event type, or "*" for all events.
   * @returns An unsubscribe function.
   */
  on<T = unknown>(
    event: InvoiceEventType | "*",
    handler: WebhookEventHandler<T>,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as WebhookEventHandler);

    return () => {
      set?.delete(handler as WebhookEventHandler);
    };
  }

  /**
   * Register a one-time listener for a specific event type.
   */
  once<T = unknown>(
    event: InvoiceEventType | "*",
    handler: WebhookEventHandler<T>,
  ): () => void {
    const unsubscribe = this.on<T>(event, async (payload) => {
      unsubscribe();
      await handler(payload);
    });
    return unsubscribe;
  }

  /**
   * Remove a previously registered listener.
   */
  off<T = unknown>(
    event: InvoiceEventType | "*",
    handler: WebhookEventHandler<T>,
  ): void {
    this.listeners.get(event)?.delete(handler as WebhookEventHandler);
  }

  /**
   * Dispatch a validated payload to all matching listeners.
   * Errors thrown by listeners are isolated so one failure does not
   * prevent other listeners from running.
   */
  async emit<T = unknown>(payload: WebhookPayload<T>): Promise<void> {
    const specific = this.listeners.get(payload.event);
    const wildcard = this.listeners.get("*");

    const handlers: WebhookEventHandler[] = [];
    if (specific) {
      handlers.push(...specific);
    }
    if (wildcard) {
      handlers.push(...wildcard);
    }

    for (const handler of handlers) {
      try {
        await handler(payload);
      } catch {
        // Isolate listener errors; continue dispatching to remaining handlers.
      }
    }
  }

  /**
   * Remove all listeners, optionally for a single event type.
   */
  removeAllListeners(event?: InvoiceEventType | "*"): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }
}

// ============================================================================
// Middleware Factory
// ============================================================================

const DEFAULT_TOLERANCE_SECONDS = 300;
const DEFAULT_NONCE_WINDOW_SIZE = 1000;
const DEFAULT_SIGNATURE_HEADER = "x-stellarsplit-signature";
const DEFAULT_TIMESTAMP_HEADER = "x-stellarsplit-timestamp";
const DEFAULT_NONCE_HEADER = "x-stellarsplit-nonce";

/**
 * Create an Express middleware that validates incoming webhook requests.
 *
 * The middleware:
 * 1. Extracts the raw body, signature, timestamp, and nonce from the request.
 * 2. Verifies the HMAC-SHA256 signature using constant-time comparison.
 * 3. Rejects requests with timestamps outside the tolerance window.
 * 4. Rejects replayed nonces using an LRU cache.
 * 5. Attaches the parsed payload to `req.webhookPayload` and dispatches it
 *    to any registered event handlers.
 *
 * @param secret - The shared webhook secret
 * @param options - Optional configuration
 * @param emitter - Optional event emitter for dispatching validated events
 * @returns Express request handler
 */
export function createWebhookMiddleware(
  secret: string,
  options: WebhookOptions = {},
  emitter?: WebhookEventEmitter,
): RequestHandler {
  if (!secret) {
    throw new ValidationError("Webhook secret is required");
  }

  const toleranceSeconds =
    options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const signatureHeader =
    options.signatureHeader ?? DEFAULT_SIGNATURE_HEADER;
  const timestampHeader =
    options.timestampHeader ?? DEFAULT_TIMESTAMP_HEADER;
  const nonceHeader = options.nonceHeader ?? DEFAULT_NONCE_HEADER;
  const seenNonces = new LRUCache<string, true>(
    options.nonceWindowSize ?? DEFAULT_NONCE_WINDOW_SIZE,
  );

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawBody = extractRawBody(req);
      const signature = getHeader(req, signatureHeader);
      const timestampRaw = getHeader(req, timestampHeader);
      const nonce = getHeader(req, nonceHeader);

      if (!signature || !timestampRaw || !nonce) {
        res.status(401).json({ error: "Missing webhook authentication headers" });
        return;
      }

      const timestamp = Number.parseInt(timestampRaw, 10);
      if (Number.isNaN(timestamp)) {
        res.status(401).json({ error: "Invalid webhook timestamp" });
        return;
      }

      const nowSeconds = Math.floor(Date.now() / 1000);
      if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
        res.status(401).json({ error: "Webhook timestamp outside tolerance" });
        return;
      }

      const valid = await verifySignature(secret, timestamp, rawBody, signature);
      if (!valid) {
        res.status(401).json({ error: "Invalid webhook signature" });
        return;
      }

      if (seenNonces.has(nonce)) {
        res.status(409).json({ error: "Webhook replay detected" });
        return;
      }
      seenNonces.set(nonce, true);

      let payload: WebhookPayload;
      try {
        payload = JSON.parse(rawBody) as WebhookPayload;
      } catch {
        res.status(400).json({ error: "Invalid webhook payload" });
        return;
      }

      const webhookReq = req as WebhookRequest;
      webhookReq.webhookPayload = payload;
      webhookReq.rawWebhookBody = rawBody;

      if (emitter) {
        await emitter.emit(payload);
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Extract the raw request body as a string.
 * Supports bodies captured by `express.raw()` (Buffer) or pre-parsed strings.
 */
function extractRawBody(req: Request): string {
  const body = (req as Request & { rawBody?: unknown }).rawBody ?? req.body;

  if (typeof body === "string") {
    return body;
  }

  if (body instanceof Uint8Array) {
    return new TextDecoder().decode(body);
  }

  if (body && typeof body === "object") {
    return JSON.stringify(body);
  }

  return "";
}

/**
 * Read a header value from the request, normalizing to a single string.
 */
function getHeader(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}
