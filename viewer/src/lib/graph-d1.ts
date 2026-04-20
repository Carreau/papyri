// Cloudflare D1 GraphBackend. Only imported in production when the D1 binding
// is available (middleware.ts).
import type { GraphBackend, RefTuple } from "./graph.ts";

// Structural interface for the Cloudflare D1 database binding.
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}
interface D1DatabaseLike {
  prepare(query: string): D1Statement;
}

export class D1Graph implements GraphBackend {
  constructor(private readonly db: D1DatabaseLike) {}

  async resolveRef(ref: RefTuple): Promise<RefTuple | null> {
    // Exact match first.
    type Row = {
      package: string;
      version: string;
      category: string;
      identifier: string;
    };
    const exact = await this.db
      .prepare(
        "SELECT package, version, category, identifier FROM documents " +
          "WHERE package=? AND version=? AND category=? AND identifier=? LIMIT 1",
      )
      .bind(ref.pkg, ref.ver, ref.kind, ref.path)
      .first<Row>();
    if (exact) {
      return {
        pkg: exact.package,
        ver: exact.version,
        kind: exact.category,
        path: exact.identifier,
      };
    }
    // Fall back: any version of same (pkg, kind, path), newest first.
    const { results } = await this.db
      .prepare(
        "SELECT package, version, category, identifier FROM documents " +
          "WHERE package=? AND category=? AND identifier=?",
      )
      .bind(ref.pkg, ref.kind, ref.path)
      .all<Row>();
    if (results.length === 0) return null;
    results.sort((a, b) => b.version.localeCompare(a.version));
    const best = results[0]!;
    return {
      pkg: best.package,
      ver: best.version,
      kind: best.category,
      path: best.identifier,
    };
  }

  async getBackrefs(target: RefTuple): Promise<RefTuple[]> {
    type Row = {
      package: string;
      version: string;
      category: string;
      identifier: string;
    };
    const { results } = await this.db
      .prepare(
        "SELECT DISTINCT d.package, d.version, d.category, d.identifier " +
          "FROM links l " +
          "JOIN destinations ds ON ds.id = l.dest " +
          "JOIN documents d ON d.id = l.source " +
          "WHERE ds.package=? AND ds.version=? AND ds.category=? AND ds.identifier=?",
      )
      .bind(target.pkg, target.ver, target.kind, target.path)
      .all<Row>();
    const out: RefTuple[] = results.map((r) => ({
      pkg: r.package,
      ver: r.version,
      kind: r.category,
      path: r.identifier,
    }));
    out.sort((a, b) =>
      `${a.pkg}/${a.ver}/${a.kind}/${a.path}`.localeCompare(
        `${b.pkg}/${b.ver}/${b.kind}/${b.path}`,
      ),
    );
    return out;
  }
}
