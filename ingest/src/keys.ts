/**
 * Graph key: the (module, version, kind, path) tuple that identifies a node
 * in the cross-link graph, plus its canonical string form.
 *
 * Used by the ingest write path and the blob store to address blobs and the
 * `nodes` table uniformly.
 */

export interface Key {
  module: string;
  version: string;
  kind: string;
  path: string;
}

export function keyStr(k: Key): string {
  return `${k.module}/${k.version}/${k.kind}/${k.path}`;
}
