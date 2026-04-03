import { describe, it, expect } from "vitest";
import { extractImageCandidates } from "../src/indexing/image-describer";
import { createDefaultConfig } from "../src/config/defaults";

function makeConfig(overrides?: Partial<ReturnType<typeof createDefaultConfig>["embedding"]["images"]>) {
  const config = createDefaultConfig("test-project");
  config.embedding.images = {
    ...config.embedding.images,
    enable: true,
    ...overrides
  };
  return config;
}

const BASE_HTML = `<html><body><main>
  <h1>Test Page</h1>
  <img src="/images/hero.jpg" alt="Hero image" width="800" height="600">
  <h2>Section One</h2>
  <p>Some text</p>
  <img src="/images/diagram.png" alt="Architecture diagram">
  <img src="/images/photo.webp" alt="Team photo" width="400" height="300">
</main></body></html>`;

describe("extractImageCandidates", () => {
  it("extracts images with src, alt, and resolved URLs", () => {
    const config = makeConfig();
    const candidates = extractImageCandidates(BASE_HTML, "/docs/getting-started", config);

    expect(candidates).toHaveLength(3);
    expect(candidates[0]).toMatchObject({
      src: "/images/hero.jpg",
      alt: "Hero image"
    });
    expect(candidates[0]!.resolvedUrl).toContain("/images/hero.jpg");
    expect(candidates[1]).toMatchObject({
      src: "/images/diagram.png",
      alt: "Architecture diagram"
    });
  });

  it("skips SVG images", () => {
    const html = `<html><body><main>
      <img src="/icons/logo.svg" alt="Logo">
      <img src="/images/photo.jpg" alt="Photo">
    </main></body></html>`;
    const config = makeConfig();
    const candidates = extractImageCandidates(html, "/page", config);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.src).toBe("/images/photo.jpg");
  });

  it("skips data URIs", () => {
    const html = `<html><body><main>
      <img src="data:image/png;base64,abc123" alt="Inline">
      <img src="/images/real.jpg" alt="Real">
    </main></body></html>`;
    const config = makeConfig();
    const candidates = extractImageCandidates(html, "/page", config);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.src).toBe("/images/real.jpg");
  });

  it("skips ico and bmp images", () => {
    const html = `<html><body><main>
      <img src="/favicon.ico" alt="Favicon">
      <img src="/images/old.bmp" alt="Old">
      <img src="/images/good.png" alt="Good">
    </main></body></html>`;
    const config = makeConfig();
    const candidates = extractImageCandidates(html, "/page", config);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.src).toBe("/images/good.png");
  });

  it("respects maxPerPage cap", () => {
    const config = makeConfig({ maxPerPage: 2 });
    const candidates = extractImageCandidates(BASE_HTML, "/page", config);

    expect(candidates).toHaveLength(2);
  });

  it("skips images with width below minWidth", () => {
    const html = `<html><body><main>
      <img src="/images/tiny.jpg" alt="Tiny" width="20" height="200">
      <img src="/images/big.jpg" alt="Big" width="200" height="200">
    </main></body></html>`;
    const config = makeConfig({ minWidth: 50 });
    const candidates = extractImageCandidates(html, "/page", config);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.src).toBe("/images/big.jpg");
  });

  it("skips images with height below minHeight", () => {
    const html = `<html><body><main>
      <img src="/images/short.jpg" alt="Short" width="200" height="10">
      <img src="/images/tall.jpg" alt="Tall" width="200" height="200">
    </main></body></html>`;
    const config = makeConfig({ minHeight: 50 });
    const candidates = extractImageCandidates(html, "/page", config);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.src).toBe("/images/tall.jpg");
  });

  it("allows images without dimension attributes (no filtering)", () => {
    const html = `<html><body><main>
      <img src="/images/no-dims.jpg" alt="No dimensions">
    </main></body></html>`;
    const config = makeConfig({ minWidth: 50, minHeight: 50 });
    const candidates = extractImageCandidates(html, "/page", config);

    expect(candidates).toHaveLength(1);
  });

  it("returns empty array when no images found", () => {
    const html = `<html><body><main><p>No images here</p></main></body></html>`;
    const config = makeConfig();
    const candidates = extractImageCandidates(html, "/page", config);

    expect(candidates).toHaveLength(0);
  });

  it("skips images inside drop selectors", () => {
    const html = `<html><body><main>
      <div class="sidebar"><img src="/images/sidebar.jpg" alt="Sidebar"></div>
      <img src="/images/content.jpg" alt="Content">
    </main></body></html>`;
    const config = makeConfig();
    const candidates = extractImageCandidates(html, "/page", config);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.src).toBe("/images/content.jpg");
  });

  it("skips images inside drop tags", () => {
    const html = `<html><body><main>
      <nav><img src="/images/nav.jpg" alt="Nav"></nav>
      <img src="/images/main.jpg" alt="Main">
    </main></body></html>`;
    const config = makeConfig();
    const candidates = extractImageCandidates(html, "/page", config);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.src).toBe("/images/main.jpg");
  });

  it("extracts picture element inner img", () => {
    const html = `<html><body><main>
      <picture>
        <source srcset="/images/hero.webp" type="image/webp">
        <img src="/images/hero.jpg" alt="Hero">
      </picture>
    </main></body></html>`;
    const config = makeConfig();
    const candidates = extractImageCandidates(html, "/page", config);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.src).toBe("/images/hero.jpg");
    expect(candidates[0]!.alt).toBe("Hero");
  });

  it("captures context heading", () => {
    const html = `<html><body><main>
      <h2>Getting Started</h2>
      <p>Some text</p>
      <img src="/images/step1.png" alt="Step 1">
    </main></body></html>`;
    const config = makeConfig();
    const candidates = extractImageCandidates(html, "/page", config);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.contextHeading).toBe("Getting Started");
  });

  it("resolves relative URLs with baseUrl", () => {
    const config = makeConfig();
    config.project.baseUrl = "https://example.com";
    const html = `<html><body><main>
      <img src="images/photo.jpg" alt="Photo">
    </main></body></html>`;
    const candidates = extractImageCandidates(html, "/docs/page", config);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.resolvedUrl).toBe("https://example.com/docs/images/photo.jpg");
  });
});
