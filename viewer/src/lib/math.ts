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

export function renderMath(value: string, displayMode: boolean): string {
  try {
    return katex.renderToString(value, {
      displayMode,
      // `throwOnError: false` would still emit KaTeX's own warning markup; we
      // want full control over the failure path, so we raise and catch.
      throwOnError: true,
      strict: "ignore",
      output: "html",
    });
  } catch {
    const escaped = value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    return `<code class="math-error">${escaped}</code>`;
  }
}
