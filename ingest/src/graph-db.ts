/**
 * GraphDb — async query interface used by the Ingester to talk to the graph
 * index (the `nodes` and `links` tables).
 *
 * SqliteGraphDb — wraps a better-sqlite3 handle. The underlying calls
 *   are sync; we expose them as async so the Ingester has a uniform API.
 */
import type DatabaseType from "better-sqlite3";

export interface GraphRow {
  [k: string]: unknown;
}

export interface BatchStmt {
  sql: string;
  params?: unknown[];
}

export interface NodeIndexRow {
  pkg: string;
  ver: string;
  node_type: string;
  content: string; // JSON-encoded node
  page_href: string;
  page_kind: string;
  page_qa: string;
}

export interface GraphDb {
  run(sql: string, params?: unknown[]): Promise<void>;
  get<R = GraphRow>(sql: string, params?: unknown[]): Promise<R | null>;
  all<R = GraphRow>(sql: string, params?: unknown[]): Promise<R[]>;
  /** Atomic batch — a single sync transaction on the SQLite backend. */
  batch(stmts: BatchStmt[]): Promise<void>;
  /**
   * Empty every row from `nodes`, `links`, and `bundles` without dropping
   * the schema. Used by the admin "clear graphstore" action to prepare the
   * processed store for a fresh re-ingest from the raw archive.
   */
  clear(): Promise<void>;
  /**
   * Insert rows into the node_index table (used at ingest time).
   */
  insertNodeIndexRows(rows: NodeIndexRow[]): Promise<void>;
  /**
   * Query the node_index table. If nodeType is provided, filter by that type.
   */
  queryNodeIndex(pkg: string, ver: string, nodeType?: string): Promise<NodeIndexRow[]>;
  /**
   * Delete all node_index rows for a (pkg, ver) pair (used before re-ingest).
   */
  deleteNodeIndex(pkg: string, ver: string): Promise<void>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// better-sqlite3
// ---------------------------------------------------------------------------

export class SqliteGraphDb implements GraphDb {
  constructor(private readonly db: DatabaseType.Database) {}

  async run(sql: string, params: unknown[] = []): Promise<void> {
    this.db.prepare(sql).run(...(params as never[]));
  }

  async get<R = GraphRow>(sql: string, params: unknown[] = []): Promise<R | null> {
    return (this.db.prepare(sql).get(...(params as never[])) as R | undefined) ?? null;
  }

  async all<R = GraphRow>(sql: string, params: unknown[] = []): Promise<R[]> {
    return this.db.prepare(sql).all(...(params as never[])) as R[];
  }

  async batch(stmts: BatchStmt[]): Promise<void> {
    if (stmts.length === 0) return;
    const tx = this.db.transaction((items: BatchStmt[]) => {
      for (const s of items) this.db.prepare(s.sql).run(...((s.params ?? []) as never[]));
    });
    tx(stmts);
  }

  async clear(): Promise<void> {
    await this.batch([
      // links has ON DELETE CASCADE on nodes, but be explicit so the order
      // is stable regardless of FK enforcement state.
      { sql: "DELETE FROM links" },
      { sql: "DELETE FROM nodes" },
      { sql: "DELETE FROM bundles" },
      { sql: "DELETE FROM node_index" },
    ]);
  }

  async insertNodeIndexRows(rows: NodeIndexRow[]): Promise<void> {
    if (rows.length === 0) return;
    const stmts = rows.map((row) => ({
      sql:
        "INSERT INTO node_index" +
        "(pkg, ver, node_type, content, page_href, page_kind, page_qa)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
      params: [
        row.pkg,
        row.ver,
        row.node_type,
        row.content,
        row.page_href,
        row.page_kind,
        row.page_qa,
      ],
    }));
    await this.batch(stmts);
  }

  async queryNodeIndex(pkg: string, ver: string, nodeType?: string): Promise<NodeIndexRow[]> {
    let sql =
      "SELECT pkg, ver, node_type, content, page_href, page_kind, page_qa" +
      " FROM node_index WHERE pkg = ? AND ver = ?";
    const params: unknown[] = [pkg, ver];
    if (nodeType) {
      sql += " AND node_type = ?";
      params.push(nodeType);
    }
    return this.all<NodeIndexRow>(sql, params);
  }

  async deleteNodeIndex(pkg: string, ver: string): Promise<void> {
    await this.run("DELETE FROM node_index WHERE pkg = ? AND ver = ?", [pkg, ver]);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
