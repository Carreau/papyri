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

export interface GraphDb {
  run(sql: string, params?: unknown[]): Promise<void>;
  get<R = GraphRow>(sql: string, params?: unknown[]): Promise<R | null>;
  all<R = GraphRow>(sql: string, params?: unknown[]): Promise<R[]>;
  /** Atomic batch (D1) / single sync transaction (SQLite). */
  batch(stmts: BatchStmt[]): Promise<void>;
  /**
   * Empty every row from `nodes`, `links`, and `bundles` without dropping
   * the schema. Used by the admin "clear graphstore" action to prepare the
   * processed store for a fresh re-ingest from the raw archive.
   */
  clear(): Promise<void>;
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
    ]);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
