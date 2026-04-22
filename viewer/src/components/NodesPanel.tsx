// Client island: fetches and renders a paginated node list from the backend.
//
// Replaces the build-time CBOR scan that the SSG nodes pages used. On mount
// it hits /api/<pkg>/<ver>/nodes.json (optionally filtered by nodetype slug)
// and renders up to 100 unique node entries with an integrated type filter.

import { useEffect, useState } from "react";

interface PageRef {
  label: string;
  href: string;
}

interface NodeEntry {
  type: string;
  value: string;
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
  /** NODE_CONFIGS slug ("math" | "code"). Absent means all types. */
  nodetype?: string;
}

export default function NodesPanel({ pkg, ver, nodetype }: Props) {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const u = new URL(`/api/${pkg}/${ver}/nodes.json`, window.location.origin);
    if (nodetype) u.searchParams.set("nodetype", nodetype);

    fetch(u.toString())
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<ApiResponse>;
      })
      .then((d) => {
        setData(d);
        const init: Record<string, boolean> = {};
        for (const e of d.entries) init[e.type] = true;
        setVisible(init);
      })
      .catch((e: unknown) => setError(String(e)));
  }, [pkg, ver, nodetype]);

  if (error) {
    return <p className="nodes-error">Failed to load nodes: {error}</p>;
  }

  if (!data) {
    return <p className="nodes-loading">Loading nodes…</p>;
  }

  const allTypes = [...new Set(data.entries.map((e) => e.type))].sort();
  const allOn = allTypes.every((t) => visible[t]);
  const allOff = allTypes.every((t) => !visible[t]);

  function toggle(key: string) {
    setVisible((prev) => ({ ...prev, [key]: !prev[key] }));
  }
  function setAll(val: boolean) {
    setVisible(Object.fromEntries(allTypes.map((t) => [t, val])));
  }

  const filtered = data.entries.filter((e) => visible[e.type] ?? true);
  const typeCounts = allTypes.map((t) => ({
    t,
    count: data.entries.filter((e) => e.type === t).length,
  }));

  return (
    <div>
      <p className="lede">
        {data.entries.length} unique value{data.entries.length !== 1 ? "s" : ""}
        {" across "}
        {allTypes.length} node type{allTypes.length !== 1 ? "s" : ""}
        {data.total >= data.limit ? ` (first ${data.limit} shown)` : ""}
      </p>

      {allTypes.length > 1 && (
        <div className="nt-filter">
          <div className="nt-filter-heading">
            <span>Node types</span>
            <span className="nt-filter-actions">
              <button
                className="nt-filter-btn"
                onClick={() => setAll(true)}
                disabled={allOn}
                aria-label="Select all"
              >
                all
              </button>
              <button
                className="nt-filter-btn"
                onClick={() => setAll(false)}
                disabled={allOff}
                aria-label="Deselect all"
              >
                none
              </button>
            </span>
          </div>
          <ul className="nt-filter-list">
            {typeCounts.map(({ t, count }) => (
              <li key={t}>
                <label className="nt-filter-label">
                  <input
                    type="checkbox"
                    checked={visible[t] ?? true}
                    onChange={() => toggle(t)}
                  />
                  <span className="nt-filter-name">{t}</span>
                  <span className="nt-filter-count">{count}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="no-nodes">No nodes match the current filter.</p>
      ) : (
        <dl className="node-list">
          {filtered.map((entry, i) => (
            <div key={i} className="node-entry" data-nodetype={entry.type}>
              <dt>
                <span className="node-kind">{entry.type}</span>
                <div className="node-value">
                  <NodeValue type={entry.type} value={entry.value} />
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
    </div>
  );
}

function NodeValue({ type, value }: { type: string; value: string }) {
  if (type === "Math" || type === "InlineMath") {
    return <code className="math-raw">{value}</code>;
  }
  if (type === "Code" || type === "InlineCode") {
    return <pre className="code-raw">{value}</pre>;
  }
  return <span className="node-raw">{value}</span>;
}
