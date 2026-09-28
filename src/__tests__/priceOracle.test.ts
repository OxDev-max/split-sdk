import {
  PriceOracle,
  parseOraclePrice,
  type OraclePrice,
} from "../priceOracle";

describe("parseOraclePrice", () => {
  it("parses a numeric price and timestamp", () => {
    const result = parseOraclePrice("XLM", { price: 0.42, timestamp: 1700000000000 });
    expect(result).toEqual({ symbol: "XLM", price: 0.42, timestamp: 1700000000000 });
  });

  it("parses string prices and aliases", () => {
    const result = parseOraclePrice("USDC", { value: "1.01", time: 1700000000000 });
    expect(result.price).toBe(1.01);
    expect(result.timestamp).toBe(1700000000000);
  });

  it("falls back to the current time when no timestamp is present", () => {
    const before = Date.now();
    const result = parseOraclePrice("XLM", { amount: 2 });
    expect(result.timestamp).toBeGreaterThanOrEqual(before);
  });

  it("throws on an invalid price", () => {
    expect(() => parseOraclePrice("XLM", { price: "not-a-number" })).toThrow(
      /Invalid oracle price/,
    );
    expect(() => parseOraclePrice("XLM", {})).toThrow(/Invalid oracle price/);
  });
});

describe("PriceOracle", () => {
  it("fetches, parses, and caches a price", async () => {
    const oracle = new PriceOracle(async () => ({ price: 3.5, timestamp: 1 }));
    const price = await oracle.fetchPrice("XLM");
    expect(price).toEqual({ symbol: "XLM", price: 3.5, timestamp: 1 });
    expect(oracle.getCachedPrice("XLM")).toEqual(price);
  });

  it("emits price updates to listeners", async () => {
    const oracle = new PriceOracle(async () => ({ price: 7 }));
    const received: OraclePrice[] = [];
    const unsubscribe = oracle.onPriceUpdate((p) => received.push(p));

    await oracle.fetchPrice("XLM");
    expect(received).toHaveLength(1);
    expect(received[0].price).toBe(7);

    unsubscribe();
    await oracle.fetchPrice("XLM");
    expect(received).toHaveLength(1);
  });

  it("fetches multiple prices in order", async () => {
    const oracle = new PriceOracle(async (symbol) => ({ price: symbol.length }));
    const prices = await oracle.fetchPrices(["XLM", "USDC"]);
    expect(prices.map((p) => p.symbol)).toEqual(["XLM", "USDC"]);
    expect(prices.map((p) => p.price)).toEqual([3, 4]);
  });
});
