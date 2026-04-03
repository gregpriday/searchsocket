import { describe, expect, it } from "vitest";
import { l2Normalize } from "../src/vector/gemini";

describe("l2Normalize", () => {
  it("normalizes a unit vector to itself", () => {
    const result = l2Normalize([1, 0, 0]);
    expect(result).toEqual([1, 0, 0]);
  });

  it("normalizes a non-unit vector to unit length", () => {
    const result = l2Normalize([3, 4, 0]);
    expect(result[0]).toBeCloseTo(0.6);
    expect(result[1]).toBeCloseTo(0.8);
    expect(result[2]).toBeCloseTo(0);
    const norm = Math.sqrt(result.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1.0);
  });

  it("returns zero vector unchanged", () => {
    const result = l2Normalize([0, 0, 0]);
    expect(result).toEqual([0, 0, 0]);
  });

  it("normalizes negative values correctly", () => {
    const result = l2Normalize([-3, 4, 0]);
    expect(result[0]).toBeCloseTo(-0.6);
    expect(result[1]).toBeCloseTo(0.8);
    const norm = Math.sqrt(result.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1.0);
  });

  it("normalizes a uniform vector", () => {
    const v = new Array(1024).fill(1);
    const result = l2Normalize(v);
    const expectedVal = 1 / Math.sqrt(1024);
    for (const val of result) {
      expect(val).toBeCloseTo(expectedVal, 6);
    }
    const norm = Math.sqrt(result.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1.0);
  });

  it("returns empty array for empty input", () => {
    const result = l2Normalize([]);
    expect(result).toEqual([]);
  });
});
