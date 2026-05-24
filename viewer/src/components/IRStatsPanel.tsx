// Client island: fetches /api/ir-stats.json and renders a two-part breakdown:
//   1. Node type counts — how many times each IR node type appears globally.
//   2. Field type breakdown — for each (NodeType, fieldName), which value
//      types actually appear and how many times.
//
// The second part is the primary diagnostic: "Section.title never contains
// Strong" means we can tighten the IR schema for that field.
//
// A field is "interesting" (shown first, bold label) when it has more than one
// distinct value type OR when at least one observed value is a typed IR node
// rather than a plain primitive.  Uninteresting scalar fields (always-string,
// always-number) are still shown but de-emphasised so they don't clutter the
// view.

import { useEffect, useMemo, useState } from "react";
import { IR_TYPE_NAMES } from "../lib/ir-types.ts";

// ---- types mirrored from the API endpoint --------------------------------

interface IRStatsResponse {
  ok: true;
  nodeCounts: Record<string, number>;
  fieldTypes: Record<string, Record<string, number>>;
  bundlesScanned: number;
  documentsScanned: number;
  scanMs: number;
}

// ---- helpers -------------------------------------------------------------

const IR_TYPE_SET: ReadonlySet<string> = new Set(IR_TYPE_NAMES);

/** Return true when `valueType` is the name of a typed IR node. */
function isIRNodeType(valueType: string): boolean {
  return IR_TYPE_SET.has(valueType);
}

/** A field is interesting if it has multiple types OR contains typed IR nodes. */
function isInteresting(typeCounts: Record<string, number>): boolean {
  const types = Object.keys(typeCounts);
  if (types.length > 1) return true;
  return types.some(isIRNodeType);
}

function total(counts: Record<string, number>): number {
  return Object.values(counts).reduce((s, n) => s + n, 0);
}

function fmtN(n: number): string {
  return n.toLocaleString();
}

// Sort entries: IR node types first (alphabetical), then primitives.
function sortedValueTypes(counts: Record<string, number>): [string, number][] {
  return Object.entries(counts).sort(([a, ca], [b, cb]) => {
    const aIsIR = isIRNodeType(a);
    const bIsIR = isIRNodeType(b);
    if (aIsIR !== bIsIR) return aIsIR ? -1 : 1;
    // Within each group: sort by count descending, then name ascending.
    if (cb !== ca) return cb - ca;
    return a.localeCompare(b);
  });
}

// ---- sub-components -------------------------------------------------------

function ValueTypePills({ counts }: { counts: Record<string, number> }) {
  const sorted = sortedValueTypes(counts);
  const tot = total(counts);
  return (
    <span className="irstats-pills">
      {sorted.map(([vt, n]) => (
        <span
          key={vt}
          className={"irstats-pill" + (isIRNodeType(vt) ? " irstats-pill--ir" : "")}
          title={`${fmtN(n)} / ${fmtN(tot)}`}
        >
          {vt}
          <span className="irstats-pill-count">{fmtN(n)}</span>
        </span>
      ))}
    </span>
  );
}

interface FieldRow {
  fieldName: string;
  counts: Record<string, number>;
  interesting: boolean;
}

