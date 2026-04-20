// Local better-sqlite3 GraphBackend. Dev only — tree-shaken from the
// Cloudflare production bundle because it is only imported behind the
// `import.meta.env.DEV` branch in middleware.ts.
import { existsSync } from "node:fs";
import type DatabaseType from "better-sqlite3";
import Database from "better-sqlite3";
import type { GraphBackend, RefTuple } from "./graph.ts";
import { ingestDb } from "./paths.ts";

export class LocalGraph implements GraphBackend {
  private db: DatabaseType.Database | null;

  constructor(dbPath: string = ingestDb()) {
    if (!existsSync(dbPath)) {
      this.db = null;
      return;
    }
    try {
      this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch {
      this.db = null;
    }
  }

  async resolveRef(ref: RefTuple): Promise<RefTuple | null> {
    const db = this.db;
    if (!db) return null;
    const exact = db
      .prepare(
        "SELECT package, version, category, identifier FROM documents " +
          "WHERE package=? AND version=? AND category=? AND identifier=? LIMIT 1",
      )
      .get(ref.pkg, ref.ver, ref.kind, ref.path) as
      | {
          package: string;
          version: string;
          category: string;
          identifier: string;
        }
      | undefined;
    if (exact) {
      return {
        pkg: exact.package,
        ver: exact.version,
        kind: exact.category,
        path: exact.identifier,
      };
    }
    const rows = db
      .prepare(
        "SELECT package, version, category, identifier FROM documents " +
          "WHERE package=? AND category=? AND identifier=?",
      )
      .all(ref.pkg, ref.kind, ref.path) as Array<{
      package: string;
      version: string;
      category: string;
      identifier: string;
    }>;
    if (rows.length === 0) return null;
    rows.sort((a, b) => b.version.localeCompare(a.version));
    const best = rows[0]!;
    return {
      pkg: best.package,
      ver: best.version,
      kind: best.category,
      path: best.identifier,
    };
  }

  async getBackrefs(target: RefTuple): Promise<RefTuple[]> {
    const db = this.db;
    if (!db) return [];
    const rows = db
      .prepare(
        "SELECT DISTINCT d.package, d.version, d.category, d.identifier " +
          "FROM links l " +
          "JOIN destinations ds ON ds.id = l.dest " +
          "JOIN documents d ON d.id = l.source " +
          "WHERE ds.package=? AND ds.version=? AND ds.category=? AND ds.identifier=?",
      )
      .all(
        target.pkg,
        target.ver,
        target.kind,
        target.path,
      ) as Array<{
      package: string;
      version: string;
      category: string;
      identifier: string;
    }>;
    const out: RefTuple[] = rows.map((r) => ({
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
