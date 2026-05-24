// SSR endpoint: global IR node statistics across all ingested bundles.
//
// Walks every document in every bundle and collects:
//   1. nodeCounts  — how many times each IR node type appears
//   2. fieldTypes  — for each (NodeType, fieldName) pair, which value types
//      actually appear in that field and how many times
//
// The field-type breakdown is the primary value: it tells you which types
// in a union are actually used (e.g. "Section.title never contains Strong")
// so the IR schema can be tightened.
//
// Method: GET. No query params. Response may be slow on large corpora (full
// bundle walk); a "Cache-Control: no-store" header is sent so stale counts
// are never served.

import type { APIRoute } from "astro";
import { getBackends } from "../../lib/backends.ts";
import { walkAllBundles } from "../../lib/bundle-walk.ts";
import { respond } from "../../lib/api-utils.ts";

export const prerender = false;

// ---------------------------------------------------------------------------
// Stats collection
// ---------------------------------------------------------------------------

type TypeCounts = Map<string, number>;

/** fieldKey = "NodeType.fieldName", value = { actualType: count } */
type FieldStats = Map<string, TypeCounts>;

function inc(map: TypeCounts, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function incField(fieldStats: FieldStats, fieldKey: string, valueType: string): void {
  let m = fieldStats.get(fieldKey);
  if (!m) {
    m = new Map();
    fieldStats.set(fieldKey, m);
  }
  inc(m, valueType);
}

/**
 * Recursively walk an IR node tree, counting node types and recording what
 * value types appear in each field of each typed node.
 *
 * Objects without a `__type` property (e.g. the `_content` record in
 * IngestedDoc, plain config objects) are recursed into but not counted —
 * their keys are dynamic / non-semantic so field-level stats would be noise.
 */
function collectIRStats(node: unknown, nodeCounts: TypeCounts, fieldStats: FieldStats): void {
  if (node === null || node === undefined || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const item of node) collectIRStats(item, nodeCounts, fieldStats);
    return;
  }

  const n = node as Record<string, unknown>;
  const nodeType = n.__type;

  if (typeof nodeType !== "string") {
    // Not a typed IR node — recurse into values but don't track field stats.
    for (const val of Object.values(n)) collectIRStats(val, nodeCounts, fieldStats);
    return;
  }

  inc(nodeCounts, nodeType);

  for (const [fieldName, fieldValue] of Object.entries(n)) {
    if (fieldName === "__type" || fieldName === "__tag") continue;
    analyzeField(`${nodeType}.${fieldName}`, fieldValue, fieldStats, nodeCounts);
  }
}

function analyzeField(
  fieldKey: string,
  value: unknown,
  fieldStats: FieldStats,
  nodeCounts: TypeCounts
): void {
  if (value === null || value === undefined) {
    incField(fieldStats, fieldKey, "null");
    return;
  }
  if (typeof value === "string") {
    incField(fieldStats, fieldKey, "string");
    return;
  }
  if (typeof value === "number") {
    incField(fieldStats, fieldKey, "number");
    return;
  }
  if (typeof value === "boolean") {
    incField(fieldStats, fieldKey, "boolean");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      incField(fieldStats, fieldKey, "[]");
      return;
    }
    for (const item of value) {
      if (item === null || item === undefined) {
        incField(fieldStats, fieldKey, "null");
      } else if (typeof item === "string") {
        incField(fieldStats, fieldKey, "string");
      } else if (typeof item === "number") {
        incField(fieldStats, fieldKey, "number");
      } else if (typeof item === "object" && !Array.isArray(item)) {
        const itemType = (item as Record<string, unknown>).__type;
        if (typeof itemType === "string") {
          incField(fieldStats, fieldKey, itemType);
          collectIRStats(item, nodeCounts, fieldStats);
        } else {
          incField(fieldStats, fieldKey, "object");
          collectIRStats(item, nodeCounts, fieldStats);
        }
      }
    }
    return;
  }
  if (typeof value === "object") {
    const objType = (value as Record<string, unknown>).__type;
    if (typeof objType === "string") {
      incField(fieldStats, fieldKey, objType);
      collectIRStats(value, nodeCounts, fieldStats);
    } else {
      incField(fieldStats, fieldKey, "object");
      collectIRStats(value, nodeCounts, fieldStats);
    }
  }
}

// ---------------------------------------------------------------------------
// API handler
// ---------------------------------------------------------------------------

export interface IRStatsResponse {
  ok: true;
  /** nodeType → total occurrence count across all bundles */
  nodeCounts: Record<string, number>;
  /**
   * "NodeType.fieldName" → { actualValueType: count }
   *
   * Only emitted for fields where at least one occurrence was observed.
   * Value types are either:
   *   - An IR node type name (e.g. "Text", "Section")
   *   - A primitive tag: "string", "number", "boolean", "null", "[]", "object"
   */
  fieldTypes: Record<string, Record<string, number>>;
  bundlesScanned: number;
  documentsScanned: number;
  scanMs: number;
}

export const GET: APIRoute = async () => {
  const t0 = performance.now();
  const nodeCounts: TypeCounts = new Map();
  const fieldStats: FieldStats = new Map();
  let bundlesScanned = 0;
  let documentsScanned = 0;

  try {
    const { blobStore, graphDb } = await getBackends();

    await walkAllBundles(blobStore, graphDb, (doc) => {
      collectIRStats(doc, nodeCounts, fieldStats);
      documentsScanned++;
      return true; // never stop early
    });

    // Count distinct bundles from the walk (walkAllBundles doesn't expose it
    // directly; approximate from fieldStats not being trivial).
    // Re-query the bundles table for an accurate count.
    const rows = await graphDb.all<{ n: number }>("SELECT COUNT(*) AS n FROM bundles");
    bundlesScanned = rows[0]?.n ?? 0;

    const nodeCountsObj: Record<string, number> = {};
    for (const [k, v] of nodeCounts) nodeCountsObj[k] = v;

    const fieldTypesObj: Record<string, Record<string, number>> = {};
    for (const [fieldKey, counts] of fieldStats) {
      const inner: Record<string, number> = {};
      for (const [vt, n] of counts) inner[vt] = n;
      fieldTypesObj[fieldKey] = inner;
    }

    const result: IRStatsResponse = {
      ok: true,
      nodeCounts: nodeCountsObj,
      fieldTypes: fieldTypesObj,
      bundlesScanned,
      documentsScanned,
      scanMs: performance.now() - t0,
    };

    return respond(result, 200, { "Cache-Control": "no-store" });
  } catch (err) {
    return respond({ ok: false, error: String(err) }, 500);
  }
};
