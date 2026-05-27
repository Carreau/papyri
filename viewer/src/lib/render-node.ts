// Server-side IR node renderer.
//
// Single async function that dispatches on __type and returns an HTML string.
// Mirrors the logic in IrNode.astro (which is now a thin wrapper around this)
// so the same rendering is available to API endpoints without an Astro component.
//
// resolveXref is optional; CrossRef nodes render as unresolved links when absent.

import { renderMath } from "./math.ts";
import { highlight } from "./highlight.ts";
import type { IRNode } from "./ir-reader.ts";
import { linkForAsset } from "./links.ts";

export type XRefResolver = (
  node: unknown
) => { url: string; label: string; external?: boolean } | null;

export interface RenderOptions {
  resolveXref?: XRefResolver;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function asArray(x: unknown): IRNode[] {
  return Array.isArray(x) ? (x as IRNode[]) : [];
}

/**
 * Build debug attributes for an unresolved CrossRef so contributors can see
 * *why* a reference failed to resolve (the underlying RefInfo: module /
 * version / kind / path). Returns the attribute string to splice into the span
 * (leading space included):
 *   - `data-debug` — drives a visible CSS hover tooltip (`:hover::after` with
 *     `content: attr(data-debug)`), since native `title` tooltips are flaky.
 *   - `title` — native fallback for accessibility.
 *   - `data-ref-*` — the raw fields, inspectable in devtools.
 */
function unresolvedRefDebug(node: Record<string, unknown>): string {
  const ref = node.reference as Record<string, unknown> | null | undefined;
  const refType = ref ? String(ref.__type ?? "RefInfo") : "RefInfo";
  const fields = ["module", "version", "kind", "path"] as const;
  const parts = fields.map((k) => `${k}=${ref?.[k] != null ? String(ref[k]) : "∅"}`);
  const debug = `unresolved ${refType}(${parts.join(", ")})`;
  let attrs = ` data-debug="${escapeHtml(debug)}" title="${escapeHtml(debug)}" data-ref-type="${escapeHtml(refType)}"`;
  for (const k of fields) {
    attrs += ` data-ref-${k}="${escapeHtml(ref?.[k] != null ? String(ref[k]) : "")}"`;
  }
  return attrs;
}

async function renderChildren(children: IRNode[], opts: RenderOptions): Promise<string> {
  const parts = await Promise.all(children.map((c) => renderNode(c, opts)));
  return parts.join("");
}

function execStatusIcon(status: string): string {
  switch (status) {
    case "success":
      return "✓";
    case "failure":
      return "✗";
    case "unexpected_exception":
      return "⚠";
    case "syntax_error":
      return "✗";
    case "compiled":
      return "○";
    default:
      return "?";
  }
}

function execStatusTitle(status: string): string {
  switch (status) {
    case "success":
      return "Example executed successfully";
    case "failure":
      return "Example produced unexpected output";
    case "unexpected_exception":
      return "Example raised an unexpected exception";
    case "syntax_error":
      return "Example has a syntax error";
    case "compiled":
      return "Example compiled but was not executed";
    default:
      return `Execution status: ${status}`;
  }
}

export async function renderNode(node: IRNode, opts: RenderOptions = {}): Promise<string> {
  const { resolveXref } = opts;
  const n = node as Record<string, unknown>;
  const type = n.__type as string | undefined;

  switch (type) {
    case "Text":
      return escapeHtml(String(n.value ?? ""));

    case "Paragraph": {
      const inner = await renderChildren(asArray(n.children), opts);
      return `<p>${inner}</p>`;
    }

    case "Emphasis": {
      const inner = await renderChildren(asArray(n.children), opts);
      return `<em>${inner}</em>`;
    }

    case "Strong": {
      const inner = await renderChildren(asArray(n.children), opts);
      return `<strong>${inner}</strong>`;
    }

    case "InlineCode":
      return `<code>${escapeHtml(String(n.value ?? ""))}</code>`;

    case "Code": {
      const inner = await highlight(String(n.value ?? ""), "python");
      const status = n.execution_status != null ? String(n.execution_status) : null;
      const out = typeof n.out === "string" && n.out.length > 0 ? n.out : null;
      const outputHtml = out != null ? `<pre class="code-output">${escapeHtml(out)}</pre>` : "";
      if (status && status !== "none") {
        const icon = execStatusIcon(status);
        const title = execStatusTitle(status);
        return `<div class="code-block-wrap" data-exec-status="${escapeHtml(status)}"><pre class="code">${inner}</pre><span class="exec-status exec-status--${escapeHtml(status)}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">${icon}</span></div>${outputHtml}`;
      }
      return `<pre class="code">${inner}</pre>${outputHtml}`;
    }

    case "Link": {
      const inner = await renderChildren(asArray(n.children), opts);
      const href = escapeHtml(String(n.url ?? ""));
      const title = n.title ? ` title="${escapeHtml(String(n.title))}"` : "";
      const isExternal = /^https?:\/\//.test(String(n.url ?? ""));
      if (isExternal) {
        return `<a class="ext-link" href="${href}"${title} target="_blank" rel="noreferrer noopener">${inner}</a>`;
      }
      return `<a href="${href}"${title}>${inner}</a>`;
    }

    case "Table": {
      const rows = asArray(n.children);
      const headers: string[] = [];
      const body: string[] = [];
      for (const row of rows) {
        const rowNode = row as { __type?: string; header?: boolean; children?: unknown };
        if (rowNode.__type !== "TableRow") continue;
        const cells = asArray(rowNode.children);
        const tag = rowNode.header ? "th" : "td";
        const cellHtml = await Promise.all(
          cells.map(async (cell) => {
            const cellNode = cell as { __type?: string; children?: unknown };
            const inner =
              cellNode.__type === "TableCell"
                ? await renderChildren(asArray(cellNode.children), opts)
                : await renderNode(cell, opts);
            return `<${tag}>${inner}</${tag}>`;
          })
        );
        const tr = `<tr>${cellHtml.join("")}</tr>`;
        if (rowNode.header) headers.push(tr);
        else body.push(tr);
      }
      const thead = headers.length ? `<thead>${headers.join("")}</thead>` : "";
      const tbody = body.length ? `<tbody>${body.join("")}</tbody>` : "";
      return `<table class="ir-table">${thead}${tbody}</table>`;
    }

    case "TableRow": {
      // Bare-row fallback: renderer above usually handles TableRow inside a
      // Table.  Emit a row without a wrapping <table> if we ever hit one.
      const cells = asArray(n.children);
      const tag = n.header ? "th" : "td";
      const cellHtml = await Promise.all(
        cells.map(async (cell) => {
          const cellNode = cell as { __type?: string; children?: unknown };
          const inner =
            cellNode.__type === "TableCell"
              ? await renderChildren(asArray(cellNode.children), opts)
              : await renderNode(cell, opts);
          return `<${tag}>${inner}</${tag}>`;
        })
      );
      return `<tr>${cellHtml.join("")}</tr>`;
    }

    case "TableCell": {
      const inner = await renderChildren(asArray(n.children), opts);
      return `<td>${inner}</td>`;
    }

    case "BulletList": {
      const inner = await renderChildren(asArray(n.children), opts);
      return `<ul>${inner}</ul>`;
    }

    case "ListItem": {
      const inner = await renderChildren(asArray(n.children), opts);
      return `<li>${inner}</li>`;
    }

    case "Blockquote": {
      const inner = await renderChildren(asArray(n.children), opts);
      return `<blockquote>${inner}</blockquote>`;
    }

    case "ThematicBreak":
      return `<hr />`;

    case "Math":
      return `<div class="math">${renderMath(String(n.value ?? ""), true)}</div>`;

    case "InlineMath":
      return `<span class="math">${renderMath(String(n.value ?? ""), false)}</span>`;

    case "Parameters": {
      const inner = await renderChildren(asArray(n.children), opts);
      return `<dl class="params">${inner}</dl>`;
    }

    case "DocParam": {
      const name = escapeHtml(String(n.name ?? ""));
      const annotation = n.annotation
        ? `<span class="ptype"> : ${escapeHtml(String(n.annotation))}</span>`
        : "";
      const desc = await renderChildren(asArray(n.desc), opts);
      return `<dt><code class="pname">${name}</code>${annotation}</dt><dd>${desc}</dd>`;
    }

    case "CrossRef": {
      if (resolveXref) {
        const resolved = resolveXref(node);
        if (resolved) {
          if (resolved.external) {
            return `<a class="xref external" href="${escapeHtml(resolved.url)}" rel="noopener noreferrer">${escapeHtml(resolved.label)}</a>`;
          }
          return `<a class="xref" href="${escapeHtml(resolved.url)}">${escapeHtml(resolved.label)}</a>`;
        }
      }
      return `<span class="xref unresolved"${unresolvedRefDebug(n)}>${escapeHtml(String(n.value ?? ""))}</span>`;
    }

    case "SeeAlsoItem": {
      // numpydoc "See Also" entry: a target (CrossRef) + an optional
      // description. Rendered as a <dt>/<dd> pair inside a <dl> (see the
      // qualname page). Both go through resolveXref so refs in the description
      // — e.g. a :class:`~collections.abc.Callable` — resolve too.
      const name = n.name ? await renderNode(n.name as IRNode, opts) : "";
      const desc = await renderChildren(asArray(n.descriptions), opts);
      return `<dt class="see-also-name">${name}</dt><dd class="see-also-desc">${desc}</dd>`;
    }

    case "Section": {
      const inner = await renderChildren(asArray(n.children), opts);
      return `<div>${inner}</div>`;
    }

    case "Admonition": {
      const kind = escapeHtml(String(n.kind ?? "note"));
      const baseType = escapeHtml(String(n.base_type ?? "note"));
      const inner = await renderChildren(asArray(n.children), opts);
      return `<aside class="admonition admonition-${baseType} ${kind}">${inner}</aside>`;
    }

    case "AdmonitionTitle": {
      const inner = await renderChildren(asArray(n.children), opts);
      return `<p class="admonition-title">${inner}</p>`;
    }

    case "InlineRole": {
      const classes = ["role"];
      if (n.domain) classes.push(`role-${escapeHtml(String(n.domain))}`);
      if (n.role) classes.push(`role-name-${escapeHtml(String(n.role))}`);
      return `<code class="${classes.join(" ")}">${escapeHtml(String(n.value ?? ""))}</code>`;
    }

    case "ParamRef": {
      const name = escapeHtml(String(n.name ?? ""));
      return `<code class="param-ref" data-param="${name}">${name}</code>`;
    }

    case "DefList": {
      const inner = await renderChildren(asArray(n.children), opts);
      return `<dl class="deflist">${inner}</dl>`;
    }

    case "DefListItem": {
      const dt = n.dt ? await renderNode(n.dt as IRNode, opts) : "";
      const dd = await renderChildren(asArray(n.dd), opts);
      return `<dt>${dt}</dt><dd>${dd}</dd>`;
    }

    case "FieldList": {
      const inner = await renderChildren(asArray(n.children), opts);
      return `<dl class="fieldlist">${inner}</dl>`;
    }

    case "FieldListItem": {
      const name = await renderChildren(asArray(n.name), opts);
      const body = await renderChildren(asArray(n.body), opts);
      return `<dt>${name}</dt><dd>${body}</dd>`;
    }

    case "Image": {
      const src = escapeHtml(String(n.url ?? ""));
      const alt = escapeHtml(String(n.alt ?? ""));
      return `<img src="${src}" alt="${alt}" />`;
    }

    case "Figure": {
      const ref = n.value as { module?: string; version?: string; path?: string } | undefined;
      if (ref && ref.module && ref.version && ref.path) {
        const src = escapeHtml(linkForAsset(ref.module, ref.version, String(ref.path)));
        const alt = escapeHtml(String(ref.path));
        return `<figure class="fig"><img src="${src}" alt="${alt}" loading="lazy" /></figure>`;
      }
      return `<figure class="fig"><code class="role">unresolved fig</code></figure>`;
    }

    case "Target": {
      const label = escapeHtml(String(n.label ?? ""));
      return `<span id="${label}" class="target"></span>`;
    }

    case "CitationReference": {
      const label = escapeHtml(String(n.label ?? ""));
      return `<a class="citation-reference" href="#cite-${label}">[${label}]</a>`;
    }

    case "Citation": {
      const label = escapeHtml(String(n.label ?? ""));
      const inner = await renderChildren(asArray(n.children), opts);
      return `<div id="cite-${label}" class="citation"><span class="citation-label">[${label}]</span>${inner}</div>`;
    }

    case "FootnoteReference": {
      const label = escapeHtml(String(n.label ?? ""));
      // The id lets the matching Footnote link back here via .footnote-backref.
      return `<a class="footnote-reference" id="footnote-ref-${label}" href="#footnote-${label}"><sup>[${label}]</sup></a>`;
    }

    case "Footnote": {
      const label = escapeHtml(String(n.label ?? ""));
      const inner = await renderChildren(asArray(n.children), opts);
      return (
        `<div id="footnote-${label}" class="footnote">` +
        `<a class="footnote-backref" href="#footnote-ref-${label}" aria-label="Jump back to footnote ${label} in text">` +
        `<span class="footnote-label">[${label}]</span>` +
        `<span class="footnote-backref-arrow" aria-hidden="true">↩</span>` +
        `</a>` +
        `<div class="footnote-body">${inner}</div>` +
        `</div>`
      );
    }

    case "SubstitutionRef":
    case "SubstitutionDef":
      return `<span class="substitution">${escapeHtml(String(n.value ?? ""))}</span>`;

    case "UnimplementedInline": {
      const inner = await renderChildren(asArray(n.children), opts);
      return `<span class="unimplemented">${inner}</span>`;
    }

    case "Unimplemented": {
      const placeholder = n.placeholder ? `<code>${escapeHtml(String(n.placeholder))}</code>` : "";
      const value = n.value ? `<span>${escapeHtml(String(n.value))}</span>` : "";
      return `<div class="unimplemented">${placeholder}${value}</div>`;
    }

    default: {
      const typeStr = escapeHtml(type ?? "raw");
      const json = escapeHtml(JSON.stringify(node, null, 2));
      return `<details class="fallback"><summary>unhandled: ${typeStr}</summary><pre>${json}</pre></details>`;
    }
  }
}
