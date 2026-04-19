import { describe, it, expect } from "vitest";
import { renderMath } from "../src/lib/math.ts";

describe("renderMath", () => {
  it("renders an inline expression via KaTeX", () => {
    const html = renderMath("a^2 + b^2 = c^2", false);
    // KaTeX always emits a wrapper with the "katex" class.
    expect(html).toContain("katex");
    // Inline mode must not set display mode.
    expect(html).not.toContain("katex-display");
  });

  it("renders a display expression via KaTeX", () => {
    const html = renderMath("\\sum_{i=0}^{n} i", true);
    expect(html).toContain("katex");
    expect(html).toContain("katex-display");
  });

  it("falls back to math-error on parse failure", () => {
    const html = renderMath("\\invalidcommand{", false);
    expect(html).toContain("math-error");
  });
});
