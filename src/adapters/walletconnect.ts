import type { WalletAdapter } from "./types.js";

/** Options for constructing a WalletConnectAdapter. */
export interface WalletConnectAdapterOptions {
  /** WalletConnect Sign Client instance (from @walletconnect/sign-client). */
  // Typed as unknown to avoid a hard dependency on @walletconnect/sign-client.
  client: {
    request(args: {
      topic: string;
      chainId: string;
      request: { method: string; params: unknown };
    }): Promise<string>;
  };
  /** Active WalletConnect session topic. */
  topic: string;
  /** Stellar chain ID (e.g. "stellar:testnet"). */
  chainId: string;
  /** The connected wallet's Stellar public key. */
  address: string;
  /**
   * Relay URL used by the WalletConnect session.
   * Persisted alongside the topic so the session can be restored on reload.
   */
  relayUrl?: string;
  /**
   * Unix timestamp (seconds) at which the WalletConnect session expires.
   * When provided the adapter validates the expiry before restoring a stored
   * session and persists it so future restores can make the same check.
   */
  expiry?: number;
}

/** Shape of the data written to / read from localStorage. */
interface PersistedSession {
  topic: string;
  relayUrl: string;
  chainId: string;
  address: string;
  /** Unix timestamp in seconds when this session expires. */
  expiry: number;
}

/** localStorage key used to store the active WalletConnect session. */
const STORAGE_KEY = "stellarsplit:wc:session";

/**
 * WalletConnect adapter — routes signing through a WalletConnect session
 * instead of the Freighter browser extension.
 *
 * ### Session persistence
 * On construction the adapter persists the session to `localStorage` so it
 * survives page reloads. Call the static `restore()` factory to hydrate an
 * adapter from a previously-persisted session without requiring the user to
 * scan a QR code again. `disconnect()` clears the stored data.
 */
export class WalletConnectAdapter implements WalletAdapter {
  private readonly opts: WalletConnectAdapterOptions;

  constructor(opts: WalletConnectAdapterOptions) {
    this.opts = opts;
    // Persist the session immediately on construction.
    this.persistSession();
  }

  // ---------------------------------------------------------------------------
  // WalletAdapter interface
  // ---------------------------------------------------------------------------

  async getAddress(): Promise<string> {
    return this.opts.address;
  }

  async signTransaction(xdr: string, network: string): Promise<string> {
    return this.opts.client.request({
      topic: this.opts.topic,
      chainId: this.opts.chainId,
      request: {
        method: "stellar_signXDR",
        params: { xdr, network },
      },
    });
  }

  /**
   * Clear the persisted session data from localStorage and reset internal
   * state so the user must reconnect after the next page load.
   */
  disconnect(): void {
    WalletConnectAdapter.clearStoredSession();
  }

  // ---------------------------------------------------------------------------
  // Static helpers for session persistence
  // ---------------------------------------------------------------------------

  /**
   * Restore a previously-persisted WalletConnect session.
   *
   * Returns `null` when:
   * - no session has been stored, or
   * - the stored session has expired.
   *
   * The caller is responsible for providing the live WalletConnect `client`
   * instance; only the session metadata is read from localStorage.
   *
   * @example
   * ```ts
   * const adapter = WalletConnectAdapter.restore(signClient);
   * if (adapter) {
   *   // Session is still valid — no QR scan needed.
   * } else {
   *   // Show QR code and create a new adapter on successful pairing.
   * }
   * ```
   */
  static restore(
    client: WalletConnectAdapterOptions["client"]
  ): WalletConnectAdapter | null {
    const raw = WalletConnectAdapter.readRawSession();
    if (!raw) return null;

    // Validate expiry before restoring.
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (raw.expiry <= nowSeconds) {
      // Stale session — clean up so the user is not stuck.
      WalletConnectAdapter.clearStoredSession();
      return null;
    }

    return new WalletConnectAdapter({
      client,
      topic: raw.topic,
      chainId: raw.chainId,
      address: raw.address,
      relayUrl: raw.relayUrl,
      expiry: raw.expiry,
    });
  }

  /**
   * Remove the persisted session entry from localStorage.
   * Called automatically by `disconnect()`.
   */
  static clearStoredSession(): void {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // localStorage may be unavailable in some environments (e.g. SSR).
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Write current session data to localStorage. */
  private persistSession(): void {
    try {
      if (typeof localStorage === "undefined") return;

      const data: PersistedSession = {
        topic: this.opts.topic,
        relayUrl: this.opts.relayUrl ?? "",
        chainId: this.opts.chainId,
        address: this.opts.address,
        // Default to 7 days from now if no expiry provided.
        expiry:
          this.opts.expiry ?? Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
      };

      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Silently ignore write failures (storage quota, SSR, etc.).
    }
  }

  /** Parse raw stored session data without validation. Returns `null` on any error. */
  private static readRawSession(): PersistedSession | null {
    try {
      if (typeof localStorage === "undefined") return null;

      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;

      const parsed = JSON.parse(raw) as Partial<PersistedSession>;

      // Basic shape validation.
      if (
        typeof parsed.topic !== "string" ||
        typeof parsed.chainId !== "string" ||
        typeof parsed.address !== "string" ||
        typeof parsed.expiry !== "number"
      ) {
        return null;
      }

      return parsed as PersistedSession;
    } catch {
      return null;
    }
  }
}
