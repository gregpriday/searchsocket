import { describe, expect, it } from "vitest";
import {
  validateMetaKey,
  serializeMetaValue,
  parseMetaValue,
  escapeFilterValue,
  buildMetaFilterString,
  toStoredMeta
} from "../src/utils/structured-meta";

describe("validateMetaKey", () => {
  it("accepts valid keys", () => {
    expect(validateMetaKey("version")).toBe(true);
    expect(validateMetaKey("_private")).toBe(true);
    expect(validateMetaKey("category2")).toBe(true);
    expect(validateMetaKey("A_B_C")).toBe(true);
  });

  it("rejects invalid keys", () => {
    expect(validateMetaKey("")).toBe(false);
    expect(validateMetaKey("1version")).toBe(false);
    expect(validateMetaKey("foo.bar")).toBe(false);
    expect(validateMetaKey("foo-bar")).toBe(false);
    expect(validateMetaKey("foo:bar")).toBe(false);
    expect(validateMetaKey("has space")).toBe(false);
  });
});

describe("serializeMetaValue / parseMetaValue round-trip", () => {
  it("handles strings", () => {
    const { content, dataType } = serializeMetaValue("auth");
    expect(dataType).toBe("string");
    expect(content).toBe("auth");
    expect(parseMetaValue(content, dataType)).toBe("auth");
  });

  it("handles numbers", () => {
    const { content, dataType } = serializeMetaValue(2.5);
    expect(dataType).toBe("number");
    expect(content).toBe("2.5");
    expect(parseMetaValue(content, dataType)).toBe(2.5);
  });

  it("handles booleans", () => {
    const { content: c1, dataType: d1 } = serializeMetaValue(true);
    expect(d1).toBe("boolean");
    expect(parseMetaValue(c1, d1)).toBe(true);

    const { content: c2, dataType: d2 } = serializeMetaValue(false);
    expect(parseMetaValue(c2, d2)).toBe(false);
  });

  it("handles string arrays", () => {
    const { content, dataType } = serializeMetaValue(["svelte", "react"]);
    expect(dataType).toBe("string[]");
    expect(content).toBe("svelte,react");
    expect(parseMetaValue(content, dataType)).toEqual(["svelte", "react"]);
  });

  it("handles Date values", () => {
    const date = new Date("2025-06-15T00:00:00Z");
    const { content, dataType } = serializeMetaValue(date);
    expect(dataType).toBe("date");
    const parsed = parseMetaValue(content, dataType);
    expect(parsed).toBe(date.getTime());
  });

  it("handles empty string array", () => {
    expect(parseMetaValue("", "string[]")).toEqual([]);
  });
});

describe("toStoredMeta", () => {
  it("converts Date to epoch ms and skips invalid keys", () => {
    const result = toStoredMeta({
      version: 2.0,
      "bad-key": "ignored",
      published: new Date("2025-01-01T00:00:00Z"),
      tags: ["a", "b"]
    });
    expect(result).toEqual({
      version: 2.0,
      published: new Date("2025-01-01T00:00:00Z").getTime(),
      tags: ["a", "b"]
    });
  });
});

describe("escapeFilterValue", () => {
  it("escapes single quotes", () => {
    expect(escapeFilterValue("O'Reilly")).toBe("O''Reilly");
    expect(escapeFilterValue("it's")).toBe("it''s");
  });

  it("passes through clean strings", () => {
    expect(escapeFilterValue("hello")).toBe("hello");
  });
});

describe("buildMetaFilterString", () => {
  it("builds string filter with CONTAINS", () => {
    expect(buildMetaFilterString({ category: "auth" })).toBe(
      "meta.category CONTAINS 'auth'"
    );
  });

  it("builds number filter with =", () => {
    expect(buildMetaFilterString({ version: 2.0 })).toBe("meta.version = 2");
  });

  it("builds boolean filter with =", () => {
    expect(buildMetaFilterString({ deprecated: false })).toBe(
      "meta.deprecated = false"
    );
  });

  it("combines multiple filters with AND", () => {
    const result = buildMetaFilterString({ version: 2, deprecated: false });
    expect(result).toContain("meta.version = 2");
    expect(result).toContain("meta.deprecated = false");
    expect(result).toContain(" AND ");
  });

  it("escapes single quotes in string values", () => {
    expect(buildMetaFilterString({ category: "O'Reilly" })).toBe(
      "meta.category CONTAINS 'O''Reilly'"
    );
  });

  it("skips invalid keys (injection prevention)", () => {
    const result = buildMetaFilterString({
      "meta.version OR 1=1": 1,
      version: 2
    });
    expect(result).toBe("meta.version = 2");
    expect(result).not.toContain("OR");
  });

  it("returns empty string for empty filters", () => {
    expect(buildMetaFilterString({})).toBe("");
  });
});
