// SSR endpoint: global IR node statistics across all ingested bundles.
//
// Walks every document in every bundle and collects:
//   1. nodeCounts  — how many times each IR node type appears
//   2. fieldTypes  — for each (NodeType, fieldName) pair, which value types
//      actually appear in that field and how many times
//   3. emptyArrayLocations — for each (NodeType, fieldName) pair seen carrying
//      an empty list, the pages where that occurred (capped per field)
//
// The field-type breakdown is the primary value: it tells you which types
// in a union are actually used (e.g. "Section.title never contains Strong")
// so the IR schema can be tightened. Boolean fields are split into separate
// "true"/"false" tags so the distribution of each flag is visible.
//
// Method: GET. No query params.
//
// Response contract: 200 application/x-ndjson stream — one JSON object per
// line, so the client can show progress during a slow corpus-wide walk.
//   {"event":"progress","bundlesScanned":n,"bundlesTotal":N,"documentsScanned":m,"current":"pkg ver"}
//   …
//   {"event":"done","result":<IRStatsResponse>}   final line on success
//   {"event":"error","error":...}                 final line on failure
// "Cache-Control: no-store" is sent so stale counts are never served.

import type { APIRoute } from "astro";
import { getBackends } from "../../../lib/backends.ts";
import { walkAllBundles, type PageRef } from "../../../lib/bundle-walk.ts";
import { respond } from "../../../lib/api-utils.ts";

export const prerender = false;

// ---------------------------------------------------------------------------
// Stats collection
// ---------------------------------------------------------------------------

type TypeCounts = Map<string, number>;

/** fieldKey = "NodeType.fieldName", value = { actualType: count } */
type FieldStats = Map<string, TypeCounts>;

/** Per-field record of pages observed carrying an empty list, deduped by href. */
interface EmptyLoc {
  pages: Map<string, string>; // href → label
  truncated: boolean; // true once the per-field cap was hit
}
type EmptyArrayLocations = Map<string, EmptyLoc>;

/** Max distinct pages recorded per field before we stop and flag truncation. */
const EMPTY_LOC_CAP = 200;

/** Emit a progress event every N documents (plus one per new bundle). */
const PROGRESS_EVERY = 100;

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

function recordEmpty(locs: EmptyArrayLocations, fieldKey: string, page: PageRef): void {
  let e = locs.get(fieldKey);
  if (!e) {
    e = { pages: new Map(), truncated: false };
    locs.set(fieldKey, e);
  }
  if (e.pages.has(page.href)) return;
  if (e.pages.size >= EMPTY_LOC_CAP) {
    e.truncated = true;
    return;
  }
  e.pages.set(page.href, page.label);
}

/** Tag a boolean value with its concrete "true"/"false" label. */
function boolTag(value: boolean): string {
  return value ? "true" : "false";
}

/**
 * Recursively walk an IR node tree, counting node types and recording what
 * value types appear in each field of each typed node.
 *
 * Objects without a `__type` property (e.g. the `_content` record in
 * IngestedDoc, plain config objects) are recursed into but not counted —
 * their keys are dynamic / non-semantic so field-level stats would be noise.
 */
function collectIRStats(
  node: unknown,
  nodeCounts: TypeCounts,
  fieldStats: FieldStats,
  page: PageRef,
  emptyLocs: EmptyArrayLocations
): void {
  if (node === null || node === undefined || typeof node !== "object") return;

  if (Array.isArray(node)) {
    for (const item of node) collectIRStats(item, nodeCounts, fieldStats, page, emptyLocs);
    return;
  }

  const n = node as Record<string, unknown>;
  const nodeType = n.__type;

  if (typeof nodeType !== "string") {
    // Not a typed IR node — recurse into values but don't track field stats.
    for (const val of Object.values(n))
      collectIRStats(val, nodeCounts, fieldStats, page, emptyLocs);
    return;
  }

  inc(nodeCounts, nodeType);

  for (const [fieldName, fieldValue] of Object.entries(n)) {
    if (fieldName === "__type" || fieldName === "__tag") continue;
    analyzeField(`${nodeType}.${fieldName}`, fieldValue, fieldStats, nodeCounts, page, emptyLocs);
  }
}

function analyzeField(
  fieldKey: string,
  value: unknown,
  fieldStats: FieldStats,
  nodeCounts: TypeCounts,
  page: PageRef,
  emptyLocs: EmptyArrayLocations
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
    incField(fieldStats, fieldKey, boolTag(value));
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      incField(fieldStats, fieldKey, "[]");
      recordEmpty(emptyLocs, fieldKey, page);
      return;
    }
    for (const item of value) {
      if (item === null || item === undefined) {
        incField(fieldStats, fieldKey, "null");
      } else if (typeof item === "string") {
        incField(fieldStats, fieldKey, "string");
      } else if (typeof item === "number") {
        incField(fieldStats, fieldKey, "number");
      } else if (typeof item === "boolean") {
        incField(fieldStats, fieldKey, boolTag(item));
      } else if (typeof item === "object" && !Array.isArray(item)) {
        const itemType = (item as Record<string, unknown>).__type;
        if (typeof itemType === "string") {
          incField(fieldStats, fieldKey, itemType);
          collectIRStats(item, nodeCounts, fieldStats, page, emptyLocs);
        } else {
          incField(fieldStats, fieldKey, "object");
          collectIRStats(item, nodeCounts, fieldStats, page, emptyLocs);
        }
      }
    }
    return;
  }
  if (typeof value === "object") {
    const objType = (value as Record<string, unknown>).__type;
    if (typeof objType === "string") {
      incField(fieldStats, fieldKey, objType);
      collectIRStats(value, nodeCounts, fieldStats, page, emptyLocs);
    } else {
      incField(fieldStats, fieldKey, "object");
      collectIRStats(value, nodeCounts, fieldStats, page, emptyLocs);
    }
  }
}

