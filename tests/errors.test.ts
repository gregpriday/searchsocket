import { describe, expect, it } from "vitest";
import { SearchSocketError, toErrorPayload } from "../src/errors";

describe("SearchSocketError", () => {
  it("sets code, message, and status", () => {
    const error = new SearchSocketError("CONFIG_MISSING", "Config not found", 404);
    expect(error.code).toBe("CONFIG_MISSING");
    expect(error.message).toBe("Config not found");
    expect(error.status).toBe(404);
  });

  it("defaults status to 500", () => {
    const error = new SearchSocketError("INTERNAL_ERROR", "Something broke");
    expect(error.status).toBe(500);
  });

  it("extends Error", () => {
    const error = new SearchSocketError("RATE_LIMITED", "slow down", 429);
    expect(error instanceof Error).toBe(true);
  });
});

describe("toErrorPayload", () => {
  it("formats SearchSocketError", () => {
    const error = new SearchSocketError("INVALID_REQUEST", "bad input", 400);
    const payload = toErrorPayload(error);
    expect(payload.error.code).toBe("INVALID_REQUEST");
    expect(payload.error.message).toBe("bad input");
  });

  it("does not leak an unexpected error's message", () => {
    // An unexpected error's text is not a deliberate public string — it can
    // carry a credential, a filesystem path, or an internal URL. Typed errors
    // say what they mean and pass through; everything else is generic.
    const payload = toErrorPayload(new Error("connect ECONNREFUSED 10.0.0.5:6379 token=sk-secret"));
    expect(payload.error.code).toBe("INTERNAL_ERROR");
    expect(payload.error.message).toBe("Internal error");
    expect(payload.error.message).not.toContain("sk-secret");
  });

  it("handles non-Error values", () => {
    const payload = toErrorPayload("string error");
    expect(payload.error.code).toBe("INTERNAL_ERROR");
    expect(payload.error.message).toBe("Internal error");
  });
});
