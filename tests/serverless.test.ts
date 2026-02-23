import { afterEach, describe, expect, it } from "vitest";
import { isServerless } from "../src/core/serverless";

const ENV_VARS = [
  "VERCEL",
  "NETLIFY",
  "AWS_LAMBDA_FUNCTION_NAME",
  "FUNCTIONS_WORKER",
  "CF_PAGES"
];

afterEach(() => {
  for (const v of ENV_VARS) {
    delete process.env[v];
  }
});

describe("isServerless", () => {
  it("returns false by default", () => {
    for (const v of ENV_VARS) {
      delete process.env[v];
    }
    expect(isServerless()).toBe(false);
  });

  it("returns true when VERCEL is set", () => {
    process.env.VERCEL = "1";
    expect(isServerless()).toBe(true);
  });

  it("returns true when NETLIFY is set", () => {
    process.env.NETLIFY = "true";
    expect(isServerless()).toBe(true);
  });

  it("returns true when AWS_LAMBDA_FUNCTION_NAME is set", () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = "my-function";
    expect(isServerless()).toBe(true);
  });

  it("returns true when FUNCTIONS_WORKER is set", () => {
    process.env.FUNCTIONS_WORKER = "1";
    expect(isServerless()).toBe(true);
  });

  it("returns true when CF_PAGES is set", () => {
    process.env.CF_PAGES = "1";
    expect(isServerless()).toBe(true);
  });
});
