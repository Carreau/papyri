// Server-side KaTeX rendering for Math / InlineMath IR nodes.
//
// M3 decision: the viewer is static-site-generated (Astro), so we render
// KaTeX at build time via `renderToString` and ship the output as precomputed
// HTML. This avoids shipping katex.js / KaTeX's JS runtime to the client;
// only the KaTeX CSS stylesheet is needed at render time.
//
// Parse errors are caught and reported inline as a `<code class="math-error">`
// fallback. A single bad `:math:` expression in a docstring must not break the
// static build.

import katex from "katex";

// Sphinx wraps `.. math::` directive bodies so that `&` alignment and `\\`
// line breaks work without the author writing an environment. KaTeX rejects a
// bare `&` outside an environment, so for display math we mirror Sphinx and
// wrap the body in `aligned` — unless it already opens with its own
// environment (e.g. `\begin{aligned}`, `\begin{cases}`), which would make the
// wrap redundant. Inline math is left untouched.
function wrapDisplayMath(value: string): string {
  if (/^\s*\\begin\{/.test(value)) {
    return value;
  }
  if (!/&|\\\\/.test(value)) {
    return value;
  }
  return `\\begin{aligned}\n${value}\n\\end{aligned}`;
}

export function renderMath(value: string, displayMode: boolean): string {
  const source = displayMode ? wrapDisplayMath(value) : value;
  try {
    return katex.renderToString(source, {
      displayMode,
      // `throwOnError: false` would still emit KaTeX's own warning markup; we
      // want full control over the failure path, so we raise and catch.
      throwOnError: true,
      strict: "ignore",
      output: "html",
    });
  } catch {
    // Report the author's original expression, not the aligned-wrapped form.
    const escaped = value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    return `<code class="math-error">${escaped}</code>`;
  }
}
