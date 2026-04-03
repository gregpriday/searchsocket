import { describe, expect, it } from "vitest";
import { diceScore, compositeScore, dominantRelationshipType } from "../src/search/related-pages";

describe("diceScore", () => {
  it("returns 1 for identical root paths", () => {
    expect(diceScore("/", "/")).toBe(1);
  });

  it("returns 1 for identical multi-segment paths", () => {
    expect(diceScore("/docs/auth", "/docs/auth")).toBe(1);
  });

  it("returns 0 for completely disjoint paths", () => {
    expect(diceScore("/docs/auth", "/blog/post")).toBe(0);
  });

  it("returns correct score for sibling paths", () => {
    // /docs/auth vs /docs/sessions: shared prefix = 1 ("docs"), total = 2+2 = 4
    expect(diceScore("/docs/auth", "/docs/sessions")).toBe(0.5);
  });

  it("returns correct score for parent-child paths", () => {
    // /docs vs /docs/auth: shared prefix = 1, total = 1+2 = 3
    expect(diceScore("/docs", "/docs/auth")).toBeCloseTo(2 / 3);
  });

  it("returns 0 when one path is root and other is deep", () => {
    expect(diceScore("/", "/docs/auth/login")).toBe(0);
  });

  it("handles paths with many shared segments", () => {
    // /a/b/c vs /a/b/d: shared = 2, total = 3+3 = 6
    expect(diceScore("/a/b/c", "/a/b/d")).toBeCloseTo(4 / 6);
  });
});

describe("compositeScore", () => {
  it("returns 0.5 for direct link only (no structural or semantic)", () => {
    expect(compositeScore(true, 0, 0)).toBe(0.5);
  });

  it("returns 0.2 for semantic only", () => {
    expect(compositeScore(false, 0, 1.0)).toBeCloseTo(0.2);
  });

  it("returns 0.3 for perfect structural match only", () => {
    expect(compositeScore(false, 1.0, 0)).toBeCloseTo(0.3);
  });

  it("returns 1.0 for all signals at maximum", () => {
    expect(compositeScore(true, 1.0, 1.0)).toBeCloseTo(1.0);
  });

  it("returns 0 for no signals", () => {
    expect(compositeScore(false, 0, 0)).toBe(0);
  });

  it("combines link and semantic correctly", () => {
    // 0.5 + 0 + 0.2*0.8 = 0.66
    expect(compositeScore(true, 0, 0.8)).toBeCloseTo(0.66);
  });
});

describe("dominantRelationshipType", () => {
  it("returns outgoing_link when isOutgoing is true", () => {
    expect(dominantRelationshipType(true, false, 0)).toBe("outgoing_link");
  });

  it("returns outgoing_link even when isIncoming is also true", () => {
    expect(dominantRelationshipType(true, true, 0.9)).toBe("outgoing_link");
  });

  it("returns incoming_link when isIncoming is true and not outgoing", () => {
    expect(dominantRelationshipType(false, true, 0.9)).toBe("incoming_link");
  });

  it("returns sibling when dice > 0.4 and no links", () => {
    expect(dominantRelationshipType(false, false, 0.5)).toBe("sibling");
  });

  it("returns semantic when dice <= 0.4 and no links", () => {
    expect(dominantRelationshipType(false, false, 0.4)).toBe("semantic");
    expect(dominantRelationshipType(false, false, 0)).toBe("semantic");
  });
});
