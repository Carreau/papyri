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

  it("renders multi-line aligned display math (the tables-and-math specimen)", () => {
    // The exact body of the `.. math::` block in
    // docs/specimens/tables-and-math.rst. A bare `&` is invalid outside an
    // environment, so this regressed to a math-error box before we wrapped
    // display math in `aligned` (Sphinx parity).
    const html = renderMath("f(x) &= (x + a)(x + b) \\\\\n     &= x^2 + (a + b)x + ab", true);
    expect(html).toContain("katex-display");
    expect(html).not.toContain("math-error");
  });

  it("does not wrap display math that already opens its own environment", () => {
    const html = renderMath("\\begin{aligned} x &= 1 \\\\ y &= 2 \\end{aligned}", true);
    expect(html).toContain("katex-display");
    expect(html).not.toContain("math-error");
  });

  it("leaves inline math with no alignment untouched", () => {
    const html = renderMath("\\frac{1}{2}", false);
    expect(html).toContain("katex");
    expect(html).not.toContain("math-error");
  });
});
