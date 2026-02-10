import { describe, expect, it } from "vitest";
import { sha1, sha256 } from "../src/utils/hash";

describe("sha1", () => {
  it("produces consistent output", () => {
    expect(sha1("hello")).toBe(sha1("hello"));
  });

  it("produces different output for different input", () => {
    expect(sha1("hello")).not.toBe(sha1("world"));
  });

  it("produces 40-char hex string", () => {
    expect(sha1("test")).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("sha256", () => {
  it("produces consistent output", () => {
    expect(sha256("hello")).toBe(sha256("hello"));
  });

  it("produces different output for different input", () => {
    expect(sha256("hello")).not.toBe(sha256("world"));
  });

  it("produces 64-char hex string", () => {
    expect(sha256("test")).toMatch(/^[0-9a-f]{64}$/);
  });
});
