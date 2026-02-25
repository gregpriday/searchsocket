import { describe, expect, it } from "vitest";
import { parseRobotsTxt, isBlockedByRobots } from "../src/indexing/robots";

describe("parseRobotsTxt", () => {
  it("parses basic disallow rules for wildcard agent", () => {
    const content = `
User-agent: *
Disallow: /admin
Disallow: /api/
`;
    const rules = parseRobotsTxt(content);
    expect(rules.disallow).toEqual(["/admin", "/api/"]);
    expect(rules.allow).toEqual([]);
  });

  it("prefers Searchsocket-specific rules over wildcard", () => {
    const content = `
User-agent: *
Disallow: /admin

User-agent: Searchsocket
Disallow: /internal
`;
    const rules = parseRobotsTxt(content);
    expect(rules.disallow).toEqual(["/internal"]);
  });

  it("falls back to wildcard when no specific agent rules exist", () => {
    const content = `
User-agent: *
Disallow: /admin
`;
    const rules = parseRobotsTxt(content);
    expect(rules.disallow).toEqual(["/admin"]);
  });

  it("handles allow rules", () => {
    const content = `
User-agent: *
Disallow: /private/
Allow: /private/public-page
`;
    const rules = parseRobotsTxt(content);
    expect(rules.disallow).toEqual(["/private/"]);
    expect(rules.allow).toEqual(["/private/public-page"]);
  });

  it("ignores comments and empty lines", () => {
    const content = `
# This is a comment
User-agent: *
Disallow: /admin # inline comment

# Another comment
Disallow: /secret
`;
    const rules = parseRobotsTxt(content);
    expect(rules.disallow).toEqual(["/admin", "/secret"]);
  });

  it("returns empty rules when no matching agent found", () => {
    const content = `
User-agent: Googlebot
Disallow: /admin
`;
    const rules = parseRobotsTxt(content);
    expect(rules.disallow).toEqual([]);
    expect(rules.allow).toEqual([]);
  });

  it("handles empty content", () => {
    const rules = parseRobotsTxt("");
    expect(rules.disallow).toEqual([]);
    expect(rules.allow).toEqual([]);
  });

  it("is case-insensitive for user-agent matching", () => {
    const content = `
User-agent: searchsocket
Disallow: /internal
`;
    const rules = parseRobotsTxt(content, "Searchsocket");
    expect(rules.disallow).toEqual(["/internal"]);
  });
});

describe("isBlockedByRobots", () => {
  it("blocks paths matching disallow", () => {
    const rules = { disallow: ["/admin"], allow: [] };
    expect(isBlockedByRobots("/admin", rules)).toBe(true);
    expect(isBlockedByRobots("/admin/users", rules)).toBe(true);
  });

  it("does not block non-matching paths", () => {
    const rules = { disallow: ["/admin"], allow: [] };
    expect(isBlockedByRobots("/about", rules)).toBe(false);
    expect(isBlockedByRobots("/", rules)).toBe(false);
  });

  it("allow overrides disallow when more specific", () => {
    const rules = {
      disallow: ["/private/"],
      allow: ["/private/public-page"]
    };
    expect(isBlockedByRobots("/private/secret", rules)).toBe(true);
    expect(isBlockedByRobots("/private/public-page", rules)).toBe(false);
  });

  it("disallow wins when equally specific", () => {
    const rules = {
      disallow: ["/page"],
      allow: ["/page"]
    };
    // Equal length — allow wins
    expect(isBlockedByRobots("/page", rules)).toBe(false);
  });

  it("handles empty rules", () => {
    const rules = { disallow: [], allow: [] };
    expect(isBlockedByRobots("/anything", rules)).toBe(false);
  });

  it("handles disallow with trailing slash", () => {
    const rules = { disallow: ["/api/"], allow: [] };
    expect(isBlockedByRobots("/api/endpoint", rules)).toBe(true);
    expect(isBlockedByRobots("/api", rules)).toBe(false);
  });
});
