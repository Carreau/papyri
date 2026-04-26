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

export type XRefResolver = (node: unknown) => { url: string; label: string } | null;

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
      if (status && status !== "none") {
        const icon = execStatusIcon(status);
        const title = execStatusTitle(status);
        return `<div class="code-block-wrap" data-exec-status="${escapeHtml(status)}"><pre class="code">${inner}</pre><span class="exec-status exec-status--${escapeHtml(status)}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">${icon}</span></div>`;
      }
      return `<pre class="code">${inner}</pre>`;
    }

    case "Link": {
      const inner = await renderChildren(asArray(n.children), opts);
      const href = escapeHtml(String(n.url ?? ""));
      const title = n.title ? ` title="${escapeHtml(String(n.title))}"` : "";
      return `<a href="${href}"${title}>${inner}</a>`;
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

    case "Heading": {
      const inner = await renderChildren(asArray(n.children), opts);
      const depth = Math.min(Math.max(Number(n.depth ?? 2), 1), 6);
      return `<h${depth}>${inner}</h${depth}>`;
    }

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
          return `<a class="xref" href="${escapeHtml(resolved.url)}">${escapeHtml(resolved.label)}</a>`;
        }
      }
      return `<span class="xref unresolved">${escapeHtml(String(n.value ?? ""))}</span>`;
    }

    case "Section": {
      const inner = await renderChildren(asArray(n.children), opts);
      return `<div>${inner}</div>`;
    }

    case "Admonition": {
      const kind = escapeHtml(String(n.kind ?? "note"));
      const inner = await renderChildren(asArray(n.children), opts);
      return `<aside class="admonition ${kind}">${inner}</aside>`;
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

    case "Directive": {
      const dirName = escapeHtml(String(n.name ?? "unknown"));
      const args = n.args
        ? `<span class="directive-args">${escapeHtml(String(n.args))}</span>`
        : "";
      const inner = await renderChildren(asArray(n.children), opts);
      return `<aside class="directive directive-${dirName}"><p class="directive-name"><code>:${dirName}:</code>${args}</p>${inner}</aside>`;
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

    case "Comment":
      return "";

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
