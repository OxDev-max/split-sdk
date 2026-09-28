/**
 * Network environment configuration for the StellarSplit SDK.
 *
 * Provides first-class presets for the well-known Stellar networks plus a
 * `CUSTOM` escape hatch, so callers can switch the active network at runtime
 * without rebuilding the client. The switcher itself lives on
 * {@link StellarSplitClient.switchNetwork} in `client.ts`.
 */

import { Networks } from "@stellar/stellar-sdk";
import { UnknownNetworkError } from "./errors.js";

/** Well-known networks the SDK can be switched to. */
export enum NetworkEnvironment {
  /** Stellar public network ("mainnet"). */
  MAINNET = "mainnet",
  /** Stellar test network. */
  TESTNET = "testnet",
  /** Stellar future network. */
  FUTURENET = "futurenet",
  /** Bring-your-own network; requires an explicit {@link NetworkPreset}. */
  CUSTOM = "custom",
}

/**
 * A fully-qualified network configuration.
 *
 * Every field is required so the switcher can rebind both the Horizon and
 * Soroban RPC references and cross-check the passphrase in one step.
 */
export interface NetworkPreset {
  /** Horizon API base URL for the network. */
  horizonUrl: string;
  /** Soroban RPC endpoint URL for the network. */
  rpcUrl: string;
  /** Stellar network passphrase reported by the RPC node. */
  networkPassphrase: string;
}

/** Built-in presets for the three well-known Stellar networks. */
export const NETWORK_PRESETS: Record<
  Exclude<NetworkEnvironment, NetworkEnvironment.CUSTOM>,
  NetworkPreset
> = {
  [NetworkEnvironment.MAINNET]: {
    horizonUrl: "https://horizon.stellar.org",
    rpcUrl: "https://soroban-mainnet.stellar.org",
    networkPassphrase: Networks.PUBLIC,
  },
  [NetworkEnvironment.TESTNET]: {
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: Networks.TESTNET,
  },
  [NetworkEnvironment.FUTURENET]: {
    horizonUrl: "https://horizon-futurenet.stellar.org",
    rpcUrl: "https://rpc-futurenet.stellar.org",
    networkPassphrase: Networks.FUTURENET,
  },
};

/** Type guard for a caller-supplied {@link NetworkPreset}. */
export function isNetworkPreset(value: unknown): value is NetworkPreset {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<NetworkPreset>;
  return (
    typeof candidate.horizonUrl === "string" &&
    typeof candidate.rpcUrl === "string" &&
    typeof candidate.networkPassphrase === "string"
  );
}

/**
 * Resolves a built-in {@link NetworkEnvironment} to its preset.
 *
 * @throws {UnknownNetworkError} when no preset exists for the environment.
 */
export function getNetworkPreset(
  environment: Exclude<NetworkEnvironment, NetworkEnvironment.CUSTOM>,
): NetworkPreset {
  const preset = NETWORK_PRESETS[environment];
  if (!preset) {
    throw new UnknownNetworkError(String(environment));
  }
  return preset;
}

/**
 * Best-effort detection of the {@link NetworkEnvironment} for a passphrase.
 * Returns {@link NetworkEnvironment.CUSTOM} when the passphrase matches no
 * built-in preset.
 */
export function detectNetworkEnvironment(
  passphrase: string,
): NetworkEnvironment {
  for (const environment of Object.keys(NETWORK_PRESETS) as Array<
    Exclude<NetworkEnvironment, NetworkEnvironment.CUSTOM>
  >) {
    if (NETWORK_PRESETS[environment].networkPassphrase === passphrase) {
      return environment;
    }
  }
  return NetworkEnvironment.CUSTOM;
}
