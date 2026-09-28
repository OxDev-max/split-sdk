/**
 * Tests for computeMovingAverage (#781).
 */

import { describe, it, expect } from "vitest";
import { computeMovingAverage } from "../src/fees/trend.js";

describe("computeMovingAverage (#781)", () => {
  it("returns an array of the same length as samples", () => {
    const result = computeMovingAverage([1, 2, 3, 4, 5], 3);
    expect(result).toHaveLength(5);
  });

  it("pads the first windowSize - 1 entries with NaN", () => {
    const result = computeMovingAverage([100, 200, 300, 400, 500], 3);
    expect(Number.isNaN(result[0])).toBe(true);
    expect(Number.isNaN(result[1])).toBe(true);
    expect(Number.isNaN(result[2])).toBe(false);
  });

  it("computes the correct SMA values (windowSize=3)", () => {
    // [NaN, NaN, (100+200+300)/3, (200+300+400)/3, (300+400+500)/3]
    const result = computeMovingAverage([100, 200, 300, 400, 500], 3);
    expect(result[2]).toBeCloseTo(200);
    expect(result[3]).toBeCloseTo(300);
    expect(result[4]).toBeCloseTo(400);
  });

  it("computes correct SMA with windowSize=1 (identity)", () => {
    const samples = [10, 20, 30];
    const result = computeMovingAverage(samples, 1);
    expect(result).toEqual([10, 20, 30]);
  });

  it("returns a single value equal to the only sample when windowSize equals samples.length", () => {
    const result = computeMovingAverage([2, 4, 6], 3);
    expect(Number.isNaN(result[0])).toBe(true);
    expect(Number.isNaN(result[1])).toBe(true);
    expect(result[2]).toBeCloseTo(4); // (2+4+6)/3
  });

  it("returns an empty array for empty samples", () => {
    expect(computeMovingAverage([], 3)).toEqual([]);
  });

  it("throws RangeError when windowSize is 0", () => {
    expect(() => computeMovingAverage([1, 2, 3], 0)).toThrowError(RangeError);
    expect(() => computeMovingAverage([1, 2, 3], 0)).toThrowError(
      /windowSize must be an integer/,
    );
  });

  it("throws RangeError when windowSize is negative", () => {
    expect(() => computeMovingAverage([1, 2, 3], -5)).toThrowError(RangeError);
  });

  it("throws RangeError when windowSize is a non-integer", () => {
    expect(() => computeMovingAverage([1, 2, 3], 1.5)).toThrowError(RangeError);
  });

  it("is pure — does not mutate the input array", () => {
    const samples = [1, 2, 3, 4, 5];
    const copy = [...samples];
    computeMovingAverage(samples, 2);
    expect(samples).toEqual(copy);
  });

  it("handles a single-element input", () => {
    const result = computeMovingAverage([42], 1);
    expect(result).toEqual([42]);
  });

  it("all entries are NaN when windowSize exceeds samples length", () => {
    const result = computeMovingAverage([1, 2], 5);
    expect(result.every((v) => Number.isNaN(v))).toBe(true);
  });
});
