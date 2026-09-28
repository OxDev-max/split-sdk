/**
 * Compile-time assertions for the `switchNetwork` overloads (issue #587).
 *
 * This file is picked up by `tsc --noEmit` (via `tsconfig.json`'s `include`),
 * but it is never imported at runtime, so the calls below are type-checked
 * only. The `@ts-expect-error` on the last line is the executable form of the
 * acceptance criterion "passing `NetworkEnvironment.CUSTOM` without a full
 * `NetworkPreset` produces a TypeScript compile-time error".
 */

import type { StellarSplitClient } from "../../client.js";
import { NetworkEnvironment } from "../../config.js";
import type { NetworkPreset } from "../../config.js";

declare const client: StellarSplitClient;
declare const customPreset: NetworkPreset;

// Built-in environments accept no preset and resolve to a promise.
const testnetSwitch: Promise<void> = client.switchNetwork(
  NetworkEnvironment.TESTNET,
);
const mainnetSwitch: Promise<void> = client.switchNetwork(
  NetworkEnvironment.MAINNET,
);
const futurenetSwitch: Promise<void> = client.switchNetwork(
  NetworkEnvironment.FUTURENET,
);
void testnetSwitch;
void mainnetSwitch;
void futurenetSwitch;

// CUSTOM requires a full NetworkPreset.
const customSwitch: Promise<void> = client.switchNetwork(
  NetworkEnvironment.CUSTOM,
  customPreset,
);
void customSwitch;

// An explicit NetworkPreset is accepted on its own.
const presetSwitch: Promise<void> = client.switchNetwork(customPreset);
void presetSwitch;

// @ts-expect-error CUSTOM without a NetworkPreset must not compile.
client.switchNetwork(NetworkEnvironment.CUSTOM);
