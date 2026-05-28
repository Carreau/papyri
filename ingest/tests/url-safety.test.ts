import { describe, expect, it } from "vitest";
import { isSafeUrl } from "../src/url-safety.ts";
import { assertSafeUrls } from "../src/bundle.ts";

type BundleArg = Parameters<typeof assertSafeUrls>[0];

function bundle(overrides: Record<string, unknown>): BundleArg {
  return {
    __type: "Bundle",
    __tag: 4070,
    module: "m",
    version: "1",
    api: {},
    narrative: {},
    examples: {},
    ...overrides,
  } as unknown as BundleArg;
}

describe("isSafeUrl", () => {
  it("allows http/https/mailto and relative URLs", () => {
    for (const u of [
      "http://x.com",
      "https://x.com/a?b=c#d",
      "mailto:a@b.com",
      "../rel/path",
      "/abs/path",
      "#frag",
      "foo/bar",
      "",
    ]) {
      expect(isSafeUrl(u)).toBe(true);
    }
  });

  it("rejects dangerous schemes", () => {
    for (const u of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>x</script>",
      "vbscript:x",
      "file:///etc/passwd",
    ]) {
      expect(isSafeUrl(u)).toBe(false);
    }
  });

  it("rejects schemes obfuscated with control chars or whitespace", () => {
    expect(isSafeUrl("java\tscript:alert(1)")).toBe(false);
    expect(isSafeUrl("  javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("java\nscript:alert(1)")).toBe(false);
  });
});

describe("assertSafeUrls", () => {
  it("throws on an unsafe Link URL nested in api", () => {
    const b = bundle({
      api: {
        "m.f": {
          __type: "GeneratedDoc",
          _content: { body: [{ __type: "Link", url: "javascript:alert(1)" }] },
        },
      },
    });
    expect(() => assertSafeUrls(b)).toThrow(/disallowed scheme/);
  });

  it("throws on an unsafe Image URL", () => {
    const b = bundle({
      examples: {
        ex: { __type: "Section", children: [{ __type: "Image", url: "data:text/html,x" }] },
      },
    });
    expect(() => assertSafeUrls(b)).toThrow(/disallowed scheme/);
  });

  it("accepts a bundle whose Link/Image URLs are all safe", () => {
    const b = bundle({
      examples: {
        ex: {
          __type: "Section",
          children: [
            { __type: "Link", url: "https://x.com" },
            { __type: "Image", url: "../assets/a.png" },
          ],
        },
      },
    });
    expect(() => assertSafeUrls(b)).not.toThrow();
  });

  it("ignores non-Link/Image url fields (e.g. RefInfo)", () => {
    const b = bundle({
      api: { "m.f": { __type: "RefInfo", url: "data:whatever", module: "m" } },
    });
    expect(() => assertSafeUrls(b)).not.toThrow();
  });
});
