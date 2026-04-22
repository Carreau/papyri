// Client island: fetches and renders a paginated node list from the backend.
//
// On mount it hits /api/<pkg>/<ver>/nodes.json (optionally filtered by nodetype
// slug) and renders up to 100 unique node entries.
//
// No client-side type filter: filtering a 100-node sample is misleading.
// Per-type browsing is done via the /nodes/<slug>/ pages, where the API scans
// the full bundle and stops when 100 of the requested type are found.

import { useEffect, useState } from "react";
import { IR_TYPE_NAMES, slugFromType } from "../lib/ir-types.ts";

interface PageRef {
  label: string;
  href: string;
}

interface NodeEntry {
  type: string;
  value: string;
  html?: string;
  pages: PageRef[];
}

interface ApiResponse {
  total: number;
  limit: number;
  entries: NodeEntry[];
}

interface Props {
  pkg: string;
  ver: string;
  /** Lowercase IR type slug (e.g. "paragraph"). Absent means all types. */
  nodetype?: string;
}

const SORTED_TYPES = [...IR_TYPE_NAMES].sort();

export default function NodesPanel({ pkg, ver, nodetype }: Props) {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const u = new URL(`/api/${pkg}/${encodeURIComponent(ver)}/nodes.json`, window.location.origin);
    if (nodetype) u.searchParams.set("nodetype", nodetype);

    fetch(u.toString())
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<ApiResponse>;
      })
      .then(setData)
      .catch((e: unknown) => setError(String(e)));
  }, [pkg, ver, nodetype]);

  if (error) {
    return <p className="nodes-error">Failed to load nodes: {error}</p>;
  }

  const shown = data?.entries.length ?? 0;
  const truncated = data ? data.total >= data.limit : false;

  return (
    <div>
      <nav className="node-type-nav" aria-label="Filter by node type">
        <a
          href={`/${pkg}/${encodeURIComponent(ver)}/nodes/`}
          className={"node-type-nav-item" + (!nodetype ? " active" : "")}
          aria-current={!nodetype ? "page" : undefined}
        >
          All
        </a>
        {SORTED_TYPES.map((typeName) => {
          const slug = slugFromType(typeName);
          return (
            <a
              key={slug}
              href={`/${pkg}/${encodeURIComponent(ver)}/nodes/${slug}/`}
              className={"node-type-nav-item" + (nodetype === slug ? " active" : "")}
              aria-current={nodetype === slug ? "page" : undefined}
            >
              {typeName}
            </a>
          );
        })}
      </nav>

      {!data ? (
        <p className="nodes-loading">Loading…</p>
      ) : (
        <>
          <p className="lede">
            {truncated
              ? `First ${shown} unique values shown`
              : `${shown} unique value${shown !== 1 ? "s" : ""}`}
          </p>

          {shown === 0 ? (
            <p className="no-nodes">No nodes found.</p>
          ) : (
            <dl className="node-list">
              {data.entries.map((entry, i) => (
                <div key={i} className="node-entry" data-nodetype={entry.type}>
                  <dt>
                    <span className="node-kind">{entry.type}</span>
                    <div className="node-value">
                      <NodeValue type={entry.type} value={entry.value} html={entry.html} />
                    </div>
                  </dt>
                  <dd>
                    <details className="node-refs">
                      <summary>
                        {entry.pages.length} page{entry.pages.length !== 1 ? "s" : ""}
                      </summary>
                      <ul>
                        {entry.pages.map((p, j) => (
                          <li key={j}>
                            <a href={p.href}>{p.label}</a>
                          </li>
                        ))}
                      </ul>
                    </details>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
    </div>
  );
}

function NodeValue({ html, type, value }: { html?: string; type: string; value: string }) {
  if (html) {
    // html is produced server-side by renderNode, which escapes all text
    // values and only uses output from trusted libraries (KaTeX, Shiki).
    return <div className="node-rendered" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  if (type === "Math" || type === "InlineMath") {
    return <code className="math-raw">{value}</code>;
  }
  if (type === "Code" || type === "InlineCode") {
    return <pre className="code-raw">{value}</pre>;
  }
  return <span className="node-raw">{value}</span>;
}
