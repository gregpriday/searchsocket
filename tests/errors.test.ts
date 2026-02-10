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

  it("wraps generic Error as INTERNAL_ERROR", () => {
    const error = new Error("unexpected");
    const payload = toErrorPayload(error);
    expect(payload.error.code).toBe("INTERNAL_ERROR");
    expect(payload.error.message).toBe("unexpected");
  });

  it("handles non-Error values", () => {
    const payload = toErrorPayload("string error");
    expect(payload.error.code).toBe("INTERNAL_ERROR");
    expect(payload.error.message).toBe("Unknown error");
  });
});
