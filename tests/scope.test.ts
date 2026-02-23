import { describe, expect, it, vi } from "vitest";
import { resolveScope } from "../src/core/scope";
import { createDefaultConfig } from "../src/config/defaults";

describe("resolveScope", () => {
  it("uses fixed scope by default", () => {
    const config = createDefaultConfig("test-proj");
    const scope = resolveScope(config);
    expect(scope.scopeName).toBe("main");
    expect(scope.projectId).toBe("test-proj");
    expect(scope.scopeId).toBe("test-proj:main");
  });

  it("respects scope override", () => {
    const config = createDefaultConfig("test-proj");
    const scope = resolveScope(config, "feature-x");
    expect(scope.scopeName).toBe("feature-x");
    expect(scope.scopeId).toBe("test-proj:feature-x");
  });

  it("sanitizes scope name", () => {
    const config = createDefaultConfig("test-proj");
    const scope = resolveScope(config, "Feature/Branch Name");
    expect(scope.scopeName).toBe("feature-branch-name");
  });

  it("preserves raw scope names when sanitize is disabled", () => {
    const config = createDefaultConfig("test-proj");
    config.scope.sanitize = false;

    const scope = resolveScope(config, "Feature/Branch Name");
    expect(scope.scopeName).toBe("Feature/Branch Name");
  });

  it("uses env var when mode is env", () => {
    const config = createDefaultConfig("test-proj");
    config.scope.mode = "env";
    config.scope.envVar = "TEST_SCOPE";

    vi.stubEnv("TEST_SCOPE", "staging");
    const scope = resolveScope(config);
    expect(scope.scopeName).toBe("staging");
    vi.unstubAllEnvs();
  });

  it("throws when env var is missing in env mode", () => {
    const config = createDefaultConfig("test-proj");
    config.scope.mode = "env";
    config.scope.envVar = "MISSING_VAR";
    delete process.env.MISSING_VAR;

    expect(() => resolveScope(config)).toThrow("MISSING_VAR");
  });
});
