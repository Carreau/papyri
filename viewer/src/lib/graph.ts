// Async graph backend abstraction over the papyri cross-link store.
//
// Singleton initialised by middleware.ts. Callers use `getGraph()`.
// Two implementations exist:
//   graph-local.ts  — better-sqlite3, dev only
//   graph-d1.ts     — Cloudflare D1, production

export interface RefTuple {
  pkg: string;
  ver: string;
  kind: string;
  path: string;
}

export interface GraphBackend {
  /** Best on-disk match for a ref tuple, or null if nothing matches. */
  resolveRef(ref: RefTuple): Promise<RefTuple | null>;
  /** Documents that link to `target`. */
  getBackrefs(target: RefTuple): Promise<RefTuple[]>;
}

let _graph: GraphBackend | undefined;

export function getGraph(): GraphBackend {
  if (!_graph) {
    throw new Error(
      "GraphBackend not initialised — middleware must call initGraph() before any request handler runs",
    );
  }
  return _graph;
}

export function initGraph(backend: GraphBackend): void {
  _graph = backend;
}

// ---------------------------------------------------------------------------
// Convenience helpers used directly by pages. They delegate to the singleton.
// ---------------------------------------------------------------------------

export async function resolveRef(ref: RefTuple): Promise<RefTuple | null> {
  return getGraph().resolveRef(ref);
}

export async function getBackrefs(target: RefTuple): Promise<RefTuple[]> {
  return getGraph().getBackrefs(target);
}
