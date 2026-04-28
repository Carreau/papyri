/**
 * GraphDb — async query interface used by the Ingester to talk to the graph
 * index (the `nodes` and `links` tables).
 *
 * Two implementations:
 *
 *   SqliteGraphDb — wraps a better-sqlite3 handle. The underlying calls
 *     are sync; we expose them as async so the Ingester has a uniform API.
 *
 *   D1GraphDb     — wraps a Cloudflare D1 binding. Native async.
 *
 * The Ingester only needs a small subset of SQL execution: parameterised
 * `run`, `get`, `all`, plus an atomic `batch` for bulk writes. Inside
 * `batch` it does NOT depend on results from earlier statements — D1
 * batches don't surface intermediate reads, so the ingest write path uses
 * subqueries (`INSERT … VALUES ((SELECT id FROM nodes WHERE …), …)`) to
 * avoid the round-trip.
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

  async close(): Promise<void> {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Cloudflare D1
//
// Structural-typed against the minimum surface we actually use, so the Node
// build doesn't need `@cloudflare/workers-types`.
// ---------------------------------------------------------------------------

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<unknown>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatement;
  batch<T = unknown>(stmts: D1PreparedStatement[]): Promise<{ results: T[] }[]>;
}

export class D1GraphDb implements GraphDb {
  constructor(private readonly db: D1DatabaseLike) {}

  async run(sql: string, params: unknown[] = []): Promise<void> {
    await this.db
      .prepare(sql)
      .bind(...params)
      .run();
  }

  async get<R = GraphRow>(sql: string, params: unknown[] = []): Promise<R | null> {
    return (
      (await this.db
        .prepare(sql)
        .bind(...params)
        .first<R>()) ?? null
    );
  }

  async all<R = GraphRow>(sql: string, params: unknown[] = []): Promise<R[]> {
    const r = await this.db
      .prepare(sql)
      .bind(...params)
      .all<R>();
    return r.results;
  }

  async batch(stmts: BatchStmt[]): Promise<void> {
    if (stmts.length === 0) return;
    const prepared = stmts.map((s) => this.db.prepare(s.sql).bind(...(s.params ?? [])));
    await this.db.batch(prepared);
  }

  async close(): Promise<void> {
    /* D1 has no close */
  }
}
