/**
 * FreighterAdapter — Adapter for the Freighter wallet extension.
 *
 * Before any Freighter API call the adapter checks whether the extension is
 * installed (`window.freighter`). If it is absent a `FreighterNotInstalledError`
 * is thrown with the install URL so callers can surface an actionable message
 * to the user instead of a cryptic TypeError.
 */

import type { WalletAdapter } from "../../types.js";

type Unsubscribe = () => void;

declare global {
  interface Window {
    freighter?: {
      isConnected(): Promise<boolean>;
      getPublicKey(): Promise<string>;
      signTransaction(xdr: string, network: string): Promise<string>;
    };
  }
}

/** Install URL shown to users when the Freighter extension is not found. */
const FREIGHTER_INSTALL_URL = "https://www.freighter.app";

/**
 * Thrown when a Freighter API call is attempted but the browser extension is
 * not installed. The `message` includes the install URL so it can be shown
 * directly to the user.
 */
export class FreighterNotInstalledError extends Error {
  constructor() {
    super(
      `Freighter wallet extension is not installed. ` +
        `Install it from ${FREIGHTER_INSTALL_URL}`
    );
    this.name = "FreighterNotInstalledError";
    // Maintain correct instanceof checks in transpiled environments.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class FreighterAdapter implements WalletAdapter {
  readonly name = "Freighter";
  private accountChangeHandlers: Array<(address: string) => void> = [];
  private pollInterval: NodeJS.Timeout | null = null;
  private lastKnownAddress: string | null = null;

  async connect(): Promise<string> {
    this.assertInstalled();

    const address = await window.freighter!.getPublicKey();
    this.lastKnownAddress = address;
    
    // Start polling for account changes (Freighter doesn't have a native event)
    this.startAccountChangePolling();
    
    return address;
  }

  async sign(xdr: string, network: string): Promise<string> {
    this.assertInstalled();

    return await window.freighter!.signTransaction(xdr, network);
  }

  async getAddress(): Promise<string> {
    this.assertInstalled();

    return await window.freighter!.getPublicKey();
  }

  async signTransaction(xdr: string, network: string): Promise<string> {
    return this.sign(xdr, network);
  }

  disconnect(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.accountChangeHandlers = [];
    this.lastKnownAddress = null;
  }

  onAccountChange(handler: (address: string) => void): Unsubscribe {
    this.accountChangeHandlers.push(handler);
    
    return () => {
      const index = this.accountChangeHandlers.indexOf(handler);
      if (index > -1) {
        this.accountChangeHandlers.splice(index, 1);
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Assert that the Freighter extension is available in the current window.
   * Throws `FreighterNotInstalledError` when it is not.
   */
  private assertInstalled(): void {
    if (!window.freighter) {
      throw new FreighterNotInstalledError();
    }
  }

  private startAccountChangePolling(): void {
    if (this.pollInterval) return;

    this.pollInterval = setInterval(async () => {
      try {
        if (!window.freighter) return;
        
        const currentAddress = await window.freighter.getPublicKey();
        
        if (currentAddress !== this.lastKnownAddress) {
          this.lastKnownAddress = currentAddress;
          for (const handler of this.accountChangeHandlers) {
            try {
              handler(currentAddress);
            } catch (err) {
              console.error("Error in account change handler:", err);
            }
          }
        }
      } catch (err) {
        // Wallet might be locked or disconnected
        console.warn("Error polling Freighter account:", err);
      }
    }, 2000); // Poll every 2 seconds
  }
}