// ---------------------------------------------------------------------------
// API handler
// ---------------------------------------------------------------------------

/** Pages where a given field was observed carrying an empty list. */
export interface EmptyArrayLocation {
  pages: PageRef[];
  /** True when more pages exist than the per-field cap returned. */
  truncated: boolean;
}

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
   *   - A primitive tag: "string", "number", "true", "false", "null", "[]",
   *     "object"
   */
  fieldTypes: Record<string, Record<string, number>>;
  /** "NodeType.fieldName" → pages observed carrying an empty list. */
  emptyArrayLocations: Record<string, EmptyArrayLocation>;
  bundlesScanned: number;
  documentsScanned: number;
  scanMs: number;
}

export const GET: APIRoute = async () => {
  let backends: Awaited<ReturnType<typeof getBackends>>;
  try {
    backends = await getBackends();
  } catch (err) {
    return respond({ ok: false, error: `failed to open backends: ${err}` }, 500);
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = (event: Record<string, unknown>): Promise<void> =>
    writer.write(encoder.encode(JSON.stringify(event) + "\n"));

  (async () => {
    const t0 = performance.now();
    const nodeCounts: TypeCounts = new Map();
    const fieldStats: FieldStats = new Map();
    const emptyLocs: EmptyArrayLocations = new Map();
    let bundlesScanned = 0;
    let documentsScanned = 0;
    let currentBundle = "";

    try {
      const { blobStore, graphDb } = backends;

      // walkAllBundles iterates exactly the rows of `SELECT module, version
      // FROM bundles`, so COUNT(*) is the true denominator for progress.
      const bundleRows = await graphDb.all<{ n: number }>("SELECT COUNT(*) AS n FROM bundles");
      const bundlesTotal = bundleRows[0]?.n ?? 0;
      void send({
        event: "progress",
        bundlesScanned: 0,
        bundlesTotal,
        documentsScanned: 0,
        current: "",
      });

      await walkAllBundles(blobStore, graphDb, (doc, page) => {
        // PageRef labels from walkAllBundles are "pkg ver — innerLabel"; the
        // prefix before the em dash identifies the bundle.
        const bundleKey = page.label.split(" — ")[0] ?? "";
        if (bundleKey !== currentBundle) {
          currentBundle = bundleKey;
          bundlesScanned++;
          void send({
            event: "progress",
            bundlesScanned,
            bundlesTotal,
            documentsScanned,
            current: currentBundle,
          });
        }
        collectIRStats(doc, nodeCounts, fieldStats, page, emptyLocs);
        documentsScanned++;
        if (documentsScanned % PROGRESS_EVERY === 0) {
          void send({
            event: "progress",
            bundlesScanned,
            bundlesTotal,
            documentsScanned,
            current: currentBundle,
          });
        }
        return true; // never stop early
      });

      const nodeCountsObj: Record<string, number> = {};
      for (const [k, v] of nodeCounts) nodeCountsObj[k] = v;

      const fieldTypesObj: Record<string, Record<string, number>> = {};
      for (const [fieldKey, counts] of fieldStats) {
        const inner: Record<string, number> = {};
        for (const [vt, n] of counts) inner[vt] = n;
        fieldTypesObj[fieldKey] = inner;
      }

      const emptyArrayLocationsObj: Record<string, EmptyArrayLocation> = {};
      for (const [fieldKey, e] of emptyLocs) {
        emptyArrayLocationsObj[fieldKey] = {
          pages: [...e.pages].map(([href, label]) => ({ href, label })),
          truncated: e.truncated,
        };
      }

      const result: IRStatsResponse = {
        ok: true,
        nodeCounts: nodeCountsObj,
        fieldTypes: fieldTypesObj,
        emptyArrayLocations: emptyArrayLocationsObj,
        // The walk visits every bundle row; report the true total (a bundle
        // with zero documents never increments the live `bundlesScanned`).
        bundlesScanned: bundlesTotal,
        documentsScanned,
        scanMs: performance.now() - t0,
      };

      await send({ event: "done", result });
    } catch (err) {
      await send({ event: "error", error: String(err) });
    } finally {
      try {
        await writer.close();
      } catch {
        /* already closed (client disconnect) */
      }
    }
  })();

  return new Response(readable, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
};
