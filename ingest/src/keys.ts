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

/**
 * Parse a canonical key string back into a Key.
 *
 * Expects exactly the `module/version/kind/path` format produced by
 * `keyStr`. Throws if the string has fewer than four `/`-separated
 * segments. `path` may itself contain `/` — everything after the third
 * separator is treated as the path component.
 */
export function parseKeyStr(s: string): Key {
  const first = s.indexOf("/");
  if (first === -1) throw new Error(`invalid key string (no separator): ${s}`);
  const second = s.indexOf("/", first + 1);
  if (second === -1) throw new Error(`invalid key string (only one separator): ${s}`);
  const third = s.indexOf("/", second + 1);
  if (third === -1) throw new Error(`invalid key string (only two separators): ${s}`);
  return {
    module: s.slice(0, first),
    version: s.slice(first + 1, second),
    kind: s.slice(second + 1, third),
    path: s.slice(third + 1),
  };
}