function NodeTypeSection({
  nodeType,
  nodeCount,
  fields,
  onlyInteresting,
}: {
  nodeType: string;
  nodeCount: number | undefined;
  fields: FieldRow[];
  onlyInteresting: boolean;
}) {
  const shown = onlyInteresting ? fields.filter((f) => f.interesting) : fields;
  const hiddenCount = fields.length - shown.length;

  if (shown.length === 0 && onlyInteresting) return null;

  return (
    <section className="irstats-node-section">
      <h3 className="irstats-node-title">
        <code>{nodeType}</code>
        {nodeCount !== undefined && <span className="irstats-node-count">{fmtN(nodeCount)}×</span>}
      </h3>
      <table className="irstats-field-table">
        <tbody>
          {shown.map((f) => (
            <tr
              key={f.fieldName}
              className={"irstats-field-row" + (!f.interesting ? " irstats-field-row--plain" : "")}
            >
              <td className="irstats-field-name">
                <code>.{f.fieldName}</code>
              </td>
              <td className="irstats-field-values">
                <ValueTypePills counts={f.counts} />
              </td>
            </tr>
          ))}
          {onlyInteresting && hiddenCount > 0 && (
            <tr className="irstats-field-row irstats-field-row--plain">
              <td colSpan={2} className="irstats-hidden-count">
                + {hiddenCount} plain scalar field{hiddenCount !== 1 ? "s" : ""} hidden
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

// ---- main component -------------------------------------------------------

export default function IRStatsPanel() {
  const [data, setData] = useState<IRStatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyInteresting, setOnlyInteresting] = useState(true);
  const [filter, setFilter] = useState("");
  const [tab, setTab] = useState<"counts" | "fields">("fields");

  useEffect(() => {
    fetch("/api/ir-stats.json")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<IRStatsResponse>;
      })
      .then(setData)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  // Build per-node-type field rows from the flat fieldTypes map.
  const nodeFieldMap = useMemo<Map<string, FieldRow[]>>(() => {
    if (!data) return new Map();
    const m = new Map<string, FieldRow[]>();
    for (const [fieldKey, counts] of Object.entries(data.fieldTypes)) {
      const dot = fieldKey.indexOf(".");
      if (dot === -1) continue;
      const nodeType = fieldKey.slice(0, dot);
      const fieldName = fieldKey.slice(dot + 1);
      const rows = m.get(nodeType) ?? [];
      rows.push({ fieldName, counts, interesting: isInteresting(counts) });
      m.set(nodeType, rows);
    }
    // Sort fields: interesting first, then alphabetical.
    for (const rows of m.values()) {
      rows.sort((a, b) => {
        if (a.interesting !== b.interesting) return a.interesting ? -1 : 1;
        return a.fieldName.localeCompare(b.fieldName);
      });
    }
    return m;
  }, [data]);

  // Node types sorted by count descending for the counts tab.
  const sortedNodeCounts = useMemo<[string, number][]>(() => {
    if (!data) return [];
    return Object.entries(data.nodeCounts).sort(([, a], [, b]) => b - a);
  }, [data]);

  // Filtered node types for the fields tab.
  const filteredNodeTypes = useMemo<string[]>(() => {
    const q = filter.trim().toLowerCase();
    const types = [...nodeFieldMap.keys()].sort((a, b) => a.localeCompare(b));
    return q ? types.filter((t) => t.toLowerCase().includes(q)) : types;
  }, [nodeFieldMap, filter]);

  if (error) {
    return <p className="irstats-error">Failed to load statistics: {error}</p>;
  }

  if (!data) {
    return (
      <p className="irstats-loading">
        Scanning all bundles… this may take a while for large corpora.
      </p>
    );
  }

  return (
    <div className="irstats-root">
      <p className="irstats-meta">
        Scanned {fmtN(data.bundlesScanned)} bundle{data.bundlesScanned !== 1 ? "s" : ""},{" "}
        {fmtN(data.documentsScanned)} document{data.documentsScanned !== 1 ? "s" : ""} in{" "}
        {(data.scanMs / 1000).toFixed(1)}s.
      </p>

      <div className="irstats-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "fields"}
          className={"irstats-tab" + (tab === "fields" ? " irstats-tab--active" : "")}
          onClick={() => setTab("fields")}
        >
          Field types
        </button>
        <button
          role="tab"
          aria-selected={tab === "counts"}
          className={"irstats-tab" + (tab === "counts" ? " irstats-tab--active" : "")}
          onClick={() => setTab("counts")}
        >
          Node counts
        </button>
      </div>

      {tab === "counts" && (
        <table className="irstats-counts-table">
          <thead>
            <tr>
              <th>Node type</th>
              <th>Count</th>
            </tr>
          </thead>
          <tbody>
            {sortedNodeCounts.map(([t, n]) => (
              <tr key={t}>
                <td>
                  <code>{t}</code>
                </td>
                <td className="irstats-count-cell">{fmtN(n)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === "fields" && (
        <>
          <div className="irstats-controls">
            <label className="irstats-filter-label">
              Filter node type{" "}
              <input
                type="search"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="e.g. Section"
                className="irstats-filter-input"
              />
            </label>
            <label className="irstats-toggle-label">
              <input
                type="checkbox"
                checked={onlyInteresting}
                onChange={(e) => setOnlyInteresting(e.target.checked)}
              />{" "}
              Hide plain scalar fields
            </label>
          </div>

          <p className="irstats-legend">
            <span className="irstats-pill irstats-pill--ir">
              IRNodeType <span className="irstats-pill-count">n</span>
            </span>{" "}
            = typed IR node.{" "}
            <span className="irstats-pill">
              string <span className="irstats-pill-count">n</span>
            </span>{" "}
            /{" "}
            <span className="irstats-pill">
              null <span className="irstats-pill-count">n</span>
            </span>{" "}
            = primitive / absent.
          </p>

          {filteredNodeTypes.length === 0 ? (
            <p className="irstats-empty">No node types match the filter.</p>
          ) : (
            filteredNodeTypes.map((nodeType) => (
              <NodeTypeSection
                key={nodeType}
                nodeType={nodeType}
                nodeCount={data.nodeCounts[nodeType]}
                fields={nodeFieldMap.get(nodeType) ?? []}
                onlyInteresting={onlyInteresting}
              />
            ))
          )}
        </>
      )}
    </div>
  );
}
