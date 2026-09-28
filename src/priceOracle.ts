/**
 * SDK price oracle integration helpers.
 *
 * Provides a small, dependency-free abstraction for fetching and parsing
 * oracle prices, plus an event emitter for price updates.
 */

export interface OraclePrice {
  /** Asset symbol, e.g. "XLM" or "USDC". */
  symbol: string;
  /** Price expressed in the oracle's quote currency. */
  price: number;
  /** Unix timestamp (ms) when the price was observed. */
  timestamp: number;
}

/**
 * Minimal shape of a raw oracle response. Real oracles vary, so we accept a
 * permissive record and normalize it in {@link parseOraclePrice}.
 */
export type RawOracleResponse = Record<string, unknown>;

/**
 * Fetches a raw price payload for a symbol. Implementations may hit an HTTP
 * endpoint, a contract, or a cache.
 */
export type OracleFetcher = (symbol: string) => Promise<RawOracleResponse>;

export type PriceUpdateListener = (price: OraclePrice) => void;

/**
 * Parse a raw oracle response into a normalized {@link OraclePrice}.
 *
 * Accepts common field aliases (`price`/`value`/`amount`, `timestamp`/`time`)
 * and throws when a usable numeric price cannot be found.
 */
export function parseOraclePrice(
  symbol: string,
  raw: RawOracleResponse,
): OraclePrice {
  const rawPrice = raw.price ?? raw.value ?? raw.amount;
  const price = typeof rawPrice === "string" ? Number(rawPrice) : rawPrice;

  if (typeof price !== "number" || !Number.isFinite(price)) {
    throw new Error(`Invalid oracle price for ${symbol}`);
  }

  const rawTimestamp = raw.timestamp ?? raw.time ?? raw.updatedAt;
  const timestamp =
    typeof rawTimestamp === "number"
      ? rawTimestamp
      : typeof rawTimestamp === "string"
        ? Date.parse(rawTimestamp)
        : Date.now();

  return {
    symbol,
    price,
    timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
  };
}

/**
 * Price oracle client that fetches, parses, and emits price updates.
 */
export class PriceOracle {
  private readonly fetcher: OracleFetcher;
  private readonly listeners = new Set<PriceUpdateListener>();
  private readonly cache = new Map<string, OraclePrice>();

  constructor(fetcher: OracleFetcher) {
    this.fetcher = fetcher;
  }

  /** Subscribe to price updates. Returns an unsubscribe function. */
  onPriceUpdate(listener: PriceUpdateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Return the last cached price for a symbol, if any. */
  getCachedPrice(symbol: string): OraclePrice | undefined {
    return this.cache.get(symbol);
  }

  /**
   * Fetch and parse the current price for a symbol, caching the result and
   * notifying listeners.
   */
  async fetchPrice(symbol: string): Promise<OraclePrice> {
    const raw = await this.fetcher(symbol);
    const price = parseOraclePrice(symbol, raw);
    this.cache.set(symbol, price);
    this.emit(price);
    return price;
  }

  /** Fetch prices for multiple symbols, preserving input order. */
  async fetchPrices(symbols: string[]): Promise<OraclePrice[]> {
    return Promise.all(symbols.map((symbol) => this.fetchPrice(symbol)));
  }

  private emit(price: OraclePrice): void {
    for (const listener of this.listeners) {
      listener(price);
    }
  }
}
